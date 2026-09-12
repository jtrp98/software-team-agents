import * as fs from "node:fs";
import { TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { Budget } from "../cost/costControl.js";
import type { Environment } from "../environment/environment.js";
import { writeStateViewFromStore } from "../store/stateView.js";
import { TaskNotFoundError, type PersistedTask, type TaskStore } from "../store/taskStore.js";
import { TaskGraph, taskGraphFromPlan, type TaskNode } from "../graph/taskGraph.js";
import type { TargetBindings } from "../threeRepo/taskBindings.js";
import { Orchestrator } from "./orchestrator.js";
import { describeStatus, unmetDependencies, type TaskStatusView } from "./taskStatus.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import {
  buildRuntimeTask,
  type RuntimeTaskBuildInput,
  type RuntimeTaskWorkRoot,
} from "./runtimeTask.js";
import type { RunRecord } from "../observability/runLog.js";
import type { BusinessInputEvidence } from "../gates/businessInput.js";
import { readWorkPlan, type WorkPlanTask } from "../docs/planGraph.js";
import { readModuleDoc } from "../agents/moduleDocs.js";

export class UnknownDependencyError extends Error {
  constructor(public readonly taskId: string, public readonly missing: string[]) {
    super(
      `task ${taskId} depends on ${missing.join(", ")}, which do not exist in this store — ` +
        "create the tasks it depends on first, rather than leaving a dependency that can never be satisfied",
    );
    this.name = "UnknownDependencyError";
  }
}

export class DependencyNotMetError extends Error {
  constructor(public readonly taskId: string, public readonly waitingOn: string[]) {
    super(`task ${taskId} cannot run yet: ${waitingOn.join(", ")} must reach DEPLOYED first`);
    this.name = "DependencyNotMetError";
  }
}

export interface TaskRegistryOptions {
  store: TaskStore;
  budget?: Budget;
  now?: () => number;
  /** When set, `.workflow/state.yaml` is rewritten from the store whenever the registry is asked to refresh it. */
  stateViewPath?: string;
  /** Read-only plan authority for this invocation; persisted states supply completion. */
  planTasks?: () => readonly WorkPlanTask[] | null;
}

export interface TaskListing {
  task: PersistedTask;
  status: TaskStatusView;
}

/**
 * Owns the set of tasks and the order they may run in — the `Orchestrator`
 * only drives one task through its pipeline, so "run B after A" has to live
 * somewhere else.
 *
 * Dependencies are declared at creation and never edited, and a task may only
 * depend on tasks that already exist. Those two rules together make a cycle
 * structurally impossible — a new task can only ever point backwards — so
 * there is no cycle detector here, and no cycle to detect.
 *
 * This deliberately does not run two ready tasks at the same time; the value
 * here is only that a task whose dependency has not shipped cannot be
 * started at all.
 */
export class TaskRegistry {
  private readonly store: TaskStore;
  private readonly budget?: Budget;
  private readonly now?: () => number;
  private readonly stateViewPath?: string;
  private readonly planTasks?: TaskRegistryOptions["planTasks"];
  /** True while a `transaction()` is open: the file-backed state view cannot be rolled back, so it waits for the commit. */
  private deferStateView = false;

  constructor(opts: TaskRegistryOptions) {
    this.store = opts.store;
    this.budget = opts.budget;
    this.now = opts.now;
    this.stateViewPath = opts.stateViewPath;
    this.planTasks = opts.planTasks;
  }

  private orchestratorOptions() {
    return { store: this.store, budget: this.budget, now: this.now };
  }

  /** Reload authored input; persisted RuntimeTask fields are never a second plan authority. */
  private currentPlan(taskId?: string): readonly WorkPlanTask[] | null {
    const supplied = this.planTasks?.();
    if (supplied) return supplied;
    const tasks = taskId ? [this.store.loadTask(taskId)].filter((t): t is PersistedTask => t !== null) : this.store.listTasks();
    const sources = [...new Set(tasks.flatMap(t => t.runtimeTask && "version" in t.runtimeTask && t.runtimeTask.version === 2 ? [t.runtimeTask.plan_source] : []))];
    if (sources.length > 1) throw new Error("graph spans multiple plans; select an explicit module plan context");
    if (!sources.length) return null;
    const parsed = readWorkPlan(fs.readFileSync(sources[0], "utf8"));
    if (parsed.problems.length) throw new Error(`invalid current plan: ${parsed.problems.join("; ")}`);
    if (taskId && !parsed.tasks.some(t => t.id === taskId)) throw new Error(`task ${taskId} disappeared from its canonical plan; recompile`);
    return parsed.tasks;
  }

