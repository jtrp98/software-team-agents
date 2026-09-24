import { describe, expect, it } from "vitest";
import { TaskState } from "../types.js";
import {
  APPROVAL_REQUEST_ID_PATTERN,
  ApprovalDecisionError,
  ApprovalRecordSchema,
  ApprovalType,
  applyHumanDecision,
  approvalTypeForEdge,
  describeApproval,
  findApproval,
  gateEvidenceFrom,
  pendingApprovals,
  rejectedApprovals,
  reopenApproval,
  requestApproval,
  withdrawApproval,
  type ApprovalLedger,
  type ApprovalRecord,
  type VerifiedHumanDecision,
} from "./approval.js";

const TASK = "T-1";

function askSchema(ledger: ApprovalLedger = [], now = 1000): ApprovalLedger {
  return requestApproval(ledger, {
    taskId: TASK,
    type: ApprovalType.SCHEMA_CONFIRMATION,
    reason: "DESIGN_APPROVED required before development can start",
    now,
    from: TaskState.DESIGN,
    to: TaskState.IMPLEMENTATION,
  });
}

function ask(type: ApprovalType, ledger: ApprovalLedger = [], now = 1): ApprovalLedger {
  return requestApproval(ledger, { taskId: TASK, type, reason: `${type} needed`, now });
}

let decisionSeq = 0;
function verified(
  record: ApprovalRecord,
  approved: boolean,
  overrides: { decisionId?: string; actor?: string; note?: string | null; scope?: Partial<ApprovalRecord["scope"]>; now?: number } = {},
): VerifiedHumanDecision {
  decisionSeq += 1;
  return {
    requestId: record.requestId,
    scope: { ...record.scope, ...(overrides.scope ?? {}) },
    decision: {
      decisionId: overrides.decisionId ?? `dec-${decisionSeq}`,
      approved,
      actor: { kind: "human", id: overrides.actor ?? "reviewer" },
      source: { channel: "unit-channel", evidenceRef: `ref-${decisionSeq}` },
      decidedAt: overrides.now ?? 2000,
      note: overrides.note ?? null,
    },
  };
}

function decide(ledger: ApprovalLedger, type: ApprovalType, approved: boolean, overrides: Parameters<typeof verified>[2] = {}): ApprovalLedger {
  const record = findApproval(ledger, type)!;
  return applyHumanDecision(ledger, verified(record, approved, overrides));
}

describe("approvalTypeForEdge", () => {
  it("names the two edges gatePolicy actually gates", () => {
    expect(approvalTypeForEdge(TaskState.DESIGN, TaskState.IMPLEMENTATION)).toBe(ApprovalType.SCHEMA_CONFIRMATION);
    expect(approvalTypeForEdge(TaskState.READY_TO_DEPLOY, TaskState.APPROVED)).toBe(ApprovalType.DEPLOY);
  });

  it("gates every edge leaving DESIGN, whatever it leads to", () => {
    expect(approvalTypeForEdge(TaskState.DESIGN, TaskState.PLAN)).toBe(ApprovalType.SCHEMA_CONFIRMATION);
  });

  it("returns null for an edge nothing gates", () => {
    expect(approvalTypeForEdge(TaskState.PLAN, TaskState.IMPLEMENTATION)).toBeNull();
    expect(approvalTypeForEdge(TaskState.QA, TaskState.READY_TO_DEPLOY)).toBeNull();
  });
});

describe("requestApproval", () => {
  it("opens a pending request with an immutable id and scope", () => {
    const ledger = askSchema();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].requestId).toMatch(APPROVAL_REQUEST_ID_PATTERN);
    expect(ledger[0]).toMatchObject({
      scope: { taskId: TASK, type: ApprovalType.SCHEMA_CONFIRMATION, from: TaskState.DESIGN, to: TaskState.IMPLEMENTATION },
      status: "pending",
      required: true,
      requestedAt: 1000,
      decision: null,
      withdrawal: null,
    });
    expect(() => ApprovalRecordSchema.parse(ledger[0])).not.toThrow();
  });

  it("mints a distinct id for every request", () => {
    const a = askSchema()[0].requestId;
    const b = askSchema()[0].requestId;
    expect(a).not.toBe(b);
  });

  it("is idempotent — asking twice leaves one record", () => {
    expect(askSchema(askSchema())).toHaveLength(1);
  });

  it("does not reopen a question that was already answered", () => {
    const answered = decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, true);
    const again = askSchema(answered);
    expect(again).toHaveLength(1);
    expect(again[0].status).toBe("approved");
  });

  it("opens a fresh request after a withdrawal, since nobody answered the first", () => {
    const opened = askSchema();
    const withdrawn = withdrawApproval(opened, opened[0].requestId, { now: 1500, reason: "evidence" });
    const again = askSchema(withdrawn, 1600);
    expect(again).toHaveLength(2);
    expect(again[1].status).toBe("pending");
    expect(again[1].requestId).not.toBe(opened[0].requestId);
  });

  it("keeps different types apart", () => {
    const ledger = ask(ApprovalType.DEPLOY, askSchema(), 2000);
    expect(ledger).toHaveLength(2);
    expect(pendingApprovals(ledger)).toHaveLength(2);
  });
});

