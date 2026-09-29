import { z } from "zod";
import { ROLE_LANES, type RoleLane } from "../roles/roleLane.js";
import {
  ApprovalDecisionError,
  ApprovalRequestIdSchema,
  ApprovalStatusSchema,
  ApprovalType,
  HumanDecisionRecordSchema,
  newApprovalRequestId,
  type HumanDecisionRecord,
} from "./approval.js";

/**
 * The lane ledger (V13 TASK-028): lane sign-offs and lane acknowledgements as
 * pending requests and trusted human decisions, never as Knowledge files.
 *
 * A lane act is about a module's knowledge, not about one task, so it is not
 * in a task's approval ledger — but it follows the same rules. Every request
 * has an immutable STA-minted `requestId` and an immutable scope: which
 * Knowledge root, module, lane and act, and the exact `{id, version, digest}`
 * of every item it covers. A decision is accepted only through a
 * `HumanDecisionVerifier`, only for the exact pending request it names, only
 * when the verifier attests the same scope, and only with a decision id never
 * seen before. Stage entry reads the decided records; nothing reads
 * `knowledge/_roles/**`, an item's `status: approved`, or a `--by` name as
 * authority.
 *
 * The two acts (human decision 1, R14B: separate decisions):
 *   - **signoff** — the person in the lane says the lane is finished. It also
 *     makes the covered items binding (human decision 3: item approval is part
 *     of the lane sign-off, not a separate act), so an item is `approved` in
 *     STA's reading exactly when the lane's latest decided sign-off covers it
 *     at its current version and digest.
 *   - **ack** — the person in the receiving lane says they have seen these
 *     exact versions. The handoff watermark is built from these decisions.
 *
 * Each lane and act has its own gate type, hence its own approver list
 * (human decision 2: new gate type per lane).
 */

export const LANE_ACTIONS = ["signoff", "ack"] as const;
export type LaneAction = (typeof LANE_ACTIONS)[number];

export const LANE_SIGNOFF_TYPE: Record<RoleLane, ApprovalType> = {
  ba: ApprovalType.BA_SIGNOFF,
  sa: ApprovalType.SA_SIGNOFF,
  uxui: ApprovalType.UXUI_SIGNOFF,
  dev: ApprovalType.DEV_SIGNOFF,
};

export const LANE_ACK_TYPE: Record<RoleLane, ApprovalType> = {
  ba: ApprovalType.BA_ACK,
  sa: ApprovalType.SA_ACK,
  uxui: ApprovalType.UXUI_ACK,
  dev: ApprovalType.DEV_ACK,
};

/** The one gate type a lane act is decided under. */
export function laneApprovalType(lane: RoleLane, action: LaneAction): ApprovalType {
  return action === "signoff" ? LANE_SIGNOFF_TYPE[lane] : LANE_ACK_TYPE[lane];
}

/** One item a lane act covers: its identity, the version asked about, and a digest of its content at that version. */
export const LaneItemRefSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LaneItemRef = z.infer<typeof LaneItemRefSchema>;

export const LaneApprovalScopeSchema = z
  .strictObject({
    kind: z.literal("lane"),
    /** Canonical (realpath) Knowledge root the items were read from. */
    knowledgeRoot: z.string().min(1),
    module: z.string().min(1),
    lane: z.enum(ROLE_LANES),
    action: z.enum(LANE_ACTIONS),
    type: z.enum(ApprovalType),
    /** Sorted by id, one entry per id. Never empty: an act about nothing would never go stale. */
    items: z.array(LaneItemRefSchema).min(1),
  })
  .superRefine((scope, ctx) => {
    if (scope.type !== laneApprovalType(scope.lane, scope.action)) {
      ctx.addIssue({ code: "custom", message: `a ${scope.lane} ${scope.action} is decided under ${laneApprovalType(scope.lane, scope.action)}, not ${scope.type}` });
    }
    for (let i = 1; i < scope.items.length; i++) {
      if (!(scope.items[i - 1]!.id < scope.items[i]!.id)) {
        ctx.addIssue({ code: "custom", message: "lane items must be sorted by id with no duplicate" });
        break;
      }
    }
  });
