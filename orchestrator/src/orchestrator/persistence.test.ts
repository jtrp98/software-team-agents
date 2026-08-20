import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { Orchestrator, type AgentExecutorResult } from "./orchestrator.js";
import { validateStructuredFailure } from "./failure.js";
import { ApprovalType } from "../gates/approval.js";

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 4 : 2, failed: status === "PASS" ? 0 : 1 },
    evidence: ["npm run typecheck"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

const pass: AgentExecutorResult = { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };

/** An incremental feature: system-analyst -> backend -> frontend -> qa. */
function incremental() {
  return classifyTask({ isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true });
}

describe("Orchestrator persistence (T01)", () => {
  it("writes the task to the store as soon as it is created", () => {
    const store = new MemoryTaskStore();
    new Orchestrator("T-1", incremental(), { store });
    expect(store.loadTask("T-1")?.machine.current).toBe(TaskState.CREATED);
  });

  it("persists the state that produced a status before returning it", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store });
    const status = orch.status();

    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
    expect(store.loadTask("T-1")!.machine.current).toBe(TaskState.DESIGN);
  });

  it("resumes on the same stage a killed process stopped at, without re-running earlier stages", async () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store });
    await first.step(() => pass); // system-analyst done
    first.provideHumanApproval("designApproved", true);
    await first.step(() => pass); // backend-engineer done

    const resumed = Orchestrator.resume("T-1", store);
    const ran: AgentStage[] = [];
    await resumed.step((req) => {
      ran.push(req.stage);
      return pass;
    });

    expect(ran).toEqual([AgentStage.FRONTEND_ENGINEER]);
  });

  it("does not ask again for an approval a person already gave", () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store });
    first.status();
    first.provideHumanApproval("designApproved", true);

    // The stage never ran, so the task is still at DESIGN — but the approval is not lost.
    const resumed = Orchestrator.resume("T-1", store);
    expect(resumed.snapshot().gateContext.designApproved).toBe(true);
  });

  it("carries retry counts and spend across a resume, so a restart is not a fresh allowance", async () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store });
    await first.step(() => pass);
    first.provideHumanApproval("designApproved", true);
    await first.step(() => ({ outcome: { tokens: 5_000, cost: 0.2, result: "PASS" } }));
    await first.step(() => ({ outcome: { tokens: 5_000, cost: 0.2, result: "PASS" } }));
    await first.step(() => ({
      outcome: { tokens: 1_000, cost: 0.05, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: qaReport("FAIL"),
    }));

    expect(first.retries.qa).toBe(1);

    const resumed = Orchestrator.resume("T-1", store);
    expect(resumed.retries.qa).toBe(1);
    expect(resumed.runLog.totalTokens("T-1")).toBe(first.runLog.totalTokens("T-1"));
    expect(resumed.runLog.runsForTask("T-1")).toHaveLength(4);
  });

  it("keeps every routing decision in the store as an audit trail", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store });
    await orch.step(() => pass);

    const types = store.eventsForTask("T-1").map((e) => e.type);
    expect(types).toContain("AGENT_ASSIGNED");
    expect(types).toContain("AGENT_COMPLETED");
  });

  it("refuses to create a task id the store already holds", () => {
    const store = new MemoryTaskStore();
    new Orchestrator("T-1", incremental(), { store });
    expect(() => new Orchestrator("T-1", incremental(), { store })).toThrow();
  });

  it("throws when asked to resume a task that was never stored", () => {
    expect(() => Orchestrator.resume("ghost", new MemoryTaskStore())).toThrow();
  });
});

describe("Orchestrator failure routing (T01)", () => {
  async function driveToFailedQa(failure?: ReturnType<typeof validateStructuredFailure>) {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store });
    await orch.step(() => pass); // system-analyst
    orch.provideHumanApproval("designApproved", true);
    await orch.step(() => pass); // backend
    await orch.step(() => pass); // frontend
    const status = await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: qaReport("FAIL"),
      failure,
    }));
    return { orch, status, store };
  }

  it("without a structured failure, a failed QA round restarts at the first implementation stage", async () => {
    const { status } = await driveToFailedQa();
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
  });

  it("with one, it goes to the engineer that owns the failure instead", async () => {
    const { status } = await driveToFailedQa(
      validateStructuredFailure({
        category: "implementation",
        owner: AgentStage.FRONTEND_ENGINEER,
        severity: "medium",
        retryable: true,
        reason: "renders the wrong total",
        affected: ["FE-002"],
        requiresHuman: false,
      }),
    );
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.FRONTEND_ENGINEER });
  });

  /**
   * Before T07 this blocked: the machine had no way back to DESIGN, so a contract
   * gap and an unclassifiable failure were indistinguishable. It now recovers to
   * the stage that actually owns the gap.
   */
  it("recovers to system-analyst when the failure is a contract gap, rather than re-running an engineer that cannot fix it", async () => {
    const { status, orch } = await driveToFailedQa(
      validateStructuredFailure({
        category: "contract",
        owner: AgentStage.SYSTEM_ANALYST,
        severity: "high",
        retryable: true,
        reason: "design.md never defines the refund window",
        affected: ["BE-004"],
        requiresHuman: false,
      }),
    );
    expect(status.kind).toBe("RUNNING");
    if (status.kind === "RUNNING") expect(status.stage).toBe(AgentStage.SYSTEM_ANALYST);
    expect(orch.machine.current).toBe(TaskState.DESIGN);
    expect(orch.recovery?.kind).toBe("RECOVER");
    expect(orch.snapshot().lastFailure?.category).toBe("contract");
  });

  it("records the failure on the task so a resumed run can still see why it stopped", async () => {
    const { store } = await driveToFailedQa(
      validateStructuredFailure({
        category: "implementation",
        owner: AgentStage.BACKEND_ENGINEER,
        severity: "high",
        retryable: true,
        reason: "API response mismatch",
        affected: ["BE-004"],
        requiresHuman: false,
      }),
    );
    expect(store.loadTask("T-1")!.lastFailure?.reason).toBe("API response mismatch");
  });
});

