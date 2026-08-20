import { z } from "zod";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { QaReportArtifactSchema, SecurityReportArtifactSchema } from "../artifacts/schemas.js";
import { StructuredFailureSchema } from "../orchestrator/failure.js";
import { ApprovalRecordSchema } from "../gates/approval.js";
import type { RunRecord } from "../observability/runLog.js";

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
});
export type PersistedTask = z.infer<typeof PersistedTaskSchema>;

export const PersistedEventSchema = z.object({
  taskId: z.string().min(1),
  at: z.number(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type PersistedEvent = z.infer<typeof PersistedEventSchema>;

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
  appendEvent(event: PersistedEvent): void;
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
}): PersistedTask {
  return {
    taskId: params.taskId,
    createdAt: params.now,
    updatedAt: params.now,
    dependsOn: params.dependsOn ?? [],
    classification: params.classification,
    machine: params.machine,
    retries: { qa: 0, security: 0 },
    gateContext: {},
    approvals: [],
    artifacts: {},
    pipelineCursor: 0,
    blockedReason: null,
    lastFailure: null,
  };
}
