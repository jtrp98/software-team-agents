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
import { ApprovalDecisionError, ApprovalType } from "../gates/approval.js";
import { NoTrustedHumanChannelError, UntrustedHumanDecisionError, type HumanDecisionVerifier } from "../gates/humanDecision.js";
import { decidePending, testHumanVerifier, trustedCredential, TEST_HUMAN_CHANNEL } from "../gates/humanDecision.testSupport.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";

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

/** Every orchestrator here that answers a gate needs a trusted channel; production has none. */
const human = { humanDecisionVerifier: testHumanVerifier(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };

/** An incremental feature: system-analyst -> test-planner -> backend -> uxui-designer -> frontend -> reviewer -> qa. */
function incremental() {
  return classifyTask({
    isIncrementalFeature: true,
    touchesBackend: true,
    touchesFrontend: true,
    testStrategyTriggers: ["cross-task"],
  });
}

describe("Orchestrator persistence (T01)", () => {
  it("writes the task to the store as soon as it is created", () => {
    const store = new MemoryTaskStore();
    new Orchestrator("T-1", incremental(), { store, ...human });
    expect(store.loadTask("T-1")?.machine.current).toBe(TaskState.CREATED);
  });

  it("persists the state that produced a status before returning it", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    const status = orch.status();

    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
    expect(store.loadTask("T-1")!.machine.current).toBe(TaskState.DESIGN);
  });

  it("resumes on the same stage a killed process stopped at, without re-running earlier stages", async () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store, ...human });
    await first.step(withStageEvidence(() => pass)); // system-analyst done
    decidePending(first, true);
    await first.step(withStageEvidence(() => pass)); // test-planner done
    await first.step(withStageEvidence(() => pass)); // backend-engineer done
    await first.step(withStageEvidence(() => pass)); // uxui-designer done

    const resumed = Orchestrator.resume("T-1", store, human);
    const ran: AgentStage[] = [];
    await resumed.step((req) => {
      ran.push(req.stage);
      return pass;
    });

    expect(ran).toEqual([AgentStage.FRONTEND_ENGINEER]);
  });

  it("refuses to record an approval before the gate has opened a request", () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store, ...human });
    first.status(); // system-analyst is assigned; the DESIGN gate has not been reached
    expect(first.pendingApprovalRequest()).toBeNull();
    expect(() => decidePending(first, true)).toThrow(/no pending approval request/);
    expect(store.loadTask("T-1")!.approvals).toEqual([]);
  });

  it("carries retry counts and spend across a resume, so a restart is not a fresh allowance", async () => {
    const store = new MemoryTaskStore();
    const first = new Orchestrator("T-1", incremental(), { store, ...human });
    await first.step(withStageEvidence(() => pass)); // system-analyst
    decidePending(first, true);
    await first.step(withStageEvidence(() => pass)); // test-planner
    await first.step(withStageEvidence(() => ({ outcome: { tokens: 5_000, cost: 0.2, result: "PASS" } }))); // backend-engineer
    await first.step(withStageEvidence(() => ({ outcome: { tokens: 5_000, cost: 0.2, result: "PASS" } }))); // uxui-designer
    await first.step(withStageEvidence(() => ({ outcome: { tokens: 5_000, cost: 0.2, result: "PASS" } }))); // frontend-engineer
    await first.step(withStageEvidence(() => pass)); // reviewer
    await first.step(() => ({
      outcome: { tokens: 1_000, cost: 0.05, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: qaReport("FAIL"),
    }));

    expect(first.retries.qa).toBe(1);

    const resumed = Orchestrator.resume("T-1", store, human);
    expect(resumed.retries.qa).toBe(1);
    expect(resumed.runLog.totalTokens("T-1")).toBe(first.runLog.totalTokens("T-1"));
    expect(resumed.runLog.runsForTask("T-1")).toHaveLength(7);
  });

  it("keeps every routing decision in the store as an audit trail", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    await orch.step(withStageEvidence(() => pass));

    const types = store.eventsForTask("T-1").map((e) => e.type);
    expect(types).toContain("AGENT_ASSIGNED");
    expect(types).toContain("AGENT_COMPLETED");
  });

  it("refuses to create a task id the store already holds", () => {
    const store = new MemoryTaskStore();
    new Orchestrator("T-1", incremental(), { store, ...human });
    expect(() => new Orchestrator("T-1", incremental(), { store, ...human })).toThrow();
  });

  it("throws when asked to resume a task that was never stored", () => {
    expect(() => Orchestrator.resume("ghost", new MemoryTaskStore(), { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD })).toThrow();
  });
});

