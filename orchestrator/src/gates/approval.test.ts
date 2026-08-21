import { describe, expect, it } from "vitest";
import { TaskState } from "../types.js";
import {
  ApprovalRecordSchema,
  ApprovalType,
  UnknownApprovalError,
  approvalTypeForEdge,
  decideApproval,
  describeApproval,
  findApproval,
  gateEvidenceFrom,
  gateFieldFor,
  pendingApprovals,
  rejectedApprovals,
  reopenApproval,
  requestApproval,
  type ApprovalLedger,
} from "./approval.js";

function askSchema(ledger: ApprovalLedger = [], now = 1000): ApprovalLedger {
  return requestApproval(ledger, {
    type: ApprovalType.SCHEMA_CONFIRMATION,
    reason: "DESIGN_APPROVED required before development can start",
    now,
    from: TaskState.DESIGN,
    to: TaskState.IMPLEMENTATION,
  });
}

describe("approvalTypeForEdge", () => {
  it("names the two edges gatePolicy actually gates", () => {
    expect(approvalTypeForEdge(TaskState.DESIGN, TaskState.IMPLEMENTATION)).toBe(ApprovalType.SCHEMA_CONFIRMATION);
    expect(approvalTypeForEdge(TaskState.READY_TO_DEPLOY, TaskState.APPROVED)).toBe(ApprovalType.DEPLOY);
  });

  /** T20: test-planner (like project-manager already did, for the "feature" pipeline) can sit
   *  between DESIGN and IMPLEMENTATION, so every edge leaving DESIGN is gated — not only the
   *  literal DESIGN->IMPLEMENTATION one, which a pipeline carrying either agent never takes. */
  it("gates every edge leaving DESIGN, whatever it leads to", () => {
    expect(approvalTypeForEdge(TaskState.DESIGN, TaskState.PLAN)).toBe(ApprovalType.SCHEMA_CONFIRMATION);
  });

  /** It describes what already stops; inventing new stopping points is not this function's job. */
  it("returns null for an edge nothing gates", () => {
    expect(approvalTypeForEdge(TaskState.PLAN, TaskState.IMPLEMENTATION)).toBeNull();
    expect(approvalTypeForEdge(TaskState.QA, TaskState.READY_TO_DEPLOY)).toBeNull();
  });
});

describe("requestApproval", () => {
  it("opens a pending record carrying the edge, the reason and when it was asked", () => {
    const ledger = askSchema();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: ApprovalType.SCHEMA_CONFIRMATION,
      status: "pending",
      required: true,
      from: TaskState.DESIGN,
      to: TaskState.IMPLEMENTATION,
      requestedAt: 1000,
      decidedAt: null,
      decidedBy: null,
    });
    expect(() => ApprovalRecordSchema.parse(ledger[0])).not.toThrow();
  });

  /** status() is polled; a second poll must not append the same question again. */
  it("is idempotent — asking twice leaves one record", () => {
    expect(askSchema(askSchema())).toHaveLength(1);
  });

  it("does not reopen a question that was already answered", () => {
    const answered = decideApproval(askSchema(), { type: ApprovalType.SCHEMA_CONFIRMATION, approved: true, now: 2000 });
    const again = askSchema(answered);
    expect(again).toHaveLength(1);
    expect(again[0].status).toBe("approved");
  });

  it("keeps different types apart", () => {
    const ledger = requestApproval(askSchema(), { type: ApprovalType.DEPLOY, reason: "production", now: 2000 });
    expect(ledger).toHaveLength(2);
    expect(pendingApprovals(ledger)).toHaveLength(2);
  });
});

