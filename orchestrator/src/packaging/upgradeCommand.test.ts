import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { runInit } from "./initCommand.js";
import { runUpgrade } from "./upgradeCommand.js";
import { readInstallManifest } from "./installManifest.js";
import { InstallManifestMissingError } from "./installManifest.js";

const roots: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
}

/** Builds a templates/ dir at a given "framework version", with whatever file set the case needs. */
function fixtureTemplatesDir(version: string, files: Record<string, string>): string {
  const source = tmpDir("sta-upgrade-source-");
  writeFiles(source, { ...files, "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version }) });
  const templatesDir = path.join(source, "templates");
  buildTemplates(source, templatesDir, "2026-08-20T09:00:00Z");
  return templatesDir;
}

describe("runUpgrade", () => {
  it("throws InstallManifestMissingError when the project was never init'd", () => {
    const templatesDir = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-upgrade-project-");
    expect(() => runUpgrade(project, templatesDir, "2026-08-21T09:00:00Z")).toThrow(InstallManifestMissingError);
  });

  it("overwrites a file the project never touched, backing up the old content first", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n", "layout.yaml": "version: 1\n" });
    const project = tmpDir("sta-upgrade-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n", "layout.yaml": "version: 1\n" });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(result.overwritten).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# v2\n");
    expect(fs.readFileSync(path.join(result.backupDir, "CLAUDE.md"), "utf8")).toBe("# v1\n");
    expect(readInstallManifest(project).framework_version).toBe("0.2.0");
  });

  it("skips a file the project edited, and leaves it exactly as the project left it", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-upgrade-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# the project's own edited rules\n", "utf8");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n" });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(result.skippedUserModified).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# the project's own edited rules\n");
  });

  it("installs a file the new framework version adds", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-upgrade-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v1\n", "policies/coding.md": "# new in v2\n" });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(result.addedNew).toContain("policies/coding.md");
    expect(fs.readFileSync(path.join(project, "policies/coding.md"), "utf8")).toBe("# new in v2\n");
  });

  it("restores a tracked file the project deleted", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-upgrade-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");
    fs.rmSync(path.join(project, "CLAUDE.md"));

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n" });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(result.restoredDeleted).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# v2\n");
  });

  it("leaves a file the new framework version dropped in place, untracked", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n", "policies/old.md": "# retired policy\n" });
    const project = tmpDir("sta-upgrade-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v1\n" });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(result.droppedFromFramework).toContain("policies/old.md");
    expect(fs.existsSync(path.join(project, "policies/old.md"))).toBe(true);
    expect(readInstallManifest(project).files.map((f) => f.path)).not.toContain("policies/old.md");
  });

  it("updates only the AGENTS.md block for a project-owned file and backs up the exact prior bytes", () => {
    const block1 = "<!-- sta:bootstrap -->\n# v1 block\n<!-- /sta:bootstrap -->\nSee CLAUDE.md.\n";
    const block2 = "<!-- sta:bootstrap -->\n# v2 block\n<!-- /sta:bootstrap -->\nSee CLAUDE.md.\n";
    const project = tmpDir("sta-upgrade-project-");
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Project-owned\r\nExact.\r\n", "utf8");
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n", "AGENTS.md": block1 });
    runInit(project, v1, "2026-08-20T09:00:00Z");
    const before = fs.readFileSync(path.join(project, "AGENTS.md"), "utf8");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n", "AGENTS.md": block2 });
    const result = runUpgrade(project, v2, "2026-08-21T09:00:00Z");

    expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")).toBe(
      "<!-- sta:bootstrap -->\n# v2 block\n<!-- /sta:bootstrap -->\n# Project-owned\r\nExact.\r\n",
    );
    expect(fs.readFileSync(path.join(result.backupDir, "AGENTS.md"), "utf8")).toBe(before);
    expect(readInstallManifest(project).files.map((file) => file.path)).not.toContain("AGENTS.md");
  });
});
