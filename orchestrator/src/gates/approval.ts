import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TaskState } from "../types.js";

/**
 * Human approval as a persisted request/decision ledger, never a boolean.
 *
 * Every question STA asks is a pending request with an immutable `requestId`
 * and an immutable scope (task, type, guarded edge). A decision is accepted
 * only when it names that exact pending request, matches its scope, carries a
 * decision id never seen before in this ledger, and was produced by a trusted
 * human channel (`humanDecision.ts`). There is no other way to move a request
 * out of `pending` except `withdrawApproval`, which records that STA itself
 * found the gate discharged by evidence — it never records a human "yes".
 *
 * The gate booleans are derived from this ledger at check time
 * (`gateEvidenceFrom`) and are never persisted or accepted from a caller.
 */

/** Human approval identities used when a risk-triggered gate actually opens. */
export enum ApprovalType {
  /** Interactive BA fallback or an exact unresolved material business question. */
  REQUIREMENT_INTERVIEW = "requirement-interview",
  /** Risk-triggered design gate (schema, migration, breaking, critical security, ambiguity). */
  SCHEMA_CONFIRMATION = "schema-confirmation",
  /** A reviewer round whose failure no automatic route may answer (V13 TASK-006). */
  REVIEW_FAILURE = "review-failure",
  /** Any ⚠️/❌ QA round. */
  QA_FAILURE = "qa-failure",
  /** Any 🔴/🟠 security finding. */
  SECURITY_RISK = "security-risk",
  /** An actual deploy or migration. */
  DEPLOY = "deploy",
  /** Human UX/UI approval before a frontend stage may start. */
  UXUI_SIGNOFF = "uxui-signoff",
}

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "withdrawn"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const APPROVAL_REQUEST_ID_PATTERN = /^apr_[0-9a-f]{32}$/;
export const ApprovalRequestIdSchema = z.string().regex(APPROVAL_REQUEST_ID_PATTERN);

/** What a request covers. Immutable once the request is opened; a decision must name the same scope. */
export const ApprovalScopeSchema = z.strictObject({
  taskId: z.string().min(1),
  type: z.enum(ApprovalType),
  /** The edge this guards. Null for an approval that is not tied to one (an escalated failure). */
  from: z.enum(TaskState).nullable(),
  to: z.enum(TaskState).nullable(),
});
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

/** A decision as recorded after the trusted channel and the ledger checks both accepted it. */
export const HumanDecisionRecordSchema = z.strictObject({
  /** Channel-issued unique id. A second decision carrying the same id is a replay. */
  decisionId: z.string().min(1),
  approved: z.boolean(),
  actor: z.strictObject({ kind: z.literal("human"), id: z.string().min(1) }),
  /** Which trusted channel authenticated the actor, and the channel's own reference for that proof. */
  source: z.strictObject({ channel: z.string().min(1), evidenceRef: z.string().min(1) }),
  decidedAt: z.number(),
  /** What they said beyond yes/no. The reason a rejection is actionable rather than just a stop. */
  note: z.string().nullable(),
});
export type HumanDecisionRecord = z.infer<typeof HumanDecisionRecordSchema>;

