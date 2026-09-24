import type { RunRecord } from "../observability/runLog.js";
import { checkEvidenceAppend, parseStoredEvidence, type EvidenceRecord } from "../evidence/evidenceStore.js";
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
 * In-memory TaskStore, used by tests written before persistence existed.
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
  private evidence: EvidenceRecord[] = [];
  private inTransaction = false;

  /**
   * Snapshot-and-restore, which is what "transaction" means for three in-memory
   * collections. It has to behave identically to the SQLite store's rollback or
   * the atomicity tests written against this store prove nothing about the real
   * one — the same reasoning as the clone-in/clone-out rule above.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    const tasks = new Map([...this.tasks].map(([id, task]) => [id, structuredClone(task)] as const));
    const runs = this.runs.map((r) => ({ ...r }));
    const events = this.events.map((e) => structuredClone(e));
    const evidence = this.evidence.map((e) => structuredClone(e));
    this.inTransaction = true;
    try {
      return fn();
    } catch (error) {
      this.tasks = tasks;
      this.runs = runs;
      this.events = events;
      this.evidence = evidence;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

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

  allRuns(): RunRecord[] {
    return this.runs.map((r) => ({ ...r }));
  }

  appendEvent(event: NewEvent): void {
    // Normalised on the way in, exactly as the SQLite store does — an event read
    // back from memory must carry the same audit fields it would carry after a
    // round trip through a real database, or the tests stop meaning anything.
    this.events.push(parseNewEvent(structuredClone(event) as NewEvent));
  }

  eventsForTask(taskId: string): PersistedEvent[] {
    return this.events.filter((e) => e.taskId === taskId).map((e) => structuredClone(e));
  }

  appendEvidence(record: EvidenceRecord): EvidenceRecord {
    const stored = parseStoredEvidence(record.evidenceId, structuredClone(record));
    const existing = this.loadEvidence(stored.evidenceId);
    const write = checkEvidenceAppend(stored, existing, (ref) =>
      this.evidence.some((e) => e.evidenceId === ref && e.taskId === stored.taskId),
    );
    if (write) this.evidence.push(stored);
    return structuredClone(existing ?? stored);
  }

  loadEvidence(evidenceId: string): EvidenceRecord | null {
    const found = this.evidence.find((e) => e.evidenceId === evidenceId);
    return found ? parseStoredEvidence(evidenceId, structuredClone(found)) : null;
  }

  evidenceForTask(taskId: string): EvidenceRecord[] {
    return this.evidence
      .filter((e) => e.taskId === taskId)
      .map((e) => parseStoredEvidence(e.evidenceId, structuredClone(e)));
  }

  close(): void {
    /* nothing to release */
  }
}