export type LaneApprovalScope = z.infer<typeof LaneApprovalScopeSchema>;

export const LanePublicationSchema = z.strictObject({ channel: z.string().min(1), ref: z.string().min(1), url: z.string().nullable() });

export const LaneApprovalRecordSchema = z
  .strictObject({
    requestId: ApprovalRequestIdSchema,
    scope: LaneApprovalScopeSchema,
    status: ApprovalStatusSchema,
    reason: z.string().min(1),
    requestedAt: z.number(),
    /** Set exactly when status is approved/rejected. */
    decision: HumanDecisionRecordSchema.nullable(),
    /** Set exactly when status is withdrawn: what the request covered changed before anyone answered. */
    withdrawal: z.strictObject({ at: z.number(), reason: z.string().min(1) }).nullable(),
    /** Where STA announced the request on its channel (chat-relay: the request ID). A decision is read only there. */
    publication: LanePublicationSchema.nullable(),
  })
  .superRefine((record, ctx) => {
    const decided = record.status === "approved" || record.status === "rejected";
    if (decided !== (record.decision !== null)) {
      ctx.addIssue({ code: "custom", message: `lane request ${record.requestId}: status ${record.status} disagrees with its decision record` });
    }
    if (decided && record.decision && record.decision.approved !== (record.status === "approved")) {
      ctx.addIssue({ code: "custom", message: `lane request ${record.requestId}: status ${record.status} disagrees with decision.approved` });
    }
    if ((record.status === "withdrawn") !== (record.withdrawal !== null)) {
      ctx.addIssue({ code: "custom", message: `lane request ${record.requestId}: status ${record.status} disagrees with its withdrawal record` });
    }
  });
export type LaneApprovalRecord = z.infer<typeof LaneApprovalRecordSchema>;

/** Which lane questions a record answers: one Knowledge root, one module, one lane, one act. */
export interface LaneKey {
  knowledgeRoot: string;
  module: string;
  lane: RoleLane;
  action: LaneAction;
}

export function sameLaneKey(scope: LaneKey, key: LaneKey): boolean {
  return scope.knowledgeRoot === key.knowledgeRoot && scope.module === key.module && scope.lane === key.lane && scope.action === key.action;
}

export function sameLaneScope(a: LaneApprovalScope, b: LaneApprovalScope): boolean {
  return (
    a.kind === b.kind &&
    sameLaneKey(a, b) &&
    a.type === b.type &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => item.id === b.items[i]!.id && item.version === b.items[i]!.version && item.digest === b.items[i]!.digest)
  );
}

/** A decision a trusted channel produced for a lane request, before the ledger checks it. */
export interface VerifiedLaneDecision {
  requestId: string;
  scope: LaneApprovalScope;
  decision: HumanDecisionRecord;
}

/** Everything the store must keep for the lane ledger. Rows are only trusted once they re-parse. */
export interface LaneDecisionStore {
  /** Inserts a new request. Throws when the id already exists. */
  insertLaneRequest(record: LaneApprovalRecord): void;
  /** Replaces an existing request row (decision, withdrawal or publication). Throws when it does not exist. */
  updateLaneRequest(record: LaneApprovalRecord): void;
  loadLaneRequest(requestId: string): LaneApprovalRecord | null;
  /** Every request for one Knowledge root and module, oldest first. */
  laneRequests(knowledgeRoot: string, module: string): LaneApprovalRecord[];
  /** Whether any lane decision already carries this decision id — the cross-module replay check. */
  laneDecisionIdExists(decisionId: string): boolean;
}

export function parseLaneRecord(requestId: string, data: unknown): LaneApprovalRecord {
  const parsed = LaneApprovalRecordSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApprovalDecisionError("untrusted-decision", `stored lane request ${requestId} is corrupt: ${parsed.error.message}`);
  }
  if (parsed.data.requestId !== requestId) {
    throw new ApprovalDecisionError("untrusted-decision", `stored lane request ${requestId} names ${parsed.data.requestId}`);
  }
  return parsed.data;
}

