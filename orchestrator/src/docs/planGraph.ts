import * as fs from "node:fs";
import * as path from "node:path";
import { taskGraphFromPlan, type PlanGraphTask } from "../graph/taskGraph.js";
import { loadModelTiers, ModelTiersInvalidError, type ModelTiers } from "../runtime/modelTiers.js";
import { detectWorkspaceKind } from "../targetcli/roleWorkspace.js";
import { isCanonicalPlan, parseCanonicalPlan, type PlanTask } from "./planTask.js";
import { readModuleTargets } from "./moduleTargets.js";
import {
  loadTargetRegistry,
  TARGET_TYPE_ROLES,
  targetById,
  targetsPath,
  TargetRegistryError,
  type TargetRegistry,
} from "../threeRepo/targets.js";

/**
 * The canonical plan.md task sections as a machine-checkable graph.
 *
 * Parses every canonical task section, then validates the graph
 * without an LLM — duplicate ids,
 * missing/self/duplicate dependencies, cycles, unknown owners, unknown
 * statuses and missing DES traceability.
 * Every failure names its task id, because "somewhere in phase 3" is not
 * actionable.
 *
 * Waves are *derived* here, never persisted as truth: `deriveWaves` layers the
 * graph the same way runtime scheduling would (declared dependencies plus
 * phase order — a later phase's work never starts before an earlier phase's,
 * which is the task graph's reading).
 *
 * Readiness is also derived, not read: `readinessOf` treats `verified` rows
 * (qa-engineer's mark, the only writer) as satisfied dependencies and answers
 * "what may start now" from the document as it stands. Nothing here writes
 * runtime state — that remains the orchestrator's store's job; this
 * is the plan-side mirror a person or a driver reads before creating tasks.
 *
 * Document readiness is a human view only, and after T-V8-029 that is all it
 * is: planned execution reads the frozen ledger DAG (`RunLedger.readiness`),
 * not this file, and there is no longer any export that prints a readiness
 * warning and proceeds past an unmet edge.
 */

export type WorkPlanTask = PlanTask;

export interface ParsedPlan {
  tasks: PlanTask[];
  problems: string[];
}
/** Parses only the current canonical PlanTask format. */
export function parsePlanTasks(planMd: string): ParsedPlan {
  return parseCanonicalPlan(planMd);
}

export function readWorkPlan(planMd: string): ParsedPlan {
  return parseCanonicalPlan(planMd);
}

export function taskDesignRefs(task: WorkPlanTask): string[] {
  return task.traceability.filter((id) => id.startsWith("DES-"));
}

export function taskObjective(task: WorkPlanTask): string {
  return task.objective;
}

function validateConfiguredTiers(
  tasks: readonly PlanTask[],
  modelTiers: ModelTiers | null,
  isKnowledgeWorkspace: boolean,
): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    if (!task.tier) continue;
    if (modelTiers === null) {
      errors.push(
        isKnowledgeWorkspace
          ? `task ${task.id} casts ${task.tier}, but model-tiers.yaml is missing from this Knowledge workspace's synced payload — resync with \`software-team-agents sync\` to restore it`
          : `task ${task.id} casts ${task.tier}, but model-tiers.yaml is not configured`,
      );
    } else if (!(task.tier in modelTiers)) {
      errors.push(`task ${task.id} casts ${task.tier}, which is absent from model-tiers.yaml`);
    }
  }
  return errors;
}

/**
 * Execution waves derived from the plan's own edges: declared dependencies plus
 * phase order. Wave 1 has no unresolved prerequisite; every task in wave N only
 * waits on strictly lower waves. Not runtime state — the orchestrator still
 * checks dependency status before dispatch.
 */
export function deriveWaves(tasks: readonly PlanGraphTask[]): Map<string, number> {
  const graph = taskGraphFromPlan(tasks);
  const waves = new Map<string, number>();
  graph.parallelLayers().forEach((layer, i) => layer.forEach((n) => waves.set(n.id, i + 1)));
  return waves;
}

