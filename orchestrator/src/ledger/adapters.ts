import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage, TaskState } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { isKnownJournalRecord, readJournal, readRunManifest, type KnownJournalRecord, type RunManifest } from "../run/journal.js";
import { reconstructRunState } from "../run/stateMachine.js";
import { LEDGER_SCHEMA_VERSION, type LedgerCheckpoint, type LedgerEvent, type LedgerRun, type LedgerTask } from "./runLedger.js";
import type { LedgerRunStatus, LedgerTaskStatus } from "./vocabulary.js";

/**
 * T-V8-016 compatibility adapters — **read only**, and versioned.
 *
 * These exist so a run that started before the ledger existed can still be
 * understood in one vocabulary. They never write: the migration contract is
 * dual-read / single-write, and a dual write with no reconciliation is exactly
 * the failure mode that produces two stores each convinced it is current.
 *
 * Bump `LEDGER_ADAPTER_VERSION` whenever a mapping below changes meaning, so a
 * projection carried into evidence can be told apart from a later one.
 */
export const LEDGER_ADAPTER_VERSION = 1;

/**
 * `RunState` (wave) -> ledger run status.
 *
 * `WAVE_COMPLETE` maps to RUNNING rather than COMPLETED on purpose: in the
 * wave machine, `RUN_COMPLETED` is immediately followed by
 * `HUMAN_REVIEW_REQUIRED`, and calling the run finished at the first of those
 * would report a run as done while a human gate is still outstanding.
 */
const WAVE_RUN_STATUS: Readonly<Record<string, LedgerRunStatus>> = {
  CREATED: "CREATED",
  PREFLIGHT: "REGISTERED",
  ISOLATED: "RUNNING",
  TASK_READY: "RUNNING",
  TASK_RUNNING: "RUNNING",
  VALIDATING: "RUNNING",
  CHECKPOINTED: "RUNNING",
  WAVE_COMPLETE: "RUNNING",
  HUMAN_REVIEW: "AWAITING_HUMAN",
  REFUSED: "REFUSED",
  HALTED: "HALTED",
  CANCELLED: "CANCELLED",
  STALE: "STALE",
};

export class LedgerAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAdapterError";
  }
}

/**
 * The per-task pipeline machine projected onto the coarse ledger status.
 *
 * These are two different questions and neither replaces the other:
 * `TaskState` says which pipeline stage a task sits at, the ledger status says
 * whether a run may move on from it. A `paused`/`cancelled` row reads BLOCKED
 * because a human froze it, which the pipeline machine itself knows nothing
 * about.
 */
export function ledgerTaskStatusFromPersisted(task: PersistedTask): LedgerTaskStatus {
  if (task.cancelled || task.paused) return "BLOCKED";
  switch (task.machine.current) {
    case TaskState.DEPLOYED:
      return "DONE";
    case TaskState.BLOCKED:
      return "BLOCKED";
    case TaskState.CREATED:
      return "PLANNED";
    case TaskState.READY_TO_DEPLOY:
    case TaskState.APPROVED:
      return "CHECKPOINTED";
    case TaskState.QA:
      return "VERIFYING";
    default:
      return "RUNNING";
  }
}

export interface LegacyWaveProjection {
  adapter_version: number;
  run: LedgerRun;
  tasks: LedgerTask[];
  checkpoints: LedgerCheckpoint[];
  events: LedgerEvent[];
  /** True when the journal's final line was an incomplete fragment; the caller decides whether to repair it. */
  truncatedFinalLine: boolean;
}

/**
 * Projects one existing `.workflow/wave-runs/<id>` directory into ledger
 * vocabulary without touching it.
 *
 * Deliberately lossy in one direction only: every legacy fact maps to a ledger
 * field, and every ledger field the legacy format never recorded is null or a
 * stated substitute, never a guess.
 */
