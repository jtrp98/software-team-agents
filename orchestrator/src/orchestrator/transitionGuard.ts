import { AgentStage, TaskState } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import type { ApprovalLedger } from "../gates/approval.js";
import type { EvidenceRecord, EvidenceStore } from "../evidence/evidenceStore.js";
import type { PersistedTask } from "../store/taskStore.js";
import { stageStateOf } from "./taskStatus.js";

/**
 * The one table of what a stage attempt must prove before STA counts it done
 * (V13 TASK-003). Every requirement is checked against persisted evidence of
 * that exact attempt — never against the executor's result object and never
 * against an agent's claim.
 *
 * Document stages require only a successful role run here: verifying the
 * document bytes they wrote against schema/traceability is TASK-018, which
 * adds its requirement to this table rather than a second decision path.
 */
export const EVIDENCE_REQUIREMENTS = [
  "role-run-succeeded",
  "deterministic-verification-passed",
  "review-report-pass",
  "review-independent",
  "qa-report-pass",
  "security-report-pass",
] as const;
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number];

export const STAGE_EVIDENCE_REQUIREMENTS: Readonly<Record<AgentStage, readonly EvidenceRequirement[]>> = {
  [AgentStage.SETUP]: ["role-run-succeeded"],
  [AgentStage.BUSINESS_ANALYST]: ["role-run-succeeded"],
  [AgentStage.SYSTEM_ANALYST]: ["role-run-succeeded"],
  [AgentStage.PROJECT_MANAGER]: ["role-run-succeeded"],
  [AgentStage.TEST_PLANNER]: ["role-run-succeeded"],
  [AgentStage.UXUI_DESIGNER]: ["role-run-succeeded"],
  [AgentStage.BACKEND_ENGINEER]: ["role-run-succeeded", "deterministic-verification-passed"],
  [AgentStage.FRONTEND_ENGINEER]: ["role-run-succeeded", "deterministic-verification-passed"],
  // The review verdict parsed from review.md, plus STA's own independence
  // record (`review-independence`) — the reviewer's report alone never
  // completes the stage.
  [AgentStage.REVIEWER]: ["role-run-succeeded", "review-report-pass", "review-independent"],
  [AgentStage.QA_ENGINEER]: ["role-run-succeeded", "qa-report-pass"],
  [AgentStage.SECURITY]: ["role-run-succeeded", "security-report-pass"],
  [AgentStage.DEVOPS]: ["role-run-succeeded"],
  // A person is not a role run; no evidence of this table completes it.
  [AgentStage.HUMAN]: [],
};

export type StageCompletionDecision =
  | { complete: true; satisfied: EvidenceRequirement[]; evidenceIds: string[] }
  | { complete: false; missing: string[]; evidenceIds: string[] };

function satisfies(requirement: EvidenceRequirement, record: EvidenceRecord): boolean {
  const payload = record.payload;
  switch (requirement) {
    case "role-run-succeeded":
      return payload.kind === "role-run" && payload.result === "PASS";
    case "deterministic-verification-passed":
      return payload.kind === "deterministic-verification" && payload.verification.passed;
    case "review-report-pass":
      return payload.kind === "artifact" && payload.artifactType === ArtifactType.REVIEW_REPORT && payload.verdict === "PASS";
    case "review-independent":
      // Only STA writes this kind, and only after its own checks held.
      return payload.kind === "review-independence" && record.role === "orchestrator";
    case "qa-report-pass":
      return payload.kind === "artifact" && payload.artifactType === ArtifactType.QA_REPORT && payload.verdict === "PASS";
    case "security-report-pass":
      return payload.kind === "artifact" && payload.artifactType === ArtifactType.SECURITY_REPORT && payload.verdict === "PASS";
  }
}

/**
 * Decides whether one attempt of `stage` is complete from the persisted records
 * of that attempt. Pure: the same records always give the same answer, so a
 * restarted process reaches the decision the original one did.
 */
