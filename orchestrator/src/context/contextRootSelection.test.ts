import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextCommand, contextCommandJson, renderContextCommand } from "./contextCommand.js";
import { fixtureTask } from "../runtime/packetFixture.testSupport.js";
import { renderCanonicalTasks } from "../docs/planTask.js";
import { configureKnowledgeRoot, configureNamedKnowledgeRoot } from "../threeRepo/installation.js";
import { declareInstallationConfigOverrideChannelForTest } from "../threeRepo/installation.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * V11 TASK-025 — `sta context` names the session's Knowledge-root selection
 * (DR §7.4): selected root name, canonical path, selection source and the
 * installation default, without ever changing the default. The selection
 * rides the same resolution the docs read uses, so what the command reads is
 * exactly what it names (closes the SA §2.5 "which root is this session on?"
 * blind spot).
 */

const STA_INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
const cfgDirs: string[] = [];
beforeEach(() => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-ctxsel-cfg-"));
  cfgDirs.push(cfgDir);
  process.env.STA_INSTALLATION_CONFIG = path.join(cfgDir, "installation.yaml");
});
afterEach(() => {
  if (STA_INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = STA_INSTALLATION_CONFIG_ORIGINAL;
  while (cfgDirs.length) fs.rmSync(cfgDirs.pop()!, { recursive: true, force: true });
});

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `sta-ctxsel-${prefix}-`)));
  roots.push(dir);
  return dir;
}
function writeDocs(root: string): void {
  // the configure writers validate the root as a standalone Git checkout
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const dir = path.join(root, "_docs", "module", "sales");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT, "utf8");
  fs.writeFileSync(path.join(dir, "design.md"), DESIGN, "utf8");
  fs.writeFileSync(path.join(dir, "plan.md"), PLAN, "utf8");
}
function installationConfigPath(): string {
  return process.env.STA_INSTALLATION_CONFIG as string;
}

const PLAN = renderCanonicalTasks([
  fixtureTask({ id: "BE-001", phase: 1, title: "First", traceability: ["REQ-001", "AC-007.2", "DES-001"], retrievalHints: "Hypothesis: The first handler is the likely boundary; confirm it.\nQuery: Locate the first handler.\nProvenance: DES-001" }),
]);
const DESIGN = "# Design\n\nDesign evidence format: 1\n\n## Feature-by-Feature Feasibility\nDES-001 REQ-001 yes\n\n## DES-001 — First contract\nvalue\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n";
const REQUIREMENT = "# Requirement\n\n## Core Features\nREQ-001 first\n\n## Scope\nMVP\n\n## References\nsource\n\n## Open Questions\nnone\n";

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("V11 TASK-025 — sta context shows the session's Knowledge-root selection", () => {
  it("names the default root with its source and the default when no flag or launch env applies", async () => {
    const knowledge = tempDir("work");
    writeDocs(knowledge);
    configureKnowledgeRoot(knowledge, installationConfigPath());
    configureNamedKnowledgeRoot(knowledge, { rootName: "work", configPath: installationConfigPath() });

    const result = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [1], projectRoot: tempDir("target"), env: {} });

    expect(result.knowledgeSelection).toMatchObject({ name: "work", source: "default", defaultRootName: "work" });
    expect(result.knowledgeSelection!.path).toBe(knowledge);
    const rendered = renderContextCommand(result);
    expect(rendered).toContain("knowledge_root: work");
    expect(rendered).toContain(`(source=default; default: work; read-only)`);
    expect(contextCommandJson(result)).toMatchObject({
      knowledge_root: { selected_root_name: "work", selection_source: "default", default_root_name: "work" },
    });
  });

  it("names the flagged root without touching the displayed default", async () => {
    const knowledge = tempDir("work");
    const other = tempDir("other");
    writeDocs(knowledge);
    writeDocs(other);
    configureKnowledgeRoot(knowledge, installationConfigPath());
    configureNamedKnowledgeRoot(knowledge, { rootName: "work", configPath: installationConfigPath() });
    configureNamedKnowledgeRoot(other, { rootName: "other", configPath: installationConfigPath() });

    const result = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [1], projectRoot: tempDir("target"), rootName: "other", env: {} });

    expect(result.knowledgeSelection).toMatchObject({ name: "other", source: "flag", defaultRootName: "work" });
    expect(renderContextCommand(result)).toContain("(source=flag; default: work; read-only)");
  });

  it("reports a managed launch-env selection by its name env, never an invented one", async () => {
    const knowledge = tempDir("work");
    writeDocs(knowledge);
    configureKnowledgeRoot(knowledge, installationConfigPath());
    configureNamedKnowledgeRoot(knowledge, { rootName: "work", configPath: installationConfigPath() });

    const result = await buildContextCommand({
      role: "backend-engineer", moduleHint: "sales", phases: [1], projectRoot: tempDir("target"),
      env: { STA_KNOWLEDGE_ROOT: knowledge, STA_KNOWLEDGE_ROOT_NAME: "work" } as NodeJS.ProcessEnv,
    });

    expect(result.knowledgeSelection).toMatchObject({ name: "work", source: "launch-env", defaultRootName: "work" });
    expect(renderContextCommand(result)).toContain("(source=launch-env; default: work; read-only)");
  });

  it("stays silent about the selection on a legacy machine with no installation config", async () => {
    const knowledge = tempDir("work");
    writeDocs(knowledge);

    const result = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales", phases: [1], projectRoot: knowledge, env: {} });

    expect(result.knowledgeSelection).toBeUndefined();
    expect(renderContextCommand(result)).not.toContain("knowledge_root:");
  });
});