/** The request of this lane act a person may answer now: the newest one, if it is still pending. */
export function pendingLaneRequest(records: readonly LaneApprovalRecord[], key: LaneKey): LaneApprovalRecord | null {
  const latest = [...records].reverse().find((r) => sameLaneKey(r.scope, key) && r.status !== "withdrawn");
  return latest?.status === "pending" ? latest : null;
}

/** Every decided (approved or rejected) request of this lane act, oldest first. */
export function decidedLaneRecords(records: readonly LaneApprovalRecord[], key: LaneKey): LaneApprovalRecord[] {
  return records.filter((r) => sameLaneKey(r.scope, key) && (r.status === "approved" || r.status === "rejected"));
}

export interface OpenLaneRequestParams {
  scope: LaneApprovalScope;
  reason: string;
  now: number;
  /** Injected only by tests that need a known id; production always mints a fresh random one. */
  requestId?: string;
}

/**
 * What opening a lane request does to the ledger: reuse the pending request
 * when it asks exactly the same question, otherwise withdraw it (its subject
 * changed before anyone answered) and open a fresh one. Pure: returns the
 * rows to write, the store commits them.
 */
export function planLaneRequest(
  records: readonly LaneApprovalRecord[],
  params: OpenLaneRequestParams,
): { request: LaneApprovalRecord; insert: LaneApprovalRecord | null; withdraw: LaneApprovalRecord | null } {
  const scope = LaneApprovalScopeSchema.parse(params.scope);
  const pending = pendingLaneRequest(records, scope);
  if (pending && sameLaneScope(pending.scope, scope)) return { request: pending, insert: null, withdraw: null };
  const withdraw = pending
    ? LaneApprovalRecordSchema.parse({
        ...pending,
        status: "withdrawn",
        withdrawal: { at: params.now, reason: "what the request covered changed before anyone answered it; superseded by a fresh request" },
      })
    : null;
  const insert = LaneApprovalRecordSchema.parse({
    requestId: params.requestId ?? newApprovalRequestId(),
    scope,
    status: "pending",
    reason: params.reason,
    requestedAt: params.now,
    decision: null,
    withdrawal: null,
    publication: null,
  });
  return { request: insert, insert, withdraw };
}

/**
 * Applies a verified decision to the exact pending lane request it names.
 * Refuses an unsolicited decision, one for a request no longer pending, one
 * a newer request superseded, one whose attested scope differs from the
 * request's (a decision cannot move to another module, lane, act or item
 * version), and a decision id already applied anywhere in the lane ledger.
 */
export function applyLaneDecision(
  records: readonly LaneApprovalRecord[],
  verified: VerifiedLaneDecision,
  decisionIdSeen: (decisionId: string) => boolean,
): LaneApprovalRecord {
  const decision = HumanDecisionRecordSchema.safeParse(verified.decision);
  if (!decision.success) {
    throw new ApprovalDecisionError("untrusted-decision", `decision for ${verified.requestId} is malformed: ${decision.error.message}`);
  }
  const record = records.find((r) => r.requestId === verified.requestId);
  if (!record) {
    throw new ApprovalDecisionError("unknown-request", `no lane request ${verified.requestId} was opened here — a decision cannot precede the question`);
  }
  if (record.status !== "pending") {
    throw new ApprovalDecisionError("not-pending", `lane request ${record.requestId} is already ${record.status}`);
  }
  if (pendingLaneRequest(records, record.scope)?.requestId !== record.requestId) {
    throw new ApprovalDecisionError("superseded", `lane request ${record.requestId} was superseded by a newer ${record.scope.type} request`);
  }
  const attested = LaneApprovalScopeSchema.safeParse(verified.scope);
  if (!attested.success || !sameLaneScope(record.scope, attested.data)) {
    throw new ApprovalDecisionError(
      "scope-mismatch",
      `decision scope ${JSON.stringify(verified.scope)} does not match lane request ${record.requestId} scope ${JSON.stringify(record.scope)}`,
    );
  }
  if (decisionIdSeen(decision.data.decisionId)) {
    throw new ApprovalDecisionError("replay", `decision ${decision.data.decisionId} was already applied to a lane request`);
  }
  return LaneApprovalRecordSchema.parse({
    ...record,
    status: decision.data.approved ? "approved" : "rejected",
    decision: decision.data,
  });
}
