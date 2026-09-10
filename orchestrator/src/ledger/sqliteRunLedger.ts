import * as path from "node:path";
import type { Finding } from "../artifacts/finding.js";
import type { ApprovalRecord } from "../gates/approval.js";
import { readFindingsForTask } from "../state/runtimeArtifacts.js";
import type { SqliteTaskStore } from "../store/sqliteStore.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import {
  LedgerAmbiguityError,
  LedgerAttemptSchema,
  LedgerCheckpointSchema,
  LedgerConflictError,
  LedgerEventSchema,
  LedgerNotFoundError,
  LedgerRunSchema,
  LedgerTaskSchema,
  type LedgerAttempt,
  type LedgerCheckpoint,
  type LedgerEvent,
  type LedgerReadiness,
  type LedgerRun,
  type LedgerTask,
  type NewLedgerEvent,
  type RunLedger,
} from "./runLedger.js";
import {
  SETTLED_TASK_STATUSES,
  TERMINAL_RUN_STATUSES,
  applyAttemptStatus,
  applyRunStatus,
  applyTaskStatus,
  type LedgerAttemptStatus,
  type LedgerRunStatus,
  type LedgerTaskStatus,
} from "./vocabulary.js";

/**
 * T-V8-016 — the canonical transactional ledger.
 *
 * It shares one `better-sqlite3` handle with the `SqliteTaskStore` it is built
 * from, which is the whole point: a plan registration writes task rows and
 * ledger rows in one transaction, so "either the entire selected plan is
 * registered or no registration state changes" is enforced by the database
 * rather than by careful ordering.
 *
 * Records are stored as one JSON document per row, matching the store's
 * existing choice for `tasks.state` and for the same reason — nothing queries
 * inside a record, and a normalised schema would have to migrate in lockstep
 * with the zod definitions, which is the drift this codebase spends effort
 * avoiding. The few columns that do exist (`run_id`, `module`, `status`,
 * `position`, …) are the ones actually used to look rows up or order them.
 */
export class SqliteRunLedger implements RunLedger {
  private readonly db: ReturnType<SqliteTaskStore["ledgerDatabase"]>;

