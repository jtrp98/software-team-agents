import * as fs from "node:fs";
import * as path from "node:path";

/**
 * T97 — undoes the most recent `sta upgrade`/`migrate` (T95/T96), paired 1:1
 * with them: neither ever runs without this being able to reverse it.
 *
 * Every backup directory upgrade/migrate creates holds exactly two kinds of
 * thing: the previous content of every file it overwrote (at the same
 * relative path) and a copy of `.sta/manifest.json` as it stood before that
 * run. Rollback restores both — files first, then the manifest pointer
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

function backupsDir(projectRoot: string): string {
  return path.join(projectRoot, ".sta", "backups");
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
  const backups = listBackups(projectRoot);
  const target = backupName ?? backups[backups.length - 1];
  if (!target) {
    throw new NoBackupToRollbackError(`${backupsDir(projectRoot)} has no snapshot to roll back to`);
  }
  const dir = path.join(backupsDir(projectRoot), target);
  if (!fs.existsSync(dir)) {
    throw new NoBackupToRollbackError(`backup "${target}" does not exist under ${backupsDir(projectRoot)}`);
  }

  const allFiles: string[] = [];
  walkFiles(dir, "", allFiles);
  const restoredFiles: string[] = [];

  for (const relPath of allFiles) {
    if (relPath === "manifest.json") continue; // restored separately, below, into .sta/ rather than project root
    const src = path.join(dir, relPath);
    const dest = path.join(projectRoot, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restoredFiles.push(relPath);
  }

  const manifestBackup = path.join(dir, "manifest.json");
  if (fs.existsSync(manifestBackup)) {
    const manifestDest = path.join(projectRoot, ".sta", "manifest.json");
    fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
    fs.copyFileSync(manifestBackup, manifestDest);
  }

  return { restoredFiles, fromBackup: target };
}