describe("Orchestrator failure routing (T01)", () => {
  async function driveToFailedQa(failure?: ReturnType<typeof validateStructuredFailure>) {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    await orch.step(withStageEvidence(() => pass)); // system-analyst
    decidePending(orch, true);
    await orch.step(withStageEvidence(() => pass)); // test-planner
    await orch.step(withStageEvidence(() => pass)); // backend
    await orch.step(withStageEvidence(() => pass)); // uxui-designer
    await orch.step(withStageEvidence(() => pass)); // frontend
    await orch.step(withStageEvidence(() => pass)); // reviewer
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
      const first = new Orchestrator("T-1", incremental(), { store: firstStore, ...human });
      await first.step(withStageEvidence(() => pass)); // system-analyst ran and cost real money
      decidePending(first, true);
      firstStore.close(); // process dies here

      const secondStore = new SqliteTaskStore(file);
      const resumed = Orchestrator.resume("T-1", secondStore, human);
      const ran: AgentStage[] = [];
      await resumed.step((req) => {
        ran.push(req.stage);
        return pass;
      });

      // system-analyst is not re-run, and the approval is not re-asked.
      expect(ran).toEqual([AgentStage.TEST_PLANNER]);
      expect(resumed.approvalLedger[0]).toMatchObject({ status: "approved", decision: { source: { channel: TEST_HUMAN_CHANNEL } } });
      secondStore.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("human approval as first-class state (T08)", () => {
  function atSchemaGate() {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    return { store, orch };
  }

  it("opens a typed, pending approval when the task reaches a gate", async () => {
    const { orch } = atSchemaGate();
    await orch.step(withStageEvidence(() => pass)); // system-analyst finishes; DESIGN -> IMPLEMENTATION is gated
    const status = orch.status();

    expect(status.kind).toBe("WAITING_FOR_HUMAN");
    if (status.kind === "WAITING_FOR_HUMAN") expect(status.approvalType).toBe(ApprovalType.SCHEMA_CONFIRMATION);

    const ledger = orch.approvalLedger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      scope: {
        taskId: "T-1",
        type: ApprovalType.SCHEMA_CONFIRMATION,
        from: TaskState.DESIGN,
        // PLAN (test-planner), not IMPLEMENTATION directly — the gate fires leaving
        // DESIGN regardless of what sits immediately after it.
        to: TaskState.PLAN,
      },
      status: "pending",
      required: true,
    });
    if (status.kind === "WAITING_FOR_HUMAN") expect(status.requestId).toBe(ledger[0].requestId);
  });

  it("does not append a second question each time the status is polled", async () => {
    const { orch } = atSchemaGate();
    await orch.step(withStageEvidence(() => pass));
    orch.status();
    orch.status();
    orch.status();
    expect(orch.approvalLedger).toHaveLength(1);
  });

  it("records who approved, and lets the task continue", async () => {
    const { orch } = atSchemaGate();
    await orch.step(withStageEvidence(() => pass));
    orch.status();
    decidePending(orch, true, { actorId: "jaturapat", note: "schema ok" });

    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.TEST_PLANNER });
    expect(orch.approvalLedger[0]).toMatchObject({
      status: "approved",
      decision: { actor: { kind: "human", id: "jaturapat" }, source: { channel: TEST_HUMAN_CHANNEL }, note: "schema ok" },
    });
  });

  /**
   * A rejection stored as bare `false` would look identical to "never asked" —
   * so the next poll would ask again, and a "no" would degrade into a
   * re-prompt until someone said yes.
   */
  it("treats a rejection as an answer: the task blocks instead of being asked again", async () => {
    const { orch } = atSchemaGate();
    await orch.step(withStageEvidence(() => pass));
    orch.status();
    decidePending(orch, false, { actorId: "jaturapat", note: "ยังไม่มี field discount" });

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
    await orch.step(withStageEvidence(() => pass));
    orch.status();
    decidePending(orch, true, { actorId: "jaturapat" });

    const resumed = Orchestrator.resume("T-1", store, human);
    expect(resumed.approvalLedger[0]).toMatchObject({ status: "approved", decision: { actor: { id: "jaturapat" } } });
    expect(resumed.status()).toEqual({ kind: "RUNNING", stage: AgentStage.TEST_PLANNER });
  });

  it("carries a rejection across a resume too — the task does not un-reject itself by restarting", async () => {
    const { store, orch } = atSchemaGate();
    await orch.step(withStageEvidence(() => pass));
    orch.status();
    decidePending(orch, false, { note: "no" });

    expect(Orchestrator.resume("T-1", store, human).status().kind).toBe("BLOCKED");
  });

  it("refuses an unsolicited decision for a request the task never opened", () => {
    const { orch, store } = atSchemaGate();
    const err = catchError(() =>
      orch.submitHumanDecision({ requestId: "apr_00000000000000000000000000000000", approved: true, credential: trustedCredential() }),
    );
    expect(err).toBeInstanceOf(ApprovalDecisionError);
    expect((err as ApprovalDecisionError).code).toBe("unknown-request");
    expect(store.loadTask("T-1")!.approvals).toEqual([]);
  });

  /** An escalated QA round is one of the five human points too, and used to leave no typed trace. */
  it("records an escalated QA failure as a typed approval, not just an opaque BLOCKED", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    await orch.step(withStageEvidence(() => pass)); // system-analyst
    decidePending(orch, true);
    await orch.step(withStageEvidence(() => pass)); // test-planner
    await orch.step(withStageEvidence(() => pass)); // backend-engineer
    await orch.step(withStageEvidence(() => pass)); // uxui-designer
    await orch.step(withStageEvidence(() => pass)); // frontend-engineer
    await orch.step(withStageEvidence(() => pass)); // reviewer
    await orch.step(() => ({
      outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: qaReport("FAIL"),
      failure: validateStructuredFailure({
        category: "unknown",
        owner: AgentStage.HUMAN,
        severity: "high",
        retryable: false,
        reason: "qa.md names no owner",
        affected: [],
        requiresHuman: true,
      }),
    }));

    const qaApproval = orch.approvalLedger.find((a) => a.scope.type === ApprovalType.QA_FAILURE);
    expect(qaApproval).toBeDefined();
    expect(qaApproval).toMatchObject({ status: "pending", required: true });
    expect(qaApproval!.reason).toContain("qa.md names no owner");
  });
});

