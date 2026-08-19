import { describe, expect, it } from "vitest";
import {
  MAX_RETRY,
  initTaskRun,
  isBlocked,
  recordFailure,
  remainingRetries,
} from "./retryPolicy.js";
import { AgentStage, TaskState } from "../types.js";
import { transition } from "../state/taskState.js";

function toQa(run: ReturnType<typeof initTaskRun>) {
  let machine = run.machine;
  if (machine.current !== TaskState.IMPLEMENTATION) {
    machine = transition(machine, TaskState.IMPLEMENTATION);
  }
  machine = transition(machine, TaskState.QA);
  return { ...run, machine };
}

describe("retryPolicy", () => {
  it("loops back to IMPLEMENTATION for the first MAX_RETRY QA failures", () => {
    let run = initTaskRun([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    for (let i = 1; i <= MAX_RETRY; i++) {
      run = toQa(run);
      run = recordFailure(run, "qa");
      expect(run.machine.current).toBe(TaskState.IMPLEMENTATION);
      expect(run.retries.qa).toBe(i);
      expect(isBlocked(run)).toBe(false);
    }
  });

  it("escalates to BLOCKED on the failure past MAX_RETRY", () => {
    let run = initTaskRun([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    for (let i = 0; i < MAX_RETRY; i++) {
      run = toQa(run);
      run = recordFailure(run, "qa");
    }
    run = toQa(run);
    run = recordFailure(run, "qa");
    expect(isBlocked(run)).toBe(true);
    expect(run.retries.qa).toBe(MAX_RETRY + 1);
  });

  it("tracks qa and security retries as independent budgets", () => {
    let run = initTaskRun(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
      true,
    );
    run = { ...run, machine: transition(run.machine, TaskState.DESIGN) };
    for (let i = 0; i < MAX_RETRY; i++) {
      run = toQa(run);
      run = recordFailure(run, "qa");
    }
    expect(run.retries.qa).toBe(MAX_RETRY);
    expect(run.retries.security).toBe(0);
    expect(remainingRetries(run, "security")).toBe(MAX_RETRY);
    expect(isBlocked(run)).toBe(false);
  });

  it("escalates immediately when the pipeline has no IMPLEMENTATION stage to retry", () => {
    let run = initTaskRun([AgentStage.QA_ENGINEER], false);
    run = { ...run, machine: transition(run.machine, TaskState.QA) };
    run = recordFailure(run, "qa");
    expect(isBlocked(run)).toBe(true);
    expect(run.retries.qa).toBe(1); // blocked on the very first failure, well under MAX_RETRY
  });

  it("remainingRetries never goes negative", () => {
    let run = initTaskRun([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    for (let i = 0; i < MAX_RETRY + 2; i++) {
      if (isBlocked(run)) break;
      run = toQa(run);
      run = recordFailure(run, "qa");
    }
    expect(isBlocked(run)).toBe(true);
    expect(remainingRetries(run, "qa")).toBeGreaterThanOrEqual(0);
  });
});
