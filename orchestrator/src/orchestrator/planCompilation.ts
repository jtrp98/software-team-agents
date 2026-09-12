import { AgentStage } from "../types.js";
import { classifyTask, type ClassificationInput, type ClassificationResult } from "../classification/taskClassifier.js";
import { isCanonicalPlan, parseCanonicalPlan, planTaskHash, type PlanReferences, type PlanTask } from "../docs/planTask.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { LEDGER_SCHEMA_VERSION, type LedgerRun, type LedgerTask, type RunBoundary, type RunLedger } from "../ledger/runLedger.js";
import type { TaskStore } from "../store/taskStore.js";
import type { TaskRegistry } from "./taskRegistry.js";
import { canonicalPlanHash, type RuntimeTaskWorkRoot } from "./runtimeTask.js";
import type { Environment } from "../environment/environment.js";
import type { TargetBindings } from "../threeRepo/taskBindings.js";

/**
 * T-V8-017 — compile and register one fixed plan in a single transaction.
 *
 * Replaces the operator ritual of preparing every task with
 * `sta run --task-id … --register-only` before a bounded run could start. That
 * loop was not only friction: each call was its own transaction, so an
 * interruption halfway through left a partially registered dependency graph
 * that readiness and resume would both read as authoritative.
 *
 * Everything here is validation followed by one `registry.transaction(...)`.
 * A refusal is thrown *inside* that callback wherever possible, because the
 * store's rollback is what turns "this plan is not registrable" into "no
 * registration state changed" without a compensating undo path to get wrong.
 */

export type PlanRunScope =
  | { kind: "all" }
  | { kind: "phase"; phase: number }
  | { kind: "tasks"; taskIds: readonly string[] };

export type PlanRegistrationRefusalKind =
  | "invalid-plan"
  | "legacy-plan"
  | "empty-scope"
  | "unknown-task"
  | "scope-not-closed"
  | "graph"
  | "classification-conflict"
  | "already-registered"
  | "drift";

export class PlanRegistrationError extends Error {
  constructor(
    public readonly kind: PlanRegistrationRefusalKind,
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length > 0 ? `${message}\n- ${details.join("\n- ")}` : message);
    this.name = "PlanRegistrationError";
  }
}

export interface PlanRegistrationInput {
  registry: TaskRegistry;
  store: TaskStore;
  ledger: RunLedger;
  /** The authored plan.md bytes. Never re-read inside the transaction. */
  planMarkdown: string;
  /** requirement.md/design.md, for the same cross-reference validation `--check-plan` performs. */
  references?: PlanReferences;
  scope: PlanRunScope;
  runId: string;
  module: string;
  boundary: RunBoundary;
  targetId: string;
  targetRoot: string;
  knowledgeRoot: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  configHash: string;
  requirementHash?: string | null;
  designHash?: string | null;
  staVersion: string;
  maxTasks?: number;
  now?: () => number;
  /**
   * Per-task classification. Supplied rather than derived because a PlanTask
   * records risk, not work kind — see `classificationInputForPlanTask`, which
   * derives the half that *is* derivable and leaves the rest to the caller.
   */
  classificationFor?: (task: PlanTask) => ClassificationInput;
  /** Task-creation context passed through to the registry, per task. */
  taskContextFor: (task: PlanTask) => {
    projectRoot?: string;
    docsRoot?: string;
    workflow?: string;
    taskText?: string;
    environment?: Environment;
    targetBindings?: TargetBindings;
    targetWorkRoots?: readonly RuntimeTaskWorkRoot[];
    changeAwareVerification?: boolean;
  };
}

export interface PlanRegistrationResult {
  run: LedgerRun;
  tasks: LedgerTask[];
  planHash: string;
  /** Ordered, human-readable record of what the one transaction did. */
  trace: string[];
}

/** The half of `PlanRegistrationInput` a read-only resolve needs — no run/target/branch identity yet. */
export type PlanScopeResolutionInput = Pick<PlanRegistrationInput, "planMarkdown" | "references" | "scope" | "module" | "registry" | "store" | "classificationFor">;

export interface ResolvedPlanTask {
  taskId: string;
  owner: AgentStage;
  phase: number;
  dependsOn: string[];
  produces: string[];
  consumes: string[];
  classification: ClassificationResult;
}

