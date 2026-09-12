import type { ClassificationResult } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { assertTargetCanStartNewTask, targetById, type TargetRegistry } from "./targets.js";

export type TargetBindingRole = AgentStage.BACKEND_ENGINEER | AgentStage.FRONTEND_ENGINEER;

export interface TargetBinding {
  target_id: string;
  role: TargetBindingRole;
}

export interface TargetBindings {
  targets: TargetBinding[];
}

export class TaskBindingError extends Error {}

export function targetBindingsOf(task: Pick<PersistedTask, "targetBindings">): TargetBindings {
  return task.targetBindings;
}

export function uniqueBoundTargetIds(bindings: TargetBindings): string[] {
  return [...new Set(bindings.targets.map((binding) => binding.target_id))];
}

export function hasTargetBindings(bindings: TargetBindings): boolean {
  return bindings.targets.length > 0;
}

function engineerRoles(pipeline: readonly AgentStage[]): Set<TargetBindingRole> {
  return new Set(
    pipeline.filter(
      (stage): stage is TargetBindingRole =>
        stage === AgentStage.BACKEND_ENGINEER || stage === AgentStage.FRONTEND_ENGINEER,
    ),
  );
}

function bindingRoles(bindings: TargetBindings): Set<TargetBindingRole> {
  return new Set(bindings.targets.map((binding) => binding.role));
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Validates creation-time rules.  The caller persists exactly this result. */
export function validateNewTaskBindings(
  classification: ClassificationResult,
  bindings: TargetBindings,
  registry: TargetRegistry,
): void {
  const expectedRoles = engineerRoles(classification.pipeline);
  const actualRoles = bindingRoles(bindings);
  if (!sameSet(expectedRoles, actualRoles)) {
    throw new TaskBindingError(
      `Target binding engineer roles (${[...actualRoles].join(", ") || "none"}) must equal classification engineer roles (${[...expectedRoles].join(", ") || "none"})`,
    );
  }
  for (const targetId of uniqueBoundTargetIds(bindings)) assertTargetCanStartNewTask(registry, targetId);
}

/** Resume-time validation permits only an already-known active identity. */
export function validatePersistedTaskBindings(
  task: Pick<PersistedTask, "taskId" | "classification" | "targetBindings">,
  registry: TargetRegistry,
): void {
  const bindings = task.targetBindings;
  const expectedRoles = engineerRoles(task.classification.pipeline);
  const actualRoles = bindingRoles(bindings);
  if ([...expectedRoles].some((role) => !actualRoles.has(role))) {
    throw new TaskBindingError(
      `legacy code task "${task.taskId}" has no explicit Target binding — create a replacement task with --frontend-target and/or --backend-target; repos.yaml cannot select a Target`,
    );
  }
  if ([...actualRoles].some((role) => !expectedRoles.has(role))) {
    throw new TaskBindingError(`task "${task.taskId}" has a Target binding outside its engineer classification`);
  }
  for (const targetId of uniqueBoundTargetIds(bindings)) targetById(registry, targetId);
}

/** The binding must never mutate once a task has entered durable history. */
export function assertBindingsImmutable(previous: TargetBindings, next: TargetBindings): void {
  const keys = (bindings: TargetBindings): Set<string> =>
    new Set(bindings.targets.map((binding) => `${binding.role}\u0000${binding.target_id}`));
  if (!sameSet(keys(previous), keys(next))) {
    throw new TaskBindingError("Target bindings are immutable after task creation; cancel this task and create a replacement");
  }
}