export function decideStageCompletion(
  stage: AgentStage,
  attempt: number,
  records: readonly EvidenceRecord[],
): StageCompletionDecision {
  const requirements = STAGE_EVIDENCE_REQUIREMENTS[stage];
  const ofAttempt = records.filter((r) => r.stage === stage && r.attempt === attempt);
  if (requirements.length === 0) {
    return { complete: false, missing: [`${stage} is not completed by a role run`], evidenceIds: [] };
  }
  const evidenceIds: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const match = ofAttempt.find((r) => satisfies(requirement, r));
    if (match) evidenceIds.push(match.evidenceId);
    else missing.push(`${stage} attempt ${attempt}: ${requirement}`);
  }
  return missing.length === 0
    ? { complete: true, satisfied: [...requirements], evidenceIds }
    : { complete: false, missing, evidenceIds };
}

/** Highest recorded attempt of `stage`, 0 when it never ran. */
export function latestAttempt(records: readonly EvidenceRecord[], stage: AgentStage): number {
  let latest = 0;
  for (const r of records) if (r.kind === "role-run" && r.stage === stage && r.attempt > latest) latest = r.attempt;
  return latest;
}

export function completionRecordFor(
  records: readonly EvidenceRecord[],
  stage: AgentStage,
  attempt: number,
): EvidenceRecord | undefined {
  return records.find((r) => r.kind === "stage-completion" && r.stage === stage && r.attempt === attempt);
}

function deployPhaseOf(records: readonly EvidenceRecord[], stage: AgentStage, attempt: number): "prepare" | "execute" | null {
  const run = records.find((r) => r.kind === "role-run" && r.stage === stage && r.attempt === attempt);
  return run?.payload.kind === "role-run" ? run.payload.deployPhase : null;
}

/**
 * The stages whose completion must be recorded before the task may leave
 * `state`: every pipeline stage behind the cursor that runs in that state.
 * devops runs twice — "prepare" gates leaving READY_TO_DEPLOY, "execute"
 * gates leaving APPROVED — so its latest attempt must be of the matching phase.
 */
export function unmetStateExit(input: {
  state: TaskState;
  pipeline: readonly AgentStage[];
  cursor: number;
  records: readonly EvidenceRecord[];
}): string[] {
  const missing: string[] = [];
  input.pipeline.forEach((stage, index) => {
    if (stage === AgentStage.DEVOPS) {
      const phase = input.state === TaskState.READY_TO_DEPLOY ? "prepare" : input.state === TaskState.APPROVED ? "execute" : null;
      if (!phase) return;
      if (phase === "execute" && index >= input.cursor) return;
      const attempt = latestAttempt(input.records, stage);
      const completed = completionRecordFor(input.records, stage, attempt);
      if (deployPhaseOf(input.records, stage, attempt) !== phase || !completed) {
        missing.push(`${stage} (${phase}) has no recorded completion`);
      }
      return;
    }
    if (index >= input.cursor || stageStateOf(stage) !== input.state) return;
    const attempt = latestAttempt(input.records, stage);
    if (attempt === 0 || !completionRecordFor(input.records, stage, attempt)) {
      missing.push(`${stage} has no recorded completion${attempt === 0 ? " (never ran)" : ` for attempt ${attempt}`}`);
    }
  });
  return missing;
}

/**
 * The approval-decision evidence that must stand behind every approved
 * request. The ledger says a person answered; this record ties the answer into
 * the evidence chain that `Done` references.
 */
export function approvalEvidenceFor(
  approvals: ApprovalLedger,
  records: readonly EvidenceRecord[],
): { evidenceIds: string[]; missing: string[] } {
  const evidenceIds: string[] = [];
  const missing: string[] = [];
  for (const approval of approvals) {
    if (approval.status === "pending") missing.push(`${approval.scope.type} request ${approval.requestId} is still pending`);
    if (approval.status === "rejected") missing.push(`${approval.scope.type} request ${approval.requestId} was rejected`);
    if (approval.status !== "approved" || !approval.decision) continue;
    const decisionId = approval.decision.decisionId;
    const record = records.find(
      (r) =>
        r.payload.kind === "approval-decision" &&
        r.payload.requestId === approval.requestId &&
        r.payload.decisionId === decisionId &&
        r.payload.approved,
    );
    if (record) evidenceIds.push(record.evidenceId);
    else missing.push(`${approval.scope.type} request ${approval.requestId} has no approval-decision evidence`);
  }
  return { evidenceIds, missing };
}

