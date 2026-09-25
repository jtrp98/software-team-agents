import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "./orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskState } from "../types.js";
import { ArtifactType, ArtifactValidationError, type HandoffArtifact, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import { validateStructuredFailure } from "../orchestrator/failure.js";
import { ApprovalType } from "../gates/approval.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { PermissionDeniedError } from "../agents/permissionPolicy.js";
import { Permission } from "../agents/permissions.js";
import { decidePending, testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { PASSING_VERIFICATION, failingReviewReport, withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";
import { FIXTURE_REVISION, packetFixture, runtimeTaskFixture } from "../runtime/packetFixture.testSupport.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { stableHash } from "../artifacts/executionPacket.js";
import { writeExecutionPacket } from "../state/runtimeArtifacts.js";
import { resolveAuthoritativeContract } from "../agents/agentContract.js";
import { verifiedArtifactProvenance, verifiedRoleAttemptProvenance } from "../knowledge/artifactProvenance.js";
import { pathRulesFor } from "../agents/pathPermissions.js";

const human = { humanDecisionVerifier: testHumanVerifier(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };

// A doc-producing stage's validated artifact is always its HANDOFF (see
// runtime/runtimeExecutor.ts's `ownedDoc` branch) — never a structured
// Requirements/Design/Plan/TestPlan payload; T-V8-028 removed those unused schemas.
const okHandoff: HandoffArtifact = {
  task_id: "T",
  implements: [],
  module: "test-module",
  phase: 1,
  constraint_refs: [],
  contract_refs: { produces: [], consumes: [] },
  decision_refs: [],
  test_refs: [],
  artifact_refs: [],
  open_findings: [],
  budget: null,
};

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 10 : 8, failed: status === "PASS" ? 0 : 2 },
    evidence: ["log"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

function securityReport(status: "PASS" | "FAIL"): SecurityReportArtifact {
  return {
    taskId: "T",
    overallStatus: status,
    findings:
      status === "PASS"
        ? []
        : [{ id: "F-1", severity: "HIGH", status: "OPEN", description: "missing authz" }],
  };
}

function makeExecutor(overrides: Partial<Record<AgentStage, (callIndex: number) => AgentExecutorResult>>): AgentExecutor {
  const counts: Partial<Record<AgentStage, number>> = {};
  return (req) => {
    const idx = counts[req.stage] ?? 0;
    counts[req.stage] = idx + 1;
    const override = overrides[req.stage];
    // A successful stage carries the evidence a real composition attaches (V13 TASK-003).
    if (override) return withRequiredEvidence(req, override(idx));
    return withRequiredEvidence(req, { outcome: { tokens: 100, cost: 0.01, result: "PASS" } });
  };
}

async function runToCompletion(orch: Orchestrator, executor: AgentExecutor, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const status = await orch.step(executor);
    if (status.kind === "WAITING_FOR_HUMAN") {
      decidePending(orch, true);
      continue;
    }
    if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
  }
  throw new Error("runToCompletion exceeded maxSteps");
}

describe("Orchestrator", () => {
  it("reserves an attempt before executor side effects and refuses a crash-time repeat", async () => {
    const { MemoryTaskStore } = await import("../store/memoryStore.js");
    const store = new MemoryTaskStore();
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-RESERVE", classification, { ...human, store });
    await orch.step(() => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } })); // prepare
    decidePending(orch, true);
    let finish!: (value: AgentExecutorResult) => void;
    const result: AgentExecutorResult = { outcome: { tokens: 1, cost: 0, result: "PASS" } };
    const pending = orch.step(() => new Promise<AgentExecutorResult>((resolve) => { finish = resolve; }));
    const reservation = store.loadTask("T-RESERVE")!.inFlightAttempt;
    expect(reservation).toEqual({ stage: AgentStage.DEVOPS, attempt: 2, idempotencyKey: "T-RESERVE:devops:2" });
    const restarted = Orchestrator.resume("T-RESERVE", store, human);
    expect(restarted.status()).toMatchObject({ kind: "BLOCKED" });
    let repeated = 0;
    expect((await restarted.step(() => { repeated += 1; return result; })).kind).toBe("BLOCKED");
    expect(repeated).toBe(0);
    finish(result);
    expect((await pending).kind).toBe("DEPLOYED");
    const after = Orchestrator.resume("T-RESERVE", store, human);
    const runs = after.runLog.all().length;
    expect(after.reportCompletion(AgentStage.DEVOPS, result, { start: 0, end: 0 }, reservation!.idempotencyKey).kind).toBe("DEPLOYED");
    expect(after.runLog.all()).toHaveLength(runs);
    expect(() => after.reportCompletion(AgentStage.DEVOPS, { outcome: { tokens: 2, cost: 0, result: "PASS" } }, { start: 0, end: 0 }, reservation!.idempotencyKey)).toThrow(/different result bytes/);
  });

  it("persists the recovery policy decision and retry budget across resume", async () => {
    const { MemoryTaskStore } = await import("../store/memoryStore.js");
    const store = new MemoryTaskStore();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-RECOVERY-DURABLE", classification, { ...human, store });
    const executor = makeExecutor({ [AgentStage.REVIEWER]: () => ({
      outcome: { tokens: 1, cost: 0, result: "FAIL" },
      artifactType: ArtifactType.REVIEW_REPORT,
      artifact: failingReviewReport("T-RECOVERY-DURABLE"),
    }) });
    await orch.step(executor);
    await orch.step(executor);
    const before = store.loadTask("T-RECOVERY-DURABLE")!;
    expect(before.retries.review).toBe(1);
    expect(before.recoveryDecision?.policyVersion).toBe(1);
    expect(before.recoveryDecision?.repairRoute).toBeNull();
    expect(before.recoveryDecision?.handoffIntent).toMatchObject({
      sourceStage: AgentStage.REVIEWER,
      nextStage: AgentStage.BACKEND_ENGINEER,
      nextRuntime: null,
      scopeDigest: null,
    });
    const recoveryEvidence = store.evidenceForTask("T-RECOVERY-DURABLE").find((item) => item.kind === "recovery-decision");
    const roleRun = store.evidenceForTask("T-RECOVERY-DURABLE").find((item) => item.kind === "role-run" && item.stage === AgentStage.REVIEWER);
    expect(recoveryEvidence?.refs).toContain(roleRun?.evidenceId);
    expect(recoveryEvidence?.payload).toMatchObject({ handoffIntent: before.recoveryDecision?.handoffIntent });
    const resumed = Orchestrator.resume("T-RECOVERY-DURABLE", store, human);
    expect(resumed.recovery).toEqual(before.recoveryDecision?.action);
    expect(resumed.repairRoute).toEqual(before.recoveryDecision?.repairRoute);
    expect(store.loadTask("T-RECOVERY-DURABLE")?.recoveryDecision?.handoffIntent).toEqual(before.recoveryDecision?.handoffIntent);
    expect(resumed.status()).toMatchObject({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(resumed.retries.review).toBe(1);
  });
  it("binds handoff evidence to the canonical frozen task scope", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-handoff-scope-"));
    try {
      const taskId = "T-FROZEN-HANDOFF";
      const runtimeTask = runtimeTaskFixture(root, { taskId });
      const { MemoryTaskStore } = await import("../store/memoryStore.js");
      const store = new MemoryTaskStore();
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const orch = new Orchestrator(taskId, classification, { ...human, store, runtimeTask });
      const executor = makeExecutor({ [AgentStage.REVIEWER]: () => ({
        outcome: { tokens: 1, cost: 0, result: "FAIL" },
        artifactType: ArtifactType.REVIEW_REPORT,
        artifact: failingReviewReport(taskId),
      }) });
      await orch.step(executor);
      await orch.step(executor);
      const decision = store.loadTask(taskId)?.recoveryDecision;
      expect(decision?.handoffIntent.scopeDigest).toBe(stableHash({ scope: runtimeTask.scope, knowledgeRoot: null, targetBindings: { targets: [] } }));
      expect(decision?.handoffIntent.nextRuntime).toBeNull();
      expect(store.evidenceForTask(taskId).find((record) => record.kind === "recovery-decision")?.payload).toMatchObject({ handoffIntent: decision?.handoffIntent });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses a Controller result without pre-dispatch proof and preserves an in-flight attempt across restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-governed-dispatch-"));
    try {
      const taskId = "T-GOVERNED-DISPATCH";
      const runtimeTask = runtimeTaskFixture(root, { taskId });
      const packet = packetFixture(root, { taskId });
      const persisted = writeExecutionPacket({ projectRoot: root, packet });
      const packetPath = path.relative(root, persisted.path).replace(/\\/g, "/");
      const stage = AgentStage.BACKEND_ENGINEER;
      const contractDigest = resolveAuthoritativeContract(stage).digest;
      const { MemoryTaskStore } = await import("../store/memoryStore.js");
      const store = new MemoryTaskStore();
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const opts = { ...human, store, runtimeTask, knowledgeRoot: { name: "knowledge", path: root } };
      const orch = new Orchestrator(taskId, classification, opts);
      const result: AgentExecutorResult = withRequiredEvidence({ stage, taskId }, {
        outcome: { tokens: 1, cost: 0, result: "PASS", runtime: "test", contract_digest: contractDigest },
        packetPath,
      });
      expect(() => orch.reportCompletion(stage, result, { start: 0, end: 1 }, `${taskId}:${stage}:1`)).toThrow(/no pre-dispatch attempt reservation/);
      expect(store.evidenceForTask(taskId)).toHaveLength(0);
      let finish!: (result: AgentExecutorResult) => void;
      const pending = orch.step((req) => {
        req.recordDispatch!({ packetPath, packetHash: packet.packet_hash, contractDigest, runtimeId: "test" });
        return new Promise<AgentExecutorResult>((resolve) => { finish = resolve; });
      });
      const reserved = store.loadTask(taskId)?.inFlightAttempt;
      expect(reserved).toMatchObject({ idempotencyKey: `${taskId}:${stage}:1` });
      const resumed = Orchestrator.resume(taskId, store, opts);
      expect(resumed.status()).toMatchObject({ kind: "BLOCKED" });
      let reruns = 0;
      expect((await resumed.step(() => { reruns += 1; return result; })).kind).toBe("BLOCKED");
      expect(reruns).toBe(0);
      expect(() => orch.reportCompletion(stage, { ...result, outcome: { ...result.outcome, runtime: "forged" } },
        { start: 0, end: 1 }, `${taskId}:${stage}:1`)).toThrow(/differs from pre-dispatch/);
      finish(result);
      await pending;
      const run = store.evidenceForTask(taskId).find((item) => item.kind === "role-run" && item.stage === stage);
      expect(verifiedRoleAttemptProvenance(store, run!.evidenceId)).toMatchObject({ stage, attempt: 1, contractDigest });
      const after = Orchestrator.resume(taskId, store, opts);
      const count = store.evidenceForTask(taskId).length;
      after.reportCompletion(stage, result, { start: 0, end: 1 }, `${taskId}:${stage}:1`);
      expect(store.evidenceForTask(taskId)).toHaveLength(count);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])("%s: Knowledge commit requires document bytes changed after BA dispatch", async (changed) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-commit-"));
    try {
      const taskId = changed ? "T-BA-CHANGED" : "T-BA-UNCHANGED";
      const stage = AgentStage.BUSINESS_ANALYST;
      const runtimeTask = runtimeTaskFixture(root, { taskId, stage, allow: ["_docs/module/*/requirement.md"] });
      const rules = pathRulesFor(stage);
      const packet = compileExecutionPacket({
        req: { stage, taskId, context: [] }, role: stage, runtimeTask,
        contractScope: { allow: rules.write, deny: rules.deny }, attempt: 1, baseRevision: FIXTURE_REVISION,
      });
      const saved = writeExecutionPacket({ projectRoot: root, packet });
      const packetPath = path.relative(root, saved.path).replace(/\\/g, "/");
      const sourcePath = path.join(root, "_docs", "module", "packet-fixture", "requirement.md");
      const sourceArtifact = { path: path.relative(root, sourcePath).replace(/\\/g, "/") };
      const contractDigest = resolveAuthoritativeContract(stage).digest;
      const { MemoryTaskStore } = await import("../store/memoryStore.js");
      const store = new MemoryTaskStore();
      const classification = classifyTask({ touchesBusinessRuleOnly: true, touchesBackend: true });
      const orch = new Orchestrator(taskId, classification, { ...human, store, runtimeTask, knowledgeRoot: { name: "knowledge", path: root } });
      const run = () => orch.step((req) => {
        req.recordDispatch!({ packetPath, packetHash: packet.packet_hash, contractDigest, runtimeId: "test" });
        if (changed) fs.appendFileSync(sourcePath, "\nrole attempt amendment\n");
        return { outcome: { tokens: 1, cost: 0, result: "PASS", runtime: "test", contract_digest: contractDigest },
          packetPath, sourceArtifact, artifactType: ArtifactType.HANDOFF,
          artifact: { ...okHandoff, task_id: taskId } };
      });
      if (!changed) {
        await expect(run()).rejects.toThrow(/not authored in the dispatched attempt/);
        expect(store.evidenceForTask(taskId).some((item) => item.kind === "artifact")).toBe(false);
        expect(store.loadTask(taskId)?.inFlightAttempt).toMatchObject({ stage, attempt: 1 });
      } else {
        await run();
        const artifact = store.evidenceForTask(taskId).find((item) => item.kind === "artifact" && item.stage === stage);
        expect(verifiedArtifactProvenance(store, artifact!.evidenceId)).toMatchObject({ stage, roleAttemptId: `${taskId}:${stage}:1` });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("drives a TRIVIAL frontend task straight to DEPLOYED in one step (no design phase — T-UX11)", async () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-TRIVIAL", classification, human);
    const executor = makeExecutor({});
    const status = await orch.step(executor);
    expect(status.kind).toBe("DEPLOYED");
    expect(orch.runLog.all()).toHaveLength(1);
    expect(orch.runLog.all()[0].agent).toBe(AgentStage.FRONTEND_ENGINEER);
  });

  it("loops a SMALL task's QA failure back to the engineer, then deploys on the retry", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SMALL", classification, human);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: (idx) => ({
        outcome: { tokens: 500, cost: 0.02, result: idx === 0 ? "FAIL" : "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport(idx === 0 ? "FAIL" : "PASS"),
      }),
    });

    const final = await runToCompletion(orch, executor);
    expect(final.kind).toBe("DEPLOYED");
    expect(orch.retries.qa).toBe(1);
    const agentsRun = orch.runLog.all().map((r) => r.agent);
    expect(agentsRun).toEqual([
      AgentStage.BACKEND_ENGINEER,
      AgentStage.REVIEWER,
      AgentStage.QA_ENGINEER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.REVIEWER,
      AgentStage.QA_ENGINEER,
    ]);
  });

  it("escalates to BLOCKED once QA fails past MAX_RETRY", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SMALL-FAIL", classification, human);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.02, result: "FAIL" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("FAIL"),
      }),
    });

    const final = await runToCompletion(orch, executor);
    expect(final.kind).toBe("BLOCKED");
    expect(orch.retries.qa).toBe(4); // 3 retries + the failure that exceeds the limit
  });

  it("drives a LARGE_CRITICAL schema-change task through both human-approval gates to DEPLOYED", async () => {
    const classification = classifyTask({
      touchesSchema: true,
      touchesBackend: true,
      testStrategyTriggers: ["migration"],
    });
    const orch = new Orchestrator("T-LARGE", classification, human);
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 2000, cost: 0.2, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: okHandoff,
      }),
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 800, cost: 0.05, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
      [AgentStage.SECURITY]: () => ({
        outcome: { tokens: 1200, cost: 0.1, result: "PASS" },
        artifactType: ArtifactType.SECURITY_REPORT,
        artifact: securityReport("PASS"),
      }),
    });

    const final = await runToCompletion(orch, executor);
    expect(final.kind).toBe("DEPLOYED");
    expect(orch.machine.history).toEqual([
      TaskState.CREATED,
      TaskState.DESIGN,
      TaskState.PLAN, // test-planner, between system-analyst and the engineers
      TaskState.IMPLEMENTATION,
      TaskState.REVIEW,
      TaskState.QA,
      TaskState.SECURITY,
      TaskState.READY_TO_DEPLOY,
      TaskState.APPROVED,
      TaskState.DEPLOYED,
    ]);
  });

  it("stops at WAITING_FOR_HUMAN for design approval and never runs the engineer until approved", async () => {
    const classification = classifyTask({
      touchesSchema: true,
      touchesBackend: true,
      testStrategyTriggers: ["migration"],
    });
    const orch = new Orchestrator("T-GATE", classification, human);
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 2000, cost: 0.2, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: okHandoff,
      }),
    });

    const status = await orch.step(executor); // runs system-analyst, then blocks on the gate
    expect(status.kind).toBe("WAITING_FOR_HUMAN");
    expect(orch.runLog.all().map((r) => r.agent)).toEqual([AgentStage.SYSTEM_ANALYST]);
    // asking again without approval makes no further progress
    const stillWaiting = await orch.step(executor);
    expect(stillWaiting.kind).toBe("WAITING_FOR_HUMAN");
    expect(orch.runLog.all()).toHaveLength(1);
  });

  it("stops with BLOCKED (STOP -> Human) once the token budget is exceeded", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-BUDGET", classification, { ...human, budget: { task_budget: Infinity, agent_budget: Infinity, retry_budget: 3, token_budget: 100 } });
    const executor = makeExecutor({
      [AgentStage.BACKEND_ENGINEER]: () => ({ outcome: { tokens: 1000, cost: 0.01, result: "PASS" } }),
    });

    const status = await orch.step(executor);
    expect(status.kind).toBe("BLOCKED");
    expect(status.kind === "BLOCKED" && status.reason).toMatch(/token_budget/);
  });

  it("routes an UNKNOWN classification straight to BLOCKED without executing any agent", async () => {
    const classification = classifyTask({});
    const orch = new Orchestrator("T-UNKNOWN", classification, human);
    const executor = makeExecutor({});
    const status = await orch.step(executor);
    expect(status.kind).toBe("BLOCKED");
    expect(orch.runLog.all()).toHaveLength(0);
  });

  it("emits AGENT_ASSIGNED, AGENT_COMPLETED, and TASK_DEPLOYED for a TRIVIAL task's event bus", async () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-EVENTS", classification, human);
    const seen: string[] = [];
    orch.events.on("AGENT_ASSIGNED", (e) => seen.push(`ASSIGNED:${e.stage}`));
    orch.events.on("AGENT_COMPLETED", (e) => seen.push(`COMPLETED:${e.stage}`));
    orch.events.on("TASK_DEPLOYED", () => seen.push("DEPLOYED"));

    await orch.step(makeExecutor({}));

    expect(seen).toEqual([
      `ASSIGNED:${AgentStage.FRONTEND_ENGINEER}`,
      `COMPLETED:${AgentStage.FRONTEND_ENGINEER}`,
      "DEPLOYED",
    ]);
  });

  it("does not re-emit AGENT_ASSIGNED for the same assignment on repeated status() polls", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-DEDUP", classification, human);
    let assignedCount = 0;
    orch.events.on("AGENT_ASSIGNED", () => assignedCount++);

    orch.status();
    orch.status();
    orch.status();
    expect(assignedCount).toBe(1);
  });

  it("reportCompletion is the same event-driven path step() uses under the hood — no direct executor call needed", () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-PUSH", classification, human);
    const assigned = orch.status();
    expect(assigned.kind).toBe("RUNNING");
    expect(assigned.kind === "RUNNING" && assigned.stage).toBe(AgentStage.FRONTEND_ENGINEER);

    // simulate "the agent finished and told us" without ever calling an executor callback
    const final = orch.reportCompletion(
      AgentStage.FRONTEND_ENGINEER,
      { outcome: { tokens: 50, cost: 0.01, result: "PASS" }, deterministicVerification: PASSING_VERIFICATION },
      { start: 0, end: 1 },
    );
    expect(final.kind).toBe("DEPLOYED");
  });

  it("reportCompletion rejects a completion report for a stage that isn't currently assigned", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-WRONG-STAGE", classification, human);
    orch.status(); // assigns BACKEND_ENGINEER
    expect(() =>
      orch.reportCompletion(
        AgentStage.QA_ENGINEER,
        { outcome: { tokens: 1, cost: 0, result: "PASS" } },
        { start: 0, end: 1 },
      ),
    ).toThrow(/not currently assigned/);
  });

  it("emits WAITING_FOR_HUMAN and TASK_BLOCKED at the right points", async () => {
    const classification = classifyTask({
      touchesSchema: true,
      touchesBackend: true,
      testStrategyTriggers: ["migration"],
    });
    const orch = new Orchestrator("T-GATE-EVENT", classification, human);
    const waiting: string[] = [];
    orch.events.on("WAITING_FOR_HUMAN", (e) => waiting.push(`${e.from}->${e.to}`));
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: okHandoff,
      }),
    });
    await orch.step(executor);
    // PLAN (test-planner), not IMPLEMENTATION directly — the gate fires leaving DESIGN
    // regardless of what sits immediately after it.
    expect(waiting).toEqual([`${TaskState.DESIGN}->${TaskState.PLAN}`]);

    const blocked: string[] = [];
    const orch2 = new Orchestrator("T-BLOCKED-EVENT", classification, { ...human,
      budget: { task_budget: Infinity, agent_budget: Infinity, retry_budget: 3, token_budget: 1 },
    });
    orch2.events.on("TASK_BLOCKED", (e) => blocked.push(e.reason));
    const executor2 = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: okHandoff,
      }),
    });
    await orch2.step(executor2);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatch(/token_budget/);
  });

  it("gives the backend-engineer only its policy-allowed context categories", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-CTX", classification, human);
    let capturedSources: string[] = [];
    const executor: AgentExecutor = (req) => {
      capturedSources = req.context.map((c) => c.source);
      return { outcome: { tokens: 10, cost: 0.01, result: "PASS" } };
    };
    await orch.step(executor);
    expect(capturedSources.every((s) => s !== "frontend-code" && s !== "devops-docs")).toBe(true);
  });
});

