import { TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { Budget } from "../cost/costControl.js";
import type { Environment } from "../environment/environment.js";
import { writeStateViewFromStore } from "../store/stateView.js";
import { TaskNotFoundError, type PersistedTask, type TaskStore } from "../store/taskStore.js";
import { TaskGraph, type TaskNode } from "../graph/taskGraph.js";
import { Orchestrator } from "./orchestrator.js";
import { describeStatus, unmetDependencies, type TaskStatusView } from "./taskStatus.js";

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
}

export interface TaskListing {
  task: PersistedTask;
  status: TaskStatusView;
}

/**
 * Owns the set of tasks and the order they may run in.
 *
 * The `Orchestrator` drives one task through its pipeline; nothing before T01
 * knew that more than one task existed, so "run B after A" was a fact kept in
 * the head of whoever was running the pipeline. This holds it instead.
 *
 * Dependencies are declared at creation and never edited, and a task may only
 * depend on tasks that already exist. Those two rules together make a cycle
 * structurally impossible — a new task can only ever point backwards — so
 * there is no cycle detector here, and no cycle to detect.
 *
 * What this deliberately does *not* do is run two ready tasks at the same
 * time. Parallel execution is T10's DAG work; the value here is that a task
 * whose dependency has not shipped cannot be started at all, which is what
 * ordering by hand kept getting wrong.
 */
export class TaskRegistry {
  private readonly store: TaskStore;
  private readonly budget?: Budget;
  private readonly now?: () => number;
  private readonly stateViewPath?: string;

  constructor(opts: TaskRegistryOptions) {
    this.store = opts.store;
    this.budget = opts.budget;
    this.now = opts.now;
    this.stateViewPath = opts.stateViewPath;
  }

  private orchestratorOptions() {
    return { store: this.store, budget: this.budget, now: this.now };
  }

  create(params: {
    taskId: string;
    classification: ClassificationResult;
    dependsOn?: string[];
    environment?: Environment;
  }): Orchestrator {
    const dependsOn = params.dependsOn ?? [];
    const missing = dependsOn.filter((id) => this.store.loadTask(id) === null);
    if (missing.length > 0) throw new UnknownDependencyError(params.taskId, missing);

    const orchestrator = new Orchestrator(params.taskId, params.classification, {
      ...this.orchestratorOptions(),
      dependsOn,
      environment: params.environment,
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
    const waitingOn = unmetDependencies(task, this.store.listTasks());
    if (waitingOn.length > 0) throw new DependencyNotMetError(taskId, waitingOn);
    return Orchestrator.fromPersisted(task, this.store, this.orchestratorOptions());
  }

  has(taskId: string): boolean {
    return this.store.loadTask(taskId) !== null;
  }

  /**
   * T31's `pause` verb — a human-imposed freeze, independent of the pipeline's own state.
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
   * T31's `cancel` verb — final, unlike pause: a cancelled task is not meant to be picked back up
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

  /** Tasks that could be worked on right now: not finished, not blocked, every dependency DEPLOYED. */
  readyTasks(): PersistedTask[] {
    const tasks = this.store.listTasks();
    return tasks.filter(
      (t) =>
        t.machine.current !== TaskState.DEPLOYED &&
        t.machine.current !== TaskState.BLOCKED &&
        unmetDependencies(t, tasks).length === 0,
    );
  }

  /**
   * The stored tasks as a dependency graph (T11).
   *
   * The registry's own ordering rule — a task may only depend on tasks that
   * already exist — makes a cycle structurally impossible, so this is not how
   * cycles are normally prevented. It is how they are *caught* anyway: a store
   * that was hand-edited, restored from a backup, or written by an older version
   * can hold a cycle the creation rule would have refused, and a task registry
   * that hangs forever is a much worse failure than one that says why.
   */
  graph(): TaskGraph {
    const tasks = this.store.listTasks();
    const known = new Set(tasks.map((t) => t.taskId));
    const nodes: TaskNode[] = tasks.map((t) => ({
      id: t.taskId,
      // Dependencies on tasks the store no longer holds are dropped rather than
      // treated as an error: a deleted task cannot be waited for, and refusing to
      // build the graph at all would make the whole registry unusable over one
      // stale row.
      dependsOn: t.dependsOn.filter((id) => known.has(id)),
    }));
    return new TaskGraph(nodes);
  }

  /**
   * Unfinished tasks grouped into batches that could run at the same time (T10).
   *
   * This answers *what may run concurrently*, which is a planning question and
   * is genuinely useful on its own — it is what `--list` shows, and what tells
   * you whether a dependency chain has serialized work that did not need to be.
   *
   * It does not run anything concurrently. Doing that safely needs file-level
   * locking so two agents cannot write the same file at once (T35), and starting
   * without it would trade a visible ordering problem for an invisible
   * corruption one.
   */
  readyLayers(): PersistedTask[][] {
    const tasks = this.store.listTasks();
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    const layers: PersistedTask[][] = [];
    for (const layer of this.graph().parallelLayers()) {
      const batch = layer
        .map((node) => byId.get(node.id)!)
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
    return unmetDependencies(task, this.store.listTasks());
  }

  /** Rewrites the human-readable view, if this registry was given a path for it. */
  refreshStateView(): void {
    if (!this.stateViewPath) return;
    writeStateViewFromStore(this.stateViewPath, this.store, { now: this.now?.() ?? Date.now() });
  }

  close(): void {
    this.store.close();
  }
}
