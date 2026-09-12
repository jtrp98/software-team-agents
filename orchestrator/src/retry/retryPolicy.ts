import { AgentStage, TaskState } from "../types.js";
import { canTransition, initTaskMachine, transition, type TaskMachine } from "../state/taskState.js";

/**
 * The global hard ceiling. Defense in depth only: ordinary findings stop after
 * two automatic rounds under `escalation-policy.yaml`, which is the limit that
 * actually governs a normal repair. This one exists so that no path — a
 * missing severity, an unrecognized failure, a caller composing the policy
 * itself — can retry more than three times. Never override, never configure
 * higher at runtime.
 */
export const MAX_RETRY = 3;

/** The automatic rounds an *ordinary* (low/medium/high) finding gets. `escalation-policy.yaml` is the authority; this names it for callers and tests. */
export const ORDINARY_REPAIR_ROUNDS = 2;

export type FailureKind = "qa" | "security";

/**
 * QA and security are tracked as separate budgets on purpose: they check
 * different things, and a task that burned through 3 QA rounds hasn't used up
 * any of its security budget.
 */
export interface RetryBudget {
  qa: number;
  security: number;
}

export interface TaskRun {
  machine: TaskMachine;
  retries: RetryBudget;
}

export function initTaskRun(pipeline: AgentStage[], requiresHumanApproval: boolean): TaskRun {
  return {
    machine: initTaskMachine(pipeline, requiresHumanApproval),
    retries: { qa: 0, security: 0 },
  };
}

const FAILED_STATE: Record<FailureKind, TaskState> = {
  qa: TaskState.QA_FAILED,
  security: TaskState.SECURITY_FAILED,
};

/**
 * Records one failure of the given kind. Below the limit, the task loops back
 * to IMPLEMENTATION for a fix-and-recheck round. On the retry that would
 * exceed MAX_RETRY, it is forced to BLOCKED instead — this is the only place
 * that decision is made, so no agent and no other code path can keep a task
 * retrying forever.
 */
export interface RecordFailureOptions {
  /**
   * False for an infrastructure/quota/runtime-unavailability outcome: it is
   * not a defect with a fix-verify-close lifecycle, so it must not spend a
   * budget that exists to bound how many times a *defect* is re-attempted
   * (T-V8-015). The state still moves — the round did fail — but the counter
   * does not, so a provider outage cannot exhaust a task's repair budget.
   * Defaults to true, which is the pre-T-V8-015 behaviour for every caller
   * that does not classify its failure.
   */
  countsAsDefect?: boolean;
}

export function recordFailure(run: TaskRun, kind: FailureKind, options: RecordFailureOptions = {}): TaskRun {
  const failedState = FAILED_STATE[kind];
  const countsAsDefect = options.countsAsDefect ?? true;
  const retries: RetryBudget = countsAsDefect
    ? { ...run.retries, [kind]: run.retries[kind] + 1 }
    : { ...run.retries };
  const machineAtFailed = transition(run.machine, failedState);

  // Escalate straight to BLOCKED either when the budget is spent, or when
  // there's no IMPLEMENTATION stage in this pipeline to loop back to at all
  // (nothing to fix in-pipeline — see taskState.ts's defensive case).
  const canRetry = retries[kind] <= MAX_RETRY && canTransition(machineAtFailed, TaskState.IMPLEMENTATION);
  const target = canRetry ? TaskState.IMPLEMENTATION : TaskState.BLOCKED;
  return { machine: transition(machineAtFailed, target), retries };
}

export function isBlocked(run: TaskRun): boolean {
  return run.machine.current === TaskState.BLOCKED;
}

export function remainingRetries(run: TaskRun, kind: FailureKind): number {
  return Math.max(0, MAX_RETRY - run.retries[kind]);
}
