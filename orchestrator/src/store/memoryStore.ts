import type { RunRecord } from "../observability/runLog.js";
import {
  TaskAlreadyExistsError,
  TaskNotFoundError,
  parseNewEvent,
  parsePersistedTask,
  type NewEvent,
  type PersistedEvent,
  type PersistedTask,
  type TaskStore,
} from "./taskStore.js";

/**
 * In-memory TaskStore. This is the store the existing 155 tests keep using —
 * they were written before persistence existed and must not start depending
 * on a file on disk to keep passing.
 *
 * It clones on the way in and on the way out for a reason beyond tidiness:
 * the SQLite store serialises through JSON, so it *cannot* hand back a live
 * reference. If this one did, a bug where the orchestrator mutates a stored
 * task in place would pass in every test and only appear against the real
 * store. Both implementations behave the same way or the tests are worthless.
 */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, PersistedTask>();
  private runs: RunRecord[] = [];
  private events: PersistedEvent[] = [];

  createTask(task: PersistedTask): void {
    if (this.tasks.has(task.taskId)) throw new TaskAlreadyExistsError(task.taskId);
    this.tasks.set(task.taskId, structuredClone(task));
  }

  saveTask(task: PersistedTask): void {
    if (!this.tasks.has(task.taskId)) throw new TaskNotFoundError(task.taskId);
    this.tasks.set(task.taskId, structuredClone(task));
  }

  loadTask(taskId: string): PersistedTask | null {
    const found = this.tasks.get(taskId);
    // Re-parsed, not just cloned: same trust rule as the SQLite store, so a
    // schema change breaks loudly in tests instead of only in production.
    return found ? parsePersistedTask(taskId, structuredClone(found)) : null;
  }

  listTasks(): PersistedTask[] {
    return [...this.tasks.values()]
      .map((t) => structuredClone(t))
      .sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  }

  appendRun(record: RunRecord): void {
    this.runs.push({ ...record });
  }

  runsForTask(taskId: string): RunRecord[] {
    return this.runs.filter((r) => r.task_id === taskId).map((r) => ({ ...r }));
  }

  appendEvent(event: NewEvent): void {
    // Normalised on the way in, exactly as the SQLite store does — an event read
    // back from memory must carry the same audit fields (T37) it would carry
    // after a round trip through a real database, or the tests stop meaning anything.
    this.events.push(parseNewEvent(structuredClone(event) as NewEvent));
  }

  eventsForTask(taskId: string): PersistedEvent[] {
    return this.events.filter((e) => e.taskId === taskId).map((e) => structuredClone(e));
  }

  close(): void {
    /* nothing to release */
  }
}