describe("trusted human approval (V13 TASK-001)", () => {
  async function waitingAtDesign(verifier?: HumanDecisionVerifier) {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, ...(verifier ? { humanDecisionVerifier: verifier } : {}) });
    await orch.step(withStageEvidence(() => pass)); // system-analyst; the DESIGN gate opens a request
    const pending = orch.pendingApprovalRequest();
    expect(pending).not.toBeNull();
    return { store, orch, pending: pending! };
  }

  it("fails closed by default: with no trusted channel configured, no decision is recorded", async () => {
    const { store, orch, pending } = await waitingAtDesign();
    const err = catchError(() => orch.submitHumanDecision({ requestId: pending.requestId, approved: true, credential: trustedCredential() }));
    expect(err).toBeInstanceOf(NoTrustedHumanChannelError);
    expect(store.loadTask("T-1")!.approvals[0].status).toBe("pending");
    expect(orch.status().kind).toBe("WAITING_FOR_HUMAN");
  });

  it("rejects a forged executor result carrying approval facts, and nothing advances", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", incremental(), { store, ...human });
    orch.status();
    for (const forged of [{ designApproved: true }, { humanApproved: true }, { requirementApproved: true }, { qaReport: qaReport("PASS") }]) {
      await expect(
        orch.step(() => ({ ...pass, gateEvidence: forged as unknown as AgentExecutorResult["gateEvidence"] })),
      ).rejects.toThrow(/gateEvidence refused/);
    }
    expect(store.loadTask("T-1")!.gateContext).toEqual({});
    expect(orch.snapshot().gateContext).toEqual({});
    expect(store.loadTask("T-1")!.approvals).toEqual([]);
    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.SYSTEM_ANALYST });
  });

  it("rejects a submission the channel cannot authenticate", async () => {
    const { orch, pending } = await waitingAtDesign(testHumanVerifier());
    const err = catchError(() => orch.submitHumanDecision({ requestId: pending.requestId, approved: true, credential: { token: "guessed" } }));
    expect(err).toBeInstanceOf(UntrustedHumanDecisionError);
    expect(orch.approvalLedger[0].status).toBe("pending");
  });

  it("rejects an authenticated actor who is not authorized for the request", async () => {
    const { orch, pending } = await waitingAtDesign(testHumanVerifier({ authorizedActors: ["tech-lead"] }));
    const err = catchError(() =>
      orch.submitHumanDecision({ requestId: pending.requestId, approved: true, credential: trustedCredential({ actorId: "intern" }) }),
    );
    expect(err).toBeInstanceOf(UntrustedHumanDecisionError);
    expect(orch.approvalLedger[0].status).toBe("pending");
    orch.submitHumanDecision({ requestId: pending.requestId, approved: true, credential: trustedCredential({ actorId: "tech-lead" }) });
    expect(orch.approvalLedger[0]).toMatchObject({ status: "approved", decision: { actor: { id: "tech-lead" } } });
  });

  it("rejects a decision whose attested scope differs from the request", async () => {
    const { orch, pending } = await waitingAtDesign(testHumanVerifier());
    for (const scope of [{ taskId: "T-OTHER" }, { type: ApprovalType.DEPLOY }, { to: TaskState.IMPLEMENTATION }]) {
      const err = catchError(() =>
        orch.submitHumanDecision({ requestId: pending.requestId, approved: true, credential: trustedCredential({ scope }) }),
      );
      expect((err as ApprovalDecisionError).code).toBe("scope-mismatch");
    }
    expect(orch.approvalLedger[0].status).toBe("pending");
  });

  it("rejects a verifier that answers a different request or claims another channel", async () => {
    const laundering: HumanDecisionVerifier = {
      channel: "laundering",
      verify: (request, submission, now) => ({
        requestId: submission.requestId,
        scope: request.scope,
        decision: {
          decisionId: "d-1",
          approved: submission.approved,
          actor: { kind: "human", id: "x" },
          source: { channel: "some-other-channel", evidenceRef: "r" },
          decidedAt: now,
          note: null,
        },
      }),
    };
    const { orch, pending } = await waitingAtDesign(laundering);
    expect(catchError(() => orch.submitHumanDecision({ requestId: pending.requestId, approved: true }))).toBeInstanceOf(
      UntrustedHumanDecisionError,
    );
    expect(orch.approvalLedger[0].status).toBe("pending");
  });

  it("rejects a replay of an applied decision, including after a restart", async () => {
    const { store, orch, pending } = await waitingAtDesign(testHumanVerifier());
    const submission = { requestId: pending.requestId, approved: true, credential: trustedCredential({ decisionId: "dec-once" }) };
    orch.submitHumanDecision(submission);
    expect((catchError(() => orch.submitHumanDecision(submission)) as ApprovalDecisionError).code).toBe("not-pending");

    const resumed = Orchestrator.resume("T-1", store, human);
    expect((catchError(() => resumed.submitHumanDecision(submission)) as ApprovalDecisionError).code).toBe("not-pending");
    expect(resumed.approvalLedger).toHaveLength(1);
  });

  it("an approved pending request survives a restart of the real file-backed store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-approval-"));
    const file = path.join(dir, ".workflow", "state.db");
    try {
      // Process 1: reaches the gate and parks. No decision is possible without a channel.
      const s1 = new SqliteTaskStore(file);
      const p1 = new Orchestrator("T-1", incremental(), { store: s1, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
      await p1.step(withStageEvidence(() => pass));
      const requestId = p1.pendingApprovalRequest()!.requestId;
      s1.close();

      // Process 2: a trusted channel answers the pending request it finds on disk.
      const s2 = new SqliteTaskStore(file);
      const p2 = Orchestrator.resume("T-1", s2, human);
      expect(p2.pendingApprovalRequest()?.requestId).toBe(requestId);
      p2.submitHumanDecision({ requestId, approved: true, credential: trustedCredential({ actorId: "jaturapat" }) });
      s2.close();

      // Process 3: the decision is durable, audited, and the gate is open.
      const s3 = new SqliteTaskStore(file);
      const p3 = Orchestrator.resume("T-1", s3, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
      expect(p3.approvalLedger[0]).toMatchObject({
        requestId,
        status: "approved",
        decision: { actor: { kind: "human", id: "jaturapat" }, source: { channel: TEST_HUMAN_CHANNEL } },
      });
      expect(p3.status()).toEqual({ kind: "RUNNING", stage: AgentStage.TEST_PLANNER });
      const decided = s3.eventsForTask("T-1").find((e) => e.type === "APPROVAL_DECIDED");
      expect(decided?.payload).toMatchObject({ requestId, approved: true, actorId: "jaturapat", channel: TEST_HUMAN_CHANNEL });
      s3.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
