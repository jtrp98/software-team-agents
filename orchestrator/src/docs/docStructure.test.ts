import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDocStructure, checkOneDoc, extractStructure } from "./docStructure.js";

const REQUIREMENT_OK = `
# Sales CRM — Requirements

## Overview
x

## Target Users & Roles
x

## Core Features
- REQ-001: x

## Scope
x

## Constraints & Assumptions
x

## Open Questions
x

## Declined / Not Pursuing
x

## References
x

## Change Log
- 2026-08-20: created
`;

const DESIGN_OK = `
# Design

## Feasibility Summary
x

## Feature-by-Feature Feasibility
- DES-001 — x

## Data Model
\`\`\`prisma
model User {}
\`\`\`

## Modules
x

## Risks & Dependencies
x

## Unresolved Open Questions
x

## Change Log
- 2026-08-20: created
`;

const PLAN_OK = `
# Plan

## Plan Summary
x

## Phase 1: Auth

| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-001 — x | pending | backend-engineer | — |

## Sequencing Notes
x

## Unresolved Open Questions
x

## Change Log
- 2026-08-20: created
`;

const REVIEW_OK = `
# Review

## Open Issues — all phases
x

## Verification Summary (current round)
x

## Review Outcome — Phase 1
**Status:** ✅ Verified (FULL)
Accepted.

## Change Log
- 2026-08-20: round 1
`;

const SECURITY_OK = `
# Security

## Open Findings — all rounds
x

## Summary
x

## Change Log
- 2026-08-20: round 1
`;

describe("extractStructure", () => {
  it("finds every required requirement.md section", () => {
    const s = extractStructure("requirement", REQUIREMENT_OK);
    expect(s).toEqual({
      hasOverview: true,
      hasTargetUsers: true,
      hasCoreFeatures: true,
      hasScope: true,
      hasConstraints: true,
      hasOpenQuestions: true,
      hasDeclined: true,
      hasReferences: true,
      hasChangeLog: true,
    });
  });

  it("counts phases and finds every required plan.md section", () => {
    const s = extractStructure("plan", PLAN_OK);
    expect(s).toEqual({
      hasPlanSummary: true,
      hasSequencingNotes: true,
      hasOpenQuestions: true,
      hasChangeLog: true,
      phaseCount: 1,
    });
  });

  it("counts review outcomes", () => {
    const s = extractStructure("review", REVIEW_OK + "\n## Review Outcome — Phase 2\n**Status:** ⚠️ Partial (TARGETED)\n");
    expect(s.reviewOutcomeCount).toBe(2);
  });
});

describe("checkOneDoc", () => {
  it("passes a well-formed requirement.md", () => {
    expect(checkOneDoc("requirement", REQUIREMENT_OK, "m/requirement.md").ok).toBe(true);
  });

  it("passes a well-formed design.md", () => {
    expect(checkOneDoc("design", DESIGN_OK, "m/design.md").ok).toBe(true);
  });

  it("passes a well-formed plan.md", () => {
    expect(checkOneDoc("plan", PLAN_OK, "m/plan.md").ok).toBe(true);
  });

  it("passes a well-formed review.md", () => {
    expect(checkOneDoc("review", REVIEW_OK, "m/review.md").ok).toBe(true);
  });

  it("passes a well-formed security.md", () => {
    expect(checkOneDoc("security", SECURITY_OK, "m/security.md").ok).toBe(true);
  });

  it("fails a requirement.md missing References, and names the file", () => {
    const broken = REQUIREMENT_OK.replace("## References\nx\n\n", "");
    const result = checkOneDoc("requirement", broken, "m/requirement.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("m/requirement.md"))).toBe(true);
  });

  it("fails a plan.md with zero phases", () => {
    const broken = PLAN_OK.replace(/## Phase 1: Auth[\s\S]*?\n\n## Sequencing Notes/, "## Sequencing Notes");
    const result = checkOneDoc("plan", broken, "m/plan.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("phaseCount"))).toBe(true);
  });

  it("fails a review.md with no Review Outcome section", () => {
    const broken = REVIEW_OK.replace(/## Review Outcome[\s\S]*?Accepted\.\n\n/, "");
    const result = checkOneDoc("review", broken, "m/review.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("reviewOutcomeCount"))).toBe(true);
  });

  it("fails a security.md missing Summary", () => {
    const broken = SECURITY_OK.replace("## Summary\nx\n\n", "");
    const result = checkOneDoc("security", broken, "m/security.md");
    expect(result.ok).toBe(false);
  });
});

describe("checkDocStructure", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docstructure-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("notes rather than fails when _docs/module/ doesn't exist yet", () => {
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("passes when every doc present is well-formed", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK);
    fs.writeFileSync(path.join(dir, "plan.md"), PLAN_OK);
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("doesn't flag a doc that hasn't been written yet (design.md absent early in a module's life)", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK);
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(true);
  });

  it("collects problems across modules, naming module and file", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK.replace("## References\nx\n\n", ""));
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("crm/requirement.md"))).toBe(true);
  });
});
