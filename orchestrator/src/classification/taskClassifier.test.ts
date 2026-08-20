import { describe, expect, it } from "vitest";
import { classifyTask } from "./taskClassifier.js";
import { AgentStage, TaskLevel } from "../types.js";

describe("classifyTask", () => {
  it("classifies a typo/copy fix as TRIVIAL with engineer-only pipeline", () => {
    const result = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    expect(result.level).toBe(TaskLevel.TRIVIAL);
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

  it("classifies a new feature/module/project as LARGE_CRITICAL with the full chain", () => {
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
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
    expect(result.requiresHumanApproval).toBe(false);
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
});
