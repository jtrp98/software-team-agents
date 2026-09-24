import { describe, expect, it } from "vitest";
import { KNOWLEDGE_KINDS, type KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { StatusTransitionError } from "../knowledge/ownership.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { REVIEW_CHECKLIST, approveItem, checklistFor, reviewItem } from "./artifactReview.js";

const NOW = "2026-08-21T10:00:00Z";

function item(id: string): KnowledgeItem {
  return sampleKnowledge().find((i) => i.id === id) as KnowledgeItem;
}

describe("reviewItem (V13 TASK-006: a person's decision)", () => {
  const rule = () => item("RULE-007"); // owned by business-analyst, status draft

  it("moves a draft to reviewed and bumps the version, because status is content", () => {
    const reviewed = reviewItem(rule(), NOW);
    expect(reviewed.status).toBe("reviewed");
    expect(reviewed.version).toBe(rule().version + 1);
    expect(reviewed.updated_at).toBe(NOW);
  });

  it("takes no agent role at all — agent review is the reviewer stage, never this function", () => {
    // The signature itself is the contract: there is no parameter a caller
    // could pass an AgentStage through.
    expect(reviewItem.length).toBe(2);
  });

  it("refuses to review something already reviewed", () => {
    expect(() => reviewItem({ ...rule(), status: "reviewed" }, NOW)).toThrow(StatusTransitionError);
  });

  it("does not mutate the item it was given", () => {
    const original = rule();
    const before = JSON.stringify(original);
    reviewItem(original, NOW);
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
