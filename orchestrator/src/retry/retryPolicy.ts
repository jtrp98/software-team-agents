import { AgentStage, TaskState } from "../types.js";
import { canTransition, initTaskMachine, transition, type TaskMachine } from "../state/taskState.js";

/** Hard limit per task-detail.md item 5 — never override, never configure higher at runtime. */
export const MAX_RETRY = 3;

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
export function recordFailure(run: TaskRun, kind: FailureKind): TaskRun {
  const failedState = FAILED_STATE[kind];
  const retries: RetryBudget = { ...run.retries, [kind]: run.retries[kind] + 1 };
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