describe("applyHumanDecision", () => {
  it("records the authenticated actor, channel, time and note on the exact request", () => {
    const ledger = decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, true, { actor: "jaturapat", note: "ok กับ schema นี้" });
    expect(ledger[0]).toMatchObject({
      status: "approved",
      decision: {
        approved: true,
        actor: { kind: "human", id: "jaturapat" },
        source: { channel: "unit-channel" },
        decidedAt: 2000,
        note: "ok กับ schema นี้",
      },
    });
    expect(() => ApprovalRecordSchema.parse(ledger[0])).not.toThrow();
  });

  it("records a rejection as an answer, distinguishable from never having asked", () => {
    const rejected = decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, false, { note: "field discount ยังไม่มีใน design" });
    expect(rejected[0].status).toBe("rejected");
    expect(rejectedApprovals(rejected)).toHaveLength(1);
    expect(pendingApprovals(rejected)).toHaveLength(0);
    expect(pendingApprovals(askSchema())).toHaveLength(1);
  });

  it("refuses an unsolicited decision for a request that was never opened", () => {
    const record = askSchema()[0];
    const err = catchDecision(() => applyHumanDecision([], verified(record, true)));
    expect(err.code).toBe("unknown-request");
  });

  it("refuses a replay: the same request cannot be decided twice", () => {
    const ledger = askSchema();
    const decision = verified(ledger[0], true);
    const once = applyHumanDecision(ledger, decision);
    expect(catchDecision(() => applyHumanDecision(once, decision)).code).toBe("not-pending");
    expect(catchDecision(() => applyHumanDecision(once, verified(ledger[0], false))).code).toBe("not-pending");
  });

  it("refuses a decision id that was already applied to another request", () => {
    const ledger = ask(ApprovalType.DEPLOY, askSchema(), 2);
    const first = decide(ledger, ApprovalType.SCHEMA_CONFIRMATION, true, { decisionId: "dec-fixed" });
    const deploy = findApproval(first, ApprovalType.DEPLOY)!;
    expect(catchDecision(() => applyHumanDecision(first, verified(deploy, true, { decisionId: "dec-fixed" }))).code).toBe("replay");
  });

  it("refuses a decision whose scope differs from the request's", () => {
    const record = askSchema()[0];
    for (const scope of [
      { taskId: "OTHER-TASK" },
      { type: ApprovalType.DEPLOY },
      { from: TaskState.READY_TO_DEPLOY },
      { to: TaskState.PLAN },
    ]) {
      expect(catchDecision(() => applyHumanDecision([record], verified(record, true, { scope }))).code).toBe("scope-mismatch");
    }
  });

  it("refuses a decision for a request that a reopen superseded", () => {
    const rejected = decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, false);
    const reopened = reopenApproval(rejected, ApprovalType.SCHEMA_CONFIRMATION, 3000);
    expect(catchDecision(() => applyHumanDecision(reopened, verified(rejected[0], true))).code).toBe("not-pending");
    const fresh = findApproval(reopened, ApprovalType.SCHEMA_CONFIRMATION)!;
    expect(applyHumanDecision(reopened, verified(fresh, true))[1].status).toBe("approved");
  });

  it("refuses a malformed decision (non-human actor, missing channel)", () => {
    const record = askSchema()[0];
    const bad = verified(record, true);
    const forged = { ...bad, decision: { ...bad.decision, actor: { kind: "agent", id: "qa-engineer" } } } as unknown as VerifiedHumanDecision;
    expect(catchDecision(() => applyHumanDecision([record], forged)).code).toBe("untrusted-decision");
    const noChannel = { ...bad, decision: { ...bad.decision, source: { channel: "", evidenceRef: "x" } } };
    expect(catchDecision(() => applyHumanDecision([record], noChannel)).code).toBe("untrusted-decision");
  });

  it("does not mutate the ledger it was given", () => {
    const before = askSchema();
    applyHumanDecision(before, verified(before[0], true));
    expect(before[0].status).toBe("pending");
  });
});

