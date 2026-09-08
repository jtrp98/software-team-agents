import { runtimeTaskFixture, FIXTURE_REVISION } from "./packetFixture.testSupport.js";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactType, type HandoffArtifact } from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { buildPrompt, buildPromptParts, compileExecutionPacket, handoffFromContext, referencedKnowledgeIds, renderExecutionPacketSections, renderSlicedDocs, sliceModuleDocsWithSavings } from "./agentRunAssembly.js";
import type { SelectedContext } from "../context/docSelection.js";
import type { ContextManager } from "../context/contextManager.js";

describe("buildPromptParts (T-V3TOK-001)", () => {
  it("accounts for every character exactly once across prompt composition", () => {
    const req = {
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-001",
      context: [{ source: ArtifactType.REQUIREMENTS, content: "REQ-1" }],
    };
    const assembled = buildPromptParts(req, "extra", {
      safety: ["safety"], docs: ["design"], knowledge: ["knowledge"], codeIntel: ["code"], toolOutput: ["tool"],
    });
    expect(Object.values(assembled.composition).reduce((sum, chars) => sum + chars, 0)).toBe(assembled.text.length);
    expect(Object.values(assembled.budgetComposition).reduce((sum, chars) => sum + chars, 0)).toBe(assembled.text.length);
    expect(assembled.budgetComposition).toMatchObject({ base: expect.any(Number), task: expect.any(Number), safety: expect.any(Number), reserve: 0 });
    expect(assembled.budgetComposition.safety).toBeGreaterThan(0);
    expect(assembled.composition.static_chars).toBeGreaterThan(0);
    expect(assembled.composition.handoff_chars).toBeGreaterThan(0);
  });

  it("keeps buildPrompt's legacy output as a wrapper", () => {
    const req = { stage: AgentStage.SETUP, taskId: "T-legacy", context: [] };
    expect(buildPrompt(req, "note", ["doc"])).toBe(buildPromptParts(req, "note", { docs: ["doc"] }).text);
  });

  it("keeps the no-handoff prompt byte-identical to the pre-P6 composition", () => {
    const req = { stage: AgentStage.SETUP, taskId: "T-legacy", context: [] };
    const expected = [
      "Task T-legacy — you are running as the `setup` stage of this repo's pipeline (see the repo's own agent documentation).",
      "",
      "No prior-stage context was supplied for this task — proceed from the repo's own docs (`_docs/status.md` first, per convention).",
      "doc",
      "",
      "Finish by stating clearly what you completed and, per convention, what should happen next — the orchestrator reads your exit status and the docs you wrote, not a special reply format.",
    ].join("\n");
    expect(buildPrompt(req, undefined, ["doc"])).toBe(expected);
  });
});

describe("T-V8-004 semantic Task Compiler", () => {
  it("renders complete fields exactly once and narrows stale grants", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-compiler-"));
    try {
      const runtimeTask = runtimeTaskFixture(root, { allow: ["server/**", "widened/**"] });
      const packet = compileExecutionPacket({ req: { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PACKET", context: [] }, role: "backend-engineer", runtimeTask,
        contractScope: { allow: ["server/**"], deny: [".git/**"] }, baseRevision: FIXTURE_REVISION, sources: { docs: ["UNRELATED PROSE"] } });
      const sections = renderExecutionPacketSections(packet);
      expect(packet.text).toBe(sections.join("\n\n"));
      expect(new Set(sections.map(s => s.split("\n")[0])).size).toBe(sections.length);
      expect(packet.scope.allow).toEqual(["server/**"]);
      expect(packet.text).not.toContain("UNRELATED");
      expect(packet.text).toContain(runtimeTask.contract.why);
      expect(packet.text).toContain(runtimeTask.contract.objective);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("renderSlicedDocs — fallback attribution (T-V5-035)", () => {
  it("names the reason in the prompt itself when a document came through in full", () => {
    const selected: SelectedContext[] = [
      {
        doc: "design",
        text: "# Design\nfull body",
        kept: ["Feature-by-Feature Feasibility"],
        skipped: [],
        unknownSections: [],
        unknownSectionReasons: [],
        fullDocument: true,
        reason: "more than 40% of design.md sections have unknown relevance (6/13) — parser confidence is insufficient, so the document is passed through whole",
        bytesBefore: 100,
        bytesAfter: 100,
      },
    ];
    const rendered = renderSlicedDocs(selected, {} as ContextManager).join("\n");
    expect(rendered).toContain("Sent in full");
    expect(rendered).toContain("parser confidence is insufficient");
    expect(rendered).not.toContain("Known-irrelevant sections not included");
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

  it("renders the HANDOFF slice notice, retrieval command, and omitted-section report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-handoff-prompt-"));
    try {
      const dir = path.join(root, "_docs", "module", "sales");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "design.md"), [
        "# Design",
        "## Feature-by-Feature Feasibility", "safe",
        "## Risks & Dependencies", "safe",
        "## Open Questions", "none",
        "## Orders Contract — DES-001", "selected",
        "## Future Contract — DES-997", "future ".repeat(100),
        "## Future Contract — DES-998", "future ".repeat(100),
        "## Future Contract — DES-999", "future ".repeat(100),
      ].join("\n"));
      const handoff: HandoffArtifact = {
        task_id: "T-1", implements: ["DES-001"], module: "sales", phase: 1,
        constraint_refs: [], contract_refs: { produces: ["design.md#Orders-Contract-%E2%80%94-DES-001"], consumes: [] },
        decision_refs: [], test_refs: [], artifact_refs: [], open_findings: [], budget: null,
      };
      const sliced = sliceModuleDocsWithSavings(AgentStage.PROJECT_MANAGER, {
        projectRoot: root, moduleName: "sales", phases: [1], handoff,
      });
      const prompt = buildPrompt(
        { stage: AgentStage.PROJECT_MANAGER, taskId: "T-1", context: [{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }] },
        undefined,
        sliced.docs,
      );
      expect(prompt).toContain("slice pointed to by the structured HANDOFF");
      expect(prompt).toContain("sta context project-manager --module sales --phase 1");
      expect(prompt).toContain("Known-irrelevant sections not included:");
      expect(prompt).toContain("Future Contract — DES-999");
      expect(prompt).not.toContain("future future future");
      expect(handoffFromContext([{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }])).toEqual(handoff);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("referencedKnowledgeIds", () => {
  it("uses only the authoritative plan task row's design references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-refs-"));
    try {
      const dir = path.join(root, "_docs", "module", "sales");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plan.md"), [
        "# Plan",
        "",
        "## Phase 1: Sales",
        "",
        "| Task | Status | Owner | Depends on |",
        "|---|---|---|---|",
        "| BE-001 (DES-010, DES-011) — implement | pending | backend-engineer | — |",
        "",
      ].join("\n"));
      expect(referencedKnowledgeIds(root, "sales", "BE-001")).toEqual(["DES-010", "DES-011"]);
      expect(referencedKnowledgeIds(root, "sales", "BE-999")).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
