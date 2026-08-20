import { describe, expect, it } from "vitest";
import { AgentEventRouter } from "./eventRouter.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { ApprovalType } from "../gates/approval.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";

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

/** A store with one live task, plus the router that reaches it — the shape a queue consumer would hold. */
function setup(taskId = "T-1") {
  const store = new MemoryTaskStore();
  const registry = new TaskRegistry({ store });
  const orch = registry.create({
    taskId,
    classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
  });
  const router = new AgentEventRouter((id) => (store.loadTask(id) ? registry.resume(id) : null));
  return { store, registry, orch, router, taskId };
}

/** An inbound event as it would arrive off a wire: plain JSON, no in-process types. */
function completedEvent(taskId: string, stage: AgentStage, result: "PASS" | "FAIL" = "PASS"): unknown {
  return JSON.parse(
    JSON.stringify({
      type: "AGENT_COMPLETED",
      taskId,
      stage,
      result: { outcome: { tokens: 120, cost: 0.01, result } },
      timing: { start: 1000, end: 2000 },
    }),
  );
}

describe("AgentEventRouter (T36)", () => {
  it("routes an agent completion to the next stage without the caller holding an Orchestrator", () => {
    const { router, orch, taskId } = setup();
    const first = orch.status();
    expect(first.kind).toBe("RUNNING");
    const stage = first.kind === "RUNNING" ? first.stage : AgentStage.BACKEND_ENGINEER;

    const result = router.dispatch(completedEvent(taskId, stage));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The "→ Next Task" half: the caller is told who runs next, not left to work it out.
    expect(result.next).not.toBeNull();
    expect(result.next).not.toBe(stage);
  });

  it("drives a whole task to DEPLOYED through events alone", () => {
    const { router, orch, taskId, store } = setup("T-EVENTED");
    let next = orch.status().kind === "RUNNING" ? (orch.status() as { stage: AgentStage }).stage : null;

    for (let i = 0; i < 10 && next; i++) {
      const stage = next;
      const event =
        stage === AgentStage.QA_ENGINEER
          ? {
              type: "AGENT_COMPLETED",
              taskId,
              stage,
              result: {
                outcome: { tokens: 500, cost: 0.02, result: "PASS" },
                artifactType: ArtifactType.QA_REPORT,
                artifact: qaReport("PASS"),
              },
              timing: { start: 0, end: 10 },
            }
          : completedEvent(taskId, stage);

      const result = router.dispatch(event);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      next = result.next;
      if (result.status.kind === "DEPLOYED") break;
    }

    expect(store.loadTask(taskId)!.machine.current).toBe("DEPLOYED");
  });

  it("rejects an event for a stage that is not currently assigned, without throwing", () => {
    const { router, taskId } = setup();
    // devops finishing before anything else has run is a duplicate or a stray message.
    const result = router.dispatch(completedEvent(taskId, AgentStage.DEVOPS));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not currently assigned");
    // Redelivering will not make it correct — the consumer should drop it, not retry.
    expect(result.retryable).toBe(false);
  });

  it("rejects a malformed event with the parse problems, and never guesses which task it meant", () => {
    const { router } = setup();
    const result = router.dispatch({ type: "AGENT_COMPLETED", taskId: "T-1", stage: "not-a-real-stage" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("does not match any known inbound shape");
    expect(result.retryable).toBe(false);
  });

  it("rejects an event for a task the store does not hold, and marks it retryable", () => {
    const { router } = setup();
    const result = router.dispatch(completedEvent("T-NOT-THERE", AgentStage.BACKEND_ENGINEER));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no task T-NOT-THERE");
    // The event may simply have overtaken the task's creation.
    expect(result.retryable).toBe(true);
  });

  it("treats a resolver that refuses as a not-now, not a never", () => {
    const router = new AgentEventRouter(() => {
      throw new Error("task T-DEP cannot run yet: T-BASE must reach DEPLOYED first");
    });
    const result = router.dispatch(completedEvent("T-DEP", AgentStage.BACKEND_ENGINEER));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("must reach DEPLOYED first");
  });

  it("applies a human decision that arrives as an event", () => {
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const orch = registry.create({
      taskId: "T-GATE",
      classification: classifyTask({ isNewFeatureModuleOrProject: true, touchesSchema: true, touchesBackend: true }),
    });
    for (let i = 0; i < 10; i++) {
      const status = orch.status();
      if (status.kind !== "RUNNING") break;
      orch.reportCompletion(status.stage, { outcome: { tokens: 1, cost: 0, result: "PASS" } }, { start: 0, end: 1 });
    }
    expect(orch.status().kind).toBe("WAITING_FOR_HUMAN");

    const router = new AgentEventRouter((id) => (store.loadTask(id) ? registry.resume(id) : null));
    const result = router.dispatch({
      type: "APPROVAL_DECIDED",
      taskId: "T-GATE",
      approvalType: ApprovalType.SCHEMA_CONFIRMATION,
      approved: true,
      by: "jane",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The gate is answered, so the task is moving again.
    expect(result.status.kind).toBe("RUNNING");
    expect(store.loadTask("T-GATE")!.approvals.at(-1)).toMatchObject({ status: "approved", decidedBy: "jane" });
  });

  it("rejects an answer to a question the task never asked", () => {
    const { router, taskId } = setup();
    const result = router.dispatch({
      type: "APPROVAL_DECIDED",
      taskId,
      approvalType: ApprovalType.DEPLOY,
      approved: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("a decision cannot precede the question");
    expect(result.retryable).toBe(false);
  });

  it("keeps optional metric fields that the wire schema does not name", () => {
    const { router, orch, taskId, store } = setup("T-METRICS");
    const stage = (orch.status() as { stage: AgentStage }).stage;

    router.dispatch({
      type: "AGENT_COMPLETED",
      taskId,
      stage,
      result: {
        outcome: { tokens: 120, cost: 0.01, result: "PASS", some_future_metric: 42 },
      },
      timing: { start: 0, end: 5 },
    });

    // A strict object would have silently dropped it — which is how a new
    // measurement turns into a missing one with nothing to notice.
    const run = store.runsForTask(taskId)[0];
    expect(run).toBeDefined();
    expect(run.tokens).toBe(120);
  });
});
