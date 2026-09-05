import { AgentStage } from "../types.js";
import type { ApprovalRecord, ApprovalType } from "../gates/approval.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import type { RecoveryAction } from "../retry/recoveryPolicy.js";

/**
 * The domain half of the event vocabulary — distinct from the lifecycle events
 * (AGENT_ASSIGNED / AGENT_COMPLETED / WAITING_FOR_HUMAN / TASK_BLOCKED /
 * TASK_DEPLOYED) that `orchestrator.ts` emits for stage transitions.
 *
 * A listener that wants "did QA pass?" would otherwise have to receive
 * AGENT_COMPLETED, check `stage === qa-engineer`, then read `outcome.result` —
 * reconstructing a fact the orchestrator already knew. The domain events also
 * carry facts the lifecycle events can't express at all: the classified
 * failure and routing decision on a failed round (QA_FAILED/SECURITY_FAILED),
 * which round passed (QA_PASSED/SECURITY_PASSED, for first-pass-rate tracking),
 * the actual ApprovalRecord rather than a generic "waiting" signal
 * (APPROVAL_REQUIRED, fired once per question, not on every status poll), the
 * human's answer (APPROVAL_DECIDED), and what reaching DEPLOYED cost in
 * stages/runs/tokens/time (DEPLOY_COMPLETED, alongside the bare TASK_DEPLOYED
 * transition).
 *
 * The two sets are kept separate rather than merged/renamed because
 * `benchmark.ts` already listens on AGENT_COMPLETED and every event is
 * persisted (`store.appendEvent`) — renaming would break a live listener and
 * make stored history from past runs unreadable.
 */

/** Domain event names, as values — for a switch, a queue's routing key, or an audit filter. */
export enum DomainEventType {
  QA_PASSED = "QA_PASSED",
  QA_FAILED = "QA_FAILED",
  SECURITY_PASSED = "SECURITY_PASSED",
  SECURITY_FAILED = "SECURITY_FAILED",
  APPROVAL_REQUIRED = "APPROVAL_REQUIRED",
  APPROVAL_DECIDED = "APPROVAL_DECIDED",
  DEPLOY_COMPLETED = "DEPLOY_COMPLETED",
}

/** A verification round that came back clean. */
export interface VerdictPassedEvent {
  taskId: string;
  stage: AgentStage;
  /**
   * How many failed rounds of this kind preceded it. 0 means first-pass —
   * used for quality score calculations.
   */
  round: number;
}

/** A verification round that came back dirty, with both halves of the answer. */
export interface VerdictFailedEvent extends VerdictPassedEvent {
  /** What broke, as classified. Null when the reporting stage supplied none. */
  failure: StructuredFailure | null;
  /** What the orchestrator decided to do about it — RETRY / RECOVER / ROLLBACK / ESCALATE / ABORT. */
  recovery: RecoveryAction | null;
}

export interface ApprovalRequiredEvent {
  taskId: string;
  approval: ApprovalRecord;
}

export interface ApprovalDecidedEvent {
  taskId: string;
  type: ApprovalType;
  approved: boolean;
  /** Free text, or null when the caller didn't say — this pipeline has no identity system (see approval.ts). */
  by: string | null;
}

/** What reaching DEPLOYED actually cost. Read off the run log, not recomputed by the listener. */
export interface DeployCompletedEvent {
  taskId: string;
  /** Every stage that ran, in the order it first ran. A stage that ran twice appears once. */
  stages: AgentStage[];
  /** Individual agent runs, including retry rounds — so `runs > stages.length` means work was redone. */
  runs: number;
  totalTokens: number;
  totalCost: number;
  /** First run's start to last run's end. Wall time including any gap a human gate introduced. */
  durationMs: number;
}

export interface DomainEventMap {
  QA_PASSED: VerdictPassedEvent;
  QA_FAILED: VerdictFailedEvent;
  SECURITY_PASSED: VerdictPassedEvent;
  SECURITY_FAILED: VerdictFailedEvent;
  APPROVAL_REQUIRED: ApprovalRequiredEvent;
  APPROVAL_DECIDED: ApprovalDecidedEvent;
  DEPLOY_COMPLETED: DeployCompletedEvent;
}

export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = Object.values(DomainEventType);

export function isDomainEventType(type: string): type is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Which verdict event a verification stage's outcome is. Returns null for a
 * stage that verifies nothing (e.g. an engineer finishing) — inventing a
 * verdict for it would make "passed" mean two different things depending on
 * who emitted it.
 */
export function verdictEventFor(
  stage: AgentStage,
  passed: boolean,
): keyof DomainEventMap | null {
  if (stage === AgentStage.QA_ENGINEER) return passed ? "QA_PASSED" : "QA_FAILED";
  if (stage === AgentStage.SECURITY) return passed ? "SECURITY_PASSED" : "SECURITY_FAILED";
  return null;
}