export interface PlanWaiting<T = WorkPlanTask> {
  task: T;
  /** Dependency ids not yet `verified`. */
  waitingOn: string[];
}

export interface PlanReadiness<T = WorkPlanTask> {
  /** `pending`, every dependency `verified` — may start now, in document order. */
  ready: T[];
  /** `in_progress` — started, not finished. */
  started: T[];
  done: T[];
  /** `blocked` rows, plus every pending row behind one — named so downstream stalls are visible, not silent. */
  stalledByBlocked: T[];
  waiting: PlanWaiting<T>[];
  /** Static waves over the whole plan (derived, 1-based). */
  waves: Map<string, number>;
}

/**
 * The ready-task selector for a plan, answered from the document's
 * own Status cells: `pending` AND every dependency `verified` AND not itself
 * blocked. A failed (`blocked`) dependency is never satisfied, so everything
 * downstream stays out of `ready` — visible in `waiting` with the reason.
 * Pure function of the parsed rows: re-running after a retry/resume cannot
 * drift, because there is no stored readiness to drift from.
 */
export function readinessOf<T extends WorkPlanTask>(tasks: readonly T[]): PlanReadiness<T> {
  const graph = taskGraphFromPlan(tasks);
  const verified = new Set(tasks.filter((t) => t.status === "verified").map((t) => t.id));
  const blockedIds = new Set(tasks.filter((t) => t.status === "blocked").map((t) => t.id));
  const stalledIds = new Set([...blockedIds].flatMap(id => graph.descendantsOf(id)));

  const ready: T[] = [];
  const started: T[] = [];
  const done: T[] = [];
  const stalledByBlocked: T[] = [];
  const waiting: PlanWaiting<T>[] = [];

  for (const task of tasks) {
    if (task.status === "verified") {
      done.push(task);
      continue;
    }
    if (task.status === "blocked") {
      stalledByBlocked.push(task);
      continue;
    }
    if (task.status === "in_progress") {
      started.push(task);
      continue;
    }
    const unmet = graph.waitingOn(task.id, verified, blockedIds);
    if (stalledIds.has(task.id)) {
      stalledByBlocked.push(task);
      continue;
    }
    if (unmet.length > 0) {
      waiting.push({ task, waitingOn: unmet });
      continue;
    }
    ready.push(task);
  }

  const waves = deriveWaves(tasks);
  return { ready, started, done, stalledByBlocked, waiting, waves };
}

export interface PlanGraphModuleResult {
  module: string;
  ok: boolean;
  errors: string[];
  notes: string[];
}

/** Loads `targets.yaml` for Target checks; `null` when it is not reachable from this workspace. */
export type PlanTargetRegistryLoader = () => TargetRegistry | null;

/**
 * The engineer roles a Target's `type` admits — the only owners a type can
 * validate. Other owners carrying `Targets:` are still checked for resolution,
 * retirement and module scope; AD-4 keeps their stages derived from the work,
 * never from the Target type.
 */
const ENGINEER_TARGET_OWNERS: ReadonlySet<string> = new Set(["frontend-engineer", "backend-engineer"]);

export interface PlanTaskTargetCheckResult {
  errors: string[];
  notes: string[];
}

/**
 * Validates every canonical task's authored `Targets:` against the registry the
 * T-V9-007 resolver reads — each id must resolve in `targets.yaml`, be active,
 * sit inside the module's declared `## Targets` set (T-V9-004's parser), and
 * have a `type` that admits the task's `Owner` (the `TARGET_TYPE_ROLES` table
 * T-V9-008's binding validation uses, so plan and runtime give one answer).
 * Every error names the task id, the Target id and the fix.
 *
 * `Targets:` is optional: a plan whose tasks declare none engages nothing here,
 * and a workspace where `targets.yaml` is unreachable skips the checks with a
 * note — the same failure-tolerant reading `loadModelTiers` uses for its
 * missing table. A registry that exists but is invalid still fails the check:
 * skipping on a broken registry would hide exactly the fact a plan author needs.
 */
