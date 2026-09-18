import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getPolicySection, listPolicySections, policyPointerResolves } from "./policyIndex.js";

/** This repo is its own fixture — the shipped standards baseline is the contract. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The ten role sections of policies/standards.md §1–§10, in the order matrix §5 lists the roles. */
const ROLE_SECTIONS: readonly (readonly [role: string, section: number])[] = [
  ["business-analyst", 1],
  ["system-analyst", 2],
  ["project-manager", 3],
  ["test-planner", 4],
  ["uxui-designer", 5],
  ["backend-engineer", 6],
  ["frontend-engineer", 7],
  ["qa-engineer", 8],
  ["security", 9],
  ["devops", 10],
];

describe("policies/standards.md section index (V11 TASK-005)", () => {
  it("carries exactly the sections TASK-001 declared — §0 plus one per matrix §5 role", () => {
    const standards = listPolicySections(REPO_ROOT).find((entry) => entry.area === "standards");
    expect(standards, "policies/standards.md exists").toBeDefined();
    expect(standards!.sections.map((section) => section.number)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("every role section resolves by number, by role name, and is titled by its role", () => {
    for (const [role, n] of ROLE_SECTIONS) {
      const byNumber = getPolicySection(REPO_ROOT, "standards", `§${n}`);
      expect(byNumber.found, role).toBe(true);
      if (!byNumber.found) continue;
      expect(byNumber.heading).toBe(`${n}. ${role}`);
      const byName = getPolicySection(REPO_ROOT, "standards", role);
      expect(byName.found, role).toBe(true);
      if (!byName.found) continue;
      expect(byName.text).toBe(byNumber.text);
    }
  });

  it("§0 (How to read) resolves too", () => {
    const hit = getPolicySection(REPO_ROOT, "standards", "§0");
    expect(hit.found).toBe(true);
    if (hit.found) expect(hit.heading).toBe("0. How to read");
  });

  it("every role section still carries the baseline table, not a stub", () => {
    for (const [role, n] of ROLE_SECTIONS) {
      const hit = getPolicySection(REPO_ROOT, "standards", `§${n}`);
      expect(hit.found, role).toBe(true);
      if (!hit.found) continue;
      expect(hit.text, role).toContain("| Standard | Level | Applies when | Evidence expected |");
    }
  });
});

describe("role prompts carry a resolvable standards pointer (V11 R02/R03 pointer health)", () => {
  // Same pointer shape promptBudget guard 4 matches, so what this pins is what the
  // --check-prompt-budget CI step resolves; presence per role is the part guard 4 cannot know.
  const POINTER = /`?policies\/([a-z-]+)\.md`?\s*(?:§|#)\s*([0-9]+[a-z]?)/gi;

  it("each role's own prompt points at its own standards section, exactly once, and it resolves", () => {
    for (const [role, n] of ROLE_SECTIONS) {
      const markdown = fs.readFileSync(path.join(REPO_ROOT, ".claude", "agents", `${role}.md`), "utf8");
      const standardsPointers = [...markdown.matchAll(POINTER)].filter(([, area]) => area === "standards");
      expect(standardsPointers.map((match) => match[2]), role).toEqual([String(n)]);
      expect(policyPointerResolves(REPO_ROOT, "standards", String(n)), role).toBe(true);
    }
  });

  it("every policy pointer in every role prompt resolves", () => {
    for (const [role] of ROLE_SECTIONS) {
      const markdown = fs.readFileSync(path.join(REPO_ROOT, ".claude", "agents", `${role}.md`), "utf8");
      for (const match of markdown.matchAll(POINTER)) {
        expect(policyPointerResolves(REPO_ROOT, match[1]!, match[2]!), `${role} → policies/${match[1]}.md §${match[2]}`).toBe(true);
      }
    }
  });

  it("setup.md carries no standards pointer — it has no §1–§10 baseline to point at (R02 decision)", () => {
    const markdown = fs.readFileSync(path.join(REPO_ROOT, ".claude", "agents", "setup.md"), "utf8");
    expect([...markdown.matchAll(POINTER)].some(([, area]) => area === "standards")).toBe(false);
  });
});
