import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactType } from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";
import { buildPrompt, buildPromptParts, sliceModuleDocsWithSavings } from "./agentRunAssembly.js";

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

describe("sliceModuleDocsWithSavings", () => {
  it("calls ContextManager's measured savings path and exposes full document bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-slice-metrics-"));
    try {
      const dir = path.join(root, "_docs", "module", "sales");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\n## Overview\nsmall\n\n## Import Rules\n" + "x".repeat(2_000));
      const sliced = sliceModuleDocsWithSavings(AgentStage.BACKEND_ENGINEER, { projectRoot: root, moduleName: "sales", phases: [1] });
      expect(sliced.docCharsBefore).toBeGreaterThan(0);
      expect(sliced.docs.join("\n")).toContain("Import Rules");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
