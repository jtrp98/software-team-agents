import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentStage } from "../types.js";
import { stableHash } from "../artifacts/executionPacket.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { ApprovalType } from "../gates/approval.js";

/**
 * Persisted, typed evidence (V13 TASK-002).
 *
 * Every fact STA uses to decide a transition is a record here, linked to the
 * task, the stage, the attempt of that stage and the role that ran it — never a
 * value held in a process or an executor's result object. Records are written
 * through `TaskStore.appendEvidence` inside the same store transaction as the
 * task row they justify, so a state change and its evidence commit together or
 * not at all.
 *
 * Identity is deterministic: `evidenceId` is derived from
 * (task, stage, attempt, kind, subject), and `digest` from the payload and
 * references. Appending the same record twice is a no-op; appending a
 * different record under the same identity is refused as a conflict, so a
 * repeated attempt can never silently rewrite what was recorded. Every read
 * re-derives both values, so a corrupted or hand-edited row fails loudly.
 */

export const EVIDENCE_KINDS = [
  /** One role execution of a stage attempt — the outcome STA observed, not the agent's claim about it. */
  "role-run",
  /** A validated artifact the attempt produced, referenced by content digest. */
  "artifact",
  /** The deterministic post-Dev sweep, stored whole so a later process (QA) reads the real result. */
  "deterministic-verification",
  /** A trusted human decision applied to a pending approval request. */
  "approval-decision",
  /**
   * STA's own check that a reviewer attempt was an independent review of the
   * completed implementation (V13 TASK-006) — evaluated by the orchestrator,
   * never taken from the reviewer's report.
   */
  "review-independence",
  /** STA's decision that a stage attempt satisfied its required evidence. */
  "stage-completion",
  /** STA's decision that the whole task is Done, referencing every evidence id that proves it. */
  "task-completion",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const DETERMINISTIC_CHECK_IDS = ["lint", "typecheck", "unit-tests", "integration-tests", "build"] as const;

const DeterministicTargetResultSchema = z.strictObject({
  targetId: z.string().optional(),
  root: z.string(),
  status: z.enum(["PASS", "FAIL"]),
  durationMs: z.number(),
  outputSummary: z.string(),
});

const DeterministicCheckResultSchema = z.strictObject({
  id: z.enum(DETERMINISTIC_CHECK_IDS),
  status: z.enum(["PASS", "FAIL"]),
  durationMs: z.number(),
  outputSummary: z.string(),
  targetResults: z.array(DeterministicTargetResultSchema).readonly().optional(),
});

/** The persisted shape of `qa/deterministic.ts`'s `DeterministicVerification`. */
export const DeterministicVerificationSchema = z.strictObject({
  required: z.array(z.enum(DETERMINISTIC_CHECK_IDS)),
  ran: z.array(DeterministicCheckResultSchema),
  failures: z.array(DeterministicCheckResultSchema),
  skipped: z.array(z.enum(DETERMINISTIC_CHECK_IDS)),
  missingRequired: z.array(z.string()),
  status: z.enum(["passed", "failed", "skipped"]),
  enforcement: z.enum(["warn", "enforce"]),
  passed: z.boolean(),
  selection: z
    .strictObject({
      source: z.string(),
      taskTypes: z.array(z.string()),
      levels: z.array(z.string()),
      reason: z.string(),
    })
    .optional(),
});

const RoleRunPayloadSchema = z.strictObject({
  kind: z.literal("role-run"),
  result: z.enum(["PASS", "FAIL"]),
  failureReason: z.string().nullable(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  packetPath: z.string().nullable(),
  deployPhase: z.enum(["prepare", "execute"]).nullable(),
  startedAt: z.number(),
  endedAt: z.number(),
  /**
   * V13 TASK-005 — sha256 of the exact `contracts/<stage>.yaml` bytes that
   * `resolveAuthoritativeContract` resolved and enforced *before this attempt
   * was allowed to start* (`runtimeExecutor.ts`'s dispatch preflight) — never
   * recomputed after the fact. Null only for an attempt refused at that same
   * preflight, before any contract resolved (HUMAN is a gate, not a
   * dispatched role, and never produces a "role-run" record at all).
   */
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

const ArtifactPayloadSchema = z.strictObject({
  kind: z.literal("artifact"),
  artifactType: z.enum(ArtifactType),
  /** sha256 of the exact stored artifact bytes (`artifacts[artifactType]` on the task row). */
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Where the bytes live; a Knowledge artifact reference replaces this in TASK-009. */
  location: z.string().min(1),
  /** The verdict an artifact carries (review/QA/security report status), null for one that carries none. */
  verdict: z.string().nullable(),
});

const DeterministicVerificationPayloadSchema = z.strictObject({
  kind: z.literal("deterministic-verification"),
  verification: DeterministicVerificationSchema,
});

const ApprovalDecisionPayloadSchema = z.strictObject({
  kind: z.literal("approval-decision"),
  requestId: z.string().min(1),
  decisionId: z.string().min(1),
  type: z.enum(ApprovalType),
  approved: z.boolean(),
  actorId: z.string().min(1),
  channel: z.string().min(1),
  evidenceRef: z.string().min(1),
});

const ReviewIndependencePayloadSchema = z.strictObject({
  kind: z.literal("review-independence"),
  /** The code-producing stages of this task's pipeline the review covers, in pipeline order. */
  reviewedStages: z.array(z.enum(AgentStage)).min(1),
  /** The stage-completion evidence ids of those stages' latest attempts — the implementation that was reviewed. */
  implementationCompletionIds: z.array(z.string().regex(/^evd_[0-9a-f]{32}$/)).min(1),
  /** The contract digest the reviewer attempt was dispatched under (its role-run record). */
  reviewerContractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The checks STA ran, by name, all of which held. */
  checks: z.array(z.string().min(1)).min(1),
});

const StageCompletionPayloadSchema = z.strictObject({
  kind: z.literal("stage-completion"),
  /** The requirement names that were satisfied, in table order (`transitionGuard.ts`). */
  satisfied: z.array(z.string().min(1)).min(1),
});

const TaskCompletionPayloadSchema = z.strictObject({
  kind: z.literal("task-completion"),
  pipeline: z.array(z.enum(AgentStage)),
});

export const EvidencePayloadSchema = z.discriminatedUnion("kind", [
  RoleRunPayloadSchema,
  ArtifactPayloadSchema,
  DeterministicVerificationPayloadSchema,
  ApprovalDecisionPayloadSchema,
  ReviewIndependencePayloadSchema,
  StageCompletionPayloadSchema,
  TaskCompletionPayloadSchema,
]);
export type EvidencePayload = z.infer<typeof EvidencePayloadSchema>;

const EVIDENCE_ID = /^evd_[0-9a-f]{32}$/;

export const EvidenceRecordSchema = z.strictObject({
  evidenceId: z.string().regex(EVIDENCE_ID),
  taskId: z.string().min(1),
  stage: z.enum(AgentStage),
  /** 1-based attempt of `stage` this record belongs to. */
  attempt: z.number().int().positive(),
  /** The role that ran the stage (registry role), or "orchestrator"/"human" for STA and human decisions. */
  role: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  /** Disambiguates several records of one kind in one attempt (the artifact type, the request id). */
  subject: z.string().min(1),
  payload: EvidencePayloadSchema,
  /** Evidence ids this record depends on; each must already exist for the same task. */
  refs: z.array(z.string().regex(EVIDENCE_ID)),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.number(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export type NewEvidence = Omit<EvidenceRecord, "evidenceId" | "digest" | "kind"> & { kind?: EvidenceKind };

export class EvidenceConflictError extends Error {
  constructor(public readonly evidenceId: string) {
    super(`evidence ${evidenceId} already exists with different content — a recorded attempt is never rewritten`);
    this.name = "EvidenceConflictError";
  }
}

export class EvidenceCorruptError extends Error {
  constructor(public readonly evidenceId: string, detail: string) {
    super(`stored evidence ${evidenceId} is corrupt: ${detail}`);
    this.name = "EvidenceCorruptError";
  }
}

export class MissingEvidenceReferenceError extends Error {
  constructor(public readonly evidenceId: string, public readonly missing: readonly string[]) {
    super(`evidence ${evidenceId} references evidence that does not exist for its task: ${missing.join(", ")}`);
    this.name = "MissingEvidenceReferenceError";
  }
}

export function evidenceIdFor(key: {
  taskId: string;
  stage: AgentStage;
  attempt: number;
  kind: EvidenceKind;
  subject: string;
}): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([key.taskId, key.stage, key.attempt, key.kind, key.subject]))
    .digest("hex");
  return `evd_${hash.slice(0, 32)}`;
}

function digestOf(record: Pick<EvidenceRecord, "payload" | "refs" | "role">): string {
  return stableHash({ payload: record.payload, refs: record.refs, role: record.role });
}

/** Builds a complete record from its content: kind comes from the payload, id and digest are derived. */
export function buildEvidence(input: NewEvidence): EvidenceRecord {
  const payload = EvidencePayloadSchema.parse(input.payload);
  const kind = payload.kind;
  if (input.kind !== undefined && input.kind !== kind) {
    throw new Error(`evidence kind ${input.kind} does not match its payload kind ${kind}`);
  }
  const refs = [...new Set(input.refs)].sort();
  const base = {
    taskId: input.taskId,
    stage: input.stage,
    attempt: input.attempt,
    role: input.role,
    kind,
    subject: input.subject,
    payload,
    refs,
    recordedAt: input.recordedAt,
  };
  return EvidenceRecordSchema.parse({
    ...base,
    evidenceId: evidenceIdFor(base),
    digest: digestOf(base),
  });
}

/**
 * Re-validates a stored record: schema, derived id and digest. Shared by both
 * store implementations so a row read from memory is trusted exactly as far as
 * one read from SQLite.
 */
export function parseStoredEvidence(evidenceId: string, data: unknown): EvidenceRecord {
  const parsed = EvidenceRecordSchema.safeParse(data);
  if (!parsed.success) {
    throw new EvidenceCorruptError(
      evidenceId,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const record = parsed.data;
  if (record.evidenceId !== evidenceId) throw new EvidenceCorruptError(evidenceId, `row carries id ${record.evidenceId}`);
  if (record.kind !== record.payload.kind) throw new EvidenceCorruptError(evidenceId, "kind does not match payload");
  if (evidenceIdFor(record) !== record.evidenceId) throw new EvidenceCorruptError(evidenceId, "id does not match its identity fields");
  if (digestOf(record) !== record.digest) throw new EvidenceCorruptError(evidenceId, "digest does not match its content");
  return record;
}

/**
 * The idempotence rule both stores apply before writing: an identical record is
 * already recorded (returns false — nothing to write), a different one under
 * the same id is a conflict, and every reference must already exist.
 */
export function checkEvidenceAppend(
  record: EvidenceRecord,
  existing: EvidenceRecord | null,
  hasRef: (evidenceId: string) => boolean,
): boolean {
  if (existing) {
    if (existing.digest !== record.digest) throw new EvidenceConflictError(record.evidenceId);
    return false;
  }
  const missing = record.refs.filter((ref) => !hasRef(ref));
  if (missing.length > 0) throw new MissingEvidenceReferenceError(record.evidenceId, missing);
  return true;
}

/**
 * V13 TASK-005 (Part D) — the contract digest bound to the latest recorded
 * attempt of `stage` on this task's evidence, or `null` when that stage has
 * never produced a "role-run" record. The dispatch preflight
 * (`runtimeExecutor.ts`) uses this to detect a contract that changed on disk
 * between one attempt and the next (a retry/resume), and any caller can use
 * it to answer "which contract digest was bound to stage X attempt N"
 * without new plumbing — `evidenceForTask` already returns every record.
 */
export function contractDigestForStage(records: readonly EvidenceRecord[], stage: AgentStage): string | null {
  let latest: EvidenceRecord | null = null;
  for (const record of records) {
    if (record.stage !== stage || record.kind !== "role-run") continue;
    if (!latest || record.attempt > latest.attempt) latest = record;
  }
  return latest && latest.payload.kind === "role-run" ? latest.payload.contractDigest : null;
}

/** The persistence half of the evidence store, implemented by every `TaskStore`. */
export interface EvidenceStore {
  /**
   * Appends one record. Idempotent for an identical record; throws
   * `EvidenceConflictError` for a different record under the same identity and
   * `MissingEvidenceReferenceError` for a dangling reference. Call inside
   * `TaskStore.transaction` together with the state change it justifies.
   */
  appendEvidence(record: EvidenceRecord): EvidenceRecord;
  /** Throws `EvidenceCorruptError` when the stored row no longer re-derives. */
  loadEvidence(evidenceId: string): EvidenceRecord | null;
  /** Every record of one task in the order it was recorded; each re-validated. */
  evidenceForTask(taskId: string): EvidenceRecord[];
}
