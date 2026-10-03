import { randomBytes } from "node:crypto";
import type SqliteDatabase from "../store/sqliteDatabase.js";
import type { StructuredIntent } from "./intent.js";
import type { RuntimeFailureClass } from "../runtime/runtimeFailureClass.js";

/**
 * A work run — one user request ("work this module until QA passes, then stop
 * for me") as STA Core owns it. The task engine keeps per-task truth in the
 * Knowledge root's ledger; this record is the layer above: which Knowledge
 * root is pinned, which bounded-run it drives, every segment launched, who
 * commanded and who worked, every runtime switch and why, the handoffs, and
 * every human gate. All of it is persisted on every change (`core.db`), so the
 * service can die and come back to exactly this.
 */

export const WORK_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "STOPPING",
  "STOPPED",
  "WAITING_FOR_HUMAN",
  "PAUSED_RUNTIME_EXHAUSTED",
  "READY_FOR_REVIEW",
  "APPROVED",
  "FAILED",
] as const;
export type WorkRunStatus = (typeof WORK_RUN_STATUSES)[number];

/** Statuses with nothing left for the Core to do on its own. */
export const SETTLED_STATUSES: ReadonlySet<WorkRunStatus> = new Set(["STOPPED", "READY_FOR_REVIEW", "APPROVED", "FAILED"]);
/** Statuses where a segment may be running. */
export const ACTIVE_STATUSES: ReadonlySet<WorkRunStatus> = new Set(["QUEUED", "RUNNING", "PAUSING", "STOPPING"]);

export type WorkerRole = "engineer" | "reviewer" | "qa";

export interface Segment {
  index: number;
  kind: "start" | "resume";
  startedAt: number;
  endedAt: number | null;
  pid: number | null;
  exitCode: number | null;
  /** The bounded-run's own final verdict line, verbatim. */
  outcome: string | null;
  logPath: string;
}

export interface RuntimeHistoryEntry {
  at: number;
  role: string;
  runtimeId: string;
  event: "selected" | "success" | "failure" | "skipped" | "fallback";
  failureClass?: RuntimeFailureClass | string | null;
  detail?: string | null;
}

export interface FallbackEntry {
  at: number;
  role: string;
  from: string;
  to: string | null;
  failureClass: string;
  reason: string;
}

export interface HumanGate {
  id: string;
  at: number;
  kind: "runtime_exhausted" | "security_runtime" | "engine_waiting" | "engine_halted" | "engine_refused" | "knowledge_changed" | "segment_budget" | "interrupted" | "review";
  reason: string;
  resolvedAt: number | null;
}

export interface Handoff {
  at: number;
  knowledge_root: string;
  knowledge_path: string;
  module: string;
  target: string | null;
  task: string | null;
  stage: string | null;
  role: string;
  previous_runtime: string | null;
  next_runtime: string | null;
  failure: { class: string; reason: string } | null;
  completed: string[];
  files_changed: string[];
  verification: Record<string, string>;
  next_action: string;
}

export interface CommanderNote {
  at: number;
  runtimeId: string | null;
  phase: "start" | "assess";
  decision: string;
  summary: string;
  accepted: boolean;
  policyNote?: string;
}

/** One Target group of a work run, driven as its own bounded run (`core/targetGroups.ts`). */
export interface TargetRun {
  key: string;
  targetIds: string[];
  taskIds: string[];
  boundedRunId: string | null;
  state: "pending" | "running" | "done" | "waiting" | "halted";
  reason: string | null;
}

