import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { AlreadyInstalledError, runInit } from "./initCommand.js";
import { readInstallManifest } from "./installManifest.js";
import { loadStaConfig } from "./staConfig.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];
const AGENTS_POINTER = "<!-- sta:bootstrap -->\n# bootstrap\n<!-- /sta:bootstrap -->\nSee CLAUDE.md.\n";

function fixtureTemplatesDir(): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sta-init-source-"));
  roots.push(source);
  const files: Record<string, string> = {
    "CLAUDE.md": "# rules\n",
    "AGENTS.md": AGENTS_POINTER,
    ".claude/agents/business-analyst.md": "---\nname: business-analyst\n---\n",
    "layout.yaml": "version: 1\n",
    "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version: "0.1.0" }),
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(source, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
  const templatesDir = path.join(source, "templates");
  buildTemplates(source, templatesDir, NOW);
  return templatesDir;
}

function tmpProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-init-project-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("runInit", () => {
  it("copies every template file into an empty project and writes .sta/config.yaml + manifest.json", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();

    const result = runInit(project, templatesDir, NOW);

    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# rules\n");
    expect(fs.readFileSync(path.join(project, ".claude/agents/business-analyst.md"), "utf8")).toContain(
      "business-analyst",
    );
    expect(result.installed).toContain("CLAUDE.md");
    expect(result.skippedConflicts).toEqual([]);
    expect(result.configWritten).toBe(true);

    const config = loadStaConfig(project);
    expect(config.schema_version).toBe(1);

    const manifest = readInstallManifest(project);
    expect(manifest.framework_version).toBe("0.1.0");
    expect(manifest.files.map((f) => f.path)).toContain("CLAUDE.md");
  });

  it("seeds knowledge/, _docs/, decisions/ only when they don't already exist", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();
    fs.mkdirSync(path.join(project, "_docs", "module", "sales"), { recursive: true });
    fs.writeFileSync(path.join(project, "_docs", "module", "sales", "requirement.md"), "# existing work\n", "utf8");

    const result = runInit(project, templatesDir, NOW);

    expect(result.seededDirs).toContain("knowledge");
    expect(result.seededDirs).toContain("decisions");
    expect(result.seededDirs).not.toContain("_docs");
    expect(fs.existsSync(path.join(project, "project.yaml"))).toBe(false);
    expect(fs.readFileSync(path.join(project, "_docs", "module", "sales", "requirement.md"), "utf8")).toBe(
      "# existing work\n",
    );
  });

  it("never overwrites a file the project already has with different content", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# this project's own CLAUDE.md, not the framework's\n", "utf8");

    const result = runInit(project, templatesDir, NOW);

    expect(result.skippedConflicts).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe(
      "# this project's own CLAUDE.md, not the framework's\n",
    );
    const manifest = readInstallManifest(project);
    expect(manifest.files.map((f) => f.path)).not.toContain("CLAUDE.md");
  });

  it("injects only the AGENTS.md managed block, preserves project bytes, and backs up before writing", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();
    const owned = "# Project rules\r\nKeep these bytes.\r\n";
    fs.writeFileSync(path.join(project, "AGENTS.md"), owned, "utf8");

    const result = runInit(project, templatesDir, NOW);

    expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")).toBe(
      "<!-- sta:bootstrap -->\n# bootstrap\n<!-- /sta:bootstrap -->\n" + owned,
    );
    expect(fs.readFileSync(path.join(project, ".sta/backups/2026-08-20T09-00-00Z/AGENTS.md"), "utf8")).toBe(owned);
    expect(result.installed).toContain("AGENTS.md");
    expect(readInstallManifest(project).files.map((file) => file.path)).not.toContain("AGENTS.md");
  });

  it("refuses to re-init an already-initialized project without --force", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();
    runInit(project, templatesDir, NOW);
    expect(() => runInit(project, templatesDir, NOW)).toThrow(AlreadyInstalledError);
  });

  it("allows re-init with --force", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpProjectRoot();
    runInit(project, templatesDir, NOW);
    expect(() => runInit(project, templatesDir, NOW, { force: true })).not.toThrow();
  });
});
