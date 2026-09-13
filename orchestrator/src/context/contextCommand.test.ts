import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { sliceModuleDocsWithSavings } from "../runtime/agentRunAssembly.js";
import { buildContextCommand, ContextCommandError, contextCommandJson, renderContextCommand } from "./contextCommand.js";
import { fixtureTask } from "../runtime/packetFixture.testSupport.js";
import { renderCanonicalTasks } from "../docs/planTask.js";

// T-V6-006: `env: {}` below means "no STA_KNOWLEDGE_ROOT", which now
// falls through to installation.yaml — isolate it from whatever is real on
// the machine running this suite, exactly like installation.test.ts does.
const STA_INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
beforeEach(() => {
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-context-command-test-no-installation.yaml");
});
afterEach(() => {
  if (STA_INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = STA_INSTALLATION_CONFIG_ORIGINAL;
});

function rootWith(modules: Record<string, Partial<Record<"requirement.md" | "design.md" | "plan.md", string>>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-context-command-"));
  for (const [moduleName, docs] of Object.entries(modules)) {
    const dir = path.join(root, "_docs", "module", moduleName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [filename, text] of Object.entries(docs)) fs.writeFileSync(path.join(dir, filename), text, "utf8");
  }
  return root;
}

const PLAN = renderCanonicalTasks([
  fixtureTask({ id: "BE-001", phase: 1, title: "First", traceability: ["REQ-001", "AC-007.2", "DES-001"], retrievalHints: "Hypothesis: The first handler is the likely boundary; confirm it.\nQuery: Locate the first handler.\nProvenance: DES-001" }),
  fixtureTask({ id: "BE-002", phase: 2, title: "Second", traceability: ["REQ-002", "AC-007.2", "DES-002"], retrievalHints: "Hypothesis: The second handler is the likely boundary; confirm it.\nQuery: Locate the second handler.\nProvenance: DES-002" }),
]);
const DESIGN = "# Design\n\nDesign evidence format: 1\n\n## Feature-by-Feature Feasibility\nDES-001 REQ-001 yes\nDES-002 REQ-002 yes\n\n## DES-001 — First contract\nvalue\n\n## DES-002 — Second contract\nvalue\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n";
const REQUIREMENT = "# Requirement\n\n## Core Features\nREQ-001 first\nREQ-002 second\nAC-007.2 accepted\n\n## Scope\nMVP\n\n## References\nsource\n\n## Open Questions\nnone\n";

describe("sta context command (T-V3TOK-040/041/043)", () => {
  it("uses the same byte-identical document rendering path as sta run", async () => {
    const root = rootWith({ sales: { "requirement.md": REQUIREMENT, "design.md": DESIGN, "plan.md": PLAN } });
    const command = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [2], projectRoot: root, env: {} });
    const run = sliceModuleDocsWithSavings(AgentStage.BACKEND_ENGINEER, { projectRoot: root, moduleName: "sales", phases: [2] });
    expect(command.context.docs).toEqual(run.docs);
    expect(command.context.docs.join("\n")).toBe(run.docs.join("\n"));
  });

  it("infers phase from an exact task id and fails open when the task is unknown", async () => {
    const root = rootWith({ sales: { "requirement.md": REQUIREMENT, "design.md": DESIGN, "plan.md": PLAN } });
    const scoped = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", taskId: "BE-002", projectRoot: root, env: {} });
    expect(scoped.phases).toEqual([2]);
    expect(scoped.phaseResolution).toBe("task");
    const unknown = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", taskId: "BE-999", projectRoot: root, env: {} });
    expect(unknown.phases).toEqual([]);
    expect(unknown.phaseResolution).toBe("task-not-found");
    expect(unknown.context.selected.find((doc) => doc.doc === "plan")?.fullDocument).toBe(true);
  });

  it("uses the Knowledge root exported by a three-repo launch, never Target-local docs", async () => {
    const target = rootWith({ wrong: { "design.md": DESIGN } });
    const knowledge = rootWith({ right: { "design.md": DESIGN } });
    const result = await buildContextCommand({
      role: "backend-engineer", moduleHint: "right", projectRoot: target,
      env: { STA_KNOWLEDGE_ROOT: knowledge },
    });
    expect(result.docsRoot).toBe(path.resolve(knowledge));
    expect(result.module).toBe("right");
  });

  it("returns distinct actionable errors for ambiguous and absent modules", async () => {
    const many = rootWith({ alpha: { "design.md": DESIGN }, beta: { "requirement.md": REQUIREMENT } });
    await expect(buildContextCommand({ role: "backend-engineer", projectRoot: many, env: {} })).rejects.toMatchObject({ exitCode: 2 });
    await expect(buildContextCommand({ role: "backend-engineer", projectRoot: rootWith({}), env: {} })).rejects.toMatchObject({ exitCode: 3 });
    try {
      await buildContextCommand({ role: "backend-engineer", projectRoot: many, env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCommandError);
      expect((error as Error).message).toContain("--module");
      expect((error as Error).message).toContain("alpha");
    }
  });

  it("reports composition and names every dropped heading with the full path", async () => {
    const root = rootWith({ sales: { "requirement.md": REQUIREMENT, "design.md": DESIGN, "plan.md": PLAN } });
    const result = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [2], projectRoot: root, env: {} });
    const rendered = renderContextCommand(result);
    for (const doc of result.context.selected) {
      for (const heading of doc.skipped) expect(rendered).toContain(heading);
    }
    expect(rendered).toContain(path.join(root, "_docs", "module", "sales", "plan.md"));
    expect(rendered).toContain("slicing_saved=");
    expect(result.composition.direct_file_reads).toBe(5);
    expect(contextCommandJson(result)).toMatchObject({ composition: { doc_chars_before: expect.any(Number), saved_pct: expect.any(Number) } });
  });

  it("names why each unknown design.md section came back unplaceable, not just which (T-V6-001)", async () => {
    const untagged = "# Design\n\n## Feature-by-Feature Feasibility\nDES-001 REQ-001 yes\n\n## Untagged Contract\nno ids here\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n";
    const root = rootWith({ sales: { "requirement.md": REQUIREMENT, "design.md": untagged, "plan.md": PLAN } });
    const result = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [1], projectRoot: root, env: {} });
    const design = contextCommandJson(result) as { savings_by_document: Array<{ doc: string; kept_as_unknown: string[]; kept_as_unknown_reasons: { heading: string; reason: string }[] }> };
    const designEntry = design.savings_by_document.find((d) => d.doc === "design")!;
    expect(designEntry.kept_as_unknown).toContain("Untagged Contract");
    expect(designEntry.kept_as_unknown_reasons).toEqual(
      expect.arrayContaining([{ heading: "Untagged Contract", reason: "no-des-id" }]),
    );
  });

  it("names each fallback document and its structural reason, not just a count (T-V5-035)", async () => {
    const root = rootWith({ sales: { "requirement.md": REQUIREMENT, "design.md": DESIGN, "plan.md": PLAN } });
    const unknown = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", taskId: "BE-999", projectRoot: root, env: {} });
    expect(unknown.composition.fallback_to_full_documents).toBeGreaterThan(0);
    expect(unknown.composition.fallback_documents).toEqual(
      expect.arrayContaining([expect.objectContaining({ doc: "plan", reason: expect.stringContaining("phase") })]),
    );
    const rendered = renderContextCommand(unknown);
    expect(rendered).toContain("fallback: plan —");
    expect(contextCommandJson(unknown)).toMatchObject({
      composition: { fallback_documents: expect.arrayContaining([expect.objectContaining({ doc: "plan" })]) },
    });
  });
});