export interface WorkRun {
  runId: string;
  /** Pinned at creation; never changed for the life of the run. */
  knowledge: { name: string; path: string };
  module: string;
  targets: string[];
  commandText: string;
  intent: StructuredIntent;
  intentSource: "gemini" | "offline" | "cli";
  intentOverrides: string[];
  /** bounded-run `--until`: `done` drives every task to QA-verified Done (no deploy stage exists in the plan-task pipeline), parking only at hard gates. */
  boundary: "done" | "next-gate";
  scope: { kind: "all" } | { kind: "phase"; phase: number } | { kind: "tasks"; taskIds: string[] };
  autonomy: "edit" | "full";
  status: WorkRunStatus;
  statusReason: string | null;
  /** The bounded run of the Target group being driven now (see `targetRuns`). */
  boundedRunId: string | null;
  /** One entry per Target group, in dependency order. Absent on runs created before per-Target splitting. */
  targetRuns?: TargetRun[];
  segments: Segment[];
  commander: { current: string | null; notes: CommanderNote[] };
  workers: Record<WorkerRole, string | null>;
  runtimeHistory: RuntimeHistoryEntry[];
  fallbacks: FallbackEntry[];
  handoffs: Handoff[];
  humanGates: HumanGate[];
  /** Latest projection snapshot (tasks, verification, changed files) for fast page loads. */
  snapshot: Record<string, unknown> | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  autoResumeAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  push: false;
  merge: false;
  deploy: false;
}

export function newRunId(now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `wr-${stamp}-${randomBytes(3).toString("hex")}`;
}

interface RunRow { doc: string }

export class WorkRunStore {
  constructor(private readonly db: SqliteDatabase, private readonly clock: () => number = Date.now) {}

  create(run: WorkRun): void {
    this.db.prepare("INSERT INTO work_runs (run_id, knowledge_name, knowledge_path, module, status, created_at, updated_at, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.runId, run.knowledge.name, run.knowledge.path, run.module, run.status, run.createdAt, run.updatedAt, JSON.stringify(run));
  }

  get(runId: string): WorkRun | null {
    const row = this.db.prepare("SELECT doc FROM work_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? (JSON.parse(row.doc) as WorkRun) : null;
  }

  /**
   * Read-modify-write in one immediate transaction. The pinned Knowledge
   * identity is re-asserted on every save: no code path may repoint a run.
   */
  update(runId: string, mutate: (run: WorkRun) => void): WorkRun {
    return this.db.transaction(() => {
      const current = this.get(runId);
      if (!current) throw new Error(`no such work run: ${runId}`);
      const pinned = { ...current.knowledge };
      mutate(current);
      if (current.knowledge.name !== pinned.name || current.knowledge.path !== pinned.path) {
        throw new Error(`work run ${runId}: the pinned Knowledge root (${pinned.name}) cannot change during a run`);
      }
      current.updatedAt = this.clock();
      this.db.prepare("UPDATE work_runs SET status = ?, updated_at = ?, doc = ? WHERE run_id = ?").run(current.status, current.updatedAt, JSON.stringify(current), runId);
      return current;
    }).immediate();
  }

  list(filter: { knowledge?: string; module?: string; statuses?: readonly WorkRunStatus[] } = {}): WorkRun[] {
    const rows = this.db.prepare("SELECT doc FROM work_runs ORDER BY created_at DESC").all() as unknown as RunRow[];
    return rows.map((row) => JSON.parse(row.doc) as WorkRun).filter((run) =>
      (filter.knowledge === undefined || run.knowledge.name === filter.knowledge) &&
      (filter.module === undefined || run.module === filter.module) &&
      (filter.statuses === undefined || filter.statuses.includes(run.status)));
  }

  /** The latest unsettled run for a Knowledge/module pair — what `sta work pause <module>` addresses. */
  latestOpen(knowledge: string, module: string): WorkRun | null {
    return this.list({ knowledge, module }).find((run) => !(["STOPPED", "APPROVED", "FAILED"] as WorkRunStatus[]).includes(run.status)) ?? null;
  }

  appendEvent(runId: string, kind: string, message: string, data?: unknown): void {
    this.db.prepare("INSERT INTO run_events (run_id, at, kind, message, data) VALUES (?, ?, ?, ?, ?)")
      .run(runId, this.clock(), kind, message, data === undefined ? null : JSON.stringify(data));
  }

  events(runId: string, limit = 500): Array<{ at: number; kind: string; message: string; data: unknown }> {
    const rows = this.db.prepare("SELECT at, kind, message, data FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, limit) as Array<{ at: number; kind: string; message: string; data: string | null }>;
    return rows.reverse().map((row) => ({ at: row.at, kind: row.kind, message: row.message, data: row.data ? JSON.parse(row.data) : null }));
  }
}