  create(params: {
    taskId: string;
    classification: ClassificationResult;
    dependsOn?: string[];
    environment?: Environment;
    targetBindings?: TargetBindings;
    /** Exact workflow identity; defaults only for legacy programmatic callers. */
    workflow?: string;
    /** Caller-supplied task/issue text. Existing callers may keep using taskId. */
    taskText?: RuntimeTaskBuildInput["taskText"];
    projectRoot?: string;
    docsRoot?: string;
    moduleName?: string;
    targetWorkRoots?: readonly RuntimeTaskWorkRoot[];
    changeAwareVerification?: boolean;
    /** Trusted intake supplied by the task creator; an executing agent cannot grant this to itself. */
    businessInput?: BusinessInputEvidence;
    adHoc?: boolean;
  }): Orchestrator {
    const planMd = params.moduleName ? readModuleDoc(params.docsRoot ?? params.projectRoot ?? defaultProjectRoot(), params.moduleName, "plan.md") : null;
    const parsed = planMd === null ? null : readWorkPlan(planMd);
    if (parsed?.problems.length) throw new Error(`task ${params.taskId}: invalid plan: ${parsed.problems.join("; ")}`);
    const plan = this.planTasks?.() ?? parsed?.tasks;
    const planned = plan?.some(t => t.id === params.taskId) ?? false;
    if (planned && params.adHoc) throw new Error(`task ${params.taskId}: a known plan task cannot use the ad-hoc path`);
    if (plan && !planned && !params.adHoc) throw new Error(`task ${params.taskId}: absent from plan; explicitly select --ad-hoc or correct the task ID`);
    const graphDependencies = planned ? taskGraphFromPlan(plan!).dependenciesOf(params.taskId) : [];
    if (planned && (params.dependsOn ?? []).some(id => !graphDependencies.includes(id))) throw new Error(`task ${params.taskId}: --depends-on disagrees with the plan graph; amend the plan`);
    const dependsOn = planned ? graphDependencies : params.dependsOn ?? [];
    const missing = dependsOn.filter((id) => this.store.loadTask(id) === null);
    if (missing.length > 0) throw new UnknownDependencyError(params.taskId, missing);

    const runtimeTask = buildRuntimeTask({
      taskId: params.taskId,
      workflow: params.workflow ?? `classification:${params.classification.level.toLowerCase()}`,
      classification: params.classification,
      dependsOn,
      projectRoot: params.projectRoot ?? defaultProjectRoot(),
      docsRoot: params.docsRoot,
      moduleName: params.moduleName,
      taskText: params.taskText,
      targetWorkRoots: params.targetWorkRoots,
      changeAwareVerification: params.changeAwareVerification,
    });

    const orchestrator = new Orchestrator(params.taskId, params.classification, {
      ...this.orchestratorOptions(),
      dependsOn,
      environment: params.environment,
      targetBindings: params.targetBindings,
      runtimeTask,
      businessInput: params.businessInput,
    });
    this.refreshStateView();
    return orchestrator;
  }

  /** Rebuilds a task that already exists. Does not check dependencies — inspecting a blocked task is legitimate. */
  resume(taskId: string): Orchestrator {
    return Orchestrator.resume(taskId, this.store, this.orchestratorOptions());
  }

  /**
   * The way a caller gets an orchestrator it intends to *run*: refuses while a
   * dependency has not reached DEPLOYED. Enforcing it here rather than inside
   * `Orchestrator` keeps the single-task machine unaware of other tasks, and
   * keeps this the only place the ordering rule lives.
   */
  open(taskId: string): Orchestrator {
    const task = this.store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const plan = this.currentPlan(taskId);
    const planned = plan?.some(t => t.id === taskId);
    const dependencies = planned ? taskGraphFromPlan(plan!).dependenciesOf(taskId) : task.dependsOn;
    if (planned && JSON.stringify([...dependencies].sort()) !== JSON.stringify([...task.dependsOn].sort())) throw new Error(`task ${taskId}: registered graph drift; explicitly recompile in a new attempt`);
    const waitingOn = this.waitingOn(taskId);
    if (waitingOn.length > 0) throw new DependencyNotMetError(taskId, waitingOn);
    return Orchestrator.fromPersisted(task, this.store, this.orchestratorOptions());
  }

  has(taskId: string): boolean {
    return this.store.loadTask(taskId) !== null;
  }

  /**
   * A human-imposed freeze, independent of the pipeline's own state.
   * `run`/`resume`/`retry` refuse to step a paused task (see cli.ts); `resume`/`retry` clear the
   * flag automatically, since asking to continue a task IS the un-pause action in a CLI with no
   * daemon to leave "paused-but-watchable" in the background.
   */
  pause(taskId: string): void {
    const task = this.store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.store.saveTask({ ...task, updatedAt: this.now?.() ?? Date.now(), paused: true });
    this.refreshStateView();
  }

  /** Clears a pause without otherwise touching the task — what `resume`/`retry` call before stepping it. */
  unpause(taskId: string): void {
    const task = this.store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (!task.paused) return;
    this.store.saveTask({ ...task, updatedAt: this.now?.() ?? Date.now(), paused: false });
    this.refreshStateView();
  }

  /**
   * Final, unlike pause: a cancelled task is not meant to be picked back up
   * (`resume`/`retry` refuse it too, see cli.ts). Distinct from `BLOCKED`: `BLOCKED` means the
   * system detected a problem (retry budget spent, an unresolved gate); `cancelled` means a human
   * deliberately gave up on the task for a reason of their own.
   */
  cancel(taskId: string, reason: string): void {
    const task = this.store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    this.store.saveTask({ ...task, updatedAt: this.now?.() ?? Date.now(), cancelled: true, cancelReason: reason });
    this.refreshStateView();
  }

