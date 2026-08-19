import { describe, expect, it } from "vitest";
import {
  AgentConfigValidationError,
  BACKEND_ENGINEER_CONFIG,
  QA_ENGINEER_CONFIG,
  validateAgentConfig,
} from "./agentConfig.js";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

describe("AgentConfig separation", () => {
  it("the two reference configs are already valid (constructed via validateAgentConfig)", () => {
    expect(BACKEND_ENGINEER_CONFIG.identity.name).toBe(AgentStage.BACKEND_ENGINEER);
    expect(QA_ENGINEER_CONFIG.identity.name).toBe(AgentStage.QA_ENGINEER);
  });

  it("keeps Identity, Instructions, Constraints, Artifacts, Tools as separate fields", () => {
    const keys = Object.keys(BACKEND_ENGINEER_CONFIG).sort();
    expect(keys).toEqual(["artifacts", "constraints", "context", "identity", "instructions", "tools"]);
  });

  it("rejects a config with no constraints (an agent must have at least one boundary)", () => {
    expect(() =>
      validateAgentConfig({
        identity: { name: AgentStage.FRONTEND_ENGINEER, role: "frontend-engineer", description: "x" },
        instructions: ["build UI per design.md"],
        context: [],
        constraints: [],
        artifacts: { reads: [ArtifactType.DESIGN], writes: [] },
        tools: ["Write"],
      }),
    ).toThrow(AgentConfigValidationError);
  });

  it("rejects an unknown artifact type in reads/writes", () => {
    expect(() =>
      validateAgentConfig({
        identity: { name: AgentStage.FRONTEND_ENGINEER, role: "frontend-engineer", description: "x" },
        instructions: ["x"],
        context: [],
        constraints: ["x"],
        artifacts: { reads: ["not-a-real-artifact"], writes: [] },
        tools: [],
      }),
    ).toThrow(AgentConfigValidationError);
  });

  it("rejects an unknown agent name", () => {
    expect(() =>
      validateAgentConfig({
        identity: { name: "not-a-real-agent", role: "x", description: "x" },
        instructions: ["x"],
        context: [],
        constraints: ["x"],
        artifacts: { reads: [], writes: [] },
        tools: [],
      }),
    ).toThrow(AgentConfigValidationError);
  });
});
