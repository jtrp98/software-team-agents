import { describe, expect, it } from "vitest";
import {
  AGENT_REGISTRY,
  agentsForFramework,
  agentsForLanguage,
  agentsWithCapability,
  coverageFor,
  getAgent,
} from "./registry.js";
import { Capability } from "./capabilities.js";
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

describe("agent capabilities (T12)", () => {
  it("gives every agent a capability block — an empty one is a claim, an absent one is an oversight", () => {
    for (const entry of Object.values(AGENT_REGISTRY)) {
      expect(entry.capability, entry.name).toBeDefined();
      expect(Array.isArray(entry.capability.capabilities), entry.name).toBe(true);
      expect(entry.capability.capabilities.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("finds every agent that can do a thing, rather than picking one", () => {
    const testers = agentsWithCapability(Capability.TESTING).map((a) => a.name);
    expect(testers).toContain(AgentStage.BACKEND_ENGINEER);
    expect(testers).toContain(AgentStage.FRONTEND_ENGINEER);
    expect(testers).toContain(AgentStage.QA_ENGINEER);
  });

  it("selects by language and framework", () => {
    expect(agentsForLanguage("TypeScript").length).toBeGreaterThan(0);
    expect(agentsForFramework("prisma").map((a) => a.name)).toContain(AgentStage.BACKEND_ENGINEER);
    expect(agentsForFramework("react").map((a) => a.name)).toContain(AgentStage.FRONTEND_ENGINEER);
  });

  it("gives the analysis roles no language, which is a statement rather than a gap", () => {
    expect(AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].capability.languages).toEqual([]);
    expect(AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].capability.capabilities).toContain(
      Capability.REQUIREMENTS_INTERVIEW,
    );
  });

  it("reports what the roster covers and what it does not", () => {
    const coverage = coverageFor([Capability.REST_API, Capability.GRPC]);
    expect(coverage.covered).toContain(Capability.REST_API);
    // Nothing on this roster builds gRPC yet. Tracking the absence is the point:
    // a capability nobody has must read as missing, not as unasked.
    expect(coverage.missing).toContain(Capability.GRPC);
  });

  it("declares the stack the prompts actually implement, not the one project.yaml targets", () => {
    const backend = AGENT_REGISTRY[AgentStage.BACKEND_ENGINEER].capability;
    expect(backend.languages).toEqual(["typescript"]);
    expect(backend.frameworks).toContain("prisma");
    expect(backend.languages).not.toContain("csharp");
  });
});
