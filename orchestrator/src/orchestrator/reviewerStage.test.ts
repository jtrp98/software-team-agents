import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "./orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskState } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { ApprovalType } from "../gates/approval.js";
import { checkGate } from "../gates/gatePolicy.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import {
  PASSING_VERIFICATION,
  failingReviewReport,
  passingQaReport,
  passingReviewReport,
  reviewerContractDigest,
  withRequiredEvidence,
} from "../evidence/stageEvidence.testSupport.js";
import { decideStageCompletion } from "./transitionGuard.js";
import type { EvidenceRecord } from "../evidence/evidenceStore.js";
import { canTransition, forwardState, initTaskMachine, nextStates, transition } from "../state/taskState.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";

/**
 * V13 TASK-006 — the reviewer stage completes only on a verified reviewer
 * artifact plus STA's own independence evidence; nothing else — an engineer's
 * or QA's claim, a review.md on disk, a CLI shortcut — moves a task out of
 * REVIEW.
 */

const human = { humanDecisionVerifier: testHumanVerifier(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };
/** backend-engineer -> reviewer -> qa-engineer. */
const bugfix = () => classifyTask({ isClearBugFix: true, touchesBackend: true });
const PASS = { tokens: 10, cost: 0.001, result: "PASS" as const };
const FAIL = { tokens: 10, cost: 0.001, result: "FAIL" as const };
const engineer: AgentExecutor = () => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION, packetPath: ".workflow/packets/T/backend-engineer-1.json" });
const reviewPass: AgentExecutor = (req) => withRequiredEvidence(req, { outcome: PASS, packetPath: ".workflow/packets/T/reviewer-1.json" });

function kinds(records: readonly EvidenceRecord[]): string[] {
  return records.map((r) => `${r.stage}#${r.attempt}:${r.kind}`);
}

function tmpDb(): string {
  return path.join(os.tmpdir(), `sta-reviewer-${Date.now()}-${Math.random().toString(36).slice(2)}`, "state.db");
}

function cleanup(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* Windows may hold the WAL briefly */
  }
}

async function atReview(taskId: string, store: TaskStore = new MemoryTaskStore()) {
  const orch = new Orchestrator(taskId, bugfix(), { ...human, store });
  expect(await orch.step(engineer)).toEqual({ kind: "RUNNING", stage: AgentStage.REVIEWER });
  expect(orch.machine.current).toBe(TaskState.REVIEW);
  return { orch, store };
}

describe("the REVIEW state (V13 TASK-006)", () => {
  it("sits between IMPLEMENTATION and QA, with its own failure loop back to IMPLEMENTATION", () => {
    const machine = initTaskMachine(bugfix().pipeline, false);
    expect(machine.sequence).toEqual([
      TaskState.CREATED,
      TaskState.IMPLEMENTATION,
      TaskState.REVIEW,
      TaskState.QA,
      TaskState.READY_TO_DEPLOY,
      TaskState.DEPLOYED,
    ]);
    const review = transition(transition(machine, TaskState.IMPLEMENTATION), TaskState.REVIEW);
    expect(nextStates(review)).toEqual([TaskState.QA, TaskState.REVIEW_FAILED]);
    expect(forwardState(review)).toBe(TaskState.QA);
    const failed = transition(review, TaskState.REVIEW_FAILED);
    expect(nextStates(failed)).toEqual([TaskState.IMPLEMENTATION, TaskState.BLOCKED]);
    expect(canTransition(failed, TaskState.QA)).toBe(false);
  });

  it("the REVIEW -> QA gate requires a PASS review report", () => {
    expect(checkGate(TaskState.REVIEW, TaskState.QA, {}).allowed).toBe(false);
    expect(checkGate(TaskState.REVIEW, TaskState.QA, { reviewReport: failingReviewReport("T") }).allowed).toBe(false);
    expect(checkGate(TaskState.REVIEW, TaskState.QA, { reviewReport: passingReviewReport("T") }).allowed).toBe(true);
    // The failure edge is never gated on a PASS.
    expect(checkGate(TaskState.REVIEW, TaskState.REVIEW_FAILED, {}).allowed).toBe(true);
  });
});