describe("T44 — deploy prepare vs execute", () => {
  it("runs devops twice for a deploy-only task — prepare, then (after the DEPLOY gate) execute — never DEPLOYED before approval", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-DEPLOY", classification, human);
    const phases: (string | undefined)[] = [];
    const executor: AgentExecutor = (req) => {
      phases.push(req.deployPhase);
      return { outcome: { tokens: 50, cost: 0.01, result: "PASS" } };
    };

    // step() runs whatever it finds assigned (devops/prepare, reached by an ungated CREATED ->
    // READY_TO_DEPLOY walk) and returns the status *after* that completion — which must be the
    // DEPLOY gate, never DEPLOYED and never a second prepare run.
    const afterPrepare = await orch.step(executor);
    expect(afterPrepare.kind).toBe("WAITING_FOR_HUMAN");
    if (afterPrepare.kind === "WAITING_FOR_HUMAN") expect(afterPrepare.approvalType).toBe(ApprovalType.DEPLOY);

    decidePending(orch, true);

    const executeStatus = await orch.step(executor);
    expect(executeStatus.kind).toBe("DEPLOYED");

    expect(phases).toEqual(["prepare", "execute"]);
    expect(orch.runLog.all().map((r) => r.agent)).toEqual([AgentStage.DEVOPS, AgentStage.DEVOPS]);
  });

  it("the capability gate refuses the deploy execute launch when devops's contract loses `deploy`", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-DEPLOY-NO-PERM", classification, human);
    const executor: AgentExecutor = () => ({ outcome: { tokens: 10, cost: 0, result: "PASS" } });
    await orch.step(executor); // prepare
    decidePending(orch, true);

    // Simulate a contract edited to drop the destructive permission: the launch
    // itself must fail closed — no run is recorded as attempted, nothing deploys.
    const registryEntry = AGENT_REGISTRY[AgentStage.DEVOPS] as { permissions: Permission[] };
    const original = registryEntry.permissions;
    registryEntry.permissions = original.filter((p) => p !== Permission.DEPLOY);
    try {
      await expect(orch.step(executor)).rejects.toThrow(PermissionDeniedError);
      // The launch died before any run or transition: still parked at APPROVED
      // with devops assigned — a person decides what happens next.
      const stuck = orch.status();
      expect(stuck.kind).toBe("RUNNING");
      if (stuck.kind === "RUNNING") expect(stuck.stage).toBe(AgentStage.DEVOPS);
    } finally {
      registryEntry.permissions = original;
    }
  });

  it("a failed prepare run is retried as prepare again, never treated as done", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-DEPLOY-FAIL", classification, human);
    const phases: (string | undefined)[] = [];
    let call = 0;
    const executor: AgentExecutor = (req) => {
      phases.push(req.deployPhase);
      call += 1;
      return { outcome: { tokens: 50, cost: 0.01, result: call === 1 ? "FAIL" : "PASS" } };
    };

    await orch.step(executor); // fails
    const afterFailedPrepare = orch.status();
    // Still assigned to devops/prepare — not waiting on the DEPLOY gate, since prepare never
    // actually succeeded.
    expect(afterFailedPrepare.kind).toBe("RUNNING");
    if (afterFailedPrepare.kind === "RUNNING") expect(afterFailedPrepare.stage).toBe(AgentStage.DEVOPS);

    await orch.step(executor); // prepare, this time PASS
    expect(orch.status().kind).toBe("WAITING_FOR_HUMAN");
    expect(phases).toEqual(["prepare", "prepare"]);
  });

  it("deployPrepared survives a resume — a task doesn't re-run prepare just because the process restarted", async () => {
    const { MemoryTaskStore } = await import("../store/memoryStore.js");
    const store = new MemoryTaskStore();
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-DEPLOY-RESUME", classification, { ...human, store });
    await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } })); // prepare

    const resumed = Orchestrator.resume("T-DEPLOY-RESUME", store, human);
    const status = resumed.status();
    expect(status.kind).toBe("WAITING_FOR_HUMAN"); // not RUNNING prepare again
    if (status.kind === "WAITING_FOR_HUMAN") expect(status.approvalType).toBe(ApprovalType.DEPLOY);
  });

  it("a non-devops stage never gets a deployPhase", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-NOT-DEPLOY", classification, human);
    let captured: string | undefined = "unset";
    const executor: AgentExecutor = (req) => {
      captured = req.deployPhase;
      return { outcome: { tokens: 10, cost: 0.01, result: "PASS" } };
    };
    await orch.step(executor);
    expect(captured).toBeUndefined();
  });
});

