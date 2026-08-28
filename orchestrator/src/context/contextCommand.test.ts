import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { sliceModuleDocsWithSavings } from "../runtime/agentRunAssembly.js";
import { buildContextCommand, ContextCommandError, contextCommandJson, renderContextCommand } from "./contextCommand.js";

function rootWith(modules: Record<string, Partial<Record<"requirement.md" | "design.md" | "plan.md", string>>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-context-command-"));
  for (const [moduleName, docs] of Object.entries(modules)) {
    const dir = path.join(root, "_docs", "module", moduleName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [filename, text] of Object.entries(docs)) fs.writeFileSync(path.join(dir, filename), text, "utf8");
  }
  return root;
}

const PLAN = "# Plan\n\n## Plan Summary\nall\n\n## Phase 1: First\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 (DES-001) — first | pending | backend-engineer | — |\n\n## Phase 2: Second\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-002 (DES-002) — second | pending | backend-engineer | — |\n\n## Open Questions\nnone\n";
const DESIGN = "# Design\n\n## Feature-by-Feature Feasibility\nDES-001 REQ-001 yes\nDES-002 REQ-002 yes\n\n## Contract\nvalue\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n";
const REQUIREMENT = "# Requirement\n\n## Core Features\nREQ-001 first\nREQ-002 second\n\n## Scope\nMVP\n\n## References\nsource\n\n## Open Questions\nnone\n";

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
      env: { AGENTCLAUDE_KNOWLEDGE_ROOT: knowledge },
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
});
