import { z } from "zod";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { QaReportArtifactSchema, ReviewReportArtifactSchema, SecurityReportArtifactSchema } from "../artifacts/schemas.js";
import { StructuredFailureSchema } from "../orchestrator/failure.js";
import { RECOVERY_POLICY_VERSION, RecoveryActionSchema, HandoffIntentSchema } from "../retry/recoveryPolicy.js";
import { RepairRouteSchema } from "../retry/repairRoute.js";
import { ApprovalRecordSchema } from "../gates/approval.js";
import { QaModeDecisionSchema } from "../qa/mode.js";
import { Environment } from "../environment/environment.js";
import type { RunRecord } from "../observability/runLog.js";
import { RuntimeTaskSchema } from "../orchestrator/runtimeTask.js";
import { BusinessInputEvidenceSchema } from "../gates/businessInput.js";
import { DesignGateAssessmentSchema } from "../docs/designEvidence.js";
import { TEST_STRATEGY_TRIGGERS } from "../classification/taskClassifier.js";
import type { EvidenceStore } from "../evidence/evidenceStore.js";

/**
 * Everything the orchestrator holds about one task, in a form that survives
 * the process.
 *
 * Nothing here is derived and stored twice, because a stored derivation is a
 * second source of truth waiting to disagree with the first. `status` is
 * therefore *not* persisted: it is recomputed from `machine` + `gateContext`
 * on load.
 */
export const KnowledgeRootIdentitySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});
export type KnowledgeRootIdentity = z.infer<typeof KnowledgeRootIdentitySchema>;

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
    testStrategyTriggers: z.array(z.enum(TEST_STRATEGY_TRIGGERS)).optional(),
    reasons: z.array(z.string()),
  }),
  /**
   * Null is intentional for historical rows and human-triage tasks — old
   * rows load without a rewrite.
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
    review: z.number().int().nonnegative(),
    qa: z.number().int().nonnegative(),
    security: z.number().int().nonnegative(),
  }),
  /**
   * Gate evidence other than human approval. Approval facts are never stored
   * here: they exist only as `approvals` ledger records and are derived at
   * check time, so a row carrying `requirementApproved`/`designApproved`/
   * `humanApproved` is refused as corrupt rather than trusted. The two report
   * fields are re-validated against their real artifact schemas on load, so a
   * truncated or hand-edited row fails loudly instead of resuming a task on a
   * QA report that no longer parses.
   */
  gateContext: z.strictObject({
    businessInput: BusinessInputEvidenceSchema.optional(),
    designAssessment: DesignGateAssessmentSchema.optional(),
    reviewReport: ReviewReportArtifactSchema.optional(),
    qaReport: QaReportArtifactSchema.optional(),
    securityReport: SecurityReportArtifactSchema.optional(),
    // The mode decision rides with the rest of the gate evidence so a resumed
    // task still closes (or refuses to close) on the same terms. Optional:
    // rows written before the optimization layer simply have no decision,
    // which is true rather than broken.
    qaModeDecision: QaModeDecisionSchema.optional(),
    // The verdict-coverage requirement rides with the mode decision for the
    // same reason: a resumed round must close (or refuse to close) on exactly
    // the ids the original round was held to, not on a set re-derived from a
    // plan that may have been amended since.
    qaVerdictRequirements: z.array(z.string().min(1)).optional(),
  }),
  /**
   * Every approval request this task opened, with its trusted human decision
   * (or evidence withdrawal). The only source of approval state: an approved
   * pending request survives a restart because it lives here. A pre-V13
   * record (no request id / scope / authenticated decision) fails to parse.
   */
  approvals: z.array(ApprovalRecordSchema),
  artifacts: z.record(z.string(), z.string()),
  pipelineCursor: z.number().int().nonnegative(),
  blockedReason: z.string().nullable(),
  lastFailure: StructuredFailureSchema.nullable(),
  /** STA's decision for the last failed attempt, committed with its retry count. */
  recoveryDecision: z.strictObject({
    policyVersion: z.literal(RECOVERY_POLICY_VERSION),
    stage: z.enum(AgentStage),
    attempt: z.number().int().positive(),
    failureKind: z.enum(["review", "qa", "security"]).nullable(),
    action: RecoveryActionSchema,
    repairRoute: RepairRouteSchema.nullable(),
    handoffIntent: HandoffIntentSchema,
  }).nullable(),
  /** Reserved before executor side effects. A restarted process must reconcile
   * this attempt instead of silently dispatching the same work again. */
  inFlightAttempt: z.strictObject({
    stage: z.enum(AgentStage),
    attempt: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
  }).nullable(),
  settledAttempt: z.strictObject({
    stage: z.enum(AgentStage),
    attempt: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
    resultDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).nullable(),
  /**
   * A human-imposed override, orthogonal to the pipeline's own state machine. Defaulted so an
   * old row still loads: an old task simply was never paused/cancelled, which is true rather
   * than broken, same pattern as `approvals`'s default above.
   */
  paused: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  cancelReason: z.string().nullable().default(null),
  /**
   * local/dev/staging/production. Defaulted to `local` so an old row still loads: an old task
   * simply never declared one, and "local" is the least destructive assumption to make about it
   * after the fact, same defaulting pattern as `paused`/`cancelled` above.
   */
  environment: z.enum(Environment).default(Environment.LOCAL),
  /**
   * True once `devops`'s "prepare" run (Dockerfile/CI/dry-run, safe unattended) has completed at
   * READY_TO_DEPLOY. Distinguishes it from "execute" (the actual deploy/migration command, at
   * APPROVED, always after the human gate) — both are the same pipeline stage (`devops`) run
   * twice, and unlike backend/frontend's two IMPLEMENTATION stages (distinguished by
   * pipelineCursor alone, since they share one TaskState) devops's two runs sit on either side of
   * a gated state transition, so pipelineCursor alone can't tell them apart. Defaulted so an old
   * row still loads: an old task simply never went through this, which is true rather than
   * broken, same pattern as `paused`/`cancelled` above.
   */
  deployPrepared: z.boolean().default(false),
  /**
   * Target identity is part of a task's audit record, not a runtime hint.
   * Defaults preserve historical rows; preflight rejects legacy code tasks
   * that have neither required binding.
   */
  targetBindings: z
    .union([
      z.object({
        targets: z.array(
          z.object({
            target_id: z.string().min(1),
            role: z.enum([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]),
          }),
        ),
      }),
      z.object({
        frontend_target: z.string().min(1).nullable().default(null),
        backend_target: z.string().min(1).nullable().default(null),
      }),
    ])
    .default({ targets: [] })
    .transform((bindings) => {
      if ("targets" in bindings) return bindings;
      return {
        targets: [
          ...(bindings.backend_target
            ? [{ target_id: bindings.backend_target, role: AgentStage.BACKEND_ENGINEER as const }]
            : []),
          ...(bindings.frontend_target
            ? [{ target_id: bindings.frontend_target, role: AgentStage.FRONTEND_ENGINEER as const }]
            : []),
        ],
      };
    }),
  /**
   * The Knowledge-root identity frozen at intake (DR §5): a task runs on the
   * root it was created with, so a later `default_root` change or `--root`
   * flag cannot repoint a resumed task. Null for legacy rows and tasks
   * created with no installation file — "nothing was frozen", which is true
   * rather than broken, same defaulting pattern as `paused` above.
   */
  knowledgeRoot: KnowledgeRootIdentitySchema.nullable().default(null),
  /**
   * V13 TASK-003: the `task-completion` evidence record written in the same
   * transaction that moved the task to DEPLOYED. Done is DEPLOYED *and* this
   * record (`transitionGuard.ts` `isTaskDone`/`verifyTaskCompletion`); a row
   * without the field is refused, and a DEPLOYED row with null is not Done.
   */
  completionEvidenceId: z.string().regex(/^evd_[0-9a-f]{32}$/).nullable(),
});
export type PersistedTask = z.infer<typeof PersistedTaskSchema>;

