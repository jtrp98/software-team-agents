import { describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import { ApprovalType } from "../gates/approval.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { DOMAIN_EVENT_TYPES, DomainEventType, isDomainEventType, verdictEventFor } from "./domainEvents.js";

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
    findings: status === "PASS" ? [] : [{ id: "F-1", severity: "HIGH", status: "OPEN", description: "missing authz" }],
  };
}

function makeExecutor(
  overrides: Partial<Record<AgentStage, (callIndex: number) => AgentExecutorResult>>,
): AgentExecutor {
  const counts: Partial<Record<AgentStage, number>> = {};
  return (req) => {
    const idx = counts[req.stage] ?? 0;
    counts[req.stage] = idx + 1;
    const override = overrides[req.stage];
    if (override) return override(idx);
    return { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };
  };
}

/** Collects every event the orchestrator emits, in order, so a test can assert on the sequence rather than one call. */
function recordEvents(orch: Orchestrator): { type: string; payload: unknown }[] {
  const seen: { type: string; payload: unknown }[] = [];
  for (const type of DOMAIN_EVENT_TYPES) {
    orch.events.on(type, (payload) => seen.push({ type, payload }));
  }
  return seen;
}

describe("domain event vocabulary", () => {
  it("names a verdict event only for the stages that verify something", () => {
    expect(verdictEventFor(AgentStage.QA_ENGINEER, true)).toBe("QA_PASSED");
    expect(verdictEventFor(AgentStage.QA_ENGINEER, false)).toBe("QA_FAILED");
    expect(verdictEventFor(AgentStage.SECURITY, true)).toBe("SECURITY_PASSED");
    expect(verdictEventFor(AgentStage.SECURITY, false)).toBe("SECURITY_FAILED");
    // An engineer finishing is an AGENT_COMPLETED and nothing more — a producer
    // "passing" is a different claim from a reviewer "passing".
    expect(verdictEventFor(AgentStage.BACKEND_ENGINEER, true)).toBeNull();
    expect(verdictEventFor(AgentStage.FRONTEND_ENGINEER, false)).toBeNull();
    expect(verdictEventFor(AgentStage.SYSTEM_ANALYST, true)).toBeNull();
  });

  it("recognises its own event names and nothing else", () => {
    expect(isDomainEventType("QA_FAILED")).toBe(true);
    expect(isDomainEventType("DEPLOY_COMPLETED")).toBe(true);
    // The lifecycle events are a separate set and must not be mistaken for these.
    expect(isDomainEventType("AGENT_COMPLETED")).toBe(false);
    expect(isDomainEventType("TASK_DEPLOYED")).toBe(false);
    expect(DOMAIN_EVENT_TYPES).toHaveLength(7);
  });
});

