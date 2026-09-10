import { z } from "zod";
import type { Finding } from "../artifacts/finding.js";
import type { ApprovalRecord } from "../gates/approval.js";
import { AgentStage } from "../types.js";
import {
  LEDGER_ATTEMPT_STATUSES,
  LEDGER_RUN_STATUSES,
  LEDGER_TASK_STATUSES,
  type LedgerAttemptStatus,
  type LedgerRunStatus,
  type LedgerTaskStatus,
} from "./vocabulary.js";

/**
 * T-V8-016 — one conceptual run ledger.
 *
 * The authority rule, stated once so no consumer has to infer it:
 *
 * | Fact | Authority | Everything else |
 * |---|---|---|
 * | run identity/status/boundary, fixed DAG + task status, attempts/routes, checkpoints | this ledger (SQLite) | — |
 * | per-task pipeline machine, retries, approvals, artifacts | `TaskStore` (same SQLite file, same transaction) | the ledger *reads* it; it never copies it |
 * | findings / repair packets | `.workflow/findings` (T-V8-013) | the ledger *reads* them |
 * | wave manifest + journal | audit/recovery export | dual-**read** only, for runs created before this ledger existed |
 *
 * Nothing is stored twice. `retriesFor`/`approvalsFor`/`findingsFor` exist on
 * this interface so one object answers "what is the current state of this
 * run", which is the acceptance criterion — not so the ledger keeps its own
 * second copy of a counter that would then be free to disagree with the
 * store's.
 */
export const LEDGER_SCHEMA_VERSION = 1;

const text = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{7,64}$/);
const runId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "run id must be a 26-character ULID-style value");
const stage = z.enum(AgentStage);

export const RUN_BOUNDARIES = ["next-gate", "qa", "done"] as const;
export type RunBoundary = (typeof RUN_BOUNDARIES)[number];

export const LedgerRunSchema = z.strictObject({
  ledger_version: z.literal(LEDGER_SCHEMA_VERSION),
  run_id: runId,
  status: z.enum(LEDGER_RUN_STATUSES),
  /** How far this explicit foreground run may proceed. Never a persistent mode. */
  boundary: z.enum(RUN_BOUNDARIES),
  module: text,
  target_id: text,
  target_root: text,
  knowledge_root: text,
  base_branch: text,
  base_sha: revision,
  run_branch: text,
  /** Authored-input identities. Null only where the module genuinely has no such document. */
  requirement_hash: sha256.nullable(),
  design_hash: sha256.nullable(),
  plan_hash: sha256,
  /** Null only in a legacy wave projection, which never recorded a config identity. Registration always supplies one. */
  config_hash: sha256.nullable(),
  sta_version: text,
  /** The frozen execution order. Membership is the run's scope; nothing joins it later. */
  task_order: z.array(text).min(1),
  max_tasks: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  halt_reason: z.string().nullable(),
});
export type LedgerRun = z.infer<typeof LedgerRunSchema>;

export const LedgerTaskSchema = z.strictObject({
  run_id: runId,
  task_id: text,
  status: z.enum(LEDGER_TASK_STATUSES),
  owner: stage,
  phase: z.number().int().positive(),
  depends_on: z.array(text),
  produces: z.array(text),
  consumes: z.array(text),
  /**
   * `planTaskHash` of the canonical task this run froze. Drift here means
   * recompile, never reinterpret. Null only in a legacy wave projection: a
   * wave manifest recorded one plan hash and no per-task identity, and saying
   * so is more useful than substituting the plan hash for it.
   */
  task_hash: sha256.nullable(),
  /** Deterministic position in the frozen order, so resume walks the same sequence. */
  position: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type LedgerTask = z.infer<typeof LedgerTaskSchema>;

export const RouteFactsSchema = z.strictObject({
  runtime: text,
  model: text.nullable(),
  effort: text.nullable(),
});
export type RouteFacts = z.infer<typeof RouteFactsSchema>;

export const CapabilityEvidenceSchema = z.strictObject({
  capability: text,
  verified: z.boolean(),
  detail: z.string().nullable(),
});

export const AttemptUsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  cache_read_tokens: z.number().int().nonnegative().nullable(),
  cache_creation_tokens: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});