export function projectWaveRun(projectRoot: string, runId: string, options: { taskOwners?: ReadonlyMap<string, AgentStage> } = {}): LegacyWaveProjection {
  const manifest: RunManifest = readRunManifest(projectRoot, runId);
  const journal = readJournal(projectRoot, runId);
  const unknown = journal.records.filter((record) => !isKnownJournalRecord(record));
  if (unknown.length > 0) {
    throw new LedgerAdapterError(
      `wave run ${runId} contains unknown journal kind(s): ${unknown.map((record) => record.kind).join(", ")}; refusing to project a record this build cannot read`,
    );
  }
  const records = journal.records.filter(isKnownJournalRecord);
  const waveState = reconstructRunState(records);
  const createdAt = Date.parse(manifest.created_at);
  if (!Number.isFinite(createdAt)) throw new LedgerAdapterError(`wave run ${runId} has an unparseable created_at`);

  const run: LedgerRun = {
    ledger_version: LEDGER_SCHEMA_VERSION,
    run_id: manifest.run_id,
    status: WAVE_RUN_STATUS[waveState] ?? "HALTED",
    // A wave run had no `--until` policy; it always stopped at the wave
    // boundary for human review, which is what `next-gate` names.
    boundary: "next-gate",
    module: manifest.module,
    target_id: manifest.target_id,
    target_root: manifest.target_root,
    knowledge_root: manifest.knowledge_root,
    base_branch: manifest.base_branch,
    base_sha: manifest.base_sha,
    run_branch: manifest.run_branch,
    requirement_hash: null,
    design_hash: null,
    plan_hash: manifest.plan_hash,
    // A wave manifest carries no config identity. Null says that; substituting
    // the plan hash would read as a recorded fact that was never recorded.
    config_hash: null,
    sta_version: manifest.sta_version,
    task_order: [...manifest.task_order],
    max_tasks: manifest.max_tasks,
    created_at: createdAt,
    updated_at: createdAt,
    halt_reason: lastReason(records) ?? null,
  };

  const checkpointed = new Set(records.filter((r) => r.kind === "TASK_CHECKPOINTED").map((r) => r.task_id));
  const failed = new Set(records.filter((r) => r.kind === "TASK_FAILED").map((r) => r.task_id));
  const started = new Set(records.filter((r) => r.kind === "TASK_STARTED").map((r) => r.task_id));
  const tasks: LedgerTask[] = manifest.task_order.map((taskId, position) => ({
    run_id: manifest.run_id,
    task_id: taskId,
    status: checkpointed.has(taskId) ? "CHECKPOINTED" : failed.has(taskId) ? "FAILED" : started.has(taskId) ? "RUNNING" : "PLANNED",
    owner: requiredOwner(options.taskOwners, taskId, runId),
    phase: 1,
    depends_on: [],
    produces: [],
    consumes: [],
    task_hash: null,
    position,
    updated_at: createdAt,
  }));

  const checkpoints: LedgerCheckpoint[] = records.flatMap((record) =>
    record.kind === "TASK_CHECKPOINTED"
      ? [{
          run_id: manifest.run_id,
          task_id: record.task_id,
          attempt_id: null,
          sha: record.sha,
          packet_hash: null,
          at: Date.parse(record.ts),
        }]
      : [],
  );

  const events: LedgerEvent[] = records.map((record) => ({
    run_id: manifest.run_id,
    task_id: record.task_id ?? null,
    at: Date.parse(record.ts),
    kind: record.kind,
    actor: "orchestrator",
    reason: "reason" in record ? String(record.reason) : null,
    from: null,
    to: null,
    payload: { ...record, adapter_version: LEDGER_ADAPTER_VERSION },
  }));

  return { adapter_version: LEDGER_ADAPTER_VERSION, run, tasks, checkpoints, events, truncatedFinalLine: journal.truncatedFinalLine };
}

/**
 * A wave manifest records task order, not owners. The caller resolves them
 * from the same plan the run froze; a missing one refuses rather than defaults,
 * because guessing an owner here would silently reshape the projected graph.
 */
function requiredOwner(owners: ReadonlyMap<string, AgentStage> | undefined, taskId: string, runId: string): AgentStage {
  const owner = owners?.get(taskId);
  if (!owner) {
    throw new LedgerAdapterError(
      `wave run ${runId} records no owner for ${taskId}; supply taskOwners resolved from the same plan rather than projecting a guessed owner`,
    );
  }
  return owner;
}

function lastReason(records: readonly KnownJournalRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if ("reason" in record && typeof record.reason === "string") return record.reason;
  }
  return undefined;
}

/** Legacy wave-run ids present on disk, newest last. Used only to decide what the ledger must read through. */
export function listWaveRunIds(projectRoot: string): string[] {
  const root = path.join(path.resolve(projectRoot), ".workflow", "wave-runs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((entry) => fs.statSync(path.join(root, entry)).isDirectory()).sort();
}

export type ExecutionAuthority =
  | { authority: "ledger"; run_id: string; reason: string }
  | { authority: "legacy-wave-journal"; run_id: string; reason: string };

/**
 * Answers "which store owns current execution truth for this run id", so no
 * two ever both claim it.
 *
 * The rule is one line and has no tie-break: if the ledger holds the run, the
 * ledger is authoritative and the journal is an export; if it does not, the
 * journal is a legacy artifact read through the adapter. There is no state in
 * which both are consulted for the same answer, which is what makes the
 * migration safe to run half-finished.
 */
export function resolveExecutionAuthority(options: {
  projectRoot: string;
  runId: string;
  ledgerHasRun: boolean;
}): ExecutionAuthority {
  if (options.ledgerHasRun) {
    return {
      authority: "ledger",
      run_id: options.runId,
      reason: "the run exists in the transactional ledger; any wave manifest/journal for it is an audit export, never consulted for current state",
    };
  }
  if (!listWaveRunIds(options.projectRoot).includes(options.runId)) {
    throw new LedgerAdapterError(`run ${options.runId} exists in neither the ledger nor .workflow/wave-runs; nothing can claim its state`);
  }
  return {
    authority: "legacy-wave-journal",
    run_id: options.runId,
    reason: "the run predates the ledger; its journal is read through the versioned adapter and is never written back",
  };
}