export function validatePlanTaskTargets(
  tasks: readonly PlanTask[],
  context: { module: string; designMd: string | null; projectRoot: string; loadRegistry: PlanTargetRegistryLoader },
): PlanTaskTargetCheckResult {
  const result: PlanTaskTargetCheckResult = { errors: [], notes: [] };
  const declaring = tasks.filter((task) => (task.targets?.length ?? 0) > 0);
  if (declaring.length === 0) return result;

  const registry = context.loadRegistry();
  if (registry === null) {
    result.notes.push(
      `targets.yaml is not reachable from ${targetsPath(context.projectRoot)} — Target checks on ${declaring.length} task(s) declaring Targets: are skipped; run --check-plan where the registry lives (the Knowledge workspace) to validate them`,
    );
    return result;
  }

  const declared = context.designMd === null ? [] : readModuleTargets(context.designMd);
  const designPath = path.join(context.projectRoot, "_docs", "module", context.module, "design.md");
  if (declared.length === 0) {
    // Reached only because some task declares `Targets:`. Keeping this a note
    // let a plan bind Targets the module never scoped, and runtime binding
    // validation would be the first thing to say so (V10 TASK-011).
    result.errors.push(
      `module "${context.module}" declares no Targets in ${designPath}, but ${declaring.length} task(s) declare Targets: — add a "## Targets" section listing every Target id those tasks use, or remove Targets: from them`,
    );
  }
  const declaredSet = new Set(declared);

  for (const task of declaring) {
    for (const targetId of task.targets!) {
      let entry;
      try {
        entry = targetById(registry, targetId);
      } catch {
        result.errors.push(
          `task ${task.id}: Target "${targetId}" is not present in ${targetsPath(context.projectRoot)} — add "${targetId}" to targets.yaml or remove it from this task's Targets:`,
        );
        continue;
      }
      if (entry.status === "retired") {
        result.errors.push(
          `task ${task.id}: Target "${targetId}" is retired — reactivate it in targets.yaml before planning work against it, or remove it from this task's Targets:`,
        );
      }
      if (declared.length > 0 && !declaredSet.has(targetId)) {
        result.errors.push(
          `task ${task.id}: Target "${targetId}" is outside module "${context.module}" declared ## Targets (${declared.join(", ")}) — add "${targetId}" to ${designPath} ## Targets, or bind the task to a declared Target`,
        );
      }
      if (entry.type !== undefined && ENGINEER_TARGET_OWNERS.has(task.owner) && !TARGET_TYPE_ROLES[entry.type].includes(task.owner)) {
        result.errors.push(
          `task ${task.id}: Owner "${task.owner}" is not admitted by Target "${targetId}" type "${entry.type}" (${TARGET_TYPE_ROLES[entry.type].join(", ")}) — change the task's Owner to an admitted role, or correct the Target type in targets.yaml if the repository scope is wrong`,
        );
      }
    }
  }
  return result;
}

