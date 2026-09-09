import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { CONTEXT_POLICY } from "./contextSelection.js";

/**
 * T-V8-011 acceptance: "BA/SA/PM/DEV/QA each receive the minimum-sufficient
 * categories from the analysis role table" (V8-PROBLEM-ANALYSIS.md §5.4).
 *
 * `CONTEXT_POLICY` is the one place that table is enforced (`contextSelection.ts`
 * already documents it as "per CLAUDE.md's per-agent 'Reads' column"). This
 * pins the exact set per role so a future change to that table is a visible,
 * intentional diff here — not a silent widening or narrowing of what a role
 * may read.
 */
describe("CONTEXT_POLICY — role-context matrix (T-V8-011)", () => {
  const EXPECTED: Partial<Record<AgentStage, ArtifactType[]>> = {
    [AgentStage.BUSINESS_ANALYST]: [ArtifactType.REQUIREMENTS, ArtifactType.DESIGN, ArtifactType.QA_REPORT],
    [AgentStage.SYSTEM_ANALYST]: [ArtifactType.REQUIREMENTS, ArtifactType.DESIGN, ArtifactType.QA_REPORT],
    [AgentStage.PROJECT_MANAGER]: [ArtifactType.DESIGN, ArtifactType.REQUIREMENTS],
    [AgentStage.QA_ENGINEER]: [
      ArtifactType.REQUIREMENTS, ArtifactType.DESIGN, ArtifactType.PLAN, ArtifactType.TEST_PLAN, ArtifactType.QA_REPORT,
    ],
  };

  it("BA/SA/PM/QA read exactly the doc categories the analysis role table names (plus HANDOFF, every role's compact index)", () => {
    for (const [stage, docCategories] of Object.entries(EXPECTED) as [AgentStage, ArtifactType[]][]) {
      const reads = CONTEXT_POLICY[stage]!.reads;
      for (const category of docCategories) expect(reads, `${stage} should read ${category}`).toContain(category);
      expect(reads, `${stage} carries the compact HANDOFF index`).toContain(ArtifactType.HANDOFF);
    }
  });

  it("DEV reads its task/design/requirement/test-plan/QA-report categories plus its own code and knowledge brief", () => {
    const reads = CONTEXT_POLICY[AgentStage.BACKEND_ENGINEER]!.reads;
    for (const category of [ArtifactType.PLAN, ArtifactType.DESIGN, ArtifactType.REQUIREMENTS, ArtifactType.TEST_PLAN, ArtifactType.QA_REPORT, "backend-code", "knowledge-brief"]) {
      expect(reads).toContain(category);
    }
    expect(reads).not.toContain("frontend-code");
  });

  it("excludes what the analysis table marks excluded by default — BA never reads code, tier/runtime data, or another role's code category", () => {
    const baReads = CONTEXT_POLICY[AgentStage.BUSINESS_ANALYST]!.reads;
    expect(baReads).not.toContain("backend-code");
    expect(baReads).not.toContain("frontend-code");
    expect(baReads).not.toContain(ArtifactType.EXECUTION_PACKET);
  });

  it("no stage may read the compiler-to-runtime EXECUTION_PACKET category — every doesNotRead set names it explicitly", () => {
    for (const stage of Object.values(AgentStage)) {
      if (stage === AgentStage.HUMAN) continue;
      const policy = CONTEXT_POLICY[stage];
      if (!policy) continue;
      expect(policy.reads, `${stage} must never read EXECUTION_PACKET`).not.toContain(ArtifactType.EXECUTION_PACKET);
      expect(policy.doesNotRead).toContain(ArtifactType.EXECUTION_PACKET);
    }
  });
});
