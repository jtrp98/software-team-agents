import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { ApprovalType } from "../gates/approval.js";
import { LANE_ACK_TYPE, LANE_SIGNOFF_TYPE, type LaneItemRef } from "../gates/laneApproval.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { laneItemRefs } from "./laneDecisions.js";
import { ROLE_LANES } from "./roleLane.js";
import { emptyWorkspace, type RoleWorkspace } from "./roleWorkspace.js";
import { currentSignoff, describeSignoff, signoffVerdict } from "./roleApproval.js";

const NOW = "2026-08-21T10:00:00Z";
const LATER = "2026-08-22T10:00:00Z";

const baItems = (): KnowledgeItem[] =>
  new KnowledgeBase(sampleKnowledge()).query({ kinds: ["requirement", "business-rule"], module: "sales-crm" });
const refs = (items: KnowledgeItem[]): LaneItemRef[] => laneItemRefs(items, os.tmpdir());

/** The projection of decided sign-offs, as `laneDecisions.ts` builds it from the lane ledger. */
function signed(approve = true, items = baItems(), note: string | null = null, at = NOW, prior: RoleWorkspace = emptyWorkspace("ba", "sales-crm", NOW)): RoleWorkspace {
  return {
    ...prior,
    signoffs: [
      ...prior.signoffs,
      {
        type: ApprovalType.BA_SIGNOFF,
        status: approve ? "approved" : "rejected",
        items: refs(items),
        at,
        by: "github-user:1001",
        note,
        requestId: `apr_${String(prior.signoffs.length).padStart(32, "0")}`,
        decisionId: `test-decision-${prior.signoffs.length}`,
      },
    ],
  };
}

describe("lane gate types (V13 TASK-028, human decision 2)", () => {
  it("gives every lane its own sign-off gate and its own acknowledgement gate", () => {
    for (const lane of ROLE_LANES) {
      expect(LANE_SIGNOFF_TYPE[lane]).toBeDefined();
      expect(LANE_ACK_TYPE[lane]).toBeDefined();
    }
    const all = [...Object.values(LANE_SIGNOFF_TYPE), ...Object.values(LANE_ACK_TYPE)];
    expect(new Set(all).size).toBe(8);
  });

  it("never reuses a task gate's approver list for a lane act", () => {
    const lane = new Set([...Object.values(LANE_SIGNOFF_TYPE), ...Object.values(LANE_ACK_TYPE)]);
    for (const taskGate of [ApprovalType.REQUIREMENT_INTERVIEW, ApprovalType.SCHEMA_CONFIRMATION, ApprovalType.DEPLOY]) {
      expect(lane.has(taskGate)).toBe(false);
    }
    expect(LANE_SIGNOFF_TYPE.uxui).toBe(ApprovalType.UXUI_SIGNOFF);
  });
});

describe("currentSignoff", () => {
  it("is the last decision — the history of send-backs survives before it", () => {
    const twice = signed(true, baItems(), null, LATER, signed(false, baItems(), "acceptance criteria are vague"));
    expect(twice.signoffs).toHaveLength(2);
    expect(currentSignoff(twice)?.status).toBe("approved");
    expect(twice.signoffs[0]!.note).toBe("acceptance criteria are vague");
  });
});

describe("signoffVerdict", () => {
  it("is 'none' before anybody answers", () => {
    const verdict = signoffVerdict(emptyWorkspace("ba", "sales-crm", NOW), refs(baItems()));
    expect(verdict.state).toBe("none");
    expect(verdict.signoff).toBeNull();
  });

  it("is 'current' while nothing it covered has moved", () => {
    expect(signoffVerdict(signed(), refs(baItems())).state).toBe("current");
  });

  it("is 'rejected' when the answer was no and nothing has changed since", () => {
    const verdict = signoffVerdict(signed(false, baItems(), "not specific enough"), refs(baItems()));
    expect(verdict.state).toBe("rejected");
    expect(describeSignoff(verdict, "ba")).toMatch(/rejected by github-user:1001: not specific enough/);
  });

  /** The whole reason a sign-off names versions: otherwise it is a flag that outlives its subject. */
  it("goes stale when something it covered is amended, and names what moved", () => {
    const amended = baItems().map((i) => (i.id === "REQ-003" ? { ...i, version: 2 } : i)) as KnowledgeItem[];
    const verdict = signoffVerdict(signed(), refs(amended));
    expect(verdict.state).toBe("stale");
    expect(verdict.changed).toEqual(["REQ-003"]);
    expect(describeSignoff(verdict, "ba")).toMatch(/no longer covers what is approved — REQ-003 changed/);
  });

  it("goes stale when content changes without a version bump (the digest moved)", () => {
    const edited = baItems().map((i) => (i.id === "REQ-003" ? { ...i, title: `${i.title} (edited)` } : i)) as KnowledgeItem[];
    expect(signoffVerdict(signed(), refs(edited)).changed).toEqual(["REQ-003"]);
  });

  it("does not move when only the file's status word changes — status is not the subject", () => {
    const relabelled = baItems().map((i) => ({ ...i, status: i.status === "approved" ? "reviewed" : "approved" })) as KnowledgeItem[];
    expect(signoffVerdict(signed(), refs(relabelled)).state).toBe("current");
  });

  it("goes stale when a new item joins the set", () => {
    const extra = [...baItems(), { ...baItems()[0]!, id: "REQ-004" }] as KnowledgeItem[];
    expect(signoffVerdict(signed(), refs(extra)).changed).toEqual(["REQ-004"]);
  });

  it("goes stale when a covered item is withdrawn", () => {
    expect(signoffVerdict(signed(), refs([baItems()[0]!])).changed).toEqual(["RULE-007"]);
  });

  /**
   * A rejection has to go stale too. "You rejected v4, here is v5" is a new
   * question — a standing no that survived its subject being fixed would be
   * unrevisitable without an override.
   */
  it("lets a fixed rejection be asked again instead of standing forever", () => {
    const fixed = baItems().map((i) => (i.id === "RULE-007" ? { ...i, version: 2 } : i)) as KnowledgeItem[];
    const verdict = signoffVerdict(signed(false), refs(fixed));
    expect(verdict.state).toBe("stale");
  });

  it("says who signed and when, for a person reading the lane", () => {
    expect(describeSignoff(signoffVerdict(signed(), refs(baItems())), "ba")).toBe("signed off by github-user:1001 on 2026-08-21");
  });
});