/**
 * One recorded event, with audit fields alongside the payload.
 *
 * `type` is WHAT and `at` is WHEN; the five below are WHO / WHY / INPUT /
 * OUTPUT / DECISION. They are nullable and defaulted rather than required
 * because two things legitimately have nothing to put in them: an old row,
 * and an event that genuinely made no decision (an agent finishing is a fact,
 * not a choice). `audit/auditTrail.ts` derives the same fields from `payload`
 * when they are null, so an old row still reads as a proper trail instead of
 * a wall of nulls.
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
export interface TaskStore extends EvidenceStore {
  /**
   * Runs `fn` as one all-or-nothing unit: every write inside it lands together
   * or none of them does, including writes made through a run ledger backed by
   * the same file and evidence records (V13 TASK-002). Added for T-V8-017, whose whole point is that a plan cannot
   * half-register. A nested call joins the open transaction and runs inline, so
   * an inner unit commits with the outer one or is rolled back with it.
   */
  transaction<T>(fn: () => T): T;
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
  gateContext?: PersistedTask["gateContext"];
  knowledgeRoot?: PersistedTask["knowledgeRoot"];
}): PersistedTask {
  return {
    taskId: params.taskId,
    createdAt: params.now,
    updatedAt: params.now,
    dependsOn: params.dependsOn ?? [],
    classification: params.classification,
    runtimeTask: params.runtimeTask ?? null,
    machine: params.machine,
    retries: { review: 0, qa: 0, security: 0 },
    gateContext: params.gateContext ?? {},
    approvals: [],
    artifacts: {},
    pipelineCursor: 0,
    blockedReason: null,
    lastFailure: null,
    recoveryDecision: null,
    inFlightAttempt: null,
    settledAttempt: null,
    paused: false,
    cancelled: false,
    cancelReason: null,
    environment: params.environment ?? Environment.LOCAL,
    deployPrepared: false,
    targetBindings: params.targetBindings ?? { targets: [] },
    knowledgeRoot: params.knowledgeRoot ?? null,
    completionEvidenceId: null,
  };
}