export const ApprovalRecordSchema = z.strictObject({
  requestId: ApprovalRequestIdSchema,
  scope: ApprovalScopeSchema,
  required: z.boolean(),
  status: ApprovalStatusSchema,
  reason: z.string().min(1),
  requestedAt: z.number(),
  /** Set exactly when status is approved/rejected. */
  decision: HumanDecisionRecordSchema.nullable(),
  /** Set exactly when status is withdrawn: STA found the gate discharged by evidence, no human answered. */
  withdrawal: z.strictObject({ at: z.number(), reason: z.string().min(1) }).nullable(),
}).superRefine((record, ctx) => {
  const decided = record.status === "approved" || record.status === "rejected";
  if (decided !== (record.decision !== null)) {
    ctx.addIssue({ code: "custom", message: `approval ${record.requestId}: status ${record.status} disagrees with its decision record` });
  }
  if (decided && record.decision && record.decision.approved !== (record.status === "approved")) {
    ctx.addIssue({ code: "custom", message: `approval ${record.requestId}: status ${record.status} disagrees with decision.approved` });
  }
  if ((record.status === "withdrawn") !== (record.withdrawal !== null)) {
    ctx.addIssue({ code: "custom", message: `approval ${record.requestId}: status ${record.status} disagrees with its withdrawal record` });
  }
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** The full ledger for one task, oldest first. */
export type ApprovalLedger = ApprovalRecord[];

/**
 * Which approval an edge needs, if any. Only the edges `gatePolicy.ts`
 * actually gates appear here.
 */
export function approvalTypeForEdge(from: TaskState, to: TaskState): ApprovalType | null {
  if (from === TaskState.REQUIREMENT) return ApprovalType.REQUIREMENT_INTERVIEW;
  if (from === TaskState.DESIGN) return ApprovalType.SCHEMA_CONFIRMATION;
  if (from === TaskState.READY_TO_DEPLOY && to === TaskState.APPROVED) return ApprovalType.DEPLOY;
  return null;
}

/** The derived gate fact an approval type feeds. */
function gateFieldFor(type: ApprovalType): keyof ApprovalGateFacts | null {
  if (type === ApprovalType.REQUIREMENT_INTERVIEW) return "requirementApproved";
  if (type === ApprovalType.SCHEMA_CONFIRMATION) return "designApproved";
  if (type === ApprovalType.DEPLOY) return "humanApproved";
  return null;
}

export function findApproval(ledger: ApprovalLedger, type: ApprovalType): ApprovalRecord | undefined {
  // Last wins: a type can legitimately be asked more than once across a task's
  // life (a reopened question), and the current request is the newest.
  return [...ledger].reverse().find((a) => a.scope.type === type);
}

export function findApprovalRequest(ledger: ApprovalLedger, requestId: string): ApprovalRecord | undefined {
  return ledger.find((a) => a.requestId === requestId);
}

export function pendingApprovals(ledger: ApprovalLedger): ApprovalRecord[] {
  return ledger.filter((a) => a.status === "pending");
}

/** A rejection stops the task for good unless a person explicitly revisits it — it is an answer, not an absence. */
export function rejectedApprovals(ledger: ApprovalLedger): ApprovalRecord[] {
  return ledger.filter((a) => a.status === "rejected");
}

export function newApprovalRequestId(): string {
  return `apr_${randomUUID().replace(/-/g, "")}`;
}

export interface RequestApprovalParams {
  taskId: string;
  type: ApprovalType;
  reason: string;
  now: number;
  from?: TaskState;
  to?: TaskState;
  /** Injected only by tests that need a known id; production always mints a fresh random one. */
  requestId?: string;
}

/**
 * Opens a pending request, or returns the ledger untouched when this type is
 * already outstanding or already answered. Must be idempotent: `status()` is
 * polled, and every poll must not append another identical question. Re-asking
 * an answered approval is `reopenApproval`, a deliberate separate act.
 */
export function requestApproval(ledger: ApprovalLedger, params: RequestApprovalParams): ApprovalLedger {
  const existing = findApproval(ledger, params.type);
  // A withdrawn request was closed by evidence, not answered; if the gate is
  // needed again, it needs a fresh question.
  if (existing && existing.status !== "withdrawn") return ledger;
  return [...ledger, openRecord(params)];
}

function openRecord(params: RequestApprovalParams): ApprovalRecord {
  return ApprovalRecordSchema.parse({
    requestId: params.requestId ?? newApprovalRequestId(),
    scope: { taskId: params.taskId, type: params.type, from: params.from ?? null, to: params.to ?? null },
    required: true,
    status: "pending",
    reason: params.reason,
    requestedAt: params.now,
    decision: null,
    withdrawal: null,
  });
}

/** Every way a decision can be refused. Each is a distinct type so callers and tests can tell them apart. */
export class ApprovalDecisionError extends Error {
  constructor(
    public readonly code:
      | "unknown-request"
      | "not-pending"
      | "superseded"
      | "scope-mismatch"
      | "replay"
      | "untrusted-decision",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalDecisionError";
  }
}

/** A decision a trusted channel produced, before the ledger checks it. */
export interface VerifiedHumanDecision {
  requestId: string;
  scope: ApprovalScope;
  decision: HumanDecisionRecord;
}

/**
 * Applies a verified human decision to the exact pending request it names.
 *
 * Refuses a decision for a request that was never opened (unsolicited), one
 * that is no longer pending (replay of an answered question), one that a newer
 * request of the same type superseded, one whose scope differs from the
 * request's, and one whose decision id already appears in the ledger.
 */
export function applyHumanDecision(ledger: ApprovalLedger, verified: VerifiedHumanDecision): ApprovalLedger {
  const decision = HumanDecisionRecordSchema.safeParse(verified.decision);
  if (!decision.success) {
    throw new ApprovalDecisionError("untrusted-decision", `decision for ${verified.requestId} is malformed: ${decision.error.message}`);
  }
  const record = findApprovalRequest(ledger, verified.requestId);
  if (!record) {
    throw new ApprovalDecisionError(
      "unknown-request",
      `no approval request ${verified.requestId} was opened for this task — a decision cannot precede the question`,
    );
  }
  if (record.status !== "pending") {
    throw new ApprovalDecisionError("not-pending", `approval request ${record.requestId} is already ${record.status}`);
  }
  if (findApproval(ledger, record.scope.type)?.requestId !== record.requestId) {
    throw new ApprovalDecisionError("superseded", `approval request ${record.requestId} was superseded by a newer ${record.scope.type} request`);
  }
  if (!sameScope(record.scope, verified.scope)) {
    throw new ApprovalDecisionError(
      "scope-mismatch",
      `decision scope ${JSON.stringify(verified.scope)} does not match request ${record.requestId} scope ${JSON.stringify(record.scope)}`,
    );
  }
  if (ledger.some((a) => a.decision?.decisionId === decision.data.decisionId)) {
    throw new ApprovalDecisionError("replay", `decision ${decision.data.decisionId} was already applied to this task`);
  }
  const decided = ApprovalRecordSchema.parse({
    ...record,
    status: decision.data.approved ? "approved" : "rejected",
    decision: decision.data,
  });
  return ledger.map((a) => (a === record ? decided : a));
}

export function sameScope(a: ApprovalScope, b: ApprovalScope): boolean {
  return a.taskId === b.taskId && a.type === b.type && a.from === b.from && a.to === b.to;
}

/**
 * Closes a pending request because STA found its gate discharged by trusted
 * evidence (e.g. confirmed business input replaced the interview). This is
 * never a human "yes": the record carries no decision and feeds no approval.
 */
export function withdrawApproval(ledger: ApprovalLedger, requestId: string, params: { now: number; reason: string }): ApprovalLedger {
  const record = findApprovalRequest(ledger, requestId);
  if (!record) throw new ApprovalDecisionError("unknown-request", `no approval request ${requestId} was opened for this task`);
  if (record.status !== "pending") throw new ApprovalDecisionError("not-pending", `approval request ${requestId} is already ${record.status}`);
  const withdrawn = ApprovalRecordSchema.parse({ ...record, status: "withdrawn", withdrawal: { at: params.now, reason: params.reason } });
  return ledger.map((a) => (a === record ? withdrawn : a));
}

/** Asks a settled question again under a fresh request id — the only way a rejection is ever revisited. */
export function reopenApproval(ledger: ApprovalLedger, type: ApprovalType, now: number): ApprovalLedger {
  const existing = findApproval(ledger, type);
  if (!existing) throw new ApprovalDecisionError("unknown-request", `no approval of type "${type}" has been requested for this task`);
  if (existing.status === "pending") return ledger;
  return [
    ...ledger,
    openRecord({
      taskId: existing.scope.taskId,
      type,
      reason: existing.reason,
      now,
      from: existing.scope.from ?? undefined,
      to: existing.scope.to ?? undefined,
    }),
  ];
}

export interface ApprovalGateFacts {
  requirementApproved?: boolean;
  designApproved?: boolean;
  humanApproved?: boolean;
}

/**
 * The gate facts, derived from the current request of each gating type.
 * Only a recorded human decision yields a fact; pending and withdrawn yield none.
 */
export function gateEvidenceFrom(ledger: ApprovalLedger): ApprovalGateFacts {
  const evidence: ApprovalGateFacts = {};
  for (const type of [ApprovalType.REQUIREMENT_INTERVIEW, ApprovalType.SCHEMA_CONFIRMATION, ApprovalType.DEPLOY]) {
    const record = findApproval(ledger, type);
    if (!record?.decision) continue;
    const field = gateFieldFor(type);
    if (field) evidence[field] = record.decision.approved;
  }
  return evidence;
}

export interface ApprovalView {
  requestId: string;
  required: boolean;
  type: ApprovalType;
  status: ApprovalStatus;
  reason: string;
}

export function describeApproval(record: ApprovalRecord): ApprovalView {
  return { requestId: record.requestId, required: record.required, type: record.scope.type, status: record.status, reason: record.reason };
}
