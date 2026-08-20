import { TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { Budget } from "../cost/costControl.js";
import { writeStateViewFromStore } from "../store/stateView.js";
import { TaskNotFoundError, type PersistedTask, type TaskStore } from "../store/taskStore.js";
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

  create(params: { taskId: string; classification: ClassificationResult; dependsOn?: string[] }): Orchestrator {
    const dependsOn = params.dependsOn ?? [];
    const missing = dependsOn.filter((id) => this.store.loadTask(id) === null);
    if (missing.length > 0) throw new UnknownDependencyError(params.taskId, missing);

    const orchestrator = new Orchestrator(params.taskId, params.classification, {
      ...this.orchestratorOptions(),
      dependsOn,
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