describe("ApprovalRecordSchema", () => {
  it("rejects a pre-V13 record with no request id, scope or authenticated decision", () => {
    const legacy = {
      type: ApprovalType.DEPLOY,
      required: true,
      status: "approved",
      from: TaskState.READY_TO_DEPLOY,
      to: TaskState.APPROVED,
      reason: "production",
      requestedAt: 1,
      decidedAt: 2,
      decidedBy: "someone",
      note: null,
    };
    expect(ApprovalRecordSchema.safeParse(legacy).success).toBe(false);
  });

  it("rejects an approved status with no decision record", () => {
    const record = { ...askSchema()[0], status: "approved" };
    expect(ApprovalRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe("withdrawApproval", () => {
  it("closes a pending request without a human decision and yields no gate fact", () => {
    const opened = ask(ApprovalType.REQUIREMENT_INTERVIEW);
    const withdrawn = withdrawApproval(opened, opened[0].requestId, { now: 5, reason: "confirmed input" });
    expect(withdrawn[0]).toMatchObject({ status: "withdrawn", decision: null, withdrawal: { at: 5, reason: "confirmed input" } });
    expect(gateEvidenceFrom(withdrawn)).toEqual({});
    expect(catchDecision(() => applyHumanDecision(withdrawn, verified(opened[0], true))).code).toBe("not-pending");
  });
});

describe("reopenApproval", () => {
  it("is the only way a rejection is revisited, and it mints a new request id", () => {
    const rejected = decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, false);
    const reopened = reopenApproval(rejected, ApprovalType.SCHEMA_CONFIRMATION, 3000);
    const current = findApproval(reopened, ApprovalType.SCHEMA_CONFIRMATION)!;
    expect(current.status).toBe("pending");
    expect(current.requestId).not.toBe(rejected[0].requestId);
    expect(current.requestedAt).toBe(3000);
    expect(reopened).toHaveLength(2);
    expect(reopened[0].status).toBe("rejected");
  });
});

describe("gateEvidenceFrom", () => {
  it("derives the gate booleans from recorded decisions only", () => {
    expect(gateEvidenceFrom(decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, true))).toEqual({ designApproved: true });
  });

  it("reports a rejection as false, not as absent", () => {
    expect(gateEvidenceFrom(decide(askSchema(), ApprovalType.SCHEMA_CONFIRMATION, false))).toEqual({ designApproved: false });
  });

  it("leaves a pending question out entirely — an unanswered gate is not a `false`", () => {
    expect(gateEvidenceFrom(askSchema())).toEqual({});
  });

  it("maps deploy to humanApproved and the requirement interview to requirementApproved", () => {
    expect(gateEvidenceFrom(decide(ask(ApprovalType.DEPLOY), ApprovalType.DEPLOY, true))).toEqual({ humanApproved: true });
    expect(gateEvidenceFrom(decide(ask(ApprovalType.REQUIREMENT_INTERVIEW), ApprovalType.REQUIREMENT_INTERVIEW, true))).toEqual({
      requirementApproved: true,
    });
  });

  it("yields no gate fact for the stops that are not edges", () => {
    for (const type of [ApprovalType.QA_FAILURE, ApprovalType.SECURITY_RISK]) {
      expect(gateEvidenceFrom(decide(ask(type), type, true))).toEqual({});
    }
  });
});

describe("describeApproval", () => {
  it("includes the request id a decision must name", () => {
    const record = askSchema()[0];
    expect(describeApproval(record)).toEqual({
      requestId: record.requestId,
      required: true,
      type: ApprovalType.SCHEMA_CONFIRMATION,
      status: "pending",
      reason: "DESIGN_APPROVED required before development can start",
    });
  });
});

describe("the approval types", () => {
  it("covers each stable human-gate identity exactly once", () => {
    expect(Object.values(ApprovalType).sort()).toEqual(
      ["deploy", "qa-failure", "requirement-interview", "schema-confirmation", "security-risk", "uxui-signoff"].sort(),
    );
  });
});

function catchDecision(fn: () => unknown): ApprovalDecisionError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApprovalDecisionError) return e;
    throw e;
  }
  throw new Error("expected an ApprovalDecisionError");
}
