import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { assertOperationAllowed, canUseCodeIntelligence } from "./capabilities.js";
import { CapabilityDeniedError, CodeIntelOperation } from "./provider.js";

const OPERATIONS: CodeIntelOperation[] = ["findRelevantCode", "getDependencies", "getDependents", "findPath", "getImpact"];

describe("capability matrix (T-GR10)", () => {
  it("SA + engineers + QA are in; every other role is out", () => {
    expect(canUseCodeIntelligence(AgentStage.SYSTEM_ANALYST)).toBe(true);
    expect(canUseCodeIntelligence(AgentStage.BACKEND_ENGINEER)).toBe(true);
    expect(canUseCodeIntelligence(AgentStage.FRONTEND_ENGINEER)).toBe(true);
    expect(canUseCodeIntelligence(AgentStage.QA_ENGINEER)).toBe(true);

    const everyoneElse = Object.values(AgentStage).filter(
      (role) => ![AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER].includes(role),
    );
    for (const role of everyoneElse) {
      expect(canUseCodeIntelligence(role), `role ${role} must be denied`).toBe(false);
    }
  });

  it("allowed roles pass every operation; denied roles fail every operation", () => {
    for (const operation of OPERATIONS) {
      expect(() => assertOperationAllowed(AgentStage.QA_ENGINEER, operation)).not.toThrow();
      expect(() => assertOperationAllowed(AgentStage.PROJECT_MANAGER, operation)).toThrow(CapabilityDeniedError);
    }
  });
});
