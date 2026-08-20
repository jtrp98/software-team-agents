import { AgentStage } from "../types.js";
import type { ApprovalRecord, ApprovalType } from "../gates/approval.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import type { RecoveryAction } from "../retry/recoveryPolicy.js";

/**
 * The domain half of the event vocabulary (T36).
 *
 * WHY THESE ARE NOT THE FIVE EVENTS THAT ALREADY EXISTED
 *
 * `orchestrator.ts` has emitted AGENT_ASSIGNED / AGENT_COMPLETED /
 * WAITING_FOR_HUMAN / TASK_BLOCKED / TASK_DEPLOYED since T01. Those describe
 * the *lifecycle*: a stage started, a stage finished, the machine stopped.
 * They are deliberately generic, and that genericness is the gap T36 names.
 *
 * A listener that wants "did QA pass?" has to receive AGENT_COMPLETED, check
 * `stage === qa-engineer`, then read `outcome.result` — reconstructing a fact
 * the orchestrator already knew and threw away. Worse, the two things a
 * listener most needs after a failed round are not in that payload at all:
 * *what* the failure was (`StructuredFailure`, T06) and *what the orchestrator
 * decided to do about it* (`RecoveryAction`, T07). Those are computed inside
 * `reportCompletion` and, before this, existed only as a return value to
 * whoever happened to be awaiting the call.
 *
 * So these are not renames of the lifecycle events. Each one carries something
 * its lifecycle counterpart cannot express:
 *
 *   QA_FAILED / SECURITY_FAILED   the classified failure AND the routing decision
 *   QA_PASSED / SECURITY_PASSED   which round passed, so a listener can tell a
 *                                 first-pass from a third-round pass (T29/T30's
 *                                 first-pass rate is exactly that distinction)
 *   APPROVAL_REQUIRED             the ApprovalRecord itself — its type, the edge it
 *                                 guards, the words to show a person. WAITING_FOR_HUMAN
 *                                 fires for *any* unsatisfied gate, including ones with
 *                                 no approval type at all, and re-fires on status change;
 *                                 this fires exactly once, when a question is actually
 *                                 opened in the ledger
 *   APPROVAL_DECIDED              the answer. Nothing emitted an answer before, so an
 *                                 external listener could see every question this
 *                                 pipeline ever asked and never learn what was said back
 *   DEPLOY_COMPLETED              TASK_DEPLOYED says the machine reached DEPLOYED.
 *                                 This says what it cost to get there — stages, runs,
 *                                 tokens, money, wall time. Same moment, different fact:
 *                                 one is a transition, the other is the result
 *
 * WHY THE TWO SETS ARE NOT MERGED
 *
 * `benchmark.ts` already listens on AGENT_COMPLETED, and every event ever
 * emitted is persisted (`store.appendEvent`). Renaming an event would both
 * break a live listener and make the stored history of past runs unreadable
 * against the current vocabulary — the audit trail T37 builds on would start
 * with a discontinuity nothing records the reason for.
 */

/** T36's event names, as values — for a switch, a queue's routing key, or an audit filter. */
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
   * How many failed rounds of this kind preceded it. 0 means first-pass — the
   * number T30's quality score is built on, and one nothing else emits.
   */
  round: number;
}

/** A verification round that came back dirty, with both halves of the answer. */
export interface VerdictFailedEvent extends VerdictPassedEvent {
  /** What broke, as classified (T06). Null when the reporting stage supplied none. */
  failure: StructuredFailure | null;
  /** What the orchestrator decided to do about it (T07) — RETRY / RECOVER / ROLLBACK / ESCALATE / ABORT. */
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
 * Which verdict event a verification stage's outcome is.
 *
 * Returns null for a stage that verifies nothing — an engineer finishing is an
 * AGENT_COMPLETED and nothing more, and inventing a verdict for it would make
 * "passed" mean two different things depending on who emitted it.
 */
export function verdictEventFor(
  stage: AgentStage,
  passed: boolean,
): keyof DomainEventMap | null {
  if (stage === AgentStage.QA_ENGINEER) return passed ? "QA_PASSED" : "QA_FAILED";
  if (stage === AgentStage.SECURITY) return passed ? "SECURITY_PASSED" : "SECURITY_FAILED";
  return null;
}
