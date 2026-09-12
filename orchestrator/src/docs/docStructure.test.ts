import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDesignContractSections,
  checkDocStructure,
  checkDocSize,
  checkOneDoc,
  checkOneDocSize,
  extractStructure,
  SECTION_SIZE_CEILING_BYTES,
  DOCUMENT_SIZE_CEILING_BYTES,
} from "./docStructure.js";
import { parseModuleTargets, readModuleTargets } from "./moduleTargets.js";

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

describe("design.md Change Log after an archive move (T-V6-003, policy-only — verifying the compatibility claim)", () => {
  it("hasChangeLog still passes when the section holds only a pointer plus current-version entries", () => {
    const archived = DESIGN_OK.replace(
      "## Change Log\n- 2026-08-20: created\n",
      "## Change Log\nOlder entries moved to `design-archive.md` — see § Change Log there.\n\n- 2026-08-20: created (current contract version)\n",
    );
    expect(checkOneDoc("design", archived, "m/design.md").ok).toBe(true);
  });
});

describe("design.md ## Targets (T-V9-004)", () => {
  const DESIGN_WITH_TARGETS = DESIGN_OK.replace(
    "## Data Model",
    "## Targets\n- sales-web (frontend-engineer)\n- sales-api\n- sales-web\n\n## Data Model",
  );

  it("marks hasTargets only when the section is present — computed outside DESIGN_HEADING_PATTERN, so the drift guard tolerates the optional property", () => {
    expect(extractStructure("design", DESIGN_WITH_TARGETS).hasTargets).toBe(true);
    expect("hasTargets" in extractStructure("design", DESIGN_OK)).toBe(false);
  });

  it("passes a design.md that declares Targets, and one that declares none", () => {
    expect(checkOneDoc("design", DESIGN_WITH_TARGETS, "m/design.md").ok).toBe(true);
    expect(checkOneDoc("design", DESIGN_OK, "m/design.md").ok).toBe(true);
  });

  it("readModuleTargets returns the declared ids in document order, de-duplicated; empty when the module declares none", () => {
    expect(readModuleTargets(DESIGN_WITH_TARGETS)).toEqual(["sales-web", "sales-api"]);
    expect(readModuleTargets(DESIGN_OK)).toEqual([]);
  });

  it("never flags ## Targets for carrying no DES-NNN id", () => {
    const result = checkDesignContractSections(DESIGN_WITH_TARGETS, "m/design.md");
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("reports a malformed section instead of silently dropping it", () => {
    const malformed = DESIGN_OK.replace(
      "## Data Model",
      [
        "## Targets",
        "- Sales_Web",
        "- sales-api because the module needs it",
        "- sales-web (qa-engineer)",
        "",
        "## Data Model",
      ].join("\n"),
    );
    const parsed = parseModuleTargets(malformed);
    expect(parsed.present).toBe(true);
    // The third line's id parses; only its role annotation is invalid.
    expect(parsed.ids).toEqual(["sales-web"]);
    expect(parsed.problems).toHaveLength(3);
    const result = checkOneDoc("design", malformed, "m/design.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("m/design.md") && p.includes("Sales_Web"))).toBe(true);
    expect(result.problems.some((p) => p.includes("no rationale"))).toBe(true);
    expect(result.problems.some((p) => p.includes("qa-engineer"))).toBe(true);
  });

  it("treats a look-alike heading (## Targets and more prose) as a contract section, not the declaration", () => {
    const lookalike = DESIGN_OK.replace("## Data Model", "## Targets and rollout stages\nno DES id\n\n## Data Model");
    expect(parseModuleTargets(lookalike).present).toBe(false);
    expect(checkDesignContractSections(lookalike, "m/design.md").ok).toBe(false);
  });
});

describe("checkDesignContractSections (T-V6-002)", () => {
  it("passes a design.md with no contract sections at all — trivially, not flagged", () => {
    const result = checkDesignContractSections(DESIGN_OK, "m/design.md");
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("fails and names an untagged contract section", () => {
    const broken = DESIGN_OK.replace(
      "## Modules\nx\n",
      "## Subject Score Aggregation Rules\nno id here\n\n## Modules\nx\n",
    );
    const result = checkDesignContractSections(broken, "m/design.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("m/design.md") && p.includes("Subject Score Aggregation Rules") && p.includes("DES-NNN"))).toBe(true);
  });

  it("passes a contract section that carries a DES-NNN id anywhere in its text, not only its heading", () => {
    const tagged = DESIGN_OK.replace(
      "## Modules\nx\n",
      "## Subject Score Aggregation Rules\nSee DES-050 for the formula.\n\n## Modules\nx\n",
    );
    expect(checkDesignContractSections(tagged, "m/design.md").ok).toBe(true);
  });

  it("never flags one of the seven schema-known headings, even though it isn't itself DES-tagged", () => {
    // DESIGN_OK's "Risks & Dependencies" and "Unresolved Open Questions" carry no DES-NNN.
    expect(checkDesignContractSections(DESIGN_OK, "m/design.md").problems).toEqual([]);
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

  it("notes a requirement.md that would fall back for having no REQ ids (T-V5-035)", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK.replace(/REQ-001: x/, "no ids here"));
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.includes("crm/requirement.md") && n.includes("REQ-NNN"))).toBe(true);
  });

  it("notes a design.md missing every §10 always-read section (T-V5-035)", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "design.md"),
      "# Design\n\n## Data Model\nx\n\n## Modules\nx\n\n## Change Log\n- x\n",
    );
    const result = checkDocStructure(tmp);
    expect(result.notes.some((n) => n.includes("crm/design.md") && n.includes("always-read"))).toBe(true);
  });

  it("reports an untagged design.md contract section as a problem (T-V6-002, report-only via CI's continue-on-error)", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "design.md"),
      DESIGN_OK.replace("## Modules\nx\n", "## Subject Score Aggregation Rules\nno id here\n\n## Modules\nx\n"),
    );
    const result = checkDocStructure(tmp);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("crm/design.md") && p.includes("Subject Score Aggregation Rules"))).toBe(true);
  });

  it("keeps well-formed legacy design readable while noting the unattended migration boundary", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK);
    fs.writeFileSync(path.join(dir, "design.md"), DESIGN_OK);
    const result = checkDocStructure(tmp);
    expect(result.notes).toEqual([
      "crm/design.md: safe whole-section compatibility fallback only — migrate to Design evidence format 1 before unattended execution",
    ]);
  });
});

