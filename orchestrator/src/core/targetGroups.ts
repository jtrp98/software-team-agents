import { readModuleDoc } from "../agents/moduleDocs.js";
import { parseCanonicalPlan, type PlanTask } from "../docs/planTask.js";
import type { WorkRun } from "./workRunStore.js";

/**
 * One bounded run per Target.
 *
 * `sta bounded-run` pins a run to ONE git repository (its git-identity root:
 * run branch, base SHA, checkpoints, resume checks) and refuses a scope that
 * spans several Targets unless a person names that root. A module whose plan
 * touches a backend and a frontend repository is the normal case, so STA Core
 * never asks: it splits the work run's scope into one group per Target set and
 * drives each group as its own bounded run, in dependency order. Every
 * repository gets its own run branch to review, and a task that depends on a
 * task in another group simply waits for it through the shared task store.
 */

export interface TargetGroup {
  /** Stable key: the sorted Target ids joined with "+", or "" for tasks that name no Target. */
  key: string;
  targetIds: string[];
  taskIds: string[];
}

function inScope(task: PlanTask, scope: WorkRun["scope"]): boolean {
  if (scope.kind === "tasks") return scope.taskIds.includes(task.id);
  if (task.status === "verified") return false;
  if (scope.kind === "phase") return task.phase === scope.phase;
  return true;
}

/**
 * Groups the in-scope tasks by the Target set each declares and orders the
 * groups so a group runs after every group it depends on (plan order breaks
 * ties; a dependency cycle between groups keeps plan order rather than guess).
 */
export function groupTasksByTarget(tasks: readonly PlanTask[], scope: WorkRun["scope"]): TargetGroup[] {
  const selected = tasks.filter((task) => inScope(task, scope));
  const groups = new Map<string, TargetGroup>();
  const groupOf = new Map<string, string>();
  for (const task of selected) {
    const targetIds = [...new Set(task.targets ?? [])].sort();
    const key = targetIds.join("+");
    if (!groups.has(key)) groups.set(key, { key, targetIds, taskIds: [] });
    groups.get(key)!.taskIds.push(task.id);
    groupOf.set(task.id, key);
  }
  const keys = [...groups.keys()];
  const after = new Map<string, Set<string>>(keys.map((key) => [key, new Set<string>()]));
  for (const task of selected) {
    const own = groupOf.get(task.id)!;
    for (const dep of task.dependsOn ?? []) {
      const other = groupOf.get(dep);
      if (other !== undefined && other !== own) after.get(own)!.add(other);
    }
  }
  const ordered: string[] = [];
  const remaining = new Set(keys);
  while (remaining.size > 0) {
    const ready = keys.find((key) => remaining.has(key) && [...after.get(key)!].every((dep) => !remaining.has(dep)));
    const next = ready ?? keys.find((key) => remaining.has(key))!;
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered.map((key) => groups.get(key)!);
}

/** Production: read the module's own plan.md from its own Knowledge root. */
export function planTargetGroups(knowledgePath: string, module: string, scope: WorkRun["scope"]): TargetGroup[] {
  const markdown = readModuleDoc(knowledgePath, module, "plan.md");
  if (markdown === null) return [];
  return groupTasksByTarget(parseCanonicalPlan(markdown).tasks, scope);
}