describe("a forged review is refused (V13 TASK-006)", () => {
  it("an engineer result carrying a review report throws, and the attempt leaves no run, evidence or state behind", () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-FORGE-DEV", bugfix(), { ...human, store });
    orch.status();
    const rowBefore = store.loadTask("T-FORGE-DEV");
    const eventsBefore = store.eventsForTask("T-FORGE-DEV").length;
    expect(() =>
      orch.reportCompletion(
        AgentStage.BACKEND_ENGINEER,
        {
          outcome: PASS,
          deterministicVerification: PASSING_VERIFICATION,
          artifactType: ArtifactType.REVIEW_REPORT,
          artifact: passingReviewReport("T-FORGE-DEV"),
        },
        { start: 0, end: 1 },
      ),
    ).toThrow(/backend-engineer is not registered \(item 9\) to produce review-report/);
    expect(store.runsForTask("T-FORGE-DEV")).toEqual([]);
    expect(store.evidenceForTask("T-FORGE-DEV")).toEqual([]);
    expect(store.eventsForTask("T-FORGE-DEV")).toHaveLength(eventsBefore);
    expect(store.loadTask("T-FORGE-DEV")).toEqual(rowBefore);
  });

  it("a QA result carrying a review report throws at QA, and leaves no trace", async () => {
    const { orch, store } = await atReview("T-FORGE-QA");
    await orch.step(reviewPass);
    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
    const evidenceBefore = store.evidenceForTask("T-FORGE-QA");
    const runsBefore = store.runsForTask("T-FORGE-QA").length;
    const rowBefore = store.loadTask("T-FORGE-QA");
    expect(() =>
      orch.reportCompletion(
        AgentStage.QA_ENGINEER,
        { outcome: PASS, artifactType: ArtifactType.REVIEW_REPORT, artifact: passingReviewReport("T-FORGE-QA") },
        { start: 0, end: 1 },
      ),
    ).toThrow(/qa-engineer is not registered \(item 9\) to produce review-report/);
    expect(store.evidenceForTask("T-FORGE-QA")).toEqual(evidenceBefore);
    expect(store.runsForTask("T-FORGE-QA")).toHaveLength(runsBefore);
    expect(store.loadTask("T-FORGE-QA")).toEqual(rowBefore);
  });

  it("a review.md on disk with no reviewer dispatch never completes REVIEW, and a cursor pushed past it is refused", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-review-disk-"));
    try {
      const moduleDir = path.join(root, "_docs", "module", "orders");
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(
        path.join(moduleDir, "review.md"),
        "# review.md — orders\n\n## Open Findings — all phases\n\n## Review Round 1 — T-DISK\n**Verdict:** ✅ Approved\n\n## Reviewed\n- src/orders.ts\n",
      );
      const { orch, store } = await atReview("T-DISK");
      // Polling never reads the document into a verdict: the reviewer never ran.
      for (let i = 0; i < 3; i++) expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.REVIEWER });
      const records = store.evidenceForTask("T-DISK");
      expect(records.some((r) => r.stage === AgentStage.REVIEWER)).toBe(false);
      expect(decideStageCompletion(AgentStage.REVIEWER, 1, records).complete).toBe(false);
      expect(store.loadTask("T-DISK")!.gateContext.reviewReport).toBeUndefined();

      // Moving the cursor past the reviewer by hand cannot leave REVIEW either.
      const row = store.loadTask("T-DISK")!;
      store.saveTask({ ...row, pipelineCursor: row.pipelineCursor + 1 });
      const gated = Orchestrator.resume("T-DISK", store, human).status();
      expect(gated).toMatchObject({ kind: "WAITING_FOR_HUMAN", from: TaskState.REVIEW, to: TaskState.QA });
      if (gated.kind === "WAITING_FOR_HUMAN") expect(gated.reason).toMatch(/REVIEW_PASS required/);

      // Even with a PASS report forged into the gate context, the evidence half refuses the edge.
      const forged = store.loadTask("T-DISK")!;
      store.saveTask({ ...forged, gateContext: { ...forged.gateContext, reviewReport: passingReviewReport("T-DISK") } });
      const refused = Orchestrator.resume("T-DISK", store, human).status();
      expect(refused.kind).toBe("BLOCKED");
      if (refused.kind === "BLOCKED") expect(refused.reason).toMatch(/REVIEW -> QA refused: reviewer has no recorded completion \(never ran\)/);
      expect(store.loadTask("T-DISK")!.machine.current).not.toBe(TaskState.QA);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reviewer independence is STA's own evidence (V13 TASK-006)", () => {
  it("a reviewer run from the engineer's packet is not a distinct dispatch: STAGE_INCOMPLETE names the check, no advance", async () => {
    const { orch, store } = await atReview("T-SAMEPACKET");
    const after = await orch.step((req) =>
      withRequiredEvidence(req, { outcome: PASS, packetPath: ".workflow/packets/T/backend-engineer-1.json" }),
    );
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.REVIEWER });
    expect(orch.machine.current).toBe(TaskState.REVIEW);
    const incomplete = store.eventsForTask("T-SAMEPACKET").filter((e) => e.type === "STAGE_INCOMPLETE");
    const missing = (incomplete[incomplete.length - 1]!.payload as { missing: string[] }).missing;
    expect(missing).toContain("reviewer attempt 1: review-independent");
    expect(missing.some((m) => /check distinct-dispatch failed — the reviewer used the same packet as backend-engineer attempt 1/.test(m))).toBe(true);
    expect(store.evidenceForTask("T-SAMEPACKET").some((r) => r.kind === "review-independence")).toBe(false);
    expect(store.evidenceForTask("T-SAMEPACKET").some((r) => r.stage === AgentStage.REVIEWER && r.kind === "stage-completion")).toBe(false);
  });

  it("a reviewer run with no dispatch contract digest is refused as not contract-bound", async () => {
    const { orch, store } = await atReview("T-NODIGEST");
    await orch.step((req) => ({ outcome: PASS, artifactType: ArtifactType.REVIEW_REPORT, artifact: passingReviewReport(req.taskId) }));
    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.REVIEWER });
    expect(orch.stageDecision?.decision).toMatchObject({ complete: false });
    const decision = orch.stageDecision!.decision;
    if (decision.complete) throw new Error("unreachable");
    expect(decision.missing.some((m) => /check contract-bound failed/.test(m))).toBe(true);
    expect(store.evidenceForTask("T-NODIGEST").some((r) => r.kind === "review-independence")).toBe(false);
  });

  it("a review of an implementation with no recorded completion is refused, naming the stage", async () => {
    const { store } = await atReview("T-NOIMPL");
    // The same task row at REVIEW, but the engineer's stage-completion record is gone.
    const forged = new MemoryTaskStore();
    forged.createTask(store.loadTask("T-NOIMPL")!);
    for (const record of store.evidenceForTask("T-NOIMPL")) {
      if (!(record.stage === AgentStage.BACKEND_ENGINEER && record.kind === "stage-completion")) forged.appendEvidence(record);
    }
    const resumed = Orchestrator.resume("T-NOIMPL", forged, human);
    const after = await resumed.step(reviewPass);
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.REVIEWER });
    const decision = resumed.stageDecision!.decision;
    if (decision.complete) throw new Error("expected an incomplete review");
    expect(decision.missing).toContain(
      "reviewer attempt 1: independence check implementation-completed failed — backend-engineer has no recorded completion for attempt 1",
    );
    expect(forged.evidenceForTask("T-NOIMPL").some((r) => r.kind === "review-independence")).toBe(false);
  });
});

