import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { validateStructuredFailure, type StructuredFailure } from "../orchestrator/failure.js";
import { InvalidRecoveryError, recoverTo, transition } from "../state/taskState.js";
import { MAX_RETRY, initTaskRun, recordFailure, type TaskRun } from "./retryPolicy.js";
import { decideRecovery, describeRecovery, isTerminal } from "./recoveryPolicy.js";
import { effectiveMaxRetry } from "../escalation/escalationPolicy.js";

const PIPELINE = [
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
];

function failure(over: Partial<StructuredFailure> = {}): StructuredFailure {
  return validateStructuredFailure({
    category: "implementation",
    owner: AgentStage.BACKEND_ENGINEER,
    severity: "high",
    retryable: true,
    reason: "API response mismatch",
    affected: ["BE-004"],
    requiresHuman: false,
    ...over,
  });
}

/** Walks a fresh run forward to QA, then records one QA failure — the ordinary case. */
function runAtFailedQa(failures = 1): TaskRun {
  let run = initTaskRun(PIPELINE, false);
  for (const state of [TaskState.REQUIREMENT, TaskState.DESIGN, TaskState.IMPLEMENTATION, TaskState.QA]) {
    run = { ...run, machine: transition(run.machine, state) };
  }
  for (let i = 0; i < failures; i++) {
    run = recordFailure(run, "qa");
    if (run.machine.current === TaskState.IMPLEMENTATION) {
      run = { ...run, machine: transition(run.machine, TaskState.QA) };
    }
  }
  return run;
}

function decide(over: Partial<Parameters<typeof decideRecovery>[0]> = {}) {
  return decideRecovery({
    failure: failure(),
    kind: "qa",
    run: runAtFailedQa(),
    pipeline: PIPELINE,
    currentState: TaskState.QA,
    ...over,
  });
}

