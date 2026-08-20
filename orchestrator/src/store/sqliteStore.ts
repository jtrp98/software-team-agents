import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";
import {
  PersistedEventSchema,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  parsePersistedTask,
  type PersistedEvent,
  type PersistedTask,
  type TaskStore,
} from "./taskStore.js";

/**
 * The real store: one local SQLite file, no server, no daemon.
 *
 * Why a database file rather than the `.workflow/state.yaml` TASKS.md T02
 * sketches: a run is a sequence of small writes after every transition, and a
 * YAML file rewritten on each one is neither atomic nor safe against two
 * processes (T35's concurrency lock has to be built by hand on top of it).
 * SQLite gives both for free. The human-readable half of T02 is not dropped —
 * `store/stateView.ts` regenerates `.workflow/state.yaml` from this file, as a
 * view, which is also what T51 asks for.
 *
 * Task state lives in one JSON column rather than a column per field on
 * purpose. Nothing here queries inside a task's state, and a normalised schema
 * would have to be migrated in lockstep with `PersistedTaskSchema` — two
 * definitions of the same shape, which is exactly the drift this pipeline
 * spends so much effort avoiding elsewhere. Runs and events *are* real columns,
 * because those are the rows worth querying (cost per task, why it failed).
 */

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  agent          TEXT NOT NULL,
  start_time     INTEGER NOT NULL,
  end_time       INTEGER NOT NULL,
  duration       INTEGER NOT NULL,
  tokens         INTEGER NOT NULL,
  cost           REAL NOT NULL,
  result         TEXT NOT NULL,
  retry_count    INTEGER NOT NULL,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS runs_task_id ON runs (task_id);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_id ON events (task_id);
`;

export class SchemaVersionMismatchError extends Error {
  constructor(public readonly found: number, public readonly expected: number) {
    super(
      `state database was written by schema version ${found}, this build expects ${expected} — ` +
        "refusing to read it rather than resuming a task from state it may misread",
    );
    this.name = "SchemaVersionMismatchError";
  }
}

interface TaskRow {
  task_id: string;
  state: string;
}

interface RunRow {
  task_id: string;
  agent: string;
  start_time: number;
  end_time: number;
  duration: number;
  tokens: number;
  cost: number;
  result: string;
  retry_count: number;
  failure_reason: string | null;
}

interface EventRow {
  task_id: string;
  at: number;
  type: string;
  payload: string;
}

export class SqliteTaskStore implements TaskStore {
  private readonly db: Database.Database;

  /** `:memory:` is accepted for tests; any other path has its parent directory created. */
  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    }
    this.db = new Database(filePath);
    // WAL keeps a reader (`agent status`) from blocking the run that is writing.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);

    const found = Number((this.db.pragma("user_version", { simple: true }) as number) ?? 0);
    if (found === 0) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (found !== SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaVersionMismatchError(found, SCHEMA_VERSION);
    }
  }

  createTask(task: PersistedTask): void {
    const exists = this.db.prepare("SELECT 1 FROM tasks WHERE task_id = ?").get(task.taskId);
    if (exists) throw new TaskAlreadyExistsError(task.taskId);
    this.db
      .prepare("INSERT INTO tasks (task_id, created_at, updated_at, state) VALUES (?, ?, ?, ?)")
      .run(task.taskId, task.createdAt, task.updatedAt, JSON.stringify(task));
  }

  saveTask(task: PersistedTask): void {
    const info = this.db
      .prepare("UPDATE tasks SET updated_at = ?, state = ? WHERE task_id = ?")
      .run(task.updatedAt, JSON.stringify(task), task.taskId);
    if (info.changes === 0) throw new TaskNotFoundError(task.taskId);
  }

  loadTask(taskId: string): PersistedTask | null {
    const row = this.db.prepare("SELECT task_id, state FROM tasks WHERE task_id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!row) return null;
    return parsePersistedTask(taskId, JSON.parse(row.state));
  }

  listTasks(): PersistedTask[] {
    const rows = this.db
      .prepare("SELECT task_id, state FROM tasks ORDER BY created_at ASC, task_id ASC")
      .all() as TaskRow[];
    return rows.map((r) => parsePersistedTask(r.task_id, JSON.parse(r.state)));
  }

  appendRun(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (task_id, agent, start_time, end_time, duration, tokens, cost, result, retry_count, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.task_id,
        record.agent,
        record.start_time,
        record.end_time,
        record.duration,
        record.tokens,
        record.cost,
        record.result,
        record.retry_count,
        record.failure_reason,
      );
  }

  runsForTask(taskId: string): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC").all(taskId) as RunRow[];
    return rows.map((r) => ({
      task_id: r.task_id,
      agent: r.agent as AgentStage,
      start_time: r.start_time,
      end_time: r.end_time,
      duration: r.duration,
      tokens: r.tokens,
      cost: r.cost,
      result: r.result === "FAIL" ? "FAIL" : "PASS",
      retry_count: r.retry_count,
      failure_reason: r.failure_reason,
    }));
  }

  appendEvent(event: PersistedEvent): void {
    this.db
      .prepare("INSERT INTO events (task_id, at, type, payload) VALUES (?, ?, ?, ?)")
      .run(event.taskId, event.at, event.type, JSON.stringify(event.payload));
  }

  eventsForTask(taskId: string): PersistedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC").all(taskId) as EventRow[];
    return rows.map((r) =>
      PersistedEventSchema.parse({ taskId: r.task_id, at: r.at, type: r.type, payload: JSON.parse(r.payload) }),
    );
  }

  close(): void {
    this.db.close();
  }
}