describe("decideApproval", () => {
  it("records who answered, when, and what they said", () => {
    const ledger = decideApproval(askSchema(), {
      type: ApprovalType.SCHEMA_CONFIRMATION,
      approved: true,
      now: 2000,
      by: "jaturapat",
      note: "ok กับ schema นี้",
    });
    expect(ledger[0]).toMatchObject({
      status: "approved",
      decidedAt: 2000,
      decidedBy: "jaturapat",
      note: "ok กับ schema นี้",
    });
  });

  /**
   * The gap T08 exists to close: before this, `designApproved: false` and
   * "never asked" were the same value, so a rejection became a re-prompt.
   */
  it("records a rejection as an answer, distinguishable from never having asked", () => {
    const rejected = decideApproval(askSchema(), {
      type: ApprovalType.SCHEMA_CONFIRMATION,
      approved: false,
      now: 2000,
      note: "field discount ยังไม่มีใน design",
    });
    expect(rejected[0].status).toBe("rejected");
    expect(rejectedApprovals(rejected)).toHaveLength(1);
    expect(pendingApprovals(rejected)).toHaveLength(0);

    // And it is not the same state as an unanswered question.
    expect(pendingApprovals(askSchema())).toHaveLength(1);
    expect(rejectedApprovals(askSchema())).toHaveLength(0);
  });

  it("refuses a decision for a question that was never posed", () => {
    expect(() => decideApproval([], { type: ApprovalType.DEPLOY, approved: true, now: 1 })).toThrow(
      UnknownApprovalError,
    );
  });

  it("does not mutate the ledger it was given", () => {
    const before = askSchema();
    decideApproval(before, { type: ApprovalType.SCHEMA_CONFIRMATION, approved: true, now: 2000 });
    expect(before[0].status).toBe("pending");
  });
});

describe("reopenApproval", () => {
  it("is the only way a rejection is revisited, and it is a deliberate act", () => {
    const rejected = decideApproval(askSchema(), { type: ApprovalType.SCHEMA_CONFIRMATION, approved: false, now: 2000 });
    const reopened = reopenApproval(rejected, ApprovalType.SCHEMA_CONFIRMATION, 3000);

    expect(findApproval(reopened, ApprovalType.SCHEMA_CONFIRMATION)?.status).toBe("pending");
    // The original answer stays in the ledger — reopening is not erasing.
    expect(reopened).toHaveLength(2);
    expect(reopened[0].status).toBe("rejected");
  });
});

describe("gateEvidenceFrom", () => {
  it("derives the gate booleans from the ledger, so the two cannot disagree", () => {
    const approved = decideApproval(askSchema(), { type: ApprovalType.SCHEMA_CONFIRMATION, approved: true, now: 2000 });
    expect(gateEvidenceFrom(approved)).toEqual({ designApproved: true });
  });

  it("reports a rejection as false, not as absent", () => {
    const rejected = decideApproval(askSchema(), { type: ApprovalType.SCHEMA_CONFIRMATION, approved: false, now: 2000 });
    expect(gateEvidenceFrom(rejected)).toEqual({ designApproved: false });
  });

  it("leaves a pending question out entirely — an unanswered gate is not a `false`", () => {
    expect(gateEvidenceFrom(askSchema())).toEqual({});
  });

  it("maps the deploy approval to the humanApproved gate", () => {
    const ledger = decideApproval(
      requestApproval([], { type: ApprovalType.DEPLOY, reason: "production", now: 1 }),
      { type: ApprovalType.DEPLOY, approved: true, now: 2 },
    );
    expect(gateEvidenceFrom(ledger)).toEqual({ humanApproved: true });
  });

  it("has no gate field for the three approvals that are stops rather than edges", () => {
    for (const type of [ApprovalType.QA_FAILURE, ApprovalType.SECURITY_RISK, ApprovalType.REQUIREMENT_INTERVIEW]) {
      expect(gateFieldFor(type)).toBeNull();
    }
  });
});

describe("findApproval", () => {
  it("returns the newest record of a type, since a type can legitimately be asked twice", () => {
    const rejected = decideApproval(askSchema(), { type: ApprovalType.SCHEMA_CONFIRMATION, approved: false, now: 2000 });
    const reopened = reopenApproval(rejected, ApprovalType.SCHEMA_CONFIRMATION, 3000);
    expect(findApproval(reopened, ApprovalType.SCHEMA_CONFIRMATION)?.requestedAt).toBe(3000);
  });
});

describe("describeApproval", () => {
  it("produces the record shape T08 specifies", () => {
    expect(describeApproval(askSchema()[0])).toEqual({
      required: true,
      type: ApprovalType.SCHEMA_CONFIRMATION,
      status: "pending",
      reason: "DESIGN_APPROVED required before development can start",
    });
  });
});

describe("the five approval types", () => {
  it("covers each of CLAUDE.md's always-human points exactly once", () => {
    expect(Object.values(ApprovalType).sort()).toEqual(
      ["deploy", "qa-failure", "requirement-interview", "schema-confirmation", "security-risk", "uxui-signoff"].sort(),
    );
  });
});
