import { AgentStage, TaskState } from "../types.js";

/**
 * Maps a pipeline stage (from classification, item 1) to the TaskState it
 * occupies while that stage runs. backend-engineer and frontend-engineer both
 * map to IMPLEMENTATION on purpose — their ordering is enforced by pipeline
 * order, not by separate states.
 */
export const STAGE_TO_STATE: Partial<Record<AgentStage, TaskState>> = {
  [AgentStage.BUSINESS_ANALYST]: TaskState.REQUIREMENT,
  [AgentStage.SYSTEM_ANALYST]: TaskState.DESIGN,
  [AgentStage.PROJECT_MANAGER]: TaskState.PLAN,
  [AgentStage.BACKEND_ENGINEER]: TaskState.IMPLEMENTATION,
  [AgentStage.FRONTEND_ENGINEER]: TaskState.IMPLEMENTATION,
  [AgentStage.QA_ENGINEER]: TaskState.QA,
  [AgentStage.SECURITY]: TaskState.SECURITY,
};

export interface TaskMachine {
  pipeline: AgentStage[];
  requiresHumanApproval: boolean;
  /** The full forward sequence this task must walk, computed once at creation. */
  sequence: TaskState[];
  current: TaskState;
  history: TaskState[];
}

/**
 * Computes the forward state sequence for a task from its classification
 * pipeline. Pure — same pipeline always yields the same sequence, so this
 * can be recomputed for inspection without touching machine state.
 */
export function computeSequence(
  pipeline: AgentStage[],
  requiresHumanApproval: boolean,
): TaskState[] {
  // Unclassifiable task (item 1: UNKNOWN) — pipeline is [HUMAN]. No forward path
  // until a human re-triages it into a real classification.
  if (pipeline.length === 1 && pipeline[0] === AgentStage.HUMAN) {
    return [TaskState.CREATED, TaskState.BLOCKED];
  }

  // Deploy-only task (production deploy/migration) — the work it deploys was
  // already verified by its own upstream task; this task starts at the gate.
  if (pipeline.length === 1 && pipeline[0] === AgentStage.DEVOPS) {
    const deploySeq = [TaskState.CREATED, TaskState.READY_TO_DEPLOY];
    if (requiresHumanApproval) deploySeq.push(TaskState.APPROVED);
    deploySeq.push(TaskState.DEPLOYED);
    return deploySeq;
  }

  const sequence: TaskState[] = [TaskState.CREATED];
  for (const stage of pipeline) {
    const state = STAGE_TO_STATE[stage];
    if (!state) continue; // SETUP/DEVOPS/HUMAN mid-pipeline: not a state of their own here
    if (sequence[sequence.length - 1] !== state) {
      sequence.push(state);
    }
  }
  sequence.push(TaskState.READY_TO_DEPLOY);
  if (requiresHumanApproval) sequence.push(TaskState.APPROVED);
  sequence.push(TaskState.DEPLOYED);
  return sequence;
}

export function initTaskMachine(
  pipeline: AgentStage[],
  requiresHumanApproval: boolean,
): TaskMachine {
  const sequence = computeSequence(pipeline, requiresHumanApproval);
  return {
    pipeline,
    requiresHumanApproval,
    sequence,
    current: TaskState.CREATED,
    history: [TaskState.CREATED],
  };
}

/**
 * Valid next states from the machine's current state: the next state in its
 * forward sequence, plus the fixed failure transition if current is QA or
 * SECURITY. BLOCKED is always a structurally valid next state from a _FAILED
 * state — retry-count policy (item 5) is what actually decides whether a
 * given failure loops back to IMPLEMENTATION or gets forced to BLOCKED; this
 * function only says both are legal moves, never chooses between them.
 */
export function nextStates(machine: TaskMachine): TaskState[] {
  const { current, sequence } = machine;
  const idx = sequence.indexOf(current);
  const hasImplementation = sequence.includes(TaskState.IMPLEMENTATION);

  if (current === TaskState.QA) {
    const next = idx >= 0 && idx + 1 < sequence.length ? [sequence[idx + 1]] : [];
    return [...next, TaskState.QA_FAILED];
  }
  if (current === TaskState.QA_FAILED) {
    return hasImplementation
      ? [TaskState.IMPLEMENTATION, TaskState.BLOCKED]
      : [TaskState.BLOCKED];
  }
  if (current === TaskState.SECURITY) {
    const next = idx >= 0 && idx + 1 < sequence.length ? [sequence[idx + 1]] : [];
    return [...next, TaskState.SECURITY_FAILED];
  }
  if (current === TaskState.SECURITY_FAILED) {
    return hasImplementation
      ? [TaskState.IMPLEMENTATION, TaskState.BLOCKED]
      : [TaskState.BLOCKED];
  }
  if (current === TaskState.BLOCKED || current === TaskState.DEPLOYED) {
    return []; // terminal until a human acts outside the state machine (item 5/17)
  }

  if (idx === -1 || idx + 1 >= sequence.length) return [];
  return [sequence[idx + 1]];
}