describe("recoverTo", () => {
  it("moves a task back to a state it genuinely passed through", () => {
    const run = runAtFailedQa();
    const machine = recoverTo(run.machine, TaskState.DESIGN);
    expect(machine.current).toBe(TaskState.DESIGN);
    expect(machine.history).toContain(TaskState.DESIGN);
  });

  it("refuses a state this task's pipeline does not have", () => {
    const run = initTaskRun([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(() => recoverTo(run.machine, TaskState.DESIGN)).toThrow(InvalidRecoveryError);
  });

  it("refuses a state the task has never actually been in", () => {
    const run = initTaskRun(PIPELINE, false);
    expect(() => recoverTo(run.machine, TaskState.DESIGN)).toThrow(InvalidRecoveryError);
  });

  /** Recovery must never become a way to skip work forward. */
  it("refuses to move forward", () => {
    let run = initTaskRun(PIPELINE, false);
    run = { ...run, machine: transition(run.machine, TaskState.REQUIREMENT) };
    run = { ...run, machine: transition(run.machine, TaskState.DESIGN) };
    run = { ...run, machine: recoverTo(run.machine, TaskState.REQUIREMENT) };
    expect(() => recoverTo(run.machine, TaskState.DESIGN)).toThrow(/only moves backwards/);
  });
});

describe("decideRecovery", () => {
  describe("RETRY", () => {
    it("re-runs the engineer that owns an implementation failure", () => {
      const action = decide();
      expect(action.kind).toBe("RETRY");
      if (action.kind === "RETRY") {
        expect(action.stage).toBe(AgentStage.BACKEND_ENGINEER);
        expect(action.strategy).toBe("retry_same_stage");
        // Two, not MAX_RETRY: the ceiling reported is the one this failure's
        // severity actually gets ("high" = a blocking issue = two rounds, per
        // CLAUDE.md's "a fix that fails twice gets escalated"). Reporting the
        // global budget here would promise a round it will not get.
        expect(action.max).toBe(effectiveMaxRetry("high"));
        expect(action.max).toBeLessThan(MAX_RETRY);
      }
    });

    /** Kept deliberately: no owner reported means no decision, not a guess. */
    it("falls back to the implementation stage when the round reported no structured failure", () => {
      const action = decide({ failure: undefined });
      expect(action.kind).toBe("RETRY");
      if (action.kind === "RETRY") expect(action.stage).toBe(AgentStage.BACKEND_ENGINEER);
    });

    it("escalates the no-failure fallback when the pipeline has no implementation stage at all", () => {
      const pipeline = [AgentStage.SYSTEM_ANALYST, AgentStage.QA_ENGINEER];
      const action = decide({ failure: undefined, pipeline, run: initTaskRun(pipeline, false) });
      expect(action.kind).toBe("ESCALATE");
    });
  });

  describe("RECOVER", () => {
    it("sends a contract failure back to system-analyst at DESIGN, not to an engineer", () => {
      const action = decide({ failure: failure({ category: "contract", owner: AgentStage.SYSTEM_ANALYST }) });
      expect(action.kind).toBe("RECOVER");
      if (action.kind === "RECOVER") {
        expect(action.stage).toBe(AgentStage.SYSTEM_ANALYST);
        expect(action.toState).toBe(TaskState.DESIGN);
        expect(action.strategy).toBe("return_to_owner");
      }
    });

    it("sends a requirement failure all the way back to business-analyst", () => {
      const action = decide({ failure: failure({ category: "requirement", owner: AgentStage.BUSINESS_ANALYST }) });
      expect(action.kind).toBe("RECOVER");
      if (action.kind === "RECOVER") expect(action.toState).toBe(TaskState.REQUIREMENT);
    });
  });

  describe("ROLLBACK", () => {
    /** A failure that arrives after verification is behind the task is not a retry of anything. */
    it("returns a task that already reached READY_TO_DEPLOY to its last verified state", () => {
      const run = runAtFailedQa(0);
      const action = decide({ run, currentState: TaskState.READY_TO_DEPLOY });
      expect(action.kind).toBe("ROLLBACK");
      if (action.kind === "ROLLBACK") {
        expect(action.toState).toBe(TaskState.QA);
        expect(action.strategy).toBe("rollback_to_verified");
      }
    });

    it("escalates instead when there is no verified state to fall back to", () => {
      const run = initTaskRun(PIPELINE, false);
      const action = decide({ run, currentState: TaskState.READY_TO_DEPLOY });
      expect(action.kind).toBe("ESCALATE");
      expect(action.reason).toContain("no verified state");
    });
  });

  describe("ESCALATE", () => {
    it("stops for a person whenever the failure says one must look", () => {
      expect(decide({ failure: failure({ requiresHuman: true }) }).kind).toBe("ESCALATE");
    });

    it("stops when the failure is not retryable", () => {
      expect(decide({ failure: failure({ retryable: false }) }).kind).toBe("ESCALATE");
    });

    it("stops when the owner is not in this task's pipeline", () => {
      expect(decide({ failure: failure({ owner: AgentStage.DEVOPS }) }).kind).toBe("ESCALATE");
    });
  });

  describe("ABORT", () => {
    it("gives up once the retry budget is spent, whatever the failure claims", () => {
      const run = runAtFailedQa(MAX_RETRY + 1);
      const action = decideRecovery({
        failure: failure({ retryable: true, requiresHuman: false }),
        kind: "qa",
        run,
        pipeline: PIPELINE,
        currentState: TaskState.QA,
      });
      expect(action.kind).toBe("ABORT");
      expect(action.reason).toContain(String(MAX_RETRY));
    });

    /** The budget outranks the failure's own opinion — that is the point of having one. */
    it("cannot be talked out of aborting by a failure that insists it is retryable", () => {
      const run = runAtFailedQa(MAX_RETRY + 1);
      const action = decideRecovery({
        failure: failure(),
        kind: "qa",
        run,
        pipeline: PIPELINE,
        currentState: TaskState.QA,
      });
      expect(action.kind).not.toBe("RETRY");
    });
  });

  it("keeps QA and security budgets apart — a spent QA budget does not abort a security round", () => {
    const run = runAtFailedQa(MAX_RETRY + 1);
    const action = decideRecovery({
      failure: failure(),
      kind: "security",
      run,
      pipeline: PIPELINE,
      currentState: TaskState.QA,
    });
    expect(action.kind).not.toBe("ABORT");
  });
});

describe("isTerminal", () => {
  it("treats both stopping kinds as terminal and the three continuing kinds as not", () => {
    expect(isTerminal(decide({ failure: failure({ requiresHuman: true }) }))).toBe(true);
    expect(isTerminal(decide())).toBe(false);
    expect(isTerminal(decide({ failure: failure({ owner: AgentStage.SYSTEM_ANALYST, category: "contract" }) }))).toBe(false);
  });
});

describe("describeRecovery", () => {
  it("produces the retry/recovery record T07 specifies", () => {
    const run = runAtFailedQa();
    const plan = describeRecovery(decide({ run }), run, "qa");
    expect(plan).toEqual({
      retry: { max: MAX_RETRY, current: run.retries.qa },
      recovery: { strategy: "retry_same_stage", reason: "API response mismatch" },
    });
  });
});