describe("T45 — a failed execute blocks instead of silently deploying", () => {
  async function toApproved(orch: Orchestrator): Promise<void> {
    await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } })); // prepare
    decidePending(orch, true);
  }

  it("execute FAIL forces BLOCKED, never DEPLOYED, and names the Rollback runbook", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-EXEC-FAIL", classification, human);
    await toApproved(orch);

    const status = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "FAIL" } })); // execute
    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") {
      expect(status.reason).toContain("execute failed");
      expect(status.reason).toContain("Rollback runbook");
    }

    // Terminal: another step() must not un-stick it or claim success.
    const again = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } }));
    expect(again.kind).toBe("BLOCKED");
  });

  it("execute PASS still reaches DEPLOYED — the new block only fires on FAIL", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-EXEC-PASS", classification, human);
    await toApproved(orch);

    const status = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } })); // execute
    expect(status.kind).toBe("DEPLOYED");
  });

  it("a FAILed prepare (before approval) is retried, not routed through the T45 block — that only applies to execute", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-PREPARE-FAIL", classification, human);

    const status = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "FAIL" } })); // prepare fails
    expect(status.kind).toBe("RUNNING"); // reassigned to prepare again, not BLOCKED
    if (status.kind === "RUNNING") expect(status.stage).toBe(AgentStage.DEVOPS);
  });
});

