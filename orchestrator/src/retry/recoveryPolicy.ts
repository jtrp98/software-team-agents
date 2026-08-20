import { AgentStage, TaskState } from "../types.js";
import { routeFailure, type StructuredFailure } from "../orchestrator/failure.js";
import type { TaskMachine } from "../state/taskState.js";
import { MAX_RETRY, type FailureKind, type TaskRun } from "./retryPolicy.js";

/**
 * Decides what actually happens after a failure — the five-way choice T07 asks
 * for, rather than the single "run the agent again" the pipeline had.
 *
 * Before this, every failed round meant the same thing: send it back to the
 * first implementation stage and hope. That conflates five genuinely different
 * situations, and treating them alike is what produces the loop
 * `qa-engineer.md` describes — an engineer guessing repeatedly at a decision
 * that was never theirs, because the system had no way to express "this is not
 * yours to fix".
 *
 *   RETRY     re-run the stage that owns it; the failure is that stage's to fix
 *   RECOVER   go back further — a contract gap belongs at DESIGN, an undecided
 *             business rule at REQUIREMENT. Not a retry: a different stage runs
 *             and everything after it is re-walked
 *   ROLLBACK  the task had already moved past verification; return it to the
 *             last verified state before anything else is decided
 *   ESCALATE  stop for a person, with the task resumable once they answer
 *   ABORT     stop for good; no further automatic work can help
 *
 * ESCALATE and ABORT both land the machine in BLOCKED, and that is not a
 * distinction without a difference: it tells the person whether they are being
 * asked a question that will restart the task, or being told the task is over.
 * Collapsing the two would lose the only signal that separates "answer this"
 * from "this one is finished".
 */

export type RecoveryStrategy =
  | "retry_same_stage"
  | "return_to_owner"
  | "rollback_to_verified"
  | "escalate_to_human"
  | "abort";

export type RecoveryAction =
  | { kind: "RETRY"; strategy: "retry_same_stage"; stage: AgentStage; attempt: number; max: number; reason: string }
  | { kind: "RECOVER"; strategy: "return_to_owner"; stage: AgentStage; toState: TaskState; reason: string }
  | { kind: "ROLLBACK"; strategy: "rollback_to_verified"; toState: TaskState; reason: string }
  | { kind: "ESCALATE"; strategy: "escalate_to_human"; reason: string }
  | { kind: "ABORT"; strategy: "abort"; reason: string };

export interface RecoveryInput {
  /** The failure as classified (T06). Undefined when the reporting stage gave none. */
  failure: StructuredFailure | undefined;
  kind: FailureKind;
  /** The run *after* `recordFailure` has counted this failure. */
  run: TaskRun;
  pipeline: AgentStage[];
  /** The state the task was in when the failure arrived, before any recovery is applied. */
  currentState: TaskState;
}

/** States that mean verification is already behind the task — a failure here is a rollback, not a retry. */
const POST_VERIFICATION: TaskState[] = [TaskState.READY_TO_DEPLOY, TaskState.APPROVED, TaskState.DEPLOYED];

/** The last state in the machine's own sequence that counts as verified work to fall back to. */
function lastVerifiedState(machine: TaskMachine): TaskState | null {
  for (const candidate of [TaskState.SECURITY, TaskState.QA, TaskState.IMPLEMENTATION]) {
    if (machine.sequence.includes(candidate) && machine.history.includes(candidate)) return candidate;
  }
  return null;
}

function firstImplementationStage(pipeline: AgentStage[]): AgentStage | null {
  return pipeline.find((s) => s === AgentStage.BACKEND_ENGINEER || s === AgentStage.FRONTEND_ENGINEER) ?? null;
}

/**
 * The single decision point. Pure: it reads the run and returns an action, and
 * never mutates anything — applying the action is the orchestrator's job, so
 * that "what should happen" stays reviewable apart from "make it happen".
 */
export function decideRecovery(input: RecoveryInput): RecoveryAction {
  const { failure, kind, run, pipeline, currentState } = input;
  const used = run.retries[kind];

  // 1. Budget first, and it outranks everything. A failure that says "retry me"
  //    does not get to override the ceiling — that is the whole purpose of a ceiling.
  if (used > MAX_RETRY) {
    return {
      kind: "ABORT",
      strategy: "abort",
      reason: `${kind} retry limit (${MAX_RETRY}) exceeded after ${used} attempts — no further automatic round can help`,
    };
  }

  // 2. Already past verification: nothing downstream should be reasoned about
  //    until the task is back where its work was last checked.
  if (POST_VERIFICATION.includes(currentState)) {
    const target = lastVerifiedState(run.machine);
    if (target) {
      return {
        kind: "ROLLBACK",
        strategy: "rollback_to_verified",
        toState: target,
        reason: `failure reported at ${currentState}, past verification — rolling back to ${target} before deciding anything else`,
      };
    }
    return {
      kind: "ESCALATE",
      strategy: "escalate_to_human",
      reason: `failure reported at ${currentState} but the task has no verified state to roll back to — needs a person`,
    };
  }

  // 3. No structured failure. The reporting stage told us something broke and
  //    nothing about whose it is, so this keeps the pre-T06 behaviour: back to
  //    the implementation stage. It is a fallback, not a decision.
  if (!failure) {
    const stage = firstImplementationStage(pipeline);
    if (!stage) {
      return {
        kind: "ESCALATE",
        strategy: "escalate_to_human",
        reason: `${kind} round failed with no structured failure, and this pipeline has no implementation stage to fall back to`,
      };
    }
    return {
      kind: "RETRY",
      strategy: "retry_same_stage",
      stage,
      attempt: used,
      max: MAX_RETRY,
      reason: `${kind} round failed without a structured failure — falling back to the implementation stage`,
    };
  }

  const route = routeFailure(failure, pipeline);
  switch (route.kind) {
    case "RETRY_STAGE":
      return {
        kind: "RETRY",
        strategy: "retry_same_stage",
        stage: route.stage,
        attempt: used,
        max: MAX_RETRY,
        reason: route.reason,
      };
    case "RECOVER":
      return {
        kind: "RECOVER",
        strategy: "return_to_owner",
        stage: route.stage,
        toState: route.toState,
        reason: route.reason,
      };
    case "ESCALATE":
      return { kind: "ESCALATE", strategy: "escalate_to_human", reason: route.reason };
  }
}

/** Whether an action stops the task rather than continuing it. Both stopping kinds land in BLOCKED. */
export function isTerminal(action: RecoveryAction): boolean {
  return action.kind === "ESCALATE" || action.kind === "ABORT";
}

/** The T07 record shape, for the state view and the run log. */
export interface RecoveryPlan {
  retry: { max: number; current: number };
  recovery: { strategy: RecoveryStrategy; reason: string };
}

export function describeRecovery(action: RecoveryAction, run: TaskRun, kind: FailureKind): RecoveryPlan {
  return {
    retry: { max: MAX_RETRY, current: run.retries[kind] },
    recovery: { strategy: action.strategy, reason: action.reason },
  };
}