  constructor(private readonly store: SqliteTaskStore, private readonly options: { projectRoot?: string } = {}) {
    this.db = store.ledgerDatabase();
  }

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }

  // -- runs ----------------------------------------------------------------

  createRun(run: LedgerRun): void {
    const record = LedgerRunSchema.parse(run);
    const existing = this.readRun(record.run_id);
    if (existing) {
      // A replayed create with identical bytes is the idempotent case; a
      // different one is a genuine conflict and must not overwrite history.
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      throw new LedgerConflictError(
        `run ${record.run_id} already exists with different identity; create a new run rather than rewriting a frozen one`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO ledger_runs (run_id, module, target_root, status, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(record.run_id, record.module, record.target_root, record.status, record.created_at, record.updated_at, JSON.stringify(record));
  }

  readRun(runId: string): LedgerRun | null {
    const row = this.db.prepare("SELECT record FROM ledger_runs WHERE run_id = ?").get(runId) as { record: string } | undefined;
    return row ? this.parseRun(runId, row.record) : null;
  }

  listRuns(): LedgerRun[] {
    const rows = this.db.prepare("SELECT run_id, record FROM ledger_runs ORDER BY created_at ASC, run_id ASC").all() as Array<{
      run_id: string;
      record: string;
    }>;
    return rows.map((row) => this.parseRun(row.run_id, row.record));
  }

  activeRun(match: { module: string; targetRoot?: string }): LedgerRun | null {
    const wanted = match.targetRoot === undefined ? undefined : path.resolve(match.targetRoot);
    const candidates = this.listRuns().filter(
      (run) =>
        run.module === match.module &&
        !TERMINAL_RUN_STATUSES.has(run.status) &&
        (wanted === undefined || path.resolve(run.target_root) === wanted),
    );
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      throw new LedgerAmbiguityError(
        candidates.map((run) => run.run_id),
        `multiple unfinished runs match module ${match.module}: ${candidates.map((run) => run.run_id).join(", ")}; refuse to guess`,
      );
    }
    return candidates[0]!;
  }

  setRunStatus(runId: string, to: LedgerRunStatus, options: { reason?: string; actor?: string } = {}): LedgerRun {
    return this.transaction(() => {
      const run = this.readRun(runId);
      if (!run) throw new LedgerNotFoundError("run", runId);
      const transition = applyRunStatus(runId, run.status, to);
      if (transition.idempotent) return run;
      const updated: LedgerRun = {
        ...run,
        status: to,
        halt_reason: options.reason ?? (to === "RUNNING" ? null : run.halt_reason),
        updated_at: this.now(),
      };
      this.db
        .prepare("UPDATE ledger_runs SET status = ?, updated_at = ?, record = ? WHERE run_id = ?")
        .run(updated.status, updated.updated_at, JSON.stringify(LedgerRunSchema.parse(updated)), runId);
      this.appendEvent({
        run_id: runId,
        task_id: null,
        at: updated.updated_at,
        kind: "RUN_STATUS",
        actor: options.actor ?? "orchestrator",
        reason: options.reason ?? null,
        from: run.status,
        to,
        payload: {},
      });
      return updated;
    });
  }

  // -- tasks ---------------------------------------------------------------

  registerTasks(tasks: readonly LedgerTask[]): void {
    const statement = this.db.prepare(
      "INSERT INTO ledger_tasks (run_id, task_id, position, record) VALUES (?, ?, ?, ?)",
    );
    for (const task of tasks) {
      const record = LedgerTaskSchema.parse(task);
      if (!this.readRun(record.run_id)) throw new LedgerNotFoundError("run", record.run_id);
      const existing = this.readTask(record.run_id, record.task_id);
      if (existing) {
        throw new LedgerConflictError(
          `task ${record.task_id} is already registered in run ${record.run_id}; a fixed run never gains or replaces a task`,
        );
      }
      statement.run(record.run_id, record.task_id, record.position, JSON.stringify(record));
    }
  }

  readTasks(runId: string): LedgerTask[] {
    const rows = this.db
      .prepare("SELECT task_id, record FROM ledger_tasks WHERE run_id = ? ORDER BY position ASC, task_id ASC")
      .all(runId) as Array<{ task_id: string; record: string }>;
    return rows.map((row) => LedgerTaskSchema.parse(JSON.parse(row.record)));
  }

  readTask(runId: string, taskId: string): LedgerTask | null {
    const row = this.db.prepare("SELECT record FROM ledger_tasks WHERE run_id = ? AND task_id = ?").get(runId, taskId) as
      | { record: string }
      | undefined;
    return row ? LedgerTaskSchema.parse(JSON.parse(row.record)) : null;
  }

  setTaskStatus(
    runId: string,
    taskId: string,
    to: LedgerTaskStatus,
    options: { reason?: string; actor?: string } = {},
  ): LedgerTask {
    return this.transaction(() => {
      const task = this.readTask(runId, taskId);
      if (!task) throw new LedgerNotFoundError(`task in run ${runId}`, taskId);
      const transition = applyTaskStatus(`${runId}/${taskId}`, task.status, to);
      if (transition.idempotent) return task;
      const updated: LedgerTask = { ...task, status: to, updated_at: this.now() };
      this.db
        .prepare("UPDATE ledger_tasks SET record = ? WHERE run_id = ? AND task_id = ?")
        .run(JSON.stringify(LedgerTaskSchema.parse(updated)), runId, taskId);
      this.appendEvent({
        run_id: runId,
        task_id: taskId,
        at: updated.updated_at,
        kind: "TASK_STATUS",
        actor: options.actor ?? "orchestrator",
        reason: options.reason ?? null,
        from: task.status,
        to,
        payload: {},
      });
      return updated;
    });
  }

  /**
   * Readiness from the frozen DAG plus ledger status — the single authority
   * T-V8-017 requires. It deliberately reads no plan file: the plan the run
   * froze is the one it walks, and a later edit to `plan.md` must force an
   * explicit recompile, not quietly change which task runs next.
   */
  readiness(runId: string): LedgerReadiness {
    const tasks = this.readTasks(runId);
    if (tasks.length === 0) throw new LedgerNotFoundError("run", runId);
    const graph = taskGraphFromPlan(
      tasks.map((task) => ({
        id: task.task_id,
        owner: task.owner,
        phase: task.phase,
        dependsOn: task.depends_on,
        produces: task.produces,
        consumes: task.consumes,
      })),
    );
    const settled = tasks.filter((task) => SETTLED_TASK_STATUSES.has(task.status)).map((task) => task.task_id);
    const blocked = tasks.filter((task) => task.status === "BLOCKED").map((task) => task.task_id);
    const ready: string[] = [];
    const waiting: Array<{ task_id: string; waiting_on: string[] }> = [];
    for (const task of tasks) {
      if (SETTLED_TASK_STATUSES.has(task.status) || task.status === "BLOCKED") continue;
      const waitingOn = graph.waitingOn(task.task_id, settled, blocked);
      if (waitingOn.length === 0) ready.push(task.task_id);
      else waiting.push({ task_id: task.task_id, waiting_on: waitingOn });
    }
    return { ready, waiting, blocked, settled };
  }

  // -- attempts ------------------------------------------------------------

  freezeAttempt(attempt: LedgerAttempt): void {
    const record = LedgerAttemptSchema.parse(attempt);
    if (!this.readTask(record.run_id, record.task_id)) {
      throw new LedgerNotFoundError(`task in run ${record.run_id}`, record.task_id);
    }
    const existing = this.readAttempt(record.attempt_id);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      throw new LedgerConflictError(
        `attempt ${record.attempt_id} is already frozen with different inputs; an explicit reroute creates a new attempt rather than editing this one`,
      );
    }
    this.db
      .prepare("INSERT INTO ledger_attempts (attempt_id, run_id, task_id, attempt, record) VALUES (?, ?, ?, ?, ?)")
      .run(record.attempt_id, record.run_id, record.task_id, record.attempt, JSON.stringify(record));
    this.appendEvent({
      run_id: record.run_id,
      task_id: record.task_id,
      at: record.started_at,
      kind: "ATTEMPT_FROZEN",
      actor: "orchestrator",
      reason: record.route_basis,
      from: null,
      to: record.status,
      payload: {
        attempt_id: record.attempt_id,
        runtime: record.observed.runtime,
        model: record.observed.model,
        effort: record.observed.effort,
        packet_hash: record.packet_hash,
        ...(record.reroute_of === null ? {} : { reroute_of: record.reroute_of }),
      },
    });
  }

  updateAttempt(
    id: string,
    patch: { status?: LedgerAttemptStatus; ended_at?: number; outcome_reason?: string; usage?: LedgerAttempt["usage"] },
  ): LedgerAttempt {
    return this.transaction(() => {
      const attempt = this.readAttempt(id);
      if (!attempt) throw new LedgerNotFoundError("attempt", id);
      const status = patch.status ?? attempt.status;
      const transition = applyAttemptStatus(id, attempt.status, status);
      const updated: LedgerAttempt = {
        ...attempt,
        status: transition.status,
        ended_at: patch.ended_at ?? attempt.ended_at,
        outcome_reason: patch.outcome_reason ?? attempt.outcome_reason,
        usage: patch.usage === undefined ? attempt.usage : patch.usage,
      };
      // The frozen half of the record is never rewritten here: `route`,
      // `packet_hash`, capability and guard evidence are inputs, and only the
      // outcome fields above may change after the attempt has started.
      this.db
        .prepare("UPDATE ledger_attempts SET record = ? WHERE attempt_id = ?")
        .run(JSON.stringify(LedgerAttemptSchema.parse(updated)), id);
      if (!transition.idempotent) {
        this.appendEvent({
          run_id: updated.run_id,
          task_id: updated.task_id,
          at: patch.ended_at ?? this.now(),
          kind: "ATTEMPT_STATUS",
          actor: "orchestrator",
          reason: patch.outcome_reason ?? null,
          from: attempt.status,
          to: transition.status,
          payload: { attempt_id: id },
        });
      }
      return updated;
    });
  }

  readAttempt(id: string): LedgerAttempt | null {
    const row = this.db.prepare("SELECT record FROM ledger_attempts WHERE attempt_id = ?").get(id) as
      | { record: string }
      | undefined;
    return row ? LedgerAttemptSchema.parse(JSON.parse(row.record)) : null;
  }

  attemptsForTask(runId: string, taskId: string): LedgerAttempt[] {
    const rows = this.db
      .prepare("SELECT record FROM ledger_attempts WHERE run_id = ? AND task_id = ? ORDER BY attempt ASC, attempt_id ASC")
      .all(runId, taskId) as Array<{ record: string }>;
    return rows.map((row) => LedgerAttemptSchema.parse(JSON.parse(row.record)));
  }

  // -- checkpoints ---------------------------------------------------------

  recordCheckpoint(checkpoint: LedgerCheckpoint): void {
    const record = LedgerCheckpointSchema.parse(checkpoint);
    const existing = this.checkpointsForRun(record.run_id).find(
      (candidate) => candidate.task_id === record.task_id && candidate.sha === record.sha,
    );
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      throw new LedgerConflictError(`checkpoint ${record.sha} for ${record.task_id} is already recorded with different identity`);
    }
    this.db
      .prepare("INSERT INTO ledger_checkpoints (run_id, task_id, sha, at, record) VALUES (?, ?, ?, ?, ?)")
      .run(record.run_id, record.task_id, record.sha, record.at, JSON.stringify(record));
    this.appendEvent({
      run_id: record.run_id,
      task_id: record.task_id,
      at: record.at,
      kind: "TASK_CHECKPOINTED",
      actor: "orchestrator",
      reason: null,
      from: null,
      to: null,
      payload: { sha: record.sha, attempt_id: record.attempt_id, packet_hash: record.packet_hash },
    });
  }

  checkpointsForRun(runId: string): LedgerCheckpoint[] {
    const rows = this.db
      .prepare("SELECT record FROM ledger_checkpoints WHERE run_id = ? ORDER BY at ASC, task_id ASC")
      .all(runId) as Array<{ record: string }>;
    return rows.map((row) => LedgerCheckpointSchema.parse(JSON.parse(row.record)));
  }

  checkpointedTaskIds(runId: string): Set<string> {
    return new Set(this.checkpointsForRun(runId).map((checkpoint) => checkpoint.task_id));
  }

  // -- events --------------------------------------------------------------

  appendEvent(event: NewLedgerEvent): void {
    const record = LedgerEventSchema.parse(event);
    this.db
      .prepare("INSERT INTO ledger_events (run_id, task_id, at, record) VALUES (?, ?, ?, ?)")
      .run(record.run_id, record.task_id, record.at, JSON.stringify(record));
  }

  eventsForRun(runId: string): LedgerEvent[] {
    const rows = this.db.prepare("SELECT record FROM ledger_events WHERE run_id = ? ORDER BY id ASC").all(runId) as Array<{
      record: string;
    }>;
    return rows.map((row) => LedgerEventSchema.parse(JSON.parse(row.record)));
  }

  // -- read-through to the authorities that already own these facts --------

  retriesFor(taskId: string): { qa: number; security: number } | null {
    const task = this.store.loadTask(taskId);
    return task ? { ...task.retries } : null;
  }

  approvalsFor(taskId: string): readonly ApprovalRecord[] | null {
    const task = this.store.loadTask(taskId);
    return task ? task.approvals : null;
  }

  findingsFor(taskId: string): readonly Finding[] {
    if (!this.options.projectRoot) return [];
    return readFindingsForTask(this.options.projectRoot, taskId);
  }

  close(): void {
    this.store.close();
  }

  private now(): number {
    return Date.now();
  }

  private parseRun(runId: string, record: string): LedgerRun {
    const raw = JSON.parse(record) as { ledger_version?: unknown };
    if (raw.ledger_version !== 1) {
      throw new LedgerConflictError(
        `run ${runId} was written by ledger version ${String(raw.ledger_version)}; this build reads version 1 only and refuses to guess at the rest`,
      );
    }
    return LedgerRunSchema.parse(raw);
  }
}