describe("Orchestrator persistence — against the real file-backed store", () => {
  it("a second store opened on the same file resumes the task the first one left behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-resume-"));
    const file = path.join(dir, ".workflow", "state.db");
    try {
      const firstStore = new SqliteTaskStore(file);
      const first = new Orchestrator("T-1", incremental(), { store: firstStore });
      await first.step(() => pass); // system-analyst ran and cost real money
      first.provideHumanApproval("designApproved", true);
      firstStore.close(); // process dies here

      const secondStore = new SqliteTaskStore(file);
      const resumed = Orchestrator.resume("T-1", secondStore);
      const ran: AgentStage[] = [];
      await resumed.step((req) => {
        ran.push(req.stage);
        return pass;
      });

      // system-analyst is not re-run, and the approval is not re-asked.
      expect(ran).toEqual([AgentStage.BACKEND_ENGINEER]);
      expect(resumed.snapshot().gateContext.designApproved).toBe(true);
      secondStore.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("human approval as first-class state (T08)", () => {
  function atSchemaGate() {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store });
    return { store, orch };
  }

  it("opens a typed, pending approval when the task reaches a gate", async () => {
    const { orch } = atSchemaGate();
    await orch.step(() => pass); // system-analyst finishes; DESIGN -> IMPLEMENTATION is gated
    const status = orch.status();

    expect(status.kind).toBe("WAITING_FOR_HUMAN");
    if (status.kind === "WAITING_FOR_HUMAN") expect(status.approvalType).toBe(ApprovalType.SCHEMA_CONFIRMATION);

    const ledger = orch.approvalLedger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: ApprovalType.SCHEMA_CONFIRMATION,
      status: "pending",
      required: true,
      from: TaskState.DESIGN,
      to: TaskState.IMPLEMENTATION,
    });
  });

  it("does not append a second question each time the status is polled", async () => {
    const { orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.status();
    orch.status();
    expect(orch.approvalLedger).toHaveLength(1);
  });

  it("records who approved, and lets the task continue", async () => {
    const { orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, true, { by: "jaturapat", note: "schema ok" });

    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(orch.approvalLedger[0]).toMatchObject({ status: "approved", decidedBy: "jaturapat", note: "schema ok" });
  });

  /**
   * The behaviour T08 exists for. A rejection used to be stored as `false`,
   * which is what "never asked" also looked like — so the next poll asked again,
   * and a "no" degraded into a re-prompt until someone said yes.
   */
  it("treats a rejection as an answer: the task blocks instead of being asked again", async () => {
    const { orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, false, { by: "jaturapat", note: "ยังไม่มี field discount" });

    const status = orch.status();
    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") {
      expect(status.reason).toContain("rejected");
      expect(status.reason).toContain("ยังไม่มี field discount");
    }
    expect(orch.status().kind).toBe("BLOCKED"); // and stays blocked on every later poll
  });

  it("carries the ledger across a resume, so a restart never re-asks an answered question", async () => {
    const { store, orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, true, { by: "jaturapat" });

    const resumed = Orchestrator.resume("T-1", store);
    expect(resumed.approvalLedger[0]).toMatchObject({ status: "approved", decidedBy: "jaturapat" });
    expect(resumed.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
  });

  it("carries a rejection across a resume too — the task does not un-reject itself by restarting", async () => {
    const { store, orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, false, { note: "no" });

    expect(Orchestrator.resume("T-1", store).status().kind).toBe("BLOCKED");
  });

  it("refuses a decision for a gate the task has not reached", () => {
    const { orch } = atSchemaGate();
    expect(() => orch.decideApproval(ApprovalType.DEPLOY, true)).toThrow();
  });

  it("still accepts the pre-T08 boolean call, so existing callers keep working", async () => {
    const { orch } = atSchemaGate();
    await orch.step(() => pass);
    orch.status();
    orch.provideHumanApproval("designApproved", true);

    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(orch.approvalLedger[0].status).toBe("approved");
  });

  /** An escalated QA round is one of the five human points too, and used to leave no typed trace. */
  it("records an escalated QA failure as a typed approval, not just an opaque BLOCKED", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store });
    await orch.step(() => pass);
    orch.provideHumanApproval("designApproved", true);
    await orch.step(() => pass);
    await orch.step(() => pass);
    await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: qaReport("FAIL"),
      failure: validateStructuredFailure({
        category: "unknown",
        owner: AgentStage.HUMAN,
        severity: "high",
        retryable: false,
        reason: "review.md names no owner",
        affected: [],
        requiresHuman: true,
      }),
    }));

    const qaApproval = orch.approvalLedger.find((a) => a.type === ApprovalType.QA_FAILURE);
    expect(qaApproval).toBeDefined();
    expect(qaApproval).toMatchObject({ status: "pending", required: true });
    expect(qaApproval!.reason).toContain("review.md names no owner");
  });
});
