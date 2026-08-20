import { AgentStage, TaskState } from "../types.js";
import { STAGE_TO_STATE, forwardState } from "../state/taskState.js";
import { checkGate } from "../gates/gatePolicy.js";
import type { PersistedTask } from "../store/taskStore.js";

/**
 * The TaskState a stage occupies while it runs. `devops` is the one stage
 * whose work spans states the single-value STAGE_TO_STATE map can't express,
 * so it is resolved here rather than in the map.
 *
 * Shared by the orchestrator's own advance loop and by anything that only
 * wants to *describe* a task (the state view, the CLI listing) — one mapping,
 * so a read-only view can never disagree with the thing it is a view of.
 */
export function stageStateOf(stage: AgentStage | undefined): TaskState | undefined {
  if (stage === undefined) return undefined;
  if (stage === AgentStage.DEVOPS) return TaskState.READY_TO_DEPLOY;
  return STAGE_TO_STATE[stage];
}

/**
 * Coarse label for a state, for a person skimming `.workflow/state.yaml`
 * (TASKS.md T02's `phase: backend`). IMPLEMENTATION is the one state that
 * cannot be labelled from the state alone — backend and frontend share it —
 * so the agent holding it decides, and it falls back to the neutral label
 * rather than guessing when there is no agent to ask.
 */
export type TaskPhase =
  | "created"
  | "requirement"
  | "design"
  | "plan"
  | "backend"
  | "frontend"
  | "implementation"
  | "qa"
  | "security"
  | "deploy"
  | "done"
  | "blocked";

export function phaseOf(state: TaskState, agent?: AgentStage): TaskPhase {
  switch (state) {
    case TaskState.CREATED:
      return "created";
    case TaskState.REQUIREMENT:
      return "requirement";
    case TaskState.DESIGN:
      return "design";
    case TaskState.PLAN:
      return "plan";
    case TaskState.IMPLEMENTATION:
      if (agent === AgentStage.BACKEND_ENGINEER) return "backend";
      if (agent === AgentStage.FRONTEND_ENGINEER) return "frontend";
      return "implementation";
    case TaskState.QA:
    case TaskState.QA_FAILED:
      return "qa";
    case TaskState.SECURITY:
    case TaskState.SECURITY_FAILED:
      return "security";
    case TaskState.READY_TO_DEPLOY:
    case TaskState.APPROVED:
      return "deploy";
    case TaskState.DEPLOYED:
      return "done";
    case TaskState.BLOCKED:
      return "blocked";
  }
}

export type TaskStatusKind =
  | "RUNNING"
  | "WAITING_FOR_HUMAN"
  | "WAITING_FOR_DEPENDENCY"
  | "BLOCKED"
  | "DEPLOYED";

export interface TaskStatusView {
  kind: TaskStatusKind;
  state: TaskState;
  currentAgent?: AgentStage;
  nextState?: TaskState;
  reason?: string;
  /** Only set for WAITING_FOR_DEPENDENCY — the task ids not yet DEPLOYED. */
  waitingOn?: string[];
}

/**
 * Describes a *settled* task without touching it.
 *
 * This deliberately does not advance anything: `Orchestrator.status()` walks
 * ungated edges forward as a side effect, which is correct for a run and
 * completely wrong for rendering a file or printing a list. Reading state
 * must never change it — so this reports what the stored state is, and leaves
 * moving it to the orchestrator.
 */
export function describeStatus(task: PersistedTask, allTasks?: readonly PersistedTask[]): TaskStatusView {
  const { machine } = task;
  const current = machine.current;

  if (current === TaskState.DEPLOYED) return { kind: "DEPLOYED", state: current };
  if (current === TaskState.BLOCKED) {
    return { kind: "BLOCKED", state: current, reason: task.blockedReason ?? "blocked" };
  }

  if (allTasks) {
    const unmet = unmetDependencies(task, allTasks);
    if (unmet.length > 0) {
      return {
        kind: "WAITING_FOR_DEPENDENCY",
        state: current,
        waitingOn: unmet,
        reason: `depends on ${unmet.join(", ")}, not yet DEPLOYED`,
      };
    }
  }

  // The next state on the success path, whoever is holding the task right
  // now — reported for every status, so a reader never has to work out "and
  // then what?" from the pipeline by hand.
  const next = forwardState(machine);

  const stage = machine.pipeline[task.pipelineCursor];
  if (stage !== undefined && stageStateOf(stage) === current) {
    return { kind: "RUNNING", state: current, currentAgent: stage, nextState: next ?? undefined };
  }

  if (next) {
    const gate = checkGate(current, next, task.gateContext);
    if (!gate.allowed) {
      return {
        kind: "WAITING_FOR_HUMAN",
        state: current,
        nextState: next,
        reason: gate.reason ?? "gate not satisfied",
      };
    }
    return { kind: "RUNNING", state: current, currentAgent: stage, nextState: next };
  }

  return { kind: "BLOCKED", state: current, reason: task.blockedReason ?? "no forward state available" };
}

/** Dependency ids that have not reached DEPLOYED — a missing task counts as unmet, never as satisfied. */
export function unmetDependencies(task: PersistedTask, allTasks: readonly PersistedTask[]): string[] {
  const byId = new Map(allTasks.map((t) => [t.taskId, t]));
  return task.dependsOn.filter((id) => byId.get(id)?.machine.current !== TaskState.DEPLOYED);
}
