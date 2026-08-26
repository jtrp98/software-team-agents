import { describe, expect, it } from "vitest";
import { ArtifactType } from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";
import { buildPrompt, buildPromptParts } from "./agentRunAssembly.js";

describe("buildPromptParts (T-V3TOK-001)", () => {
  it("accounts for every character exactly once across prompt composition", () => {
    const req = {
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-001",
      context: [{ source: ArtifactType.REQUIREMENTS, content: "REQ-1" }],
    };
    const assembled = buildPromptParts(req, "extra", {
      docs: ["design"], knowledge: ["knowledge"], codeIntel: ["code"], toolOutput: ["tool"],
    });
    expect(Object.values(assembled.composition).reduce((sum, chars) => sum + chars, 0)).toBe(assembled.text.length);
    expect(assembled.composition.static_chars).toBeGreaterThan(0);
    expect(assembled.composition.handoff_chars).toBeGreaterThan(0);
  });

  it("keeps buildPrompt's legacy output as a wrapper", () => {
    const req = { stage: AgentStage.SETUP, taskId: "T-legacy", context: [] };
    expect(buildPrompt(req, "note", ["doc"])).toBe(buildPromptParts(req, "note", { docs: ["doc"] }).text);
  });
});