  list(): TaskListing[] {
    const tasks = this.store.listTasks();
    return tasks.map((task) => ({ task, status: describeStatus(task, tasks) }));
  }

  runsForTask(taskId: string): RunRecord[] {
    return this.store.runsForTask(taskId);
  }

  /** Tasks that could be worked on right now: not finished, not blocked, every dependency DEPLOYED. */
  readyTasks(): PersistedTask[] {
    const tasks = this.store.listTasks();
    return tasks.filter(
      (t) =>
        t.machine.current !== TaskState.DEPLOYED &&
        t.machine.current !== TaskState.BLOCKED &&
        !t.cancelled && !t.paused && this.waitingOn(t.taskId).length === 0,
    );
  }

  /**
   * The stored tasks as a dependency graph.
   *
   * The registry's own ordering rule — a task may only depend on tasks that
   * already exist — makes a cycle structurally impossible, so this is not how
   * cycles are normally prevented. It is how they are *caught* anyway: a store
   * that was hand-edited, restored from a backup, or written by an older version
   * can hold a cycle the creation rule would have refused, and a task registry
   * that hangs forever is a much worse failure than one that says why.
   */
  graph(): TaskGraph {
    const plan = this.currentPlan();
    const tasks = this.store.listTasks();
    const plannedGraph = plan ? taskGraphFromPlan(plan) : null;
    const nodes: TaskNode[] = tasks.filter(t => !plannedGraph?.nodes.has(t.taskId)).map((t) => ({
      id: t.taskId,
      // Registry-only/ad-hoc pipelines have no plan owner or phase. Keep every
      // resolved edge; missing persisted ancestors fail closed.
      dependsOn: t.dependsOn,
    }));
    return new TaskGraph([...(plannedGraph?.nodes.values() ?? []), ...nodes]);
  }

  /**
   * Unfinished tasks grouped into batches that could run at the same time.
   *
   * This answers *what may run concurrently*, which is a planning question and
   * is genuinely useful on its own — it is what `--list` shows, and what tells
   * you whether a dependency chain has serialized work that did not need to be.
   *
   * It does not run anything concurrently. Doing that safely needs file-level
   * locking so two agents cannot write the same file at once, and starting
   * without it would trade a visible ordering problem for an invisible
   * corruption one.
   */
  readyLayers(): PersistedTask[][] {
    const tasks = this.store.listTasks();
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    const layers: PersistedTask[][] = [];
    for (const layer of this.graph().parallelLayers()) {
      const batch = layer
        .flatMap((node) => byId.has(node.id) ? [byId.get(node.id)!] : [])
        .filter((t) => t.machine.current !== TaskState.DEPLOYED && t.machine.current !== TaskState.BLOCKED);
      if (batch.length > 0) layers.push(batch);
    }
    return layers;
  }

  /** How much of this store's work could run in parallel, versus one task at a time. */
  parallelism(): { tasks: number; layers: number; widest: number; sequentialSpeedup: number } {
    return this.graph().parallelism();
  }

  waitingOn(taskId: string): string[] {
    const task = this.store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const tasks = this.store.listTasks();
    const plan = this.currentPlan(taskId);
    if (!plan?.some(t => t.id === taskId)) return unmetDependencies(task, tasks);
    const graph = taskGraphFromPlan(plan);
    if (JSON.stringify(graph.dependenciesOf(taskId).sort()) !== JSON.stringify([...task.dependsOn].sort())) throw new Error(`task ${taskId}: registered graph drift; explicitly recompile in a new attempt`);
    const completed = tasks.filter(t => t.machine.current === TaskState.DEPLOYED && !t.cancelled && !t.paused && unmetDependencies(t, tasks).length === 0).map(t => t.taskId);
    return graph.waitingOn(taskId, completed, plan.filter(t => t.status === "blocked").map(t => t.id));
  }

  /**
   * One all-or-nothing registration unit (T-V8-017).
   *
   * Two things have to be true together for whole-plan registration to be
   * atomic: the store writes must share a transaction, and the human-readable
   * `.workflow/state.yaml` must not be rewritten from a half-built store part
   * way through. The state view is a file, so it cannot participate in the
   * rollback — the fix is not to write it until the transaction has committed.
   */
  transaction<T>(fn: () => T): T {
    const outermost = !this.deferStateView;
    this.deferStateView = true;
    try {
      const result = this.store.transaction(fn);
      if (outermost) {
        this.deferStateView = false;
        this.refreshStateView();
      }
      return result;
    } finally {
      if (outermost) this.deferStateView = false;
    }
  }

  /** Rewrites the human-readable view, if this registry was given a path for it. */
  refreshStateView(): void {
    if (this.deferStateView) return;
    if (!this.stateViewPath) return;
    writeStateViewFromStore(this.stateViewPath, this.store, { now: this.now?.() ?? Date.now() });
  }

  close(): void {
    this.store.close();
  }
}