/** Validates one module's plan.md (and its design.md DES refs, when design.md exists). */
export function checkPlanGraphForModule(
  docsModuleDir: string,
  module: string,
  modelTiers: ModelTiers | null = null,
  isKnowledgeWorkspace = false,
  targetRegistryLoader: PlanTargetRegistryLoader | null = null,
): PlanGraphModuleResult {
  const planPath = path.join(docsModuleDir, module, "plan.md");
  const notes: string[] = [];
  if (!fs.existsSync(planPath)) {
    return { module, ok: true, errors: [], notes: [`${module}/plan.md does not exist yet — nothing to graph-check`] };
  }
  const designPath = path.join(docsModuleDir, module, "design.md");
  const designMd = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8") : undefined;

  const planMd = fs.readFileSync(planPath, "utf8");
  if (isCanonicalPlan(planMd)) {
    const requirementPath = path.join(docsModuleDir, module, "requirement.md");
    const requirementMd = fs.existsSync(requirementPath) ? fs.readFileSync(requirementPath, "utf8") : "";
    const canonical = parseCanonicalPlan(planMd, { requirementMd, designMd: designMd ?? "" });
    const projectRoot = path.join(docsModuleDir, "..", "..");
    const loadRegistry = targetRegistryLoader ?? (() => (fs.existsSync(targetsPath(projectRoot)) ? loadTargetRegistry(projectRoot) : null));
    const targetCheck = canonical.problems.length === 0
      ? validatePlanTaskTargets(canonical.tasks, { module, designMd: designMd ?? null, projectRoot, loadRegistry })
      : { errors: [], notes: [] };
    const tierErrors = validateConfiguredTiers(canonical.tasks, modelTiers, isKnowledgeWorkspace);
    return { module,
      ok: canonical.problems.length === 0 && targetCheck.errors.length === 0 && tierErrors.length === 0,
      errors: [...canonical.problems, ...targetCheck.errors, ...tierErrors],
      notes: [
        `${module}/plan.md: ${canonical.tasks.length} canonical task(s), format 1; ${canonical.problems.length ? 0 : Math.max(0, ...deriveWaves(canonical.tasks).values())} wave(s)`,
        ...targetCheck.notes,
      ] };
  }
  const noncanonical = parseCanonicalPlan(planMd);
  return {
    module,
    ok: false,
    errors: noncanonical.problems,
    notes: [`${module}/plan.md: not current canonical PlanTask format 1`],
  };
}

export interface PlanGraphCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * The check `--check-plan` runs: every module's plan.md becomes a validated
 * DAG. A project with no `_docs/module/` yet is the normal pre-BA state — a
 * note, not a failure, matching `--check-doc-structure`'s reading.
 */
export function checkPlanGraphs(projectRoot: string, moduleName?: string): PlanGraphCheckResult {
  const docsModuleDir = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(docsModuleDir)) {
    return { ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to check."] };
  }

  const modules = moduleName
    ? [moduleName]
    : fs
        .readdirSync(docsModuleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  if (!moduleName && modules.length === 0) {
    return { ok: true, problems: [], notes: ["`_docs/module/` has no module folders yet."] };
  }
  if (moduleName && !fs.existsSync(path.join(docsModuleDir, moduleName))) {
    return { ok: false, problems: [`module "${moduleName}" has no folder under _docs/module/`], notes: [] };
  }

  let modelTiers: ModelTiers | null;
  try {
    modelTiers = loadModelTiers(projectRoot);
  } catch (error) {
    if (error instanceof ModelTiersInvalidError) {
      return { ok: false, problems: [error.message], notes: [] };
    }
    throw error;
  }

  const isKnowledgeWorkspace = detectWorkspaceKind(projectRoot) === "knowledge";
  // Loaded at most once per check, and only when a canonical task actually
  // declares Targets: — a missing registry is the tolerated skip-with-note
  // case (see validatePlanTaskTargets); a present-but-invalid one fails the
  // check the same way an invalid model-tiers.yaml does.
  let targetRegistry: TargetRegistry | null | undefined;
  const loadRegistry: PlanTargetRegistryLoader = () => {
    if (targetRegistry === undefined) {
      targetRegistry = fs.existsSync(targetsPath(projectRoot)) ? loadTargetRegistry(projectRoot) : null;
    }
    return targetRegistry;
  };
  const problems: string[] = [];
  const notes: string[] = [];
  for (const module of modules) {
    let result: PlanGraphModuleResult;
    try {
      result = checkPlanGraphForModule(docsModuleDir, module, modelTiers, isKnowledgeWorkspace, loadRegistry);
    } catch (error) {
      if (error instanceof TargetRegistryError) {
        return { ok: false, problems: [error.message], notes };
      }
      throw error;
    }
    notes.push(...result.notes);
    problems.push(...result.errors.map((e) => `${module}/plan.md: ${e}`));
  }
  return { ok: problems.length === 0, problems, notes };
}