/**
 * The pure, non-mutating half of plan compilation: validate, hash and order
 * one scope. `compileAndRegisterPlan` and `previewPlanRegistration` both call
 * this and only this to answer "what scope, in what order, under what plan
 * hash" — so a preview and the run it precedes are never two computations
 * that merely ought to agree, they are one. Classification is deliberately
 * not resolved here — see `previewPlanRegistration`.
 */
export function resolvePlanScope(input: PlanScopeResolutionInput): { order: string[]; planHash: string; byId: Map<string, PlanTask>; trace: string[] } {
  if (!isCanonicalPlan(input.planMarkdown)) {
    throw new PlanRegistrationError(
      "legacy-plan",
      `module ${input.module}: plan.md is not canonical PlanTask format 1; convert it explicitly with migrateLegacyTaskTable ` +
        "(see docs/plan-task-v1.md) rather than having a bounded run reinterpret a legacy table",
    );
  }
  const parsed = parseCanonicalPlan(input.planMarkdown, input.references);
  if (parsed.problems.length > 0) {
    throw new PlanRegistrationError("invalid-plan", `module ${input.module}: plan.md is not registrable`, parsed.problems);
  }

  const selected = selectScope(parsed.tasks, input.scope);
  if (selected.length === 0) {
    throw new PlanRegistrationError("empty-scope", `module ${input.module}: the selected scope contains no task`);
  }

  const selectedIds = new Set(selected.map((task) => task.id));
  const notClosed: string[] = [];
  for (const task of selected) {
    for (const dependency of task.dependsOn) {
      if (selectedIds.has(dependency)) continue;
      const stored = input.store.loadTask(dependency);
      if (!stored) notClosed.push(`task ${task.id} depends on ${dependency}, which is neither in this scope nor registered`);
    }
  }
  if (notClosed.length > 0) {
    throw new PlanRegistrationError("scope-not-closed", `module ${input.module}: selected scope is not dependency-closed`, notClosed);
  }

  let order: string[];
  try {
    const graph = taskGraphFromPlan(selected);
    order = graph.parallelLayers().flatMap((layer) => layer.map((node) => node.id).sort());
  } catch (error) {
    throw new PlanRegistrationError("graph", `module ${input.module}: plan graph is not executable: ${String(error)}`);
  }

  const byId = new Map(selected.map((task) => [task.id, task]));
  const already = selected.filter((task) => input.registry.has(task.id));
  if (already.length > 0) {
    throw new PlanRegistrationError(
      "already-registered",
      `module ${input.module}: task(s) ${already.map((task) => task.id).join(", ")} are already registered; ` +
        "immutable registration metadata is never replaced — select a different scope or start a new plan",
    );
  }

  const planHash = runScopeHash(order.map((id) => byId.get(id)!));
  const trace: string[] = [
    `plan_hash=${planHash} tasks=${order.length} scope=${input.scope.kind}`,
    `order=${order.join(" -> ")}`,
  ];

  return { order, planHash, byId, trace };
}

/**
 * Read-only preview of what `compileAndRegisterPlan` would freeze for this
 * scope: selected task order, plan hash and per-task classification/gates —
 * with no ledger run created, no task registered, and no store touched.
 *
 * Order/hash/refusals come from `resolvePlanScope`, the exact function
 * `compileAndRegisterPlan` calls for the same purpose, so the two can never
 * disagree about the scope itself. Classification is recomputed here from the
 * same deterministic inputs (`classificationFor`/`classificationInputForPlanTask`
 * + `classifyTask`) rather than threaded through from `resolvePlanScope`,
 * because `compileAndRegisterPlan` must classify each task interleaved with
 * its own registration (a fault mid-loop must leave earlier tasks visible
 * pre-rollback) — a second, purely-for-display pass here does not disturb that.
 */