export function canTransition(machine: TaskMachine, to: TaskState): boolean {
  return nextStates(machine).includes(to);
}

/**
 * The next state to move to on a success path — i.e. nextStates() with the
 * QA/SECURITY failure branches filtered out. Used by the orchestrator (item 13)
 * to drive normal forward progress; failure transitions are never decided
 * here, only by retry policy (item 5) explicitly choosing QA_FAILED/SECURITY_FAILED.
 */
export function forwardState(machine: TaskMachine): TaskState | null {
  const candidates = nextStates(machine).filter(
    (s) => s !== TaskState.QA_FAILED && s !== TaskState.SECURITY_FAILED,
  );
  return candidates[0] ?? null;
}

/**
 * The single mutator for task state. No agent holds a reference to this
 * function directly — only the orchestrator (item 13) will call it — so an
 * agent finishing its work cannot move a task forward itself; it can only
 * report completion and let the orchestrator decide the transition.
 */
export function transition(machine: TaskMachine, to: TaskState): TaskMachine {
  if (!canTransition(machine, to)) {
    throw new Error(
      `invalid transition: ${machine.current} -> ${to} (allowed: ${nextStates(machine).join(", ") || "none"})`,
    );
  }
  return {
    ...machine,
    current: to,
    history: [...machine.history, to],
  };
}

export class InvalidRecoveryError extends Error {
  constructor(machine: TaskMachine, to: TaskState, why: string) {
    super(`cannot recover ${machine.current} -> ${to}: ${why}`);
    this.name = "InvalidRecoveryError";
  }
}

/**
 * Moves a task *backwards* to a state it already completed — the "Recover"
 * strategy (T07), as distinct from a retry.
 *
 * Retrying re-runs the stage that failed. Recovering says the failure was never
 * that stage's to fix: a contract gap belongs to `system-analyst` at DESIGN, a
 * business rule that was never decided belongs to `business-analyst` at
 * REQUIREMENT. Before this existed the machine had no edge for that, so
 * `routeFailure` had to stop for a person on every such failure — the honest
 * limit it documented and left to T07.
 *
 * This is the second deliberate exception to "transition() is the single
 * mutator", and it is guarded much more tightly than `forceBlock`. The target
 * must satisfy all three:
 *
 *   - be in this task's own `sequence`, so recovery can never invent a stage
 *     this pipeline does not have;
 *   - be in `history`, so a task can only return somewhere it genuinely was;
 *   - sit strictly earlier in the sequence than the current state, so this can
 *     never be used to skip work forward.
 *
 * Together those make it impossible for recovery to reach a state a normal
 * forward walk could not have reached first. After it lands, the ordinary
 * forward walk re-runs everything from there — which is the point: a design
 * amendment has to flow back through PLAN and IMPLEMENTATION to matter.
 */
export function recoverTo(machine: TaskMachine, to: TaskState): TaskMachine {
  const targetIdx = machine.sequence.indexOf(to);
  if (targetIdx === -1) {
    throw new InvalidRecoveryError(machine, to, `${to} is not in this task's sequence (${machine.sequence.join(" -> ")})`);
  }
  if (!machine.history.includes(to)) {
    throw new InvalidRecoveryError(machine, to, "the task has never been in that state, so there is nothing to return to");
  }

  const currentIdx = machine.sequence.indexOf(machine.current);
  // A failed state (QA_FAILED/SECURITY_FAILED) is not in `sequence`, so index -1
  // means "off the forward path" — recovering from there is exactly the case
  // this exists for, and any earlier state qualifies.
  if (currentIdx !== -1 && targetIdx >= currentIdx) {
    throw new InvalidRecoveryError(machine, to, "recovery only moves backwards; use transition() to go forward");
  }

  return {
    ...machine,
    current: to,
    history: [...machine.history, to],
  };
}

/**
 * Emergency-stop bypass for cost/token budget overruns (item 12): forces
 * BLOCKED from any state, ignoring the structural graph. This is the one
 * intentional exception to "transition() is the single mutator" — a budget
 * cutoff isn't a pipeline event, it's an outside-the-pipeline safety brake,
 * and only costControl.ts's assertBudget failure path may call it.
 */
export function forceBlock(machine: TaskMachine): TaskMachine {
  return {
    ...machine,
    current: TaskState.BLOCKED,
    history: [...machine.history, TaskState.BLOCKED],
  };
}