/**
 * T-V8-018 — the complete, frozen contract for one artifact-producing attempt.
 *
 * `requested` and `observed` are separate on purpose and neither is optional:
 * "what policy asked for" and "what the adapter was actually handed" are the
 * two halves of the only question an audit can ask, and collapsing them is how
 * a silent reroute becomes invisible.
 */
export const LedgerAttemptSchema = z.strictObject({
  attempt_id: text,
  run_id: runId,
  task_id: text,
  stage,
  attempt: z.number().int().positive(),
  status: z.enum(LEDGER_ATTEMPT_STATUSES),
  requested: RouteFactsSchema,
  observed: RouteFactsSchema,
  /** True when the adapter must receive `observed.model` rather than fall back to its own default. */
  model_explicit: z.boolean(),
  /** `level-N;<model basis>/<effort basis>` from the central policy resolver. */
  route_basis: text,
  tier: text.nullable(),
  /** Adapter/config identity, so a rebuilt binary cannot silently resume someone else's contract. */
  adapter_version: text,
  config_hash: sha256,
  plan_hash: sha256,
  base_revision: revision,
  capability_evidence: z.array(CapabilityEvidenceSchema),
  /** Guard facts a Target-writing attempt may not start without. */
  guard_evidence: z.strictObject({
    target_write: z.boolean(),
    pre_tool_guard: z.boolean(),
    writable_roots: z.array(text),
  }),
  packet_hash: sha256,
  /** Runtime-state-relative packet path; the immutable bytes the model was asked to act on. */
  packet_path: text,
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().nullable(),
  outcome_reason: z.string().nullable(),
  usage: AttemptUsageSchema.nullable(),
  /** Set only by an explicit reroute: the attempt this one replaces. */
  reroute_of: z.string().nullable(),
});
export type LedgerAttempt = z.infer<typeof LedgerAttemptSchema>;

export const LedgerCheckpointSchema = z.strictObject({
  run_id: runId,
  task_id: text,
  /** Null only in a legacy wave projection: checkpoints predating per-attempt identity have none. */
  attempt_id: z.string().nullable(),
  sha: revision,
  packet_hash: sha256.nullable(),
  at: z.number().int().nonnegative(),
});
export type LedgerCheckpoint = z.infer<typeof LedgerCheckpointSchema>;

