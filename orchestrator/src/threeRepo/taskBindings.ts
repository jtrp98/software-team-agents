import type { ClassificationResult } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { assertTargetCanStartNewTask, targetById, type TargetRegistry } from "./targets.js";

export interface TargetBindings {
  frontend_target: string | null;
  backend_target: string | null;
}

export class TaskBindingError extends Error {}

export function targetBindingsOf(task: Pick<PersistedTask, "targetBindings">): TargetBindings {
  return task.targetBindings;
}

export function uniqueBoundTargetIds(bindings: TargetBindings): string[] {
  return [...new Set([bindings.backend_target, bindings.frontend_target].filter((id): id is string => id !== null))];
}

/** Validates creation-time rules.  The caller persists exactly this result. */
export function validateNewTaskBindings(
  classification: ClassificationResult,
  bindings: TargetBindings,
  registry: TargetRegistry,
): void {
  const touchesFrontend = classification.pipeline.includes(AgentStage.FRONTEND_ENGINEER);
  const touchesBackend = classification.pipeline.includes(AgentStage.BACKEND_ENGINEER);
  if (touchesFrontend !== (bindings.frontend_target !== null)) {
    throw new TaskBindingError(`touchesFrontend=${touchesFrontend} requires frontend_target to be ${touchesFrontend ? "set" : "null"}`);
  }
  if (touchesBackend !== (bindings.backend_target !== null)) {
    throw new TaskBindingError(`touchesBackend=${touchesBackend} requires backend_target to be ${touchesBackend ? "set" : "null"}`);
  }
  const targetIds = uniqueBoundTargetIds(bindings);
  if (targetIds.length > 2) throw new TaskBindingError("a V1 task may bind at most two Targets");
  for (const targetId of targetIds) assertTargetCanStartNewTask(registry, targetId);
}

/** Resume-time validation permits only an already-known active identity. */
export function validatePersistedTaskBindings(
  task: Pick<PersistedTask, "taskId" | "classification" | "targetBindings">,
  registry: TargetRegistry,
): void {
  const bindings = task.targetBindings;
  const touchesFrontend = task.classification.pipeline.includes(AgentStage.FRONTEND_ENGINEER);
  const touchesBackend = task.classification.pipeline.includes(AgentStage.BACKEND_ENGINEER);
  if ((touchesFrontend && !bindings.frontend_target) || (touchesBackend && !bindings.backend_target)) {
    throw new TaskBindingError(
      `legacy code task "${task.taskId}" has no explicit Target binding — create a replacement task with --frontend-target and/or --backend-target; repos.yaml cannot select a Target`,
    );
  }
  if ((!touchesFrontend && bindings.frontend_target) || (!touchesBackend && bindings.backend_target)) {
    throw new TaskBindingError(`task "${task.taskId}" has a Target binding outside its engineer classification`);
  }
  for (const targetId of uniqueBoundTargetIds(bindings)) targetById(registry, targetId);
}

/** The binding must never mutate once a task has entered durable history. */
export function assertBindingsImmutable(previous: TargetBindings, next: TargetBindings): void {
  if (previous.frontend_target !== next.frontend_target || previous.backend_target !== next.backend_target) {
    throw new TaskBindingError("Target bindings are immutable after task creation; cancel this task and create a replacement");
  }
}