export function previewPlanRegistration(input: PlanScopeResolutionInput): { order: string[]; planHash: string; tasks: ResolvedPlanTask[]; trace: string[] } {
  const resolved = resolvePlanScope(input);
  const conflictProblems: string[] = [];
  const tasks: ResolvedPlanTask[] = resolved.order.map((taskId) => {
    const task = resolved.byId.get(taskId)!;
    const classification = classifyTask(input.classificationFor?.(task) ?? classificationInputForPlanTask(task));
    conflictProblems.push(...classificationConflicts(task, classification));
    return {
      taskId,
      owner: task.owner as AgentStage,
      phase: task.phase,
      dependsOn: [...task.dependsOn],
      produces: [...task.produces],
      consumes: [...task.consumes],
      classification,
    };
  });
  if (conflictProblems.length > 0) {
    throw new PlanRegistrationError("classification-conflict", `module ${input.module}: classification contradicts authored plan risk`, conflictProblems);
  }
  return { order: resolved.order, planHash: resolved.planHash, tasks, trace: resolved.trace };
}

/**
 * Identity for the exact tasks this run froze, in the exact order it froze them.
 *
 * Deliberately the same `canonicalPlanHash` the RuntimeTask compiler uses
 * rather than a second definition of "the plan hash" — but computed over the
 * *selected, ordered* subset, because a run's identity is its own scope, not
 * whatever else happens to sit in the same plan.md.
 */
export function runScopeHash(orderedTasks: readonly PlanTask[]): string {
  return canonicalPlanHash(orderedTasks);
}

/**
 * The half of classification a canonical PlanTask genuinely determines.
 *
 * Risk and human-gate cells are authored facts about *this* task, so they map
 * straight through. Work kind (new feature / bug fix / copy change) is not a
 * PlanTask field and is not invented here: `isIncrementalFeature` is the
 * defensible default only because a canonical PlanTask exists solely downstream
 * of BA/SA/PM — the analysis this flag would otherwise re-run has, by
 * construction, already happened — and a caller may override it.
 */
export function classificationInputForPlanTask(task: PlanTask, overrides: ClassificationInput = {}): ClassificationInput {
  const derived: ClassificationInput = {
    isIncrementalFeature: true,
    touchesSchema: task.risk.includes("schema") || task.humanGate.includes("schema"),
    touchesSensitiveArea:
      task.risk.includes("security") || task.risk.includes("authorization") || task.humanGate.includes("security"),
    isProductionDeployOrMigration: task.humanGate.includes("deployment") || task.humanGate.includes("migration"),
    touchesBackend: task.owner === AgentStage.BACKEND_ENGINEER,
    touchesFrontend: task.owner === AgentStage.FRONTEND_ENGINEER,
  };
  return { ...derived, ...overrides };
}

/** The authored risk facts a supplied classification may not contradict. */
function classificationConflicts(task: PlanTask, classification: ClassificationResult): string[] {
  const derived = classificationInputForPlanTask(task);
  const problems: string[] = [];
  if (derived.touchesSchema && classification.touchesSchema !== true) {
    problems.push(`task ${task.id}: plan risk/gate declares a schema change but the supplied classification does not`);
  }
  if (derived.touchesSensitiveArea && !classification.sensitiveGate) {
    problems.push(`task ${task.id}: plan risk/gate declares a security-sensitive change but the supplied classification sets no security gate`);
  }
  if (task.humanGate.length > 0 && !classification.requiresHumanApproval && !classification.sensitiveGate) {
    problems.push(`task ${task.id}: plan declares human gate(s) ${task.humanGate.join(", ")} but the supplied classification requires no approval`);
  }
  return problems;
}

function selectScope(tasks: readonly PlanTask[], scope: PlanRunScope): PlanTask[] {
  if (scope.kind === "all") return [...tasks];
  if (scope.kind === "phase") return tasks.filter((task) => task.phase === scope.phase);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const missing = scope.taskIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new PlanRegistrationError("unknown-task", `selected task(s) are not in this plan: ${missing.join(", ")}`);
  }
  // Selection order never decides execution order — the graph does.
  return tasks.filter((task) => scope.taskIds.includes(task.id));
}

/**
 * Validate, hash, order and register. Either every selected task is registered
 * under one run identity, or nothing changed.
 */