describe("uxui-designer routes questions back to ba/sa (T-UX10)", () => {
  const uxQuestion = (owner: AgentStage, severity: "medium" | "critical" = "medium") =>
    validateStructuredFailure({
      category: owner === AgentStage.BUSINESS_ANALYST ? "requirement" : "contract",
      owner,
      severity,
      retryable: true,
      reason:
        owner === AgentStage.BUSINESS_ANALYST
          ? "requirement.md does not say whether the loyalty tier UI is worth building — a business call"
          : "design.md has no model for the referral widget the design source shows — a schema gap",
      affected: ["UX-001"],
      requiresHuman: false,
    });

  /** Drives a full-chain feature task until uxui-designer is the assigned stage. */
  async function driveToUxui(orch: Orchestrator, executor: AgentExecutor): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const status = await orch.step(executor);
      if (status.kind === "RUNNING" && status.stage === AgentStage.UXUI_DESIGNER) return;
      if (status.kind === "WAITING_FOR_HUMAN") {
        decidePending(orch, true);
        continue;
      }
      if (status.kind === "BLOCKED" || status.kind === "DEPLOYED") break;
    }
    throw new Error("uxui-designer was never assigned");
  }

  const feature = () => classifyTask({
    isNewFeatureModuleOrProject: true,
    touchesBackend: true,
    touchesFrontend: true,
    testStrategyTriggers: ["cross-task"],
  });

  it("a value question routes back to business-analyst at REQUIREMENT, not forward to frontend", async () => {
    const orch = new Orchestrator("T-UX-BA", feature(), human);
    await driveToUxui(orch, makeExecutor({}));

    const status = await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      failure: uxQuestion(AgentStage.BUSINESS_ANALYST),
    }));

    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.BUSINESS_ANALYST });
    expect(orch.machine.current).toBe(TaskState.REQUIREMENT);
    // No verification budget was touched by a routed question.
    expect(orch.retries.qa).toBe(0);
  });

  it("fails closed when a doc stage returns an invalid handoff instead of silently storing it", () => {
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const orch = new Orchestrator("T-BAD-HANDOFF", classification, human);
    const status = orch.status();
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
    expect(() => orch.reportCompletion(
      AgentStage.SYSTEM_ANALYST,
      {
        outcome: { tokens: 1, cost: 0, result: "PASS" },
        artifactType: ArtifactType.HANDOFF,
        artifact: { task_id: "T-BAD-HANDOFF", module: "sales" },
      },
      { start: 0, end: 1 },
    )).toThrow(ArtifactValidationError);
  });

  it("a feasibility question routes back to system-analyst at DESIGN and re-walks the chain", async () => {
    const orch = new Orchestrator("T-UX-SA", feature(), human);
    await driveToUxui(orch, makeExecutor({}));

    const status = await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      failure: uxQuestion(AgentStage.SYSTEM_ANALYST),
    }));

    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
    expect(orch.machine.current).toBe(TaskState.DESIGN);
  });

  it("fails closed when the owner is not in this pipeline — an incremental task has no BA to ask", async () => {
    const classification = classifyTask({
      isIncrementalFeature: true,
      touchesBackend: true,
      touchesFrontend: true,
      testStrategyTriggers: ["cross-task"],
    });
    const orch = new Orchestrator("T-UX-NOBA", classification, human);
    // incremental: SA -> TP -> BE -> UXUI -> FE -> QA; the DESIGN->PLAN schema gate still fires.
    await orch.step(() => pass); // system-analyst
    decidePending(orch, true);
    await orch.step(() => pass); // test-planner
    await orch.step((req) => withRequiredEvidence(req, pass)); // backend-engineer

    const status = await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      failure: uxQuestion(AgentStage.BUSINESS_ANALYST),
    }));

    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") expect(status.reason).toMatch(/not in this task's pipeline/);
  });

  it("a critical-severity question stops for a person instead of routing automatically", async () => {
    const orch = new Orchestrator("T-UX-CRIT", feature(), human);
    await driveToUxui(orch, makeExecutor({}));

    const status = await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      failure: uxQuestion(AgentStage.BUSINESS_ANALYST, "critical"),
    }));

    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") expect(status.reason).toMatch(/never handled autonomously/);
  });

  const pass: AgentExecutorResult = { outcome: { tokens: 10, cost: 0.001, result: "PASS" } };
});