describe("a verified review (V13 TASK-006)", () => {
  it("records role-run, review-report artifact, review-independence and stage-completion, advances to QA, and survives a restart", async () => {
    const file = tmpDb();
    try {
      const store1 = new SqliteTaskStore(file);
      const { orch } = await atReview("T-VALID", store1);
      const heard: string[] = [];
      orch.events.on("REVIEW_PASSED", () => heard.push("REVIEW_PASSED"));
      const after = await orch.step(reviewPass);
      expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
      expect(heard).toEqual(["REVIEW_PASSED"]);

      const records = store1.evidenceForTask("T-VALID");
      expect(kinds(records).filter((k) => k.startsWith("reviewer"))).toEqual([
        "reviewer#1:role-run",
        "reviewer#1:artifact",
        "reviewer#1:review-independence",
        "reviewer#1:stage-completion",
      ]);
      const artifact = records.find((r) => r.stage === AgentStage.REVIEWER && r.kind === "artifact")!;
      expect(artifact.payload).toMatchObject({ artifactType: ArtifactType.REVIEW_REPORT, verdict: "PASS" });
      const independence = records.find((r) => r.kind === "review-independence")!;
      const engineerCompletion = records.find((r) => r.stage === AgentStage.BACKEND_ENGINEER && r.kind === "stage-completion")!;
      const reviewerRun = records.find((r) => r.stage === AgentStage.REVIEWER && r.kind === "role-run")!;
      expect(independence.role).toBe("orchestrator");
      expect(independence.payload).toEqual({
        kind: "review-independence",
        reviewedStages: [AgentStage.BACKEND_ENGINEER],
        implementationCompletionIds: [engineerCompletion.evidenceId],
        reviewerContractDigest: reviewerContractDigest(),
        checks: ["implementation-completed", "contract-bound", "distinct-dispatch", "review-separation"],
      });
      expect(independence.refs).toEqual([engineerCompletion.evidenceId, reviewerRun.evidenceId].sort());
      const completion = records.find((r) => r.stage === AgentStage.REVIEWER && r.kind === "stage-completion")!;
      expect(completion.payload).toEqual({
        kind: "stage-completion",
        satisfied: ["role-run-succeeded", "review-report-pass", "review-independent"],
      });
      expect(store1.loadTask("T-VALID")!.gateContext.reviewReport?.verdict).toBe("PASS");
      store1.close();

      // A fresh process reaches the same decision from the file alone.
      const store2 = new SqliteTaskStore(file);
      const resumed = Orchestrator.resume("T-VALID", store2, human);
      expect(resumed.status()).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
      expect(decideStageCompletion(AgentStage.REVIEWER, 1, store2.evidenceForTask("T-VALID"))).toEqual({
        complete: true,
        satisfied: ["role-run-succeeded", "review-report-pass", "review-independent"],
        evidenceIds: expect.any(Array),
      });
      // ...and the whole task can finish, its Done referencing the review.
      const done = await resumed.step(() => ({ outcome: PASS, artifactType: ArtifactType.QA_REPORT, artifact: passingQaReport("T-VALID") }));
      expect(done).toEqual({ kind: "DEPLOYED" });
      const doneRecord = store2.loadEvidence(store2.loadTask("T-VALID")!.completionEvidenceId!)!;
      expect(doneRecord.refs).toContain(completion.evidenceId);
      store2.close();
    } finally {
      cleanup(file);
    }
  });

  it("a reviewer FAIL goes REVIEW_FAILED -> back to the owning engineer, spends retries.review, and emits REVIEW_FAILED", async () => {
    const { orch, store } = await atReview("T-REVFAIL");
    const failed: unknown[] = [];
    orch.events.on("REVIEW_FAILED", (e) => failed.push(e));
    const after = await orch.step((req) =>
      withRequiredEvidence(req, {
        outcome: FAIL,
        artifactType: ArtifactType.REVIEW_REPORT,
        artifact: failingReviewReport(req.taskId, AgentStage.BACKEND_ENGINEER),
        failure: {
          category: "implementation",
          owner: AgentStage.BACKEND_ENGINEER,
          severity: "high",
          retryable: true,
          reason: "RV-1 at src/index.ts:1: does not do what the design says",
          affected: ["RV-1"],
          requiresHuman: false,
        },
      } as AgentExecutorResult),
    );
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(orch.retries).toEqual({ review: 1, qa: 0, security: 0 });
    expect(orch.machine.history).toEqual([TaskState.CREATED, TaskState.IMPLEMENTATION, TaskState.REVIEW, TaskState.REVIEW_FAILED, TaskState.IMPLEMENTATION]);
    expect(orch.recovery).toMatchObject({ kind: "RETRY", stage: AgentStage.BACKEND_ENGINEER });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ stage: AgentStage.REVIEWER, round: 1, failure: { owner: AgentStage.BACKEND_ENGINEER } });
    expect(store.evidenceForTask("T-REVFAIL").some((r) => r.stage === AgentStage.REVIEWER && r.kind === "stage-completion")).toBe(false);
    expect(store.loadTask("T-REVFAIL")!.retries.review).toBe(1);

    // The fix, then a clean re-review, and the task moves on to QA.
    await orch.step(engineer);
    expect(await orch.step((req) => withRequiredEvidence(req, { outcome: PASS, packetPath: ".workflow/packets/T/reviewer-2.json" }))).toEqual({
      kind: "RUNNING",
      stage: AgentStage.QA_ENGINEER,
    });
  });

  it("a reviewer FAIL no automatic route may answer escalates as a typed review-failure approval", async () => {
    const { orch } = await atReview("T-REVESC");
    const after = await orch.step(() => ({
      outcome: { ...FAIL, failure_reason: "review.md unreadable" },
      failure: {
        category: "unknown",
        owner: AgentStage.HUMAN,
        severity: "high",
        retryable: false,
        reason: "review.md cannot be read as a review verdict",
        affected: [],
        requiresHuman: true,
      },
    }));
    expect(after.kind).toBe("BLOCKED");
    const approval = orch.approvalLedger.find((a) => a.scope.type === ApprovalType.REVIEW_FAILURE);
    expect(approval).toMatchObject({ status: "pending", required: true });
    expect(approval!.reason).toContain("review.md cannot be read as a review verdict");
    expect(orch.retries.review).toBe(1);
  });
});
