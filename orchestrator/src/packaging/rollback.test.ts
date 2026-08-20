import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { runInit } from "./initCommand.js";
import { runUpgrade } from "./upgradeCommand.js";
import { readInstallManifest } from "./installManifest.js";
import { NoBackupToRollbackError, listBackups, rollbackSta } from "./rollback.js";

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

function fixtureTemplatesDir(version: string, files: Record<string, string>): string {
  const source = tmpDir("sta-rollback-source-");
  writeFiles(source, { ...files, "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version }) });
  const templatesDir = path.join(source, "templates");
  buildTemplates(source, templatesDir, "2026-08-20T09:00:00Z");
  return templatesDir;
}

describe("listBackups", () => {
  it("is empty for a project that never upgraded", () => {
    const project = tmpDir("sta-rollback-project-");
    expect(listBackups(project)).toEqual([]);
  });
});

describe("rollbackSta", () => {
  it("throws NoBackupToRollbackError when there is nothing to roll back to", () => {
    const project = tmpDir("sta-rollback-project-");
    expect(() => rollbackSta(project)).toThrow(NoBackupToRollbackError);
  });

  it("undoes the most recent upgrade — files and framework_version alike", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n", "layout.yaml": "version: 1\n" });
    const project = tmpDir("sta-rollback-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n", "layout.yaml": "version: 1\n" });
    runUpgrade(project, v2, "2026-08-21T09:00:00Z");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# v2\n");
    expect(readInstallManifest(project).framework_version).toBe("0.2.0");

    const result = rollbackSta(project);

    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# v1\n");
    expect(readInstallManifest(project).framework_version).toBe("0.1.0");
    expect(result.restoredFiles).toContain("CLAUDE.md");
  });

  it("never restores anything under knowledge/, _docs/, decisions/, or .workflow/", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-rollback-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");
    writeFiles(project, {
      "_docs/module/sales/requirement.md": "# real project work\n",
      "knowledge/sales/requirement/REQ-001.yaml": "id: REQ-001\n",
    });

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n" });
    runUpgrade(project, v2, "2026-08-21T09:00:00Z");
    rollbackSta(project);

    expect(fs.readFileSync(path.join(project, "_docs/module/sales/requirement.md"), "utf8")).toBe(
      "# real project work\n",
    );
    expect(fs.existsSync(path.join(project, "knowledge/sales/requirement/REQ-001.yaml"))).toBe(true);
  });

  it("rolls back to an explicitly named earlier snapshot, not just the latest", () => {
    const v1 = fixtureTemplatesDir("0.1.0", { "CLAUDE.md": "# v1\n" });
    const project = tmpDir("sta-rollback-project-");
    runInit(project, v1, "2026-08-20T09:00:00Z");

    const v2 = fixtureTemplatesDir("0.2.0", { "CLAUDE.md": "# v2\n" });
    runUpgrade(project, v2, "2026-08-21T09:00:00Z");
    const [firstBackup] = listBackups(project);

    const v3 = fixtureTemplatesDir("0.3.0", { "CLAUDE.md": "# v3\n" });
    runUpgrade(project, v3, "2026-08-22T09:00:00Z");
    expect(listBackups(project)).toHaveLength(2);

    rollbackSta(project, firstBackup);
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# v1\n");
    expect(readInstallManifest(project).framework_version).toBe("0.1.0");
  });
});