export function compileAndRegisterPlan(input: PlanRegistrationInput): PlanRegistrationResult {
  const now = input.now ?? Date.now;
  const resolved = resolvePlanScope(input);
  const { order, planHash, byId } = resolved;
  const trace = [...resolved.trace];
  const timestamp = now();

  const run: LedgerRun = {
    ledger_version: LEDGER_SCHEMA_VERSION,
    run_id: input.runId,
    status: "CREATED",
    boundary: input.boundary,
    module: input.module,
    target_id: input.targetId,
    target_root: input.targetRoot,
    knowledge_root: input.knowledgeRoot,
    base_branch: input.baseBranch,
    base_sha: input.baseSha,
    run_branch: input.runBranch,
    requirement_hash: input.requirementHash ?? null,
    design_hash: input.designHash ?? null,
    plan_hash: planHash,
    config_hash: input.configHash,
    sta_version: input.staVersion,
    task_order: order,
    max_tasks: input.maxTasks ?? order.length,
    created_at: timestamp,
    updated_at: timestamp,
    halt_reason: null,
  };

  const ledgerTasks: LedgerTask[] = order.map((taskId, position) => {
    const task = byId.get(taskId)!;
    return {
      run_id: input.runId,
      task_id: taskId,
      status: "PLANNED",
      owner: task.owner as AgentStage,
      phase: task.phase,
      depends_on: [...task.dependsOn],
      produces: [...task.produces],
      consumes: [...task.consumes],
      task_hash: planTaskHash(task),
      position,
      updated_at: timestamp,
    };
  });

  input.registry.transaction(() => {
    input.ledger.createRun(run);
    input.ledger.registerTasks(ledgerTasks);
    trace.push(`ledger: run ${input.runId} created with ${ledgerTasks.length} task record(s)`);

    for (const taskId of order) {
      const task = byId.get(taskId)!;
      const classification = classifyTask(input.classificationFor?.(task) ?? classificationInputForPlanTask(task));
      const conflicts = classificationConflicts(task, classification);
      if (conflicts.length > 0) {
        throw new PlanRegistrationError("classification-conflict", `module ${input.module}: classification contradicts authored plan risk`, conflicts);
      }
      const context = input.taskContextFor(task);
      input.registry.create({
        taskId,
        classification,
        environment: context.environment,
        targetBindings: context.targetBindings,
        workflow: context.workflow,
        taskText: context.taskText,
        projectRoot: context.projectRoot,
        docsRoot: context.docsRoot,
        moduleName: input.module,
        targetWorkRoots: context.targetWorkRoots,
        changeAwareVerification: context.changeAwareVerification,
      });
      trace.push(
        `registered ${taskId} owner=${task.owner} phase=${task.phase} level=${classification.level} ` +
          `pipeline=${classification.pipeline.join(">")} depends_on=${task.dependsOn.join(",") || "none"}`,
      );
    }

    input.ledger.setRunStatus(input.runId, "REGISTERED", { reason: `atomic registration of ${order.length} task(s)` });
  });

  const registered = input.ledger.readRun(input.runId)!;
  return { run: registered, tasks: input.ledger.readTasks(input.runId), planHash, trace };
}

/**
 * Refuses to continue a frozen run whose plan bytes have since changed.
 *
 * Separate from `assertRunIdentity` because this one recomputes the hash from
 * the *current* plan file, which is the check `--resume` needs and which a
 * caller holding only the run record cannot perform.
 */
export function assertPlanUnchanged(run: LedgerRun, planMarkdown: string, references?: PlanReferences): void {
  const parsed = parseCanonicalPlan(planMarkdown, references);
  if (parsed.problems.length > 0) {
    throw new PlanRegistrationError("invalid-plan", `run ${run.run_id}: the current plan.md no longer parses`, parsed.problems);
  }
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  const missing = run.task_order.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new PlanRegistrationError(
      "drift",
      `run ${run.run_id}: task(s) ${missing.join(", ")} disappeared from the current plan.md; recompile explicitly`,
    );
  }
  const current = runScopeHash(run.task_order.map((id) => byId.get(id)!));
  if (current !== run.plan_hash) {
    throw new PlanRegistrationError(
      "drift",
      `run ${run.run_id}: plan_hash drifted (run=${run.plan_hash}, current=${current}); ` +
        "recompile explicitly in a new run rather than executing a frozen scope against edited tasks",
    );
  }
}
