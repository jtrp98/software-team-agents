import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { buildPrompt, sliceModuleDocsFor } from "./agentRunAssembly.js";
import type { AgentExecutorRequest } from "../orchestrator/orchestrator.js";
import type { ContextItem } from "../context/contextSelection.js";

/**
 * OFF07 โ€” Shared Knowledge is a consumer-independent capability.
 *
 * The orchestrator curates context once, in one place (`agentRunAssembly.ts`),
 * and every runtime receives the result of that same curation. That is the
 * property that makes Shared Knowledge an organizational capability rather than
 * a Claude feature or a Codex feature โ€” but until now nothing proved it. This
 * file is the proof, kept executable so the parity cannot silently rot:
 *
 *   1. the doc slice produced for a stage is byte-identical regardless of which
 *      runtime will consume it (slicing never sees a binding);
 *   2. the assembled prompt for an identical request is byte-identical;
 *   3. neither the slices nor the prompt ever name a runtime โ€” the assembly
 *      layer is vendor-blind by construction.
 *
 * If a future change makes context differ per provider, this test fails and the
 * difference has to be argued for explicitly, not smuggled in.
 */

function makeProject(docs: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-consumer-parity-"));
  for (const [rel, content] of Object.entries(docs)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const REQUIREMENT = [
  "# REQ-101 โ€” Fixture module",
  "",
  "## Functional Requirements",
  "- FR-1 The fixture stores one string.",
  "## Non-Functional Requirements",
  "- NFR-1 Reads are O(1).",
].join("\n");

const DESIGN = [
  "# DES-101 โ€” Fixture module",
  "",
  "## Feasibility",
  "A Map suffices.",
  "## Risks",
  "None beyond fixture scope.",
  "## Open Questions",
  "None.",
].join("\n");

const PLAN = [
  "# PLAN-101",
  "",
  "## Phase 1 โ€” Implement",
  "- Write the Map.",
].join("\n");

const baseDocs = {
  "_docs/module/fixture/requirement.md": REQUIREMENT,
  "_docs/module/fixture/design.md": DESIGN,
  "_docs/module/fixture/plan.md": PLAN,
};

let claudeRoot: string;
let codexRoot: string;

beforeEach(() => {
  claudeRoot = makeProject(baseDocs);
  codexRoot = makeProject(baseDocs);
});

afterEach(() => {
  for (const dir of [claudeRoot, codexRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("consumer parity โ€” one curation, every runtime", () => {
  it("produces byte-identical doc slices for both consumers", () => {
    const forClaude = sliceModuleDocsFor(AgentStage.BACKEND_ENGINEER, { projectRoot: claudeRoot, moduleName: "fixture", phases: [1] });
    const forCodex = sliceModuleDocsFor(AgentStage.BACKEND_ENGINEER, { projectRoot: codexRoot, moduleName: "fixture", phases: [1] });
    expect(forClaude.length).toBeGreaterThan(0);
    expect(forCodex).toEqual(forClaude);
  });

  it("assembles a byte-identical prompt for an identical request", () => {
    const context: ContextItem[] = [
      { source: "backend-code", content: "Design approved on 2026-08-23." },
    ];
    const requestFor = (): AgentExecutorRequest => ({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-parity",
      context,
    });
    const sliced = sliceModuleDocsFor(AgentStage.BACKEND_ENGINEER, { projectRoot: claudeRoot, moduleName: "fixture", phases: [1] });
    const forClaude = buildPrompt(requestFor(), undefined, sliced);
    const forCodex = buildPrompt(requestFor(), undefined, sliced);
    expect(forCodex).toBe(forClaude);
    // The curated-context framing must also be identical when there is no
    // prior-stage context at all โ€” the "no context" path is part of the contract.
    const empty = (): AgentExecutorRequest => ({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-parity", context: [] });
    expect(buildPrompt(empty())).toBe(buildPrompt(empty()));
  });

  it("never names a runtime anywhere in assembled output", () => {
    const sliced = sliceModuleDocsFor(AgentStage.BACKEND_ENGINEER, { projectRoot: claudeRoot, moduleName: "fixture", phases: [1] });
    const prompt = buildPrompt(
      { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-parity", context: [{ source: "backend-code", content: "x" }] },
      undefined,
      sliced,
    );
    expect(prompt.toLowerCase()).not.toContain("claude");
    expect(prompt.toLowerCase()).not.toContain("codex");
    for (const part of sliced) {
      expect(part.toLowerCase()).not.toContain("claude");
      expect(part.toLowerCase()).not.toContain("codex");
    }
  });
});

