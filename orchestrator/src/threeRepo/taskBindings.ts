import type { ClassificationResult } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import {
  assertTargetCanStartNewTask,
  TARGET_TYPE_ROLES,
  targetById,
  type TargetRegistry,
} from "./targets.js";

export type TargetBindingRole = AgentStage.BACKEND_ENGINEER | AgentStage.FRONTEND_ENGINEER;

export interface TargetBinding {
  target_id: string;
  role: TargetBindingRole;
}

export interface TargetBindings {
  targets: TargetBinding[];
}

export interface TaskBindingModuleScope {
  module: string;
  designPath: string;
  declaredTargetIds: readonly string[];
}

export interface TaskBindingValidationOptions {
  moduleScope?: TaskBindingModuleScope;
}

export interface TaskBindingValidationResult {
  warnings: string[];
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

/**
 * Type and module checks are deliberately shared by creation and resume. A
 * compatibility exemption that existed on only one path would either admit a
 * bad new task or strand an already-running one after restart.
 *
 * One engineer role may hold several Targets: the module's declared `## Targets`
 * is the scope bound, not the role. The commit boundary keeps its own arity
 * limit at `freezeAttempt`/`assertTargetAttempt`, where a git identity actually
 * matters.
 */
function validateBindingPolicy(
  bindings: TargetBindings,
  registry: TargetRegistry,
  options: TaskBindingValidationOptions,
): TaskBindingValidationResult {
  const warnings: string[] = [];
  const targets = new Map(uniqueBoundTargetIds(bindings).map((targetId) => [targetId, targetById(registry, targetId)]));

  for (const [targetId, target] of targets) {
    if (target.type === undefined) {
      warnings.push(
        `Target "${targetId}" has no declared type; accepting its engineer binding under targets.yaml schema v1 compatibility — add type: frontend, backend, or fullstack to enable type/role validation`,
      );
    }
  }
  for (const binding of bindings.targets) {
    const target = targets.get(binding.target_id)!;
    if (target.type !== undefined && !TARGET_TYPE_ROLES[target.type].includes(binding.role)) {
      throw new TaskBindingError(
        `Target "${binding.target_id}" has type "${target.type}", which does not admit role "${binding.role}" — bind it to an admitted role (${TARGET_TYPE_ROLES[target.type].join(" or ")}), or correct the Target type in targets.yaml if the repository scope is wrong`,
      );
    }
  }

  const moduleScope = options.moduleScope;
  if (moduleScope !== undefined) {
    if (moduleScope.declaredTargetIds.length === 0) {
      warnings.push(
        `module "${moduleScope.module}" declares no Targets in ${moduleScope.designPath}; module-scope validation is exempt and the module remains unscoped`,
      );
    } else {
      const declared = new Set(moduleScope.declaredTargetIds);
      for (const targetId of targets.keys()) {
        if (!declared.has(targetId)) {
          throw new TaskBindingError(
            `Target "${targetId}" is outside module "${moduleScope.module}" declared ## Targets (${moduleScope.declaredTargetIds.join(", ")}) — add "${targetId}" to ${moduleScope.designPath} ## Targets, or bind the task to a declared Target`,
          );
        }
      }
    }
  }
  return { warnings };
}

/** Validates creation-time rules.  The caller persists exactly this result. */
export function validateNewTaskBindings(
  classification: ClassificationResult,
  bindings: TargetBindings,
  registry: TargetRegistry,
  options: TaskBindingValidationOptions = {},
): TaskBindingValidationResult {
  const expectedRoles = engineerRoles(classification.pipeline);
  const actualRoles = bindingRoles(bindings);
  if (!sameSet(expectedRoles, actualRoles)) {
    throw new TaskBindingError(
      `Target binding engineer roles (${[...actualRoles].join(", ") || "none"}) must equal classification engineer roles (${[...expectedRoles].join(", ") || "none"})`,
    );
  }
  for (const targetId of uniqueBoundTargetIds(bindings)) assertTargetCanStartNewTask(registry, targetId);
  return validateBindingPolicy(bindings, registry, options);
}

/** Resume-time validation permits only an already-known active identity. */
export function validatePersistedTaskBindings(
  task: Pick<PersistedTask, "taskId" | "classification" | "targetBindings">,
  registry: TargetRegistry,
  options: TaskBindingValidationOptions = {},
): TaskBindingValidationResult {
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
  return validateBindingPolicy(bindings, registry, options);
}

/** The binding must never mutate once a task has entered durable history. */
export function assertBindingsImmutable(previous: TargetBindings, next: TargetBindings): void {
  const keys = (bindings: TargetBindings): Set<string> =>
    new Set(bindings.targets.map((binding) => `${binding.role}\u0000${binding.target_id}`));
  if (!sameSet(keys(previous), keys(next))) {
    throw new TaskBindingError("Target bindings are immutable after task creation; cancel this task and create a replacement");
  }
}
