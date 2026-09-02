import * as fs from "node:fs";
import * as path from "node:path";
import { checkTargetManifest } from "../targetcli/targetMeta.js";

/**
 * T97 + T-V5-013 — undoes the most recent live `.agent-team` sync snapshot,
 * with a `.sta` fallback for legacy upgrade/migrate snapshots.
 *
 * Every backup directory upgrade/migrate creates holds exactly two kinds of
 * thing: the previous content of every file it overwrote (at the same
 * relative path) and a copy of the lifecycle manifest as it stood before that
 * run. Rollback validates the snapshot, then restores both — files first, then the manifest pointer
 * (including `framework_version` and `schema_version`) — and touches nothing
 * else. `knowledge/`, `_docs/`, `decisions/`, `.workflow/` are never part of
 * a backup snapshot in the first place (upgrade/migrate never write to
 * them), so rollback structurally cannot reach them.
 */
export interface RollbackResult {
  restoredFiles: string[];
  fromBackup: string;
}

export class NoBackupToRollbackError extends Error {}

type BackupLayout = "agent-team" | "sta";

function backupLayout(projectRoot: string): BackupLayout {
  return fs.existsSync(path.join(projectRoot, ".agent-team", "backups")) ? "agent-team" : "sta";
}

function backupsDir(projectRoot: string, layout = backupLayout(projectRoot)): string {
  return path.join(projectRoot, layout === "agent-team" ? ".agent-team" : ".sta", "backups");
}

/** Every backup snapshot's directory name, oldest first — names are timestamp-derived so lexical sort is chronological. */
export function listBackups(projectRoot: string): string[] {
  const dir = backupsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();
}

function walkFiles(dir: string, relDir: string, out: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walkFiles(abs, rel, out);
    else out.push(rel);
  }
}

/**
 * Restores `projectRoot` to the state a backup snapshot recorded. Defaults
 * to the most recent snapshot; pass `backupName` (one of `listBackups`'s
 * results) to target an older one explicitly.
 */
export function rollbackSta(projectRoot: string, backupName?: string): RollbackResult {
  const layout = backupLayout(projectRoot);
  const backups = listBackups(projectRoot);
  const target = backupName ?? backups[backups.length - 1];
  if (!target) {
    throw new NoBackupToRollbackError(`${backupsDir(projectRoot)} has no snapshot to roll back to`);
  }
  const dir = path.join(backupsDir(projectRoot, layout), target);
  if (!fs.existsSync(dir)) {
    throw new NoBackupToRollbackError(`backup "${target}" does not exist under ${backupsDir(projectRoot)}`);
  }

  const manifestBackup = path.join(dir, "manifest.json");
  if (layout === "agent-team") {
    if (!fs.existsSync(manifestBackup)) {
      throw new NoBackupToRollbackError(
        `backup "${target}" predates restorable .agent-team snapshots and has no manifest.json — no file was changed`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestBackup, "utf8"));
    } catch (error) {
      throw new NoBackupToRollbackError(`backup "${target}" manifest.json is unreadable: ${error instanceof Error ? error.message : String(error)} — no file was changed`);
    }
    const problems = checkTargetManifest(parsed);
    if (problems.length > 0) {
      throw new NoBackupToRollbackError(`backup "${target}" manifest.json is invalid: ${problems.join("; ")} — no file was changed`);
    }
  }

  const allFiles: string[] = [];
  walkFiles(dir, "", allFiles);
  const restoredFiles: string[] = [];

  for (const relPath of allFiles) {
    if (relPath === "manifest.json") continue; // restored separately into the selected lifecycle metadata root
    const src = path.join(dir, relPath);
    const dest = path.join(projectRoot, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restoredFiles.push(relPath);
  }

  if (fs.existsSync(manifestBackup)) {
    const manifestDest = path.join(projectRoot, layout === "agent-team" ? ".agent-team" : ".sta", "manifest.json");
    fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
    fs.copyFileSync(manifestBackup, manifestDest);
  }

  return { restoredFiles, fromBackup: target };
}
