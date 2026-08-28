import { z } from "zod";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { QaReportArtifactSchema, SecurityReportArtifactSchema } from "../artifacts/schemas.js";
import { StructuredFailureSchema } from "../orchestrator/failure.js";
import { ApprovalRecordSchema } from "../gates/approval.js";
import { QaModeDecisionSchema } from "../qa/mode.js";
import { Environment } from "../environment/environment.js";
import type { RunRecord } from "../observability/runLog.js";
import { RuntimeTaskSchema } from "../orchestrator/runtimeTask.js";

/**
 * Everything the orchestrator holds about one task, in a form that survives
 * the process.
 *
 * Before T01 the `Orchestrator` kept all of this in private fields, so closing
 * the terminal lost a task's position in the pipeline entirely (README's own
 * "ข้อจำกัดที่ควรรู้ก่อนใช้จริง" said as much). The fields here are exactly
 * those fields — nothing is derived and stored twice, because a stored
 * derivation is a second source of truth waiting to disagree with the first.
 * `status` is therefore *not* persisted: it is recomputed from `machine` +
 * `gateContext` on load.
 */
export const PersistedTaskSchema = z.object({
  taskId: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Task ids that must reach DEPLOYED before this one may run (see orchestrator/taskRegistry.ts). */
  dependsOn: z.array(z.string()),
  classification: z.object({
    level: z.enum(TaskLevel),
    pipeline: z.array(z.enum(AgentStage)),
    requiresHumanApproval: z.boolean(),
    sensitiveGate: z.boolean(),
    reasons: z.array(z.string()),
  }),
  /**
   * V3 Phase 1 deterministic execution contract. Null is intentional for
   * historical rows and human-triage tasks; v12 rows load without a rewrite.
   */
  runtimeTask: RuntimeTaskSchema.nullable().default(null),
  machine: z.object({
    pipeline: z.array(z.enum(AgentStage)),
    requiresHumanApproval: z.boolean(),
    sequence: z.array(z.enum(TaskState)),
    current: z.enum(TaskState),
    history: z.array(z.enum(TaskState)),
  }),
  retries: z.object({
    qa: z.number().int().nonnegative(),
    security: z.number().int().nonnegative(),
  }),
  /**
   * Human evidence is persisted on purpose: an approval a person already gave
   * must not be asked for again just because the process restarted. The two
   * report fields are re-validated against their real artifact schemas on load,
   * so a truncated or hand-edited row fails loudly instead of resuming a task
   * on a QA report that no longer parses.
   */
  gateContext: z.object({
    designApproved: z.boolean().optional(),
    humanApproved: z.boolean().optional(),
    qaReport: QaReportArtifactSchema.optional(),
    securityReport: SecurityReportArtifactSchema.optional(),
    // QA02/QA05: the mode decision rides with the rest of the gate evidence so a
    // resumed task still closes (or refuses to close) on the same terms. Optional:
    // rows written before the optimization layer simply have no decision, which is
    // true rather than broken.
    qaModeDecision: QaModeDecisionSchema.optional(),
  }),
  /**
   * Every human decision this task has asked for, with its answer (T08).
   *
   * `gateContext`'s booleans are derived from this, not kept beside it — one
   * source of truth. Defaulted to empty so a row written before T08 still loads
   * instead of failing as corrupt: an old task simply has no ledger yet, which
   * is true rather than broken.
   */
  approvals: z.array(ApprovalRecordSchema).default([]),
  artifacts: z.record(z.string(), z.string()),
  pipelineCursor: z.number().int().nonnegative(),
  blockedReason: z.string().nullable(),
  lastFailure: StructuredFailureSchema.nullable(),
  /**
   * T31's `pause`/`cancel` verbs (Developer Experience) — a human-imposed override, orthogonal
   * to the pipeline's own state machine. Defaulted so a row written before T31 still loads: an
   * old task simply was never paused/cancelled, which is true rather than broken, same pattern
   * as `approvals`'s default above.
   */
  paused: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  cancelReason: z.string().nullable().default(null),
  /**
   * T43 — local/dev/staging/production. Defaulted to `local` so a row written before T43 still
   * loads: an old task simply never declared one, and "local" is the least destructive assumption
   * to make about it after the fact, same defaulting pattern as `paused`/`cancelled` above.
   */
  environment: z.enum(Environment).default(Environment.LOCAL),
  /**
   * T44 — true once `devops`'s "prepare" run (Dockerfile/CI/dry-run, safe unattended) has
   * completed at READY_TO_DEPLOY. Distinguishes it from "execute" (the actual deploy/migration
   * command, at APPROVED, always after the human gate) — both are the same pipeline stage
   * (`devops`) run twice, and unlike backend/frontend's two IMPLEMENTATION stages (distinguished
   * by pipelineCursor alone, since they share one TaskState) devops's two runs sit on either
   * side of a gated state transition, so pipelineCursor alone can't tell them apart. Defaulted
   * so a row written before T44 still loads: an old task simply never went through this, which
   * is true rather than broken, same pattern as `paused`/`cancelled` above.
   */
  deployPrepared: z.boolean().default(false),
  /**
   * Phase 2: Target identity is part of a task's audit record, not a runtime
   * hint.  Defaults preserve historical rows; preflight rejects legacy code
   * tasks that have neither required binding.
   */
  targetBindings: z.object({
    frontend_target: z.string().min(1).nullable().default(null),
    backend_target: z.string().min(1).nullable().default(null),
  }).default({ frontend_target: null, backend_target: null }),
});
export type PersistedTask = z.infer<typeof PersistedTaskSchema>;

