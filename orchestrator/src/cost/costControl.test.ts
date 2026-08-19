import { describe, expect, it } from "vitest";
import { BudgetExceededError, DEFAULT_BUDGET, assertBudget, checkBudget } from "./costControl.js";
import { RunLog } from "../observability/runLog.js";
import { AgentStage } from "../types.js";

function seedRuns(log: RunLog, taskId: string, tokenAmounts: number[], costPerRun = 0.1) {
  let t = 0;
  for (const tokens of tokenAmounts) {
    log.record({
      task_id: taskId,
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: t,
      end_time: t + 1,
      outcome: { tokens, cost: costPerRun, result: "PASS" },
    });
    t += 1;
  }
}

describe("costControl", () => {
  it("stays within the default 150k token budget", () => {
    const log = new RunLog();
    seedRuns(log, "TASK-1", [50_000, 50_000, 49_000]);
    expect(checkBudget(log, "TASK-1").withinBudget).toBe(true);
  });

  it("flags a task that exceeds the default token budget", () => {
    const log = new RunLog();
    seedRuns(log, "TASK-1", [80_000, 80_000]);
    const result = checkBudget(log, "TASK-1");
    expect(result.withinBudget).toBe(false);
    expect(result.violations.some((v) => v.includes("token_budget"))).toBe(true);
  });

  it("assertBudget throws BudgetExceededError (STOP -> Human) once exceeded", () => {
    const log = new RunLog();
    seedRuns(log, "TASK-1", [160_000]);
    expect(() => assertBudget(log, "TASK-1")).toThrow(BudgetExceededError);
  });

  it("assertBudget does not throw while under budget", () => {
    const log = new RunLog();
    seedRuns(log, "TASK-1", [1000]);
    expect(() => assertBudget(log, "TASK-1")).not.toThrow();
  });

  it("flags a single run that exceeds a custom agent_budget", () => {
    const log = new RunLog();
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.QA_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 100, cost: 5, result: "PASS" },
    });
    const result = checkBudget(log, "TASK-1", { ...DEFAULT_BUDGET, agent_budget: 1 });
    expect(result.withinBudget).toBe(false);
    expect(result.violations.some((v) => v.includes("agent_budget"))).toBe(true);
  });

  it("flags a task_budget (total cost) violation independently of tokens", () => {
    const log = new RunLog();
    seedRuns(log, "TASK-1", [10, 10, 10], 5); // low tokens, high cost per run
    const result = checkBudget(log, "TASK-1", { ...DEFAULT_BUDGET, task_budget: 10 });
    expect(result.withinBudget).toBe(false);
    expect(result.violations.some((v) => v.includes("task_budget"))).toBe(true);
  });
});
