import { z } from "zod";
import { TaskState } from "../types.js";

/**
 * Human approval as recorded state rather than a thing that happened in a
 * conversation.
 *
 * The pipeline always stopped at the right places — `gatePolicy.ts` blocks the
 * edges, and the orchestrator genuinely refuses to move past them. What it had
 * no way to say was *what* it was waiting for, *who* answered, *when*, or
 * whether the answer had been "no".
 *
 * That last one was the real gap. `gateContext.designApproved` is a boolean, so
 * `false` and "never asked" are the same value. A person who explicitly rejected
 * a schema left behind exactly the state of a person who had not looked yet, and
 * the next run would ask again as though nothing had been decided — which is how
 * a rejection quietly becomes a re-prompt until someone says yes.
 *
 * So an approval here is a record, not a flag: it carries its type, its status,
 * the edge it guards, when it was asked, when it was answered, and by whom. The
 * booleans remain as the gate's input (nothing about `gatePolicy.ts` changes),
 * but they are now derived from this ledger rather than being the whole truth.
 */

/** The five points CLAUDE.md says always wait for a person, whatever mode the pipeline is running in. */
export enum ApprovalType {
  /** business-analyst running at all — a requirement is never inferred. */
  REQUIREMENT_INTERVIEW = "requirement-interview",
  /** system-analyst's data model, before any code is written against it. */
  SCHEMA_CONFIRMATION = "schema-confirmation",
  /** Any ⚠️/❌ QA round. */
  QA_FAILURE = "qa-failure",
  /** Any 🔴/🟠 security finding. */
  SECURITY_RISK = "security-risk",
  /** An actual deploy or migration. */
  DEPLOY = "deploy",
  /** Human UX/UI approval before a frontend stage may start. */
  UXUI_SIGNOFF = "uxui-signoff",
}

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRecordSchema = z.object({
  type: z.enum(ApprovalType),
  /** Always true today — recorded rather than assumed, so a future optional approval is representable. */
  required: z.boolean(),
  status: ApprovalStatusSchema,
  /** The edge this guards. Null for an approval that is not tied to one (an escalated failure). */
  from: z.enum(TaskState).nullable(),
  to: z.enum(TaskState).nullable(),
  /** Why a person is needed, in the words the task will show them. */
  reason: z.string().min(1),
  requestedAt: z.number(),
  decidedAt: z.number().nullable(),
  /** Who answered. Free text — this pipeline has no identity system, and pretending otherwise would be worse. */
  decidedBy: z.string().nullable(),
  /** What they said beyond yes/no. The reason a rejection is actionable rather than just a stop. */
  note: z.string().nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** The full ledger for one task, oldest first. */
export type ApprovalLedger = ApprovalRecord[];

/**
 * Which approval an edge needs, if any. Only the edges `gatePolicy.ts`
 * actually gates appear here — this names what already blocks, and deliberately
 * does not invent new stopping points.
 */
export function approvalTypeForEdge(from: TaskState, to: TaskState): ApprovalType | null {
  // A requirement is never inferred (CLAUDE.md's always-human point #1): leaving
  // the REQUIREMENT state needs a person's answer, whatever pipeline brought a
  // business-analyst stage into existence. Pipelines that skip BA never enter
  // the state, so they are unaffected.
  if (from === TaskState.REQUIREMENT) return ApprovalType.REQUIREMENT_INTERVIEW;
  // Matches gatePolicy.ts's checkGate: gated on leaving DESIGN at all, since PLAN (project-manager
  // and/or test-planner) can sit between DESIGN and IMPLEMENTATION and must not be reachable
  // without the same confirmation IMPLEMENTATION requires.
  if (from === TaskState.DESIGN) return ApprovalType.SCHEMA_CONFIRMATION;
  if (from === TaskState.READY_TO_DEPLOY && to === TaskState.APPROVED) return ApprovalType.DEPLOY;
  return null;
}

/** The `gateContext` boolean an approval type feeds, so the gate keeps its existing shape. */
export function gateFieldFor(type: ApprovalType): "requirementApproved" | "designApproved" | "humanApproved" | null {
  if (type === ApprovalType.REQUIREMENT_INTERVIEW) return "requirementApproved";
  if (type === ApprovalType.SCHEMA_CONFIRMATION) return "designApproved";
  if (type === ApprovalType.DEPLOY) return "humanApproved";
  return null;
}

export function findApproval(ledger: ApprovalLedger, type: ApprovalType): ApprovalRecord | undefined {
  // Last wins: a type can legitimately be asked more than once across a task's
  // life (a second deploy after a rollback), and the current answer is the newest.
  return [...ledger].reverse().find((a) => a.type === type);
}

export function pendingApprovals(ledger: ApprovalLedger): ApprovalRecord[] {
  return ledger.filter((a) => a.status === "pending");
}

/** A rejection stops the task for good unless a person explicitly revisits it — it is an answer, not an absence. */
export function rejectedApprovals(ledger: ApprovalLedger): ApprovalRecord[] {
  return ledger.filter((a) => a.status === "rejected");
}

export interface RequestApprovalParams {
  type: ApprovalType;
  reason: string;
  now: number;
  from?: TaskState;
  to?: TaskState;
}

/**
 * Opens a pending approval, or returns the ledger untouched when this type is
 * already outstanding or already answered.
 *
 * Idempotence is the point: `status()` is polled, and every poll must not append
 * another identical question. An answered approval is likewise never reopened
 * here — re-asking is `reopenApproval`, which is a deliberate act.
 */
export function requestApproval(ledger: ApprovalLedger, params: RequestApprovalParams): ApprovalLedger {
  const existing = findApproval(ledger, params.type);
  if (existing) return ledger;

  return [
    ...ledger,
    {
      type: params.type,
      required: true,
      status: "pending",
      from: params.from ?? null,
      to: params.to ?? null,
      reason: params.reason,
      requestedAt: params.now,
      decidedAt: null,
      decidedBy: null,
      note: null,
    },
  ];
}

export class UnknownApprovalError extends Error {
  constructor(type: ApprovalType) {
    super(`no approval of type "${type}" has been requested for this task — a decision cannot precede the question`);
    this.name = "UnknownApprovalError";
  }
}

export interface DecideApprovalParams {
  type: ApprovalType;
  approved: boolean;
  now: number;
  by?: string;
  note?: string;
}

/**
 * Records a person's answer. Throws when nothing of that type was ever asked —
 * an approval that arrives for a question the task never posed is a bug at the
 * call site, and accepting it would let a task be waved through a gate it had
 * not reached.
 */
export function decideApproval(ledger: ApprovalLedger, params: DecideApprovalParams): ApprovalLedger {
  const existing = findApproval(ledger, params.type);
  if (!existing) throw new UnknownApprovalError(params.type);

  const decided: ApprovalRecord = {
    ...existing,
    status: params.approved ? "approved" : "rejected",
    decidedAt: params.now,
    decidedBy: params.by ?? null,
    note: params.note ?? null,
  };
  return ledger.map((a) => (a === existing ? decided : a));
}

/** Asks a settled question again — the only way a rejection is ever revisited, and always a deliberate act. */
export function reopenApproval(ledger: ApprovalLedger, type: ApprovalType, now: number): ApprovalLedger {
  const existing = findApproval(ledger, type);
  if (!existing) throw new UnknownApprovalError(type);
  return [
    ...ledger,
    { ...existing, status: "pending", requestedAt: now, decidedAt: null, decidedBy: null, note: null },
  ];
}

/**
 * The gate booleans, derived from the ledger rather than kept alongside it.
 *
 * One source of truth: a `gateContext.designApproved` that could be set
 * independently of the ledger would eventually disagree with it, and then
 * neither would be trustworthy.
 */
export function gateEvidenceFrom(ledger: ApprovalLedger): { requirementApproved?: boolean; designApproved?: boolean; humanApproved?: boolean } {
  const evidence: { requirementApproved?: boolean; designApproved?: boolean; humanApproved?: boolean } = {};
  for (const type of [ApprovalType.REQUIREMENT_INTERVIEW, ApprovalType.SCHEMA_CONFIRMATION, ApprovalType.DEPLOY]) {
    const record = findApproval(ledger, type);
    if (!record || record.status === "pending") continue;
    const field = gateFieldFor(type);
    if (field) evidence[field] = record.status === "approved";
  }
  return evidence;
}

/** T08's record shape, for the state view and for anything showing a person what is outstanding. */
export interface ApprovalView {
  required: boolean;
  type: ApprovalType;
  status: ApprovalStatus;
  reason: string;
}

export function describeApproval(record: ApprovalRecord): ApprovalView {
  return { required: record.required, type: record.type, status: record.status, reason: record.reason };
}