describe("checkOneDocSize (T-V5-033)", () => {
  it("passes a small, well-sectioned document", () => {
    expect(checkOneDocSize(REQUIREMENT_OK, "m/requirement.md").ok).toBe(true);
  });

  it("fails and names a section over the ceiling", () => {
    // Padded well past the section ceiling but under the document ceiling, so
    // only the section problem fires, not the whole-document one.
    const markdown = REQUIREMENT_OK.replace(
      "## Change Log\n- 2026-08-20: created\n",
      `## Change Log\n- 2026-08-20: created\n${"x".repeat(SECTION_SIZE_CEILING_BYTES + 1)}\n`,
    );
    const result = checkOneDocSize(markdown, "m/requirement.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("m/requirement.md") && p.includes("Change Log"))).toBe(true);
  });

  it("fails and names the whole document when it is over the document ceiling", () => {
    const markdown = `# Title\n\n## Overview\n${"x".repeat(DOCUMENT_SIZE_CEILING_BYTES + 1)}\n`;
    const result = checkOneDocSize(markdown, "m/requirement.md");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("whole document"))).toBe(true);
  });

  it("prints the ceiling value in the failure message", () => {
    const markdown = `# Title\n\n## Overview\n${"x".repeat(DOCUMENT_SIZE_CEILING_BYTES + 1)}\n`;
    const result = checkOneDocSize(markdown, "m/requirement.md");
    expect(result.problems.some((p) => p.includes(DOCUMENT_SIZE_CEILING_BYTES.toLocaleString()))).toBe(true);
  });
});

describe("checkDocSize (T-V5-033)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docsize-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("notes rather than fails when _docs/module/ doesn't exist yet", () => {
    const result = checkDocSize(tmp);
    expect(result.ok).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("passes when every doc present is under ceiling", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT_OK);
    const result = checkDocSize(tmp);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("collects problems across modules, naming module and file", () => {
    const dir = path.join(tmp, "_docs", "module", "crm");
    fs.mkdirSync(dir, { recursive: true });
    const markdown = `# Title\n\n## Overview\n${"x".repeat(DOCUMENT_SIZE_CEILING_BYTES + 1)}\n`;
    fs.writeFileSync(path.join(dir, "requirement.md"), markdown);
    const result = checkDocSize(tmp);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("crm/requirement.md"))).toBe(true);
  });

  it("scopes to one module when moduleName is given, ignoring another module's oversized doc (T-V5-034)", () => {
    const oversized = `# Title\n\n## Overview\n${"x".repeat(DOCUMENT_SIZE_CEILING_BYTES + 1)}\n`;
    fs.mkdirSync(path.join(tmp, "_docs", "module", "crm"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "_docs", "module", "crm", "requirement.md"), oversized);
    fs.mkdirSync(path.join(tmp, "_docs", "module", "sales"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "_docs", "module", "sales", "requirement.md"), REQUIREMENT_OK);

    const scoped = checkDocSize(tmp, "sales");
    expect(scoped.ok).toBe(true);
    expect(scoped.problems).toEqual([]);
  });

  it("reports a moduleName with no folder as a problem, not a silent pass", () => {
    fs.mkdirSync(path.join(tmp, "_docs", "module", "other"), { recursive: true });
    const result = checkDocSize(tmp, "nonexistent");
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("nonexistent"))).toBe(true);
  });
});