/**
 * One recorded event, with T37's audit fields alongside the payload.
 *
 * `type` is WHAT and `at` is WHEN; the five below are WHO / WHY / INPUT /
 * OUTPUT / DECISION. They are nullable and defaulted rather than required
 * because two things legitimately have nothing to put in them: a row written
 * before T37 existed, and an event that genuinely made no decision (an agent
 * finishing is a fact, not a choice). `audit/auditTrail.ts` derives the same
 * fields from `payload` when they are null, so an old row still reads as a
 * proper trail instead of a wall of nulls.
 */
export const PersistedEventSchema = z.object({
  taskId: z.string().min(1),
  at: z.number(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  /** WHO: the agent role, the person, or "orchestrator". */
  actor: z.string().nullable().default(null),
  /** WHY: the reason carried by the event, in the words it used. */
  reason: z.string().nullable().default(null),
  /** INPUT: what went in — the artifact categories handed over, or the gate being answered. */
  input: z.string().nullable().default(null),
  /** OUTPUT: what came out — the artifact, the verdict, the cost. */
  output: z.string().nullable().default(null),
  /** DECISION: the choice made, as a short stable token. Null for an event that decided nothing. */
  decision: z.string().nullable().default(null),
});
export type PersistedEvent = z.infer<typeof PersistedEventSchema>;

/**
 * What a caller supplies to record an event, as opposed to what it gets back.
 *
 * The asymmetry is deliberate: an emitter states the audit fields it knows and
 * omits the rest, while a reader always receives all seven — explicitly null
 * where nothing was recorded. Requiring them on the way in would force every
 * call site to write `actor: null, reason: null, …` for events that genuinely
 * have none, which is noise that hides the ones that matter.
 */
export type NewEvent = z.input<typeof PersistedEventSchema>;

/** Normalises an event on the way into a store, so both implementations record the same shape. */
export function parseNewEvent(event: NewEvent): PersistedEvent {
  return PersistedEventSchema.parse(event);
}

export class TaskAlreadyExistsError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} already exists in this store — use loadTask()/resume() instead of creating it again`);
    this.name = "TaskAlreadyExistsError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} does not exist in this store`);
    this.name = "TaskNotFoundError";
  }
}

export class PersistedStateCorruptError extends Error {
  constructor(taskId: string, public readonly issues: string[]) {
    super(`stored state for task ${taskId} does not match the current schema:\n- ${issues.join("\n- ")}`);
    this.name = "PersistedStateCorruptError";
  }
}

/**
 * The persistence seam. The orchestrator talks to this and never to a file or
 * a database directly, so which one backs it (SQLite for a real run, memory
 * for a test) is not a decision baked into the coordination logic.
 *
 * Implementations must be value-safe in both directions: what goes in cannot
 * be mutated afterwards through the caller's reference, and what comes out
 * cannot be mutated back into the store.
 */
export interface TaskStore {
  /** Throws TaskAlreadyExistsError rather than overwriting — creating a task twice is a bug, not an update. */
  createTask(task: PersistedTask): void;
  /** Upsert of an existing task. Throws TaskNotFoundError if it was never created. */
  saveTask(task: PersistedTask): void;
  loadTask(taskId: string): PersistedTask | null;
  listTasks(): PersistedTask[];
  appendRun(record: RunRecord): void;
  runsForTask(taskId: string): RunRecord[];
  /** Read-only cross-task run view for observability reports, including interactive session rows that have no task record. */
  allRuns(): RunRecord[];
  appendEvent(event: NewEvent): void;
  eventsForTask(taskId: string): PersistedEvent[];
  close(): void;
}

/** Shared by every implementation: a stored row is only trusted once it re-parses. */
export function parsePersistedTask(taskId: string, data: unknown): PersistedTask {
  const result = PersistedTaskSchema.safeParse(data);
  if (!result.success) {
    throw new PersistedStateCorruptError(
      taskId,
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

export function newPersistedTask(params: {
  taskId: string;
  dependsOn?: string[];
  classification: PersistedTask["classification"];
  machine: PersistedTask["machine"];
  now: number;
  environment?: Environment;
  targetBindings?: PersistedTask["targetBindings"];
  runtimeTask?: PersistedTask["runtimeTask"];
}): PersistedTask {
  return {
    taskId: params.taskId,
    createdAt: params.now,
    updatedAt: params.now,
    dependsOn: params.dependsOn ?? [],
    classification: params.classification,
    runtimeTask: params.runtimeTask ?? null,
    machine: params.machine,
    retries: { qa: 0, security: 0 },
    gateContext: {},
    approvals: [],
    artifacts: {},
    pipelineCursor: 0,
    blockedReason: null,
    lastFailure: null,
    paused: false,
    cancelled: false,
    cancelReason: null,
    environment: params.environment ?? Environment.LOCAL,
    deployPrepared: false,
    targetBindings: params.targetBindings ?? { frontend_target: null, backend_target: null },
  };
}
