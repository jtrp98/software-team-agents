import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_KINDS, type KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { StatusTransitionError } from "../knowledge/ownership.js";
import { canSeeKind } from "../knowledge/roleView.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { ArtifactReviewError, REVIEW_CHECKLIST, approveItem, checklistFor, reviewItem, reviewersFor } from "./artifactReview.js";
import { laneOf } from "./roleLane.js";

const NOW = "2026-08-21T10:00:00Z";

function item(id: string): KnowledgeItem {
  return sampleKnowledge().find((i) => i.id === id) as KnowledgeItem;
}

describe("reviewItem (T104)", () => {
  const rule = () => item("RULE-007"); // owned by business-analyst, status draft

  it("moves a draft to reviewed and bumps the version, because status is content", () => {
    const reviewed = reviewItem(rule(), AgentStage.SYSTEM_ANALYST, NOW);
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.version).toBe(rule().version + 1);
    expect(reviewed.updated_at).toBe(NOW);
  });

  it("refuses the owner — an owner marking its own work reviewed records that nothing happened", () => {
    expect(() => reviewItem(rule(), AgentStage.BUSINESS_ANALYST, NOW)).toThrow(StatusTransitionError);
  });

  /** A role whose context policy never puts this kind in front of it cannot meaningfully have reviewed it. */
  it("refuses a reviewer that does not see the kind", () => {
    // devops does not read requirements documents, so it cannot review a business rule.
    expect(canSeeKind(AgentStage.DEVOPS, "business-rule")).toBe(false);
    expect(() => reviewItem(rule(), AgentStage.DEVOPS, NOW)).toThrow(ArtifactReviewError);
    expect(() => reviewItem(rule(), AgentStage.DEVOPS, NOW)).toThrow(/would record a check that did not happen/);
  });

  /** A person can bypass every ownership rule, but doing so here loses the one thing a review records. */
  it("refuses `human` as the reviewing role", () => {
    expect(() => reviewItem(rule(), AgentStage.HUMAN, NOW)).toThrow(/name the role/);
  });

  it("refuses to review something already reviewed", () => {
    expect(() => reviewItem({ ...rule(), status: "reviewed" }, AgentStage.SYSTEM_ANALYST, NOW)).toThrow(StatusTransitionError);
  });

  it("does not mutate the item it was given", () => {
    const original = rule();
    const before = JSON.stringify(original);
    reviewItem(original, AgentStage.SYSTEM_ANALYST, NOW);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("approveItem", () => {
  it("moves a reviewed item to approved", () => {
    const approved = approveItem({ ...item("RULE-007"), status: "reviewed" }, NOW);
    expect(approved.status).toBe("approved");
  });

  /** There is no draft -> approved shortcut: that is what makes review optional. */
  it("refuses to skip review", () => {
    expect(() => approveItem(item("RULE-007"), NOW)).toThrow(StatusTransitionError);
  });
});

describe("the checklist", () => {
  it("covers every knowledge kind, so 'reviewed' means the same thing twice", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      expect(checklistFor(kind).length).toBeGreaterThan(0);
    }
    expect(Object.keys(REVIEW_CHECKLIST).sort()).toEqual([...KNOWLEDGE_KINDS].sort());
  });

  it("asks about the specific failures the rules already name, not for a general opinion", () => {
    expect(checklistFor("api").join(" ")).toMatch(/contract_name/);
    expect(checklistFor("architecture").join(" ")).toMatch(/must never have to decide/);
    expect(checklistFor("db-schema").join(" ")).toMatch(/schema\.prisma/);
    expect(checklistFor("requirement").join(" ")).toMatch(/unconfirmed assumption/);
  });
});

describe("reviewersFor", () => {
  it("never suggests the owner", () => {
    expect(reviewersFor(item("RULE-007")).map((r) => r.role)).not.toContain(AgentStage.BUSINESS_ANALYST);
  });

  it("never suggests a role that cannot see the kind", () => {
    for (const suggestion of reviewersFor(item("DB-Shift"))) {
      expect(canSeeKind(suggestion.role, "db-schema")).toBe(true);
    }
  });

  /** The lane that has to live with it being wrong is listed first. */
  it("puts a different lane ahead of the owner's own", () => {
    const suggestions = reviewersFor(item("RULE-007"));
    expect(suggestions.length).toBeGreaterThan(0);
    expect(laneOf(suggestions[0].role)).not.toBe(laneOf(AgentStage.BUSINESS_ANALYST));
    expect(suggestions[0].why).toMatch(/has to live with this being wrong/);
  });

  it("never suggests `human` — a review records which discipline looked", () => {
    expect(reviewersFor(item("DES-003")).map((r) => r.role)).not.toContain(AgentStage.HUMAN);
  });
});
