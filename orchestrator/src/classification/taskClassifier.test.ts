import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyTask, pmMode, type ClassificationInput } from "./taskClassifier.js";
import { AgentStage, TaskLevel } from "../types.js";
import { catalogWorkflows } from "../workflow/workflowCatalog.js";
import { pipelineFromWorkflow } from "../workflow/workflowDefinition.js";

describe("classifyTask", () => {
  it("keeps typo pipeline free of a QA stage (T-V3R-060 INV-10)", () => {
    const result = classifyTask({ isTypoOrCopyOnly: true, touchesBackend: true });
    expect(result.pipeline).not.toContain(AgentStage.QA_ENGINEER);
  });
  it("classifies a typo/copy fix as TRIVIAL with engineer-only pipeline", () => {
    const result = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    expect(result.level).toBe(TaskLevel.TRIVIAL);
    // No design phase in a copy tweak (T-UX11) — the module's existing signed
    // UX artifact covers it; uxui-designer runs only in design-bearing pipelines.
    expect(result.pipeline).toEqual([AgentStage.FRONTEND_ENGINEER]);
    expect(result.requiresHumanApproval).toBe(false);
  });

  it("classifies a clear bug fix as SMALL with engineer -> qa", () => {
    const result = classifyTask({ isClearBugFix: true, touchesBackend: true });
    expect(result.level).toBe(TaskLevel.SMALL);
    expect(result.pipeline).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER]);
  });

  it("puts backend before frontend when both are touched", () => {
    const result = classifyTask({
      isClearBugFix: true,
      touchesBackend: true,
      touchesFrontend: true,
    });
    expect(result.pipeline.indexOf(AgentStage.BACKEND_ENGINEER)).toBeLessThan(
      result.pipeline.indexOf(AgentStage.FRONTEND_ENGINEER),
    );
  });

  it("puts the UX/UI consultant before the frontend engineer it advises (T-UX6)", () => {
    const result = classifyTask({
      isIncrementalFeature: true,
      touchesBackend: true,
      touchesFrontend: true,
    });
    expect(result.pipeline.indexOf(AgentStage.UXUI_DESIGNER)).toBeLessThan(
      result.pipeline.indexOf(AgentStage.FRONTEND_ENGINEER),
    );
    // Backend-only work never pays for a UX pass.
    const backendOnly = classifyTask({ isIncrementalFeature: true, touchesBackend: true });
    expect(backendOnly.pipeline).not.toContain(AgentStage.UXUI_DESIGNER);
  });

  it("runs uxui-designer only in design-bearing pipelines, not small fixes (T-UX11)", () => {
    for (const signal of [
      { isNewFeatureModuleOrProject: true },
      { touchesSchema: true },
      { touchesBusinessRuleOnly: true },
      { isIncrementalFeature: true },
    ] as const) {
      const withFrontend = classifyTask({ ...signal, touchesFrontend: true });
      expect(withFrontend.pipeline).toContain(AgentStage.UXUI_DESIGNER);
    }
    // Small fixes have no design phase to advise on.
    const bugFix = classifyTask({ isClearBugFix: true, touchesFrontend: true });
    expect(bugFix.pipeline).not.toContain(AgentStage.UXUI_DESIGNER);
    const typo = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    expect(typo.pipeline).not.toContain(AgentStage.UXUI_DESIGNER);
  });

  it("classifies an incremental feature as MEDIUM, skipping BA and PM", () => {
    const result = classifyTask({ isIncrementalFeature: true, touchesBackend: true });
    expect(result.level).toBe(TaskLevel.MEDIUM);
    expect(result.pipeline).toEqual([
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
  });

  it("classifies a business-rule-only change as MEDIUM, skipping PM", () => {
    const result = classifyTask({ touchesBusinessRuleOnly: true, touchesBackend: true });
    expect(result.level).toBe(TaskLevel.MEDIUM);
    expect(result.pipeline).toEqual([
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
  });

  it("classifies a schema change as LARGE_CRITICAL and always forces security + human approval", () => {
    const result = classifyTask({ touchesSchema: true, touchesBackend: true });
    expect(result.level).toBe(TaskLevel.LARGE_CRITICAL);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.sensitiveGate).toBe(true);
    expect(result.pipeline).toEqual([
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.QA_ENGINEER,
      AgentStage.SECURITY,
    ]);
  });

  it("classifies a new feature/module/project as LARGE_CRITICAL with the full chain and the interview gate", () => {
    const result = classifyTask({
      isNewFeatureModuleOrProject: true,
      touchesBackend: true,
      touchesFrontend: true,
    });
    expect(result.level).toBe(TaskLevel.LARGE_CRITICAL);
    expect(result.pipeline).toEqual([
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.PROJECT_MANAGER,
      AgentStage.TEST_PLANNER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.UXUI_DESIGNER,
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
    // The requirements interview is always-human point #1 — a new feature never
    // spawns business-analyst headless without a person answering it.
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("a new feature that also touches schema keeps the interview first AND the schema obligations", () => {
    const result = classifyTask({
      isNewFeatureModuleOrProject: true,
      touchesSchema: true,
      touchesBackend: true,
      touchesFrontend: true,
    });
    // Not the schema-only pipeline: BA and PM stay in.
    expect(result.pipeline[0]).toBe(AgentStage.BUSINESS_ANALYST);
    expect(result.pipeline).toContain(AgentStage.PROJECT_MANAGER);
    // Schema obligations still apply on top.
    expect(result.touchesSchema).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.sensitiveGate).toBe(true);
    expect(result.pipeline).toContain(AgentStage.SECURITY);
  });

  it("adds security to a sensitive new-feature task without duplicating it", () => {
    const result = classifyTask({
      isNewFeatureModuleOrProject: true,
      touchesBackend: true,
      touchesSensitiveArea: true,
    });
    expect(result.pipeline.filter((s) => s === AgentStage.SECURITY)).toHaveLength(1);
    expect(result.sensitiveGate).toBe(true);
  });

  it("classifies a production deploy/migration as LARGE_CRITICAL requiring human approval", () => {
    const result = classifyTask({ isProductionDeployOrMigration: true });
    expect(result.level).toBe(TaskLevel.LARGE_CRITICAL);
    expect(result.pipeline).toEqual([AgentStage.DEVOPS]);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("production deploy takes priority even if other flags are set", () => {
    const result = classifyTask({
      isProductionDeployOrMigration: true,
      touchesSchema: true,
      isTypoOrCopyOnly: true,
    });
    expect(result.pipeline).toEqual([AgentStage.DEVOPS]);
  });

  it("returns UNKNOWN and escalates to a human when no signal matches", () => {
    const result = classifyTask({});
    expect(result.level).toBe(TaskLevel.UNKNOWN);
    expect(result.pipeline).toEqual([AgentStage.HUMAN]);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("flags a missing engineer selection instead of silently producing an empty stage", () => {
    const result = classifyTask({ isClearBugFix: true });
    expect(result.reasons.some((r) => r.includes("no engineer stage selected"))).toBe(true);
  });

  it("names the existing Lightweight/Full PM boundary without changing it", () => {
    expect(pmMode(classifyTask({}))).toBe("none");
    expect(pmMode(classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true }))).toBe("lightweight");
    expect(pmMode(classifyTask({ isClearBugFix: true, touchesBackend: true }))).toBe("lightweight");
    expect(pmMode(classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }))).toBe("full");
    expect(
      pmMode({
        level: TaskLevel.LARGE_CRITICAL,
        pipeline: [AgentStage.PROJECT_MANAGER],
        requiresHumanApproval: false,
        sensitiveGate: false,
        reasons: [],
      }),
    ).toBe("full");
  });

  it("keeps all ten workflow stage/level/approval outputs byte-identical to the Phase 1 baseline", () => {
    const signalInputs: Record<string, ClassificationInput> = {
      typo: { isTypoOrCopyOnly: true, touchesBackend: true, touchesFrontend: true },
      bugfix: { isClearBugFix: true, touchesBackend: true, touchesFrontend: true },
      incremental: { isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true },
      "business-rule": { touchesBusinessRuleOnly: true, touchesBackend: true, touchesFrontend: true },
      feature: { isNewFeatureModuleOrProject: true, touchesBackend: true, touchesFrontend: true },
      "schema-change": { touchesSchema: true, touchesBackend: true, touchesFrontend: true },
      deploy: { isProductionDeployOrMigration: true },
    };
    const ids = [
      "typo",
      "bugfix",
      "incremental",
      "business-rule",
      "feature",
      "schema-change",
      "deploy",
      "hotfix",
      "refactor",
      "security-fix",
    ];
    const catalog = catalogWorkflows();
    const actual = ids.map((workflow) => {
      const signal = signalInputs[workflow];
      const result = signal
        ? classifyTask(signal)
        : {
            level: catalog[workflow].level,
            pipeline: pipelineFromWorkflow(catalog[workflow], {
              touchesBackend: true,
              touchesFrontend: true,
              touchesSensitiveArea: workflow === "security-fix",
            }),
            requiresHumanApproval: catalog[workflow].requires_human_approval,
          };
      return {
        workflow,
        level: result.level,
        pipeline: result.pipeline,
        requiresHumanApproval: result.requiresHumanApproval,
      };
    });
    const bytes = `${JSON.stringify(actual, null, 2)}\n`;
    const goldenPath = fileURLToPath(new URL("./fixtures/v3-phase1-classification.golden.json", import.meta.url));
    expect(bytes).toBe(fs.readFileSync(goldenPath, "utf8").replace(/\r\n/g, "\n"));
  });
});
