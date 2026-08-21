import { describe, expect, it } from "vitest";
import { ApprovalType } from "../gates/approval.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { ROLE_LANES } from "./roleLane.js";
import { emptyWorkspace } from "./roleWorkspace.js";
import {
  APPROVAL_TYPE_OF_LANE,
  SignoffError,
  currentSignoff,
  describeSignoff,
  itemRefs,
  recordSignoff,
  signoffVerdict,
} from "./roleApproval.js";

const NOW = "2026-08-21T10:00:00Z";
const LATER = "2026-08-22T10:00:00Z";

const baItems = (): KnowledgeItem[] =>
  new KnowledgeBase(sampleKnowledge()).query({ kinds: ["requirement", "business-rule"], module: "sales-crm" });

function signed(approve = true, items = baItems(), note?: string) {
  return recordSignoff(emptyWorkspace("ba", "sales-crm", NOW), { approved: items, approve, by: "Jaturapat", note, now: NOW });
}

describe("APPROVAL_TYPE_OF_LANE (T103)", () => {
  /**
   * The gates are not new: CLAUDE.md already names five points that always wait
   * for a person, and three of them are one per lane. A second enum here would
   * be two names for one rule.
   */
  it("reuses the T08 ApprovalType rather than inventing lane gate names", () => {
    expect(APPROVAL_TYPE_OF_LANE.ba).toBe(ApprovalType.REQUIREMENT_INTERVIEW);
    expect(APPROVAL_TYPE_OF_LANE.sa).toBe(ApprovalType.SCHEMA_CONFIRMATION);
    expect(APPROVAL_TYPE_OF_LANE.dev).toBe(ApprovalType.DEPLOY);
  });

  it("gives every lane a gate", () => {
    for (const lane of ROLE_LANES) expect(APPROVAL_TYPE_OF_LANE[lane]).toBeDefined();
    expect(new Set(Object.values(APPROVAL_TYPE_OF_LANE)).size).toBe(4);
  });

  /**
   * `REQUIREMENT_INTERVIEW` existed in the enum with no edge ever producing it —
   * the one always-human point CLAUDE.md states most plainly had nothing
   * enforcing it. This is what closes that.
   */
  it("gives REQUIREMENT_INTERVIEW its first gate", () => {
    expect(Object.values(APPROVAL_TYPE_OF_LANE)).toContain(ApprovalType.REQUIREMENT_INTERVIEW);
  });
});

describe("recordSignoff", () => {
  it("refuses an unnamed signer — this gate exists so no agent can pass it", () => {
    expect(() => signed(true, baItems()) && recordSignoff(emptyWorkspace("ba", null, NOW), { approved: baItems(), approve: true, by: "  ", now: NOW })).toThrow(
      SignoffError,
    );
  });

  it("refuses to sign off on nothing — an empty sign-off could never go stale", () => {
    expect(() => recordSignoff(emptyWorkspace("ba", "sales-crm", NOW), { approved: [], approve: true, by: "X", now: NOW })).toThrow(
      /covers no item/,
    );
  });

  it("appends rather than replacing, so the history of send-backs survives", () => {
    const once = signed(false, baItems(), "acceptance criteria are vague");
    const twice = recordSignoff(once, { approved: baItems(), approve: true, by: "Nan", now: LATER });
    expect(twice.signoffs).toHaveLength(2);
    expect(currentSignoff(twice)?.status).toBe("approved");
    expect(twice.signoffs?.[0].note).toBe("acceptance criteria are vague");
  });

  it("records exactly what it covered, at the versions it covered", () => {
    expect(currentSignoff(signed())?.items).toEqual(itemRefs(baItems()));
  });

  it("stamps the lane's own gate type", () => {
    expect(currentSignoff(signed())?.type).toBe(ApprovalType.REQUIREMENT_INTERVIEW);
  });
});

describe("signoffVerdict", () => {
  it("is 'none' before anybody answers", () => {
    const verdict = signoffVerdict(emptyWorkspace("ba", "sales-crm", NOW), baItems());
    expect(verdict.state).toBe("none");
    expect(verdict.signoff).toBeNull();
  });

  it("is 'current' while nothing it covered has moved", () => {
    expect(signoffVerdict(signed(), baItems()).state).toBe("current");
  });

  it("is 'rejected' when the answer was no and nothing has changed since", () => {
    const verdict = signoffVerdict(signed(false, baItems(), "not specific enough"), baItems());
    expect(verdict.state).toBe("rejected");
    expect(describeSignoff(verdict, "ba")).toMatch(/rejected by Jaturapat: not specific enough/);
  });

  /** The whole reason a sign-off names versions: otherwise it is a flag that outlives its subject. */
  it("goes stale when something it covered is amended, and names what moved", () => {
    const amended = baItems().map((i) => (i.id === "REQ-003" ? { ...i, version: 2 } : i)) as KnowledgeItem[];
    const verdict = signoffVerdict(signed(), amended);
    expect(verdict.state).toBe("stale");
    expect(verdict.changed).toEqual(["REQ-003"]);
    expect(describeSignoff(verdict, "ba")).toMatch(/no longer covers what is approved — REQ-003 changed/);
  });

  it("goes stale when a new item joins the approved set", () => {
    const extra = [...baItems(), { ...baItems()[0], id: "REQ-004" }] as KnowledgeItem[];
    expect(signoffVerdict(signed(), extra).changed).toEqual(["REQ-004"]);
  });

  it("goes stale when an approved item is withdrawn", () => {
    expect(signoffVerdict(signed(), [baItems()[0]]).changed).toEqual(["RULE-007"]);
  });

  /**
   * A rejection has to go stale too. "You rejected v4, here is v5" is a new
   * question — a standing no that survived its subject being fixed would be the
   * mirror of the bug T08 fixed in the other direction.
   */
  it("lets a fixed rejection be asked again instead of standing forever", () => {
    const fixed = baItems().map((i) => (i.id === "RULE-007" ? { ...i, version: 2 } : i)) as KnowledgeItem[];
    const verdict = signoffVerdict(signed(false), fixed);
    expect(verdict.state).toBe("stale");
    expect(verdict.state).not.toBe("rejected");
  });

  it("says who signed and when, for a person reading the lane", () => {
    expect(describeSignoff(signoffVerdict(signed(), baItems()), "ba")).toBe("signed off by Jaturapat on 2026-08-21");
  });
});
