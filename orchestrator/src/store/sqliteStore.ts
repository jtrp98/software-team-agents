import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";
import {
  PersistedEventSchema,
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

// v2 (T26/T28): added runs.model/input_tokens/output_tokens/cache_read_tokens/context_chars.
// v3 (T37): added events.actor/reason/input/output/decision — the audit trail's WHO/WHY/INPUT/
//           OUTPUT/DECISION.
// v4 (T57): added runs.prompt_version — same nullable-column shape as v2 -> v3, migrated the
//           same way, for the same reason: an old row simply reads back "not recorded".
// v5 (three-repo Phase 2): adds targetBindings inside the task JSON document.
// v6 (QA07): adds runs.qa_mode — the verify mode a qa-engineer round ran in, so TARGETED vs
//            FULL is queryable per run instead of re-parsed out of review.md prose. Same
//            nullable-column shape as v3 -> v4: an old row reads back null ("not recorded").
//
// v2 -> v3, v3 -> v4 and v5 -> v6 are migrated in place (see MIGRATIONS below), unlike v1 -> v2
// which still fails closed. The difference is what is being added and what it would cost to get
// it wrong: nullable columns that an old row simply reads as null with nothing guessed and
// nothing lost. v1 -> v2 changed the columns a *run* is read through, where a silent misread
// would corrupt cost and token accounting that nothing downstream could tell was wrong. An
// unknown version still refuses to open at all.
// v7 (token observability): adds nullable runtime/session/composition fields. Historical rows
// remain explicitly "not reported"; this migration never infers a breakdown.
// v8: records full module-doc bytes alongside the sliced prompt bytes.
// v9: records deterministic-gate enabled/disabled for optimized QA runs.
// v10: records warning-only context-budget accounting and overflow telemetry.
// v11: records launch-time always-on instruction bytes for interactive sessions.
// v12 (T-V3R-002): records requested-vs-actual routing and fallback decisions. All five fields
// are nullable because historical runs did not report them and must not be backfilled.
// v14 (T-V3R-060): records the orthogonal QA effort decision. Historical rows stay null.
// v15 (T-V4-COST-001): records deterministic input-token estimates. Historical rows stay null.
// v16 (T-V4-COST-006): records agent-frontmatter effort independently from qa_effort.
const SCHEMA_VERSION = 16;

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL,
  agent              TEXT NOT NULL,
  start_time         INTEGER NOT NULL,
  end_time           INTEGER NOT NULL,
  duration           INTEGER NOT NULL,
  model              TEXT,
  tokens             INTEGER NOT NULL,
  cost               REAL NOT NULL,
  result             TEXT NOT NULL,
  retry_count        INTEGER NOT NULL,
  failure_reason     TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  context_chars      INTEGER,
  estimated_input_tokens INTEGER,
  prompt_version     INTEGER,
  effort             TEXT,
  qa_mode            TEXT,
  qa_effort          TEXT,
  deterministic_gate TEXT,
  runtime            TEXT,
  requested_runtime  TEXT,
  requested_model    TEXT,
  routing_basis      TEXT,
  fallback_reason    TEXT,
  fallback_count     INTEGER,
  session_kind       TEXT,
  static_chars       INTEGER,
  instruction_surface_bytes INTEGER,
  handoff_chars      INTEGER,
  doc_chars          INTEGER,
  doc_chars_before   INTEGER,
  knowledge_chars    INTEGER,
  code_intel_chars   INTEGER,
  tool_output_chars          INTEGER,
  context_budget_chars       INTEGER,
  context_budget_source      TEXT,
  context_overflow_chars     INTEGER,
  context_budget_warning     INTEGER,
  context_base_chars         INTEGER,
  context_task_chars         INTEGER,
  context_safety_chars       INTEGER,
  context_docs_chars         INTEGER,
  context_knowledge_chars    INTEGER,
  context_code_chars         INTEGER,
  context_tool_output_chars  INTEGER,
  context_reserve_chars      INTEGER
);
CREATE INDEX IF NOT EXISTS runs_task_id ON runs (task_id);
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,
  actor    TEXT,
  reason   TEXT,
  input    TEXT,
  output   TEXT,
  decision TEXT
);
CREATE INDEX IF NOT EXISTS events_task_id ON events (task_id);
`;

/** The columns T37 adds to `events`. Named once so the DDL above and the migration below cannot drift apart. */
const EVENT_AUDIT_COLUMNS = ["actor", "reason", "input", "output", "decision"] as const;

export class SchemaVersionMismatchError extends Error {
  constructor(public readonly found: number, public readonly expected: number) {
    super(
      `state database was written by schema version ${found}, this build expects ${expected} — ` +
        "refusing to read it rather than resuming a task from state it may misread",
    );
    this.name = "SchemaVersionMismatchError";
  }
}

/**
 * T47 (Disaster Recovery) — "database unavailable" as a named, actionable failure instead of
 * whatever raw error `better-sqlite3`/`fs` happened to throw reaching the terminal as a bare
 * stack trace. This is deliberately narrow: it only wraps *opening* the store (the constructor),
 * not every query — a query failing mid-run for its own reason (a real bug, a corrupt row) should
 * still surface as itself, not get relabelled "unavailable" and hidden behind a generic message.
 *
 * Nothing is written before the constructor succeeds (WAL mode + DDL run before any task row is
 * touched), so once whatever made the file unavailable clears — the disk had no space, another
 * process held an incompatible lock, the parent directory couldn't be created — the exact same
 * `resume`/`retry` command picks the task back up with nothing lost. This class exists so a
 * person hits a clear message instead of a crash, not so anything gets auto-retried: retrying a
 * database open by itself, without knowing why it failed, is exactly the kind of guess CLAUDE.md's
 * "verify against real state, not memory" rule warns against.
 */
export class DatabaseUnavailableError extends Error {
  constructor(public readonly filePath: string, public readonly cause: unknown) {
    super(
      `cannot open the state database at ${filePath}: ${cause instanceof Error ? cause.message : String(cause)} — ` +
        "this is likely transient (disk full, another process holding an incompatible lock, the path " +
        "unreachable) rather than corrupt state; once it clears, resume/retry with the same task id " +
        "continues from exactly where it left off, since nothing was written before this failed.",
    );
    this.name = "DatabaseUnavailableError";
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
  model: string | null;
  tokens: number;
  cost: number;
  result: string;
  retry_count: number;
  failure_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  context_chars: number | null;
  estimated_input_tokens: number | null;
  prompt_version: number | null;
  effort: string | null;
  qa_mode: string | null;
  qa_effort: string | null;
  deterministic_gate: string | null;
  runtime: string | null;
  requested_runtime: string | null;
  requested_model: string | null;
  routing_basis: string | null;
  fallback_reason: string | null;
  fallback_count: number | null;
  session_kind: string | null;
  static_chars: number | null;
  instruction_surface_bytes: number | null;
  handoff_chars: number | null;
  doc_chars: number | null;
  doc_chars_before: number | null;
  knowledge_chars: number | null;
  code_intel_chars: number | null;
  tool_output_chars: number | null;
  context_budget_chars: number | null;
  context_budget_source: string | null;
  context_overflow_chars: number | null;
  context_budget_warning: number | null;
  context_base_chars: number | null;
  context_task_chars: number | null;
  context_safety_chars: number | null;
  context_docs_chars: number | null;
  context_knowledge_chars: number | null;
  context_code_chars: number | null;
  context_tool_output_chars: number | null;
  context_reserve_chars: number | null;
}

interface EventRow {
  task_id: string;
  at: number;
  type: string;
  payload: string;
  actor: string | null;
  reason: string | null;
  input: string | null;
  output: string | null;
  decision: string | null;
}

/**
 * Forward migrations, keyed by the version being left.
 *
 * Only the steps that can be applied without interpreting existing data live
 * here. Adding a nullable column qualifies: every existing row keeps exactly the
 * meaning it had, and the new column reads as "not recorded", which is true.
 * Anything that would need a row rewritten — a changed unit, a split field —
 * does not belong in a silent startup path, and this map having no entry for it
 * is what makes the store refuse to open instead.
 */
const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  2: (db) => {
    // `events` predates T37; the DDL above only creates the columns on a fresh file.
    const existing = new Set((db.pragma("table_info(events)") as { name: string }[]).map((c) => c.name));
    for (const column of EVENT_AUDIT_COLUMNS) {
      if (!existing.has(column)) db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`);
    }
  },
  3: (db) => {
    // `runs` predates T57; the DDL above only creates the column on a fresh file.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("prompt_version")) db.exec("ALTER TABLE runs ADD COLUMN prompt_version INTEGER");
  },
  4: (db) => {
    // Target bindings live in the versioned task JSON document. PersistedTaskSchema
    // supplies null defaults for historical rows, so this migration intentionally
    // changes no history bytes and cannot invent a Target identity.
    void db;
  },
  5: (db) => {
    // QA07: runs predating the qa_mode column simply read back "not recorded".
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("qa_mode")) db.exec("ALTER TABLE runs ADD COLUMN qa_mode TEXT");
  },
  6: (db) => {
    // Every T-V3TOK-001 field is nullable. A v6 row did not measure these
    // values, so null is the only truthful migration result (never zero).
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    const columns: ReadonlyArray<[string, "TEXT" | "INTEGER"]> = [
      ["runtime", "TEXT"],
      ["session_kind", "TEXT"],
      ["static_chars", "INTEGER"],
      ["handoff_chars", "INTEGER"],
      ["doc_chars", "INTEGER"],
      ["knowledge_chars", "INTEGER"],
      ["code_intel_chars", "INTEGER"],
      ["tool_output_chars", "INTEGER"],
    ];
    for (const [column, type] of columns) if (!existing.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`);
  },
  7: (db) => {
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("doc_chars_before")) db.exec("ALTER TABLE runs ADD COLUMN doc_chars_before INTEGER");
  },
  8: (db) => {
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("deterministic_gate")) db.exec("ALTER TABLE runs ADD COLUMN deterministic_gate TEXT");
  },
  9: (db) => {
    // Warning-only context budget telemetry. Historical rows did not measure
    // any of this, so every new nullable field stays null rather than guessed.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    const columns: ReadonlyArray<[string, "TEXT" | "INTEGER"]> = [
      ["context_budget_chars", "INTEGER"], ["context_budget_source", "TEXT"], ["context_overflow_chars", "INTEGER"],
      ["context_budget_warning", "INTEGER"], ["context_base_chars", "INTEGER"], ["context_task_chars", "INTEGER"],
      ["context_safety_chars", "INTEGER"], ["context_docs_chars", "INTEGER"], ["context_knowledge_chars", "INTEGER"],
      ["context_code_chars", "INTEGER"], ["context_tool_output_chars", "INTEGER"], ["context_reserve_chars", "INTEGER"],
    ];
    for (const [column, type] of columns) if (!existing.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`);
  },
  10: (db) => {
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("instruction_surface_bytes")) db.exec("ALTER TABLE runs ADD COLUMN instruction_surface_bytes INTEGER");
  },
  11: (db) => {
    // T-V3R-002: old rows have no truthful requested route or fallback facts.
    // Nullable columns preserve every legacy value byte-for-byte and read as
    // "not reported" without inventing a backfill.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    const columns: ReadonlyArray<[string, "TEXT" | "INTEGER"]> = [
      ["requested_runtime", "TEXT"],
      ["requested_model", "TEXT"],
      ["routing_basis", "TEXT"],
      ["fallback_reason", "TEXT"],
      ["fallback_count", "INTEGER"],
    ];
    for (const [column, type] of columns) if (!existing.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`);
  },
  12: (db) => {
    // T-V3R-010: RuntimeTask lives in the existing versioned task JSON.
    // PersistedTaskSchema supplies null for historical v12 rows, so migration
    // is additive and deliberately does not rewrite their state bytes.
    void db;
  },
  13: (db) => {
    // T-V3R-060: a pre-v14 run has no recorded effort decision; null is the
    // only truthful value and keeps the mode/effort axes independently queryable.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("qa_effort")) db.exec("ALTER TABLE runs ADD COLUMN qa_effort TEXT");
  },
  14: (db) => {
    // T-V4-COST-001: an old row has no honest estimate, so it remains null.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("estimated_input_tokens")) db.exec("ALTER TABLE runs ADD COLUMN estimated_input_tokens INTEGER");
  },
  15: (db) => {
    // T-V4-COST-006: old rows have no configured agent effort to report.
    const existing = new Set((db.pragma("table_info(runs)") as { name: string }[]).map((c) => c.name));
    if (!existing.has("effort")) db.exec("ALTER TABLE runs ADD COLUMN effort TEXT");
  },
};

export class SqliteTaskStore implements TaskStore {
  private readonly db: Database.Database;

  /** `:memory:` is accepted for tests; any other path has its parent directory created. */
  constructor(filePath: string) {
    try {
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
        this.migrate(found);
      }
    } catch (e) {
      // SchemaVersionMismatchError is already a specific, well-messaged refusal (and already
      // closed the handle itself in migrate()) — pass it through unchanged rather than
      // relabelling a deliberate refusal as "unavailable" (T47).
      if (e instanceof SchemaVersionMismatchError) throw e;
      throw new DatabaseUnavailableError(filePath, e);
    }
  }

  /**
   * Walks the file forward one version at a time, or refuses to open it.
   *
   * Every step runs in one transaction: a half-migrated database is the one
   * outcome worse than a refused one, because it looks openable and is not.
   */
  private migrate(from: number): void {
    // A file from a *newer* build is not a migration problem, it is a downgrade:
    // this code cannot know what changed, so walking forward would run off the end.
    if (from > SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaVersionMismatchError(from, SCHEMA_VERSION);
    }
    let version = from;
    while (version !== SCHEMA_VERSION) {
      const step = MIGRATIONS[version];
      if (!step) {
        this.db.close();
        throw new SchemaVersionMismatchError(from, SCHEMA_VERSION);
      }
      const next = version + 1;
      this.db.transaction(() => {
        step(this.db);
        this.db.pragma(`user_version = ${next}`);
      })();
      version = next;
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
        `INSERT INTO runs (task_id, agent, start_time, end_time, duration, model, tokens, cost, result, retry_count, failure_reason, input_tokens, output_tokens, cache_read_tokens, context_chars, estimated_input_tokens, prompt_version, effort, qa_mode, qa_effort, deterministic_gate, runtime, requested_runtime, requested_model, routing_basis, fallback_reason, fallback_count, session_kind, static_chars, instruction_surface_bytes, handoff_chars, doc_chars, doc_chars_before, knowledge_chars, code_intel_chars, tool_output_chars, context_budget_chars, context_budget_source, context_overflow_chars, context_budget_warning, context_base_chars, context_task_chars, context_safety_chars, context_docs_chars, context_knowledge_chars, context_code_chars, context_tool_output_chars, context_reserve_chars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.task_id,
        record.agent,
        record.start_time,
        record.end_time,
        record.duration,
        record.model,
        record.tokens,
        record.cost,
        record.result,
        record.retry_count,
        record.failure_reason,
        record.input_tokens,
        record.output_tokens,
        record.cache_read_tokens,
        record.context_chars,
        record.estimated_input_tokens,
        record.promptVersion,
        record.effort,
        record.qa_mode,
        record.qa_effort,
        record.deterministic_gate,
        record.runtime,
        record.requested_runtime,
        record.requested_model,
        record.routing_basis,
        record.fallback_reason,
        record.fallback_count,
        record.session_kind,
        record.static_chars,
        record.instruction_surface_bytes ?? null,
        record.handoff_chars,
        record.doc_chars,
        record.doc_chars_before,
        record.knowledge_chars,
        record.code_intel_chars,
        record.tool_output_chars,
        record.context_budget_chars,
        record.context_budget_source,
        record.context_overflow_chars,
        record.context_budget_warning === null ? null : Number(record.context_budget_warning),
        record.context_base_chars,
        record.context_task_chars,
        record.context_safety_chars,
        record.context_docs_chars,
        record.context_knowledge_chars,
        record.context_code_chars,
        record.context_tool_output_chars,
        record.context_reserve_chars,
      );
  }

  runsForTask(taskId: string): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC").all(taskId) as RunRow[];
    return rows.map((r) => this.runRecordFromRow(r));
  }

  allRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY id ASC").all() as RunRow[];
    return rows.map((r) => this.runRecordFromRow(r));
  }

  private runRecordFromRow(r: RunRow): RunRecord {
    return {
      task_id: r.task_id,
      agent: r.agent as AgentStage,
      start_time: r.start_time,
      end_time: r.end_time,
      duration: r.duration,
      model: r.model,
      promptVersion: r.prompt_version,
      effort: r.effort,
      tokens: r.tokens,
      cost: r.cost,
      result: r.result === "FAIL" ? "FAIL" : "PASS",
      retry_count: r.retry_count,
      failure_reason: r.failure_reason,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      context_chars: r.context_chars,
      estimated_input_tokens: r.estimated_input_tokens,
      qa_mode: r.qa_mode === "FULL" || r.qa_mode === "TARGETED" ? r.qa_mode : null,
      qa_effort: r.qa_effort === "skip" || r.qa_effort === "lightweight" || r.qa_effort === "full" ? r.qa_effort : null,
      deterministic_gate: r.deterministic_gate === "enabled" || r.deterministic_gate === "disabled" ? r.deterministic_gate : null,
      runtime: r.runtime,
      requested_runtime: r.requested_runtime,
      requested_model: r.requested_model,
      routing_basis: r.routing_basis,
      fallback_reason: r.fallback_reason,
      fallback_count: r.fallback_count,
      session_kind: r.session_kind === "orchestrated" || r.session_kind === "interactive" ? r.session_kind : null,
      static_chars: r.static_chars,
      instruction_surface_bytes: r.instruction_surface_bytes,
      handoff_chars: r.handoff_chars,
      doc_chars: r.doc_chars,
      doc_chars_before: r.doc_chars_before,
      knowledge_chars: r.knowledge_chars,
      code_intel_chars: r.code_intel_chars,
      tool_output_chars: r.tool_output_chars,
      context_budget_chars: r.context_budget_chars,
      context_budget_source: r.context_budget_source === "role" || r.context_budget_source === "model_context_window" ? r.context_budget_source : null,
      context_overflow_chars: r.context_overflow_chars,
      context_budget_warning: r.context_budget_warning === null ? null : r.context_budget_warning !== 0,
      context_base_chars: r.context_base_chars,
      context_task_chars: r.context_task_chars,
      context_safety_chars: r.context_safety_chars,
      context_docs_chars: r.context_docs_chars,
      context_knowledge_chars: r.context_knowledge_chars,
      context_code_chars: r.context_code_chars,
      context_tool_output_chars: r.context_tool_output_chars,
      context_reserve_chars: r.context_reserve_chars,
    };
  }

  appendEvent(event: NewEvent): void {
    const record = parseNewEvent(event);
    this.db
      .prepare(
        `INSERT INTO events (task_id, at, type, payload, actor, reason, input, output, decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.taskId,
        record.at,
        record.type,
        JSON.stringify(record.payload),
        record.actor,
        record.reason,
        record.input,
        record.output,
        record.decision,
      );
  }

  eventsForTask(taskId: string): PersistedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC").all(taskId) as EventRow[];
    return rows.map((r) =>
      PersistedEventSchema.parse({
        taskId: r.task_id,
        at: r.at,
        type: r.type,
        payload: JSON.parse(r.payload),
        actor: r.actor,
        reason: r.reason,
        input: r.input,
        output: r.output,
        decision: r.decision,
      }),
    );
  }

  close(): void {
    this.db.close();
  }
}
