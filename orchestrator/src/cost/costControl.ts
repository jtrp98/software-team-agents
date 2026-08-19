import type { RunLog } from "../observability/runLog.js";
import { MAX_RETRY } from "../retry/retryPolicy.js";

export interface Budget {
  /** Max total cost for one task, across every agent run. */
  task_budget: number;
  /** Max cost a single agent run may spend. */
  agent_budget: number;
  /** Mirrors item 5's hard retry limit — kept here only for visibility alongside the other budgets. */
  retry_budget: number;
  /** Max total tokens for one task, across every agent run. */
  token_budget: number;
}

/** task-detail.md item 12's own example: max_retry: 3, max_token: 150000. */
export const DEFAULT_BUDGET: Budget = {
  task_budget: Infinity,
  agent_budget: Infinity,
  retry_budget: MAX_RETRY,
  token_budget: 150_000,
};

export interface BudgetCheckResult {
  withinBudget: boolean;
  violations: string[];
}

export function checkBudget(log: RunLog, taskId: string, budget: Budget = DEFAULT_BUDGET): BudgetCheckResult {
  const violations: string[] = [];

  const totalTokens = log.totalTokens(taskId);
  if (totalTokens > budget.token_budget) {
    violations.push(`token_budget exceeded: ${totalTokens} > ${budget.token_budget}`);
  }

  const totalCost = log.totalCost(taskId);
  if (totalCost > budget.task_budget) {
    violations.push(`task_budget exceeded: ${totalCost} > ${budget.task_budget}`);
  }

  for (const run of log.runsForTask(taskId)) {
    if (run.cost > budget.agent_budget) {
      violations.push(`agent_budget exceeded by ${run.agent}: ${run.cost} > ${budget.agent_budget}`);
    }
  }

  return { withinBudget: violations.length === 0, violations };
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly violations: string[],
  ) {
    super(`STOP -> Human: task ${taskId} exceeded budget:\n- ${violations.join("\n- ")}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * The enforcement point: called after each run is logged. Throws instead of
 * letting the task continue — task-detail.md's rule is STOP -> Human, not a
 * warning a caller could choose to ignore.
 */
export function assertBudget(log: RunLog, taskId: string, budget: Budget = DEFAULT_BUDGET): void {
  const result = checkBudget(log, taskId, budget);
  if (!result.withinBudget) {
    throw new BudgetExceededError(taskId, result.violations);
  }
}
