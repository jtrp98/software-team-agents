import { describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "./orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskState } from "../types.js";
import { ArtifactType, type DesignArtifact, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import { BudgetExceededError } from "../cost/costControl.js";
import { ApprovalType } from "../gates/approval.js";

const okDesign: DesignArtifact = {
  taskId: "T",
  feasibility: "feasible",
  dataModel: [{ model: "Refund", fields: [{ name: "id", type: "string" }] }],
  risks: [],
  openQuestions: [],
  contract: ["refund status must be REFUNDED"],
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
    if (override) return override(idx);
    return { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };
  };
}

async function runToCompletion(orch: Orchestrator, executor: AgentExecutor, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const status = await orch.step(executor);
    if (status.kind === "WAITING_FOR_HUMAN") {
      // Keyed on approvalType, not on `to`: T20 put test-planner between DESIGN and
      // IMPLEMENTATION, so the schema-confirmation gate's target is PLAN, not
      // IMPLEMENTATION directly (gatePolicy.ts/approval.ts's matching fix).
      const field = status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved";
      orch.provideHumanApproval(field, true);
      continue;
    }
    if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
  }
  throw new Error("runToCompletion exceeded maxSteps");
}

describe("Orchestrator", () => {
  it("drives a TRIVIAL task straight to DEPLOYED in one step", async () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-TRIVIAL", classification);
    const executor = makeExecutor({});
    const status = await orch.step(executor);
    expect(status.kind).toBe("DEPLOYED");
    expect(orch.runLog.all()).toHaveLength(1);
    expect(orch.runLog.all()[0].agent).toBe(AgentStage.FRONTEND_ENGINEER);
  });

  it("loops a SMALL task's QA failure back to the engineer, then deploys on the retry", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SMALL", classification);
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
      AgentStage.QA_ENGINEER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
  });

  it("escalates to BLOCKED once QA fails past MAX_RETRY", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SMALL-FAIL", classification);
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
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const orch = new Orchestrator("T-LARGE", classification);
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 2000, cost: 0.2, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
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
      TaskState.PLAN, // test-planner (T20), between system-analyst and the engineers
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.SECURITY,
      TaskState.READY_TO_DEPLOY,
      TaskState.APPROVED,
      TaskState.DEPLOYED,
    ]);
  });

  it("stops at WAITING_FOR_HUMAN for design approval and never runs the engineer until approved", async () => {
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const orch = new Orchestrator("T-GATE", classification);
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 2000, cost: 0.2, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
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
    const orch = new Orchestrator("T-BUDGET", classification, { budget: { task_budget: Infinity, agent_budget: Infinity, retry_budget: 3, token_budget: 100 } });
    const executor = makeExecutor({
      [AgentStage.BACKEND_ENGINEER]: () => ({ outcome: { tokens: 1000, cost: 0.01, result: "PASS" } }),
    });

    const status = await orch.step(executor);
    expect(status.kind).toBe("BLOCKED");
    expect(status.kind === "BLOCKED" && status.reason).toMatch(/token_budget/);
  });

  it("routes an UNKNOWN classification straight to BLOCKED without executing any agent", async () => {
    const classification = classifyTask({});
    const orch = new Orchestrator("T-UNKNOWN", classification);
    const executor = makeExecutor({});
    const status = await orch.step(executor);
    expect(status.kind).toBe("BLOCKED");
    expect(orch.runLog.all()).toHaveLength(0);
  });

  it("emits AGENT_ASSIGNED, AGENT_COMPLETED, and TASK_DEPLOYED for a TRIVIAL task's event bus", async () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-EVENTS", classification);
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
    const orch = new Orchestrator("T-DEDUP", classification);
    let assignedCount = 0;
    orch.events.on("AGENT_ASSIGNED", () => assignedCount++);

    orch.status();
    orch.status();
    orch.status();
    expect(assignedCount).toBe(1);
  });

  it("reportCompletion is the same event-driven path step() uses under the hood — no direct executor call needed", () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    const orch = new Orchestrator("T-PUSH", classification);
    const assigned = orch.status();
    expect(assigned.kind).toBe("RUNNING");
    expect(assigned.kind === "RUNNING" && assigned.stage).toBe(AgentStage.FRONTEND_ENGINEER);

    // simulate "the agent finished and told us" without ever calling an executor callback
    const final = orch.reportCompletion(
      AgentStage.FRONTEND_ENGINEER,
      { outcome: { tokens: 50, cost: 0.01, result: "PASS" } },
      { start: 0, end: 1 },
    );
    expect(final.kind).toBe("DEPLOYED");
  });

  it("reportCompletion rejects a completion report for a stage that isn't currently assigned", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-WRONG-STAGE", classification);
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
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const orch = new Orchestrator("T-GATE-EVENT", classification);
    const waiting: string[] = [];
    orch.events.on("WAITING_FOR_HUMAN", (e) => waiting.push(`${e.from}->${e.to}`));
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
      }),
    });
    await orch.step(executor);
    // PLAN (test-planner), not IMPLEMENTATION directly — the gate fires leaving DESIGN
    // regardless of what sits immediately after it (T20).
    expect(waiting).toEqual([`${TaskState.DESIGN}->${TaskState.PLAN}`]);

    const blocked: string[] = [];
    const orch2 = new Orchestrator("T-BLOCKED-EVENT", classification, {
      budget: { task_budget: Infinity, agent_budget: Infinity, retry_budget: 3, token_budget: 1 },
    });
    orch2.events.on("TASK_BLOCKED", (e) => blocked.push(e.reason));
    const executor2 = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
      }),
    });
    await orch2.step(executor2);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatch(/token_budget/);
  });

  it("gives the backend-engineer only its policy-allowed context categories", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-CTX", classification);
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
    const orch = new Orchestrator("T-DEPLOY", classification);
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

    orch.decideApproval(ApprovalType.DEPLOY, true, { by: "tester" });

    const executeStatus = await orch.step(executor);
    expect(executeStatus.kind).toBe("DEPLOYED");

    expect(phases).toEqual(["prepare", "execute"]);
    expect(orch.runLog.all().map((r) => r.agent)).toEqual([AgentStage.DEVOPS, AgentStage.DEVOPS]);
  });

  it("a failed prepare run is retried as prepare again, never treated as done", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-DEPLOY-FAIL", classification);
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
    const orch = new Orchestrator("T-DEPLOY-RESUME", classification, { store });
    await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } })); // prepare

    const resumed = Orchestrator.resume("T-DEPLOY-RESUME", store);
    const status = resumed.status();
    expect(status.kind).toBe("WAITING_FOR_HUMAN"); // not RUNNING prepare again
    if (status.kind === "WAITING_FOR_HUMAN") expect(status.approvalType).toBe(ApprovalType.DEPLOY);
  });

  it("a non-devops stage never gets a deployPhase", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-NOT-DEPLOY", classification);
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
    orch.decideApproval(ApprovalType.DEPLOY, true, { by: "tester" });
  }

  it("execute FAIL forces BLOCKED, never DEPLOYED, and names the Rollback runbook", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-EXEC-FAIL", classification);
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
    const orch = new Orchestrator("T-EXEC-PASS", classification);
    await toApproved(orch);

    const status = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "PASS" } })); // execute
    expect(status.kind).toBe("DEPLOYED");
  });

  it("a FAILed prepare (before approval) is retried, not routed through the T45 block — that only applies to execute", async () => {
    const classification = classifyTask({ isProductionDeployOrMigration: true });
    const orch = new Orchestrator("T-PREPARE-FAIL", classification);

    const status = await orch.step(() => ({ outcome: { tokens: 10, cost: 0.01, result: "FAIL" } })); // prepare fails
    expect(status.kind).toBe("RUNNING"); // reassigned to prepare again, not BLOCKED
    if (status.kind === "RUNNING") expect(status.stage).toBe(AgentStage.DEVOPS);
  });
});