export const LedgerEventSchema = z.strictObject({
  run_id: runId,
  task_id: z.string().nullable(),
  at: z.number().int().nonnegative(),
  kind: text,
  actor: text,
  reason: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type NewLedgerEvent = z.input<typeof LedgerEventSchema>;

export interface LedgerReadiness {
  /** Frozen order, filtered to tasks whose dependencies are all settled. */
  ready: string[];
  waiting: Array<{ task_id: string; waiting_on: string[] }>;
  blocked: string[];
  settled: string[];
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

export class LedgerNotFoundError extends Error {
  constructor(public readonly what: string, public readonly id: string) {
    super(`${what} ${id} does not exist in this ledger`);
    this.name = "LedgerNotFoundError";
  }
}

export class LedgerAmbiguityError extends Error {
  constructor(public readonly candidates: readonly string[], message: string) {
    super(message);
    this.name = "LedgerAmbiguityError";
  }
}

/** Everything the ledger must agree with before an interrupted run may continue. */
export interface RunIdentityExpectation {
  planHash?: string;
  configHash?: string;
  requirementHash?: string | null;
  designHash?: string | null;
  staVersion?: string;
  targetRoot?: string;
  knowledgeRoot?: string;
  baseSha?: string;
  runBranch?: string;
}

/**
 * The persistence seam for a bounded run. One object answers run, task,
 * attempt, readiness, finding, checkpoint and approval state; nothing else may
 * claim any of them as current truth.
 */
export interface RunLedger {
  /**
   * Runs `fn` inside the same transaction the underlying store uses, so a
   * ledger write and a `TaskStore` write in one callback either both land or
   * neither does. Nesting is rejected rather than silently flattened.
   */
  transaction<T>(fn: () => T): T;

  createRun(run: LedgerRun): void;
  readRun(runIdValue: string): LedgerRun | null;
  listRuns(): LedgerRun[];
  /** Exactly one unfinished run for this module/target, or a refusal. Never "pick newest". */
  activeRun(match: { module: string; targetRoot?: string }): LedgerRun | null;
  setRunStatus(runIdValue: string, to: LedgerRunStatus, options?: { reason?: string; actor?: string }): LedgerRun;

  registerTasks(tasks: readonly LedgerTask[]): void;
  readTasks(runIdValue: string): LedgerTask[];
  readTask(runIdValue: string, taskId: string): LedgerTask | null;
  setTaskStatus(
    runIdValue: string,
    taskId: string,
    to: LedgerTaskStatus,
    options?: { reason?: string; actor?: string },
  ): LedgerTask;
  readiness(runIdValue: string): LedgerReadiness;

  /** Write-once by `attempt_id`; a replay with identical bytes is accepted, a changed one refuses. */
  freezeAttempt(attempt: LedgerAttempt): void;
  updateAttempt(
    attemptId: string,
    patch: {
      status?: LedgerAttemptStatus;
      ended_at?: number;
      outcome_reason?: string;
      usage?: LedgerAttempt["usage"];
    },
  ): LedgerAttempt;
  readAttempt(attemptId: string): LedgerAttempt | null;
  attemptsForTask(runIdValue: string, taskId: string): LedgerAttempt[];

  recordCheckpoint(checkpoint: LedgerCheckpoint): void;
  checkpointsForRun(runIdValue: string): LedgerCheckpoint[];
  checkpointedTaskIds(runIdValue: string): Set<string>;

  appendEvent(event: NewLedgerEvent): void;
  eventsForRun(runIdValue: string): LedgerEvent[];

  /** Read-through to the authorities that already own these facts. */
  retriesFor(taskId: string): { qa: number; security: number } | null;
  approvalsFor(taskId: string): readonly ApprovalRecord[] | null;
  findingsFor(taskId: string): readonly Finding[];

  close(): void;
}

/** Deterministic attempt identity: the same run/task/stage/attempt always resolves to one record. */
export function attemptId(runIdValue: string, taskId: string, stageValue: AgentStage, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt number must be a positive integer, got ${String(attempt)}`);
  return `${runIdValue}:${taskId}:${stageValue}:${attempt}`;
}

/**
 * Refuses a resume whose world no longer matches the frozen run.
 *
 * Every field is compared only when the caller supplies it: a caller that
 * cannot resolve, say, a requirement hash for this module must not have that
 * absence read as "it changed".
 */
export function assertRunIdentity(run: LedgerRun, expected: RunIdentityExpectation): void {
  const drift: string[] = [];
  const compare = (name: string, actual: unknown, wanted: unknown): void => {
    if (wanted === undefined) return;
    if (actual !== wanted) drift.push(`${name}: run=${String(actual)}, current=${String(wanted)}`);
  };
  compare("plan_hash", run.plan_hash, expected.planHash);
  compare("config_hash", run.config_hash, expected.configHash);
  compare("requirement_hash", run.requirement_hash, expected.requirementHash);
  compare("design_hash", run.design_hash, expected.designHash);
  compare("sta_version", run.sta_version, expected.staVersion);
  compare("target_root", run.target_root, expected.targetRoot);
  compare("knowledge_root", run.knowledge_root, expected.knowledgeRoot);
  compare("base_sha", run.base_sha, expected.baseSha);
  compare("run_branch", run.run_branch, expected.runBranch);
  if (drift.length > 0) {
    throw new LedgerConflictError(
      `run ${run.run_id} cannot resume: ${drift.join("; ")} — recompile explicitly rather than reinterpreting a frozen run`,
    );
  }
}
