import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { runInit } from "./initCommand.js";
import { runUpgrade } from "./upgradeCommand.js";
import { readInstallManifest } from "./installManifest.js";
import { NoBackupToRollbackError, listBackups, rollbackSta } from "./rollback.js";
import { runTargetSync } from "../targetcli/syncEngine.js";
import { defaultTargetConfig, readTargetManifest, writeTargetConfig } from "../targetcli/targetMeta.js";
import { gatherStatus } from "../targetcli/statusCommand.js";

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

  it("T-V5-013: restores a sync file and .agent-team manifest while preserving config overrides", () => {
    const v1 = fixtureTemplatesDir("1.0.0", { "CLAUDE.md": "# v1\n" });
    const v2 = fixtureTemplatesDir("1.1.0", { "CLAUDE.md": "# v2\n" });
    const project = tmpDir("sta-target-rollback-");
    fs.mkdirSync(path.join(project, ".git"));
    runTargetSync({ targetRoot: project, templatesDir: v1, now: "2026-08-20T09:00:00Z" });
    const config = { ...defaultTargetConfig("rollback-target", "2026-08-20T09:00:00Z"), overrides: ["project-owned.md"] };
    writeTargetConfig(project, config);

    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# local pre-sync edit\n", "utf8");
    const beforeManifest = fs.readFileSync(path.join(project, ".agent-team", "manifest.json"), "utf8");
    const beforeStatus = gatherStatus({ targetRoot: project, templatesDir: v2 });
    const synced = runTargetSync({
      targetRoot: project,
      templatesDir: v2,
      manifest: readTargetManifest(project),
      config,
      now: "2026-08-21T09:00:00Z",
      force: true,
    });
    expect(synced.backupDir).toBeTruthy();
    expect(fs.existsSync(path.join(synced.backupDir!, "manifest.json"))).toBe(true);
    expect(listBackups(project)).toEqual([path.basename(synced.backupDir!)]);

    rollbackSta(project);

    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# local pre-sync edit\n");
    expect(fs.readFileSync(path.join(project, ".agent-team", "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(fs.readFileSync(path.join(project, ".agent-team", "config.yaml"), "utf8")).toContain("project-owned.md");
    const afterStatus = gatherStatus({ targetRoot: project, templatesDir: v2 });
    expect({ syncState: afterStatus.syncState, conflictCount: afterStatus.conflictCount }).toEqual({
      syncState: beforeStatus.syncState,
      conflictCount: beforeStatus.conflictCount,
    });
  });

  it("T-V5-013: refuses an old .agent-team snapshot without a manifest before restoring a file", () => {
    const project = tmpDir("sta-target-old-backup-");
    const backup = path.join(project, ".agent-team", "backups", "2026-08-20T09-00-00-000Z");
    writeFiles(backup, { "CLAUDE.md": "# old bytes\n" });
    writeFiles(project, { "CLAUDE.md": "# current bytes\n" });

    expect(() => rollbackSta(project)).toThrow(/has no manifest\.json.*no file was changed/);
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("# current bytes\n");
  });
});
