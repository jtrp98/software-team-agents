import { describe, expect, it } from "vitest";
import { AGENT_REGISTRY, getAgent } from "./registry.js";
import { STAGE_TO_STATE } from "../state/taskState.js";
import { AgentStage } from "../types.js";

describe("AGENT_REGISTRY", () => {
  it("has an entry for every AgentStage", () => {
    for (const stage of Object.values(AgentStage)) {
      expect(AGENT_REGISTRY[stage]).toBeDefined();
      expect(AGENT_REGISTRY[stage].name).toBe(stage);
    }
  });

  it("agrees with taskState.ts's STAGE_TO_STATE for every stage that has one", () => {
    for (const [stage, state] of Object.entries(STAGE_TO_STATE)) {
      expect(getAgent(stage as AgentStage).allowed_states).toContain(state);
    }
  });

  it("only qa-engineer can write a qa-report", () => {
    const writers = Object.values(AGENT_REGISTRY).filter((e) => e.outputs.includes("qa-report"));
    expect(writers.map((w) => w.name)).toEqual([AgentStage.QA_ENGINEER]);
  });

  it("only security can write a security-report", () => {
    const writers = Object.values(AGENT_REGISTRY).filter((e) => e.outputs.includes("security-report"));
    expect(writers.map((w) => w.name)).toEqual([AgentStage.SECURITY]);
  });

  it("devops is the only role with deploy/rollback permissions", () => {
    for (const entry of Object.values(AGENT_REGISTRY)) {
      if (entry.name === AgentStage.DEVOPS) continue;
      expect(entry.permissions).not.toContain("deploy");
      expect(entry.permissions).not.toContain("rollback");
    }
  });

  it("every engineer has write_code but not deploy", () => {
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const entry = getAgent(stage);
      expect(entry.permissions).toContain("write_code");
      expect(entry.permissions).not.toContain("deploy");
    }
  });
});
