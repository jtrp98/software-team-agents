import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTraceableTokenBenchmarkFixture, TOKEN_BENCHMARK_DOC_BYTES } from "../observability/tokenBenchmark.js";
import { AgentStage } from "../types.js";
import { CONTEXT_POLICY } from "./contextSelection.js";
import { CATEGORY_TO_DOC, ContextManager, type DocKind, keepDesignSection, selectDocContext, type ContextRequest } from "./contextManager.js";

const SECURITY_FIXTURE_BYTES = 1_024;

function fixedDocument(seed: string, bytes: number): string {
  if (seed.length > bytes) throw new Error(`fixture seed exceeds fixed size ${bytes}`);
  return `${seed}${"s".repeat(bytes - seed.length)}`;
}

function createCharacterizationFixture(): { root: string; moduleName: string } {
  const fixture = createTraceableTokenBenchmarkFixture();
  const moduleDir = path.join(fixture.root, "_docs", "module", fixture.moduleName);
  fs.writeFileSync(
    path.join(moduleDir, "security.md"),
    fixedDocument("# Security\n\n## Findings\nPinned security finding.\n\n", SECURITY_FIXTURE_BYTES),
    "utf8",
  );
  expect(fs.readFileSync(path.join(moduleDir, "design.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.design);
  expect(fs.readFileSync(path.join(moduleDir, "plan.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.plan);
  expect(fs.readFileSync(path.join(moduleDir, "requirement.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.requirement);
  expect(fs.readFileSync(path.join(moduleDir, "review.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.review);
  expect(fs.readFileSync(path.join(moduleDir, "test-plan.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.testPlan);
  expect(fs.readFileSync(path.join(moduleDir, "security.md"), "utf8").length).toBe(SECURITY_FIXTURE_BYTES);
  return fixture;
}

function policyPairs(): string[] {
  return Object.entries(CONTEXT_POLICY).flatMap(([stage, policy]) =>
    policy.reads
      .map((category) => CATEGORY_TO_DOC[category])
      .filter((doc): doc is DocKind => doc !== undefined)
      .map((doc) => `${stage}:${doc}`),
  ).sort();
}

const DESIGN = {
  bytesBefore: 67_000,
  bytesAfter: 13_287,
  savedPct: 80,
  kept: ["Feature-by-Feature Feasibility", "Import Contract — DES-001", "Modules", "Risks & Dependencies", "Open Questions", "Legacy Design Appendix"],
  skipped: ["Data Model", "Modules > other-module", "Change Log", "Reporting Contract — DES-002"],
  unknownSections: ["Legacy Design Appendix"],
};
const DESIGN_WITH_DATA_MODEL = {
  bytesBefore: 67_000,
  bytesAfter: 18_304,
  savedPct: 73,
  kept: ["Feature-by-Feature Feasibility", "Import Contract — DES-001", "Data Model", "Modules", "Risks & Dependencies", "Open Questions", "Legacy Design Appendix"],
  skipped: ["Modules > other-module", "Change Log", "Reporting Contract — DES-002"],
  unknownSections: ["Legacy Design Appendix"],
};
const REQUIREMENT = {
  bytesBefore: 12_000,
  bytesAfter: 317,
  savedPct: 97,
  kept: ["Overview", "Target Users & Roles", "Core Features", "Scope — MVP vs Nice-to-have", "Constraints & Assumptions", "Open Questions", "Declined / Not Pursuing", "References"],
  skipped: ["Core Features > REQ-002", "Core Features > REQ-003", "Change Log"],
  unknownSections: ["Overview", "Target Users & Roles", "Constraints & Assumptions", "Declined / Not Pursuing"],
};
const REQUIREMENT_IN_FULL = {
  bytesBefore: 12_000,
  bytesAfter: 12_000,
  savedPct: 0,
  kept: ["Overview", "Target Users & Roles", "Core Features", "Scope — MVP vs Nice-to-have", "Constraints & Assumptions", "Open Questions", "Declined / Not Pursuing", "References", "Change Log"],
  skipped: [],
  unknownSections: [],
};
const PLAN = {
  bytesBefore: 17_000,
  bytesAfter: 280,
  savedPct: 98,
  kept: ["Plan Summary", "Phase 1: Import", "Open Questions"],
  skipped: ["Phase 2: Reporting"],
  unknownSections: [],
};
const REVIEW = { bytesBefore: 3_400, bytesAfter: 3_402, savedPct: -0, kept: ["Open Issues", "Round 1"], skipped: [], unknownSections: [] };
const TEST_PLAN = { bytesBefore: 1_200, bytesAfter: 1_200, savedPct: 0, kept: ["Coverage"], skipped: [], unknownSections: [] };
const SECURITY = { bytesBefore: SECURITY_FIXTURE_BYTES, bytesAfter: SECURITY_FIXTURE_BYTES, savedPct: 0, kept: ["Findings"], skipped: [], unknownSections: [] };

const CHARACTERIZATION: Record<string, unknown> = {
  "setup:design": DESIGN,
  "business-analyst:requirement": REQUIREMENT_IN_FULL,
  "business-analyst:design": DESIGN,
  "business-analyst:review": REVIEW,
  "system-analyst:requirement": REQUIREMENT_IN_FULL,
  "system-analyst:review": REVIEW,
  "project-manager:design": DESIGN_WITH_DATA_MODEL,
  "project-manager:requirement": REQUIREMENT,
  "test-planner:requirement": REQUIREMENT,
  "test-planner:design": DESIGN,
  "test-planner:plan": PLAN,
  "uxui-designer:requirement": REQUIREMENT,
  "uxui-designer:design": DESIGN,
  "backend-engineer:plan": PLAN,
  "backend-engineer:design": DESIGN,
  "backend-engineer:requirement": REQUIREMENT,
  "backend-engineer:test-plan": TEST_PLAN,
  "backend-engineer:review": REVIEW,
  "frontend-engineer:plan": PLAN,
  "frontend-engineer:design": DESIGN,
  "frontend-engineer:requirement": REQUIREMENT,
  "frontend-engineer:test-plan": TEST_PLAN,
  "frontend-engineer:review": REVIEW,
  "qa-engineer:requirement": REQUIREMENT,
  "qa-engineer:design": DESIGN_WITH_DATA_MODEL,
  "qa-engineer:plan": PLAN,
  "qa-engineer:test-plan": TEST_PLAN,
  "qa-engineer:review": REVIEW,
  "security:requirement": REQUIREMENT,
  "security:design": DESIGN,
  "security:review": REVIEW,
  "devops:review": REVIEW,
  "devops:security": SECURITY,
  "devops:plan": PLAN,
  "devops:design": DESIGN,
  "setup:aggregate": { bytesBefore: 67_000, bytesAfter: 13_287, savedPct: 80 },
  "business-analyst:aggregate": { bytesBefore: 82_400, bytesAfter: 28_689, savedPct: 65 },
  "system-analyst:aggregate": { bytesBefore: 15_400, bytesAfter: 15_402, savedPct: -0 },
  "project-manager:aggregate": { bytesBefore: 79_000, bytesAfter: 18_621, savedPct: 76 },
  "test-planner:aggregate": { bytesBefore: 96_000, bytesAfter: 13_884, savedPct: 86 },
  "uxui-designer:aggregate": { bytesBefore: 79_000, bytesAfter: 13_604, savedPct: 83 },
  "backend-engineer:aggregate": { bytesBefore: 100_600, bytesAfter: 18_486, savedPct: 82 },
  "frontend-engineer:aggregate": { bytesBefore: 100_600, bytesAfter: 18_486, savedPct: 82 },
  "qa-engineer:aggregate": { bytesBefore: 100_600, bytesAfter: 23_503, savedPct: 77 },
  "security:aggregate": { bytesBefore: 82_400, bytesAfter: 17_006, savedPct: 79 },
  "devops:aggregate": { bytesBefore: 88_424, bytesAfter: 17_993, savedPct: 80 },
};

describe("T-V4-CTX-001 ContextManager characterization", () => {
  it("pins every ContextManager stage × document-policy pair and each stage aggregate", () => {
    const fixture = createCharacterizationFixture();
    try {
      const actual: Record<string, unknown> = {};
      for (const stage of Object.keys(CONTEXT_POLICY) as AgentStage[]) {
        const manager = new ContextManager({ projectRoot: fixture.root, moduleName: fixture.moduleName });
        const selected = manager.forStage(stage, [1]);
        for (const context of selected) {
          actual[`${stage}:${context.doc}`] = {
            bytesBefore: context.bytesBefore,
            bytesAfter: context.bytesAfter,
            savedPct: Math.round(((context.bytesBefore - context.bytesAfter) / context.bytesBefore) * 100),
            kept: context.kept,
            skipped: context.skipped,
            unknownSections: context.unknownSections,
          };
        }
        actual[`${stage}:aggregate`] = manager.savings(selected);
      }

      expect(Object.keys(actual).filter((key) => !key.endsWith(":aggregate")).sort()).toEqual(policyPairs());
      expect(actual).toEqual(CHARACTERIZATION);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous design section while pinning all three keepDesignSection verdicts", () => {
    const request: ContextRequest = {
      stage: AgentStage.BACKEND_ENGINEER,
      doc: "design",
      phases: [1],
      moduleName: "token-fixture",
      traceability: {
        usableForDesign: true,
        usableForRequirement: false,
        reason: "test",
        selectedTaskIds: new Set(),
        selectedDesignRefs: new Set(),
        plannedDesignRefs: new Set(),
        relevantRequirementIds: new Set(),
        plannedRequirementIds: new Set(),
      },
    };
    expect(keepDesignSection("Risks & Dependencies", "", request)).toBe("keep");
    expect(keepDesignSection("Change Log", "", request)).toBe("drop");
    expect(keepDesignSection("Future Contract", "DES-999", request)).toBe("unknown");

    const selected = selectDocContext(request, [
      "# Design",
      "",
      "## Feature-by-Feature Feasibility",
      "Pinned.",
      "",
      "## Risks & Dependencies",
      "Pinned.",
      "",
      "## Open Questions",
      "None.",
      "",
      "## Future Contract",
      "DES-999 remains ambiguous.",
      "",
      "## Change Log",
      "- historical",
    ].join("\n"));
    expect(selected.kept).toContain("Future Contract");
    expect(selected.unknownSections).toContain("Future Contract");
    expect(selected.text).toContain("DES-999 remains ambiguous.");
    expect(selected.skipped).toContain("Change Log");
  });
});