describe("Orchestrator emits domain events", () => {
  it("emits QA_PASSED with the round number on a first-pass round", async () => {
    const orch = new Orchestrator("T-PASS", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const events = recordEvents(orch);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.02, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
    });

    for (let i = 0; i < 10; i++) {
      const status = await orch.step(executor);
      if (status.kind === "WAITING_FOR_HUMAN") {
        orch.provideHumanApproval(
          status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved",
          true,
        );
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const passed = events.filter((e) => e.type === DomainEventType.QA_PASSED);
    expect(passed).toHaveLength(1);
    expect(passed[0].payload).toMatchObject({ taskId: "T-PASS", stage: AgentStage.QA_ENGINEER, round: 0 });
    expect(events.some((e) => e.type === DomainEventType.QA_FAILED)).toBe(false);
  });

  it("emits QA_FAILED carrying both the classified failure and the routing decision", async () => {
    const orch = new Orchestrator("T-FAIL", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const events = recordEvents(orch);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: (idx) => ({
        outcome: { tokens: 500, cost: 0.02, result: idx === 0 ? "FAIL" : "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport(idx === 0 ? "FAIL" : "PASS"),
        failure:
          idx === 0
            ? {
                category: "implementation" as const,
                owner: AgentStage.BACKEND_ENGINEER,
                severity: "high" as const,
                retryable: true,
                reason: "API response mismatch",
                affected: ["BE-004"],
                requiresHuman: false,
              }
            : undefined,
      }),
    });

    for (let i = 0; i < 10; i++) {
      const status = await orch.step(executor);
      if (status.kind === "WAITING_FOR_HUMAN") {
        orch.provideHumanApproval(
          status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved",
          true,
        );
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const failed = events.filter((e) => e.type === DomainEventType.QA_FAILED);
    expect(failed).toHaveLength(1);
    // The two halves nothing else could reconstruct: what broke, and what was decided.
    expect(failed[0].payload).toMatchObject({
      round: 1,
      failure: { owner: AgentStage.BACKEND_ENGINEER, affected: ["BE-004"] },
      recovery: { kind: "RETRY", stage: AgentStage.BACKEND_ENGINEER },
    });
    // The retry round passed, so the pass event says round 1, not round 0.
    const passed = events.filter((e) => e.type === DomainEventType.QA_PASSED);
    expect(passed[0].payload).toMatchObject({ round: 1 });
  });

  it("emits SECURITY_FAILED with the recovery action when an audit finds something", async () => {
    const orch = new Orchestrator(
      "T-SEC",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesSensitiveArea: true, touchesBackend: true }),
    );
    const events = recordEvents(orch);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.02, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
      [AgentStage.SECURITY]: (idx) => ({
        outcome: { tokens: 500, cost: 0.02, result: idx === 0 ? "FAIL" : "PASS" },
        artifactType: ArtifactType.SECURITY_REPORT,
        artifact: securityReport(idx === 0 ? "FAIL" : "PASS"),
      }),
    });

    for (let i = 0; i < 20; i++) {
      const status = await orch.step(executor);
      if (status.kind === "WAITING_FOR_HUMAN") {
        orch.provideHumanApproval(
          status.approvalType === ApprovalType.REQUIREMENT_INTERVIEW
            ? "requirementApproved"
            : status.approvalType === ApprovalType.SCHEMA_CONFIRMATION
              ? "designApproved"
              : "humanApproved",
          true,
        );
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const failed = events.filter((e) => e.type === DomainEventType.SECURITY_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({ stage: AgentStage.SECURITY, round: 1, failure: null });
    expect((failed[0].payload as { recovery: { kind: string } }).recovery.kind).toBeTruthy();
  });

  it("emits APPROVAL_REQUIRED once per question, however often status() is polled", () => {
    const orch = new Orchestrator(
      "T-GATE",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesSchema: true, touchesBackend: true }),
    );
    const events = recordEvents(orch);

    // Walk to the interview gate (always the first question on this pipeline
    // since the BA gate exists) by reporting each stage as done.
    for (let i = 0; i < 10; i++) {
      const status = orch.status();
      if (status.kind !== "RUNNING") break;
      orch.reportCompletion(status.stage, { outcome: { tokens: 1, cost: 0, result: "PASS" } }, { start: 0, end: 1 });
    }

    const waiting = orch.status();
    expect(waiting.kind).toBe("WAITING_FOR_HUMAN");
    // Polling is what the CLI does in its loop; it must not re-open the question.
    orch.status();
    orch.status();

    const required = events.filter((e) => e.type === DomainEventType.APPROVAL_REQUIRED);
    expect(required).toHaveLength(1);
    expect(required[0].payload).toMatchObject({
      taskId: "T-GATE",
      approval: { type: ApprovalType.REQUIREMENT_INTERVIEW, status: "pending" },
    });
  });

  it("emits APPROVAL_DECIDED with the answer, including a rejection", () => {
    const orch = new Orchestrator(
      "T-REJECT",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesSchema: true, touchesBackend: true }),
    );
    const events = recordEvents(orch);
    for (let i = 0; i < 10; i++) {
      const status = orch.status();
      if (status.kind !== "RUNNING") break;
      orch.reportCompletion(status.stage, { outcome: { tokens: 1, cost: 0, result: "PASS" } }, { start: 0, end: 1 });
    }

    orch.decideApproval(ApprovalType.REQUIREMENT_INTERVIEW, false, { by: "jane", note: "model is wrong" });

    const decided = events.filter((e) => e.type === DomainEventType.APPROVAL_DECIDED);
    expect(decided).toHaveLength(1);
    expect(decided[0].payload).toMatchObject({
      type: ApprovalType.REQUIREMENT_INTERVIEW,
      approved: false,
      by: "jane",
    });
  });

  it("emits DEPLOY_COMPLETED with what the task cost, alongside the bare TASK_DEPLOYED transition", async () => {
    const orch = new Orchestrator("T-COST", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const events = recordEvents(orch);
    let deployedTransitions = 0;
    orch.events.on("TASK_DEPLOYED", () => deployedTransitions++);

    let clock = 1000;
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.25, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
    });

    for (let i = 0; i < 10; i++) {
      const status = await orch.step(executor, () => (clock += 500));
      if (status.kind === "WAITING_FOR_HUMAN") {
        orch.provideHumanApproval(
          status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved",
          true,
        );
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const completed = events.filter((e) => e.type === DomainEventType.DEPLOY_COMPLETED);
    expect(completed).toHaveLength(1);
    expect(deployedTransitions).toBe(1);
    const payload = completed[0].payload as {
      stages: AgentStage[];
      runs: number;
      totalCost: number;
      totalTokens: number;
      durationMs: number;
    };
    expect(payload.stages).toContain(AgentStage.QA_ENGINEER);
    expect(payload.runs).toBe(orch.runLog.all().length);
    expect(payload.totalCost).toBeCloseTo(orch.runLog.totalCost("T-COST"), 6);
    expect(payload.totalTokens).toBe(orch.runLog.totalTokens("T-COST"));
    expect(payload.durationMs).toBeGreaterThan(0);
  });

  it("persists every domain event to the store, so the trail survives the process", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-STORE", classifyTask({ isClearBugFix: true, touchesBackend: true }), { store });
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.02, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
    });
    for (let i = 0; i < 10; i++) {
      const status = await orch.step(executor);
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const types = store.eventsForTask("T-STORE").map((e) => e.type);
    expect(types).toContain(DomainEventType.QA_PASSED);
    expect(types).toContain(DomainEventType.DEPLOY_COMPLETED);
    // The lifecycle events are still there — the two sets coexist, neither replaces the other.
    expect(types).toContain("AGENT_COMPLETED");
    expect(types).toContain("TASK_DEPLOYED");
  });
});