export type TaskCompletionDecision =
  | { done: true; evidenceIds: string[] }
  | { done: false; missing: string[] };

/**
 * The single definition of Done: every pipeline stage's latest attempt has a
 * recorded completion (devops's latest being "execute" after a completed
 * "prepare"), and every approval the task asked for was answered yes by a
 * recorded, trusted decision. Returns the evidence ids that prove it.
 */
export function decideTaskCompletion(input: {
  pipeline: readonly AgentStage[];
  approvals: ApprovalLedger;
  records: readonly EvidenceRecord[];
}): TaskCompletionDecision {
  const evidenceIds: string[] = [];
  const missing: string[] = [];
  for (const stage of new Set(input.pipeline)) {
    if (stage === AgentStage.DEVOPS) {
      const attempt = latestAttempt(input.records, stage);
      const completed = completionRecordFor(input.records, stage, attempt);
      const prepared = input.records.some(
        (r) => r.kind === "stage-completion" && r.stage === stage && deployPhaseOf(input.records, stage, r.attempt) === "prepare",
      );
      if (deployPhaseOf(input.records, stage, attempt) !== "execute" || !completed) {
        missing.push(`${stage} (execute) has no recorded completion`);
      } else evidenceIds.push(completed.evidenceId);
      if (!prepared) missing.push(`${stage} (prepare) has no recorded completion`);
      continue;
    }
    if (stageStateOf(stage) === undefined) continue; // never assigned by the state machine
    const attempt = latestAttempt(input.records, stage);
    const completed = attempt === 0 ? undefined : completionRecordFor(input.records, stage, attempt);
    if (completed) evidenceIds.push(completed.evidenceId);
    else missing.push(`${stage} has no recorded completion`);
  }
  const approvals = approvalEvidenceFor(input.approvals, input.records);
  evidenceIds.push(...approvals.evidenceIds);
  missing.push(...approvals.missing);
  return missing.length === 0 ? { done: true, evidenceIds } : { done: false, missing };
}

export type CompletionVerification =
  | { done: true; completionEvidenceId: string; evidenceIds: string[] }
  | { done: false; reason: string };

/**
 * Re-verifies a task's Done against the store: the completion record exists,
 * belongs to the task, and every evidence id it references still loads (each
 * load re-derives the record's id and digest). What a dependent task and the
 * status query rely on — never the stored pointer alone.
 */
export function verifyTaskCompletion(
  store: EvidenceStore,
  task: Pick<PersistedTask, "taskId" | "machine" | "completionEvidenceId">,
): CompletionVerification {
  if (task.machine.current !== TaskState.DEPLOYED) return { done: false, reason: `state is ${task.machine.current}` };
  if (task.completionEvidenceId === null) return { done: false, reason: "DEPLOYED without a recorded completion decision" };
  try {
    const record = store.loadEvidence(task.completionEvidenceId);
    if (!record) return { done: false, reason: `completion evidence ${task.completionEvidenceId} does not exist` };
    if (record.taskId !== task.taskId || record.kind !== "task-completion") {
      return { done: false, reason: `completion evidence ${task.completionEvidenceId} is not this task's completion` };
    }
    for (const ref of record.refs) {
      const referenced = store.loadEvidence(ref);
      if (!referenced || referenced.taskId !== task.taskId) {
        return { done: false, reason: `completion references missing evidence ${ref}` };
      }
    }
    return { done: true, completionEvidenceId: record.evidenceId, evidenceIds: [...record.refs] };
  } catch (error) {
    return { done: false, reason: (error as Error).message };
  }
}
