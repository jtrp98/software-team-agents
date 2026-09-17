import * as fs from "node:fs";
import * as path from "node:path";
import { loadTargetConfig, readTargetManifest, isUserOverridden, isTargetInitialized, type TargetConfig } from "./targetMeta.js";
import { GITIGNORE_PATH, GITIGNORE_BLOCK_OPEN, inspectGitignoreBlock } from "./knowledgeRender.js";

/**
 * Payload cleanup for a workspace the framework no longer manages (V10
 * TASK-029): V10 stopped needing payload in a Target, so a checkout that used
 * to be synced can shed it — into a backup snapshot, never into the void.
 *
 * The plan is deliberately narrow: exactly the files the workspace's manifest
 * tracks, plus the managed `.gitignore` block (marker-identified). Anything
 * the manifest does not name — the user's own code, and a payload file the
 * user claimed via `overrides` — is left untouched and reported. The manifest
 * itself is removed last, so `cleanup` is the exact inverse of `sync` and a
 * backup snapshot rolls back with the ordinary `sta rollback`/
 * `list-backups` pair: same directory, same two kinds of content (previous
 * bytes at relative paths, plus the manifest copy).
 *
 * Removing files from the working tree does not untrack them: files a user
 * already committed stay in git history, and the completion report says so
 * plainly rather than implying ignore equals removal.
 */

export interface CleanupPlanEntry {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  /** `move` = goes to backup and off the tree; `keep-override` = user claimed it; `absent` = already gone. */
  readonly action: "move" | "keep-override" | "absent";
}

export interface CleanupPlan {
  readonly targetRoot: string;
  readonly entries: readonly CleanupPlanEntry[];
  /** The managed `.gitignore` block exists and will be stripped on apply. */
  readonly gitignoreBlock: boolean;
  /** `.gitignore` is user-claimed, so its managed block (if any) is left alone. */
  readonly gitignoreClaimed: boolean;
}

export class CleanupUnmanagedWorkspaceError extends Error {}

/** Pure: reads manifest, config and `.gitignore`; writes nothing. */
export function planCleanup(options: { targetRoot: string }): CleanupPlan {
  const config = loadTargetConfig(options.targetRoot);
  if (!isTargetInitialized(options.targetRoot)) {
    throw new CleanupUnmanagedWorkspaceError(
      `${options.targetRoot} has no Framework payload manifest — nothing to clean up (a workspace is managed only after \`software-team-agents init\` ran there)`,
    );
  }
  const manifest = readTargetManifest(options.targetRoot);
  const entries: CleanupPlanEntry[] = manifest.files.map((file) => {
    const relPath = file.path.replaceAll("\\", "/");
    if (isUserOverridden(options.targetRoot, relPath, config)) return { path: relPath, action: "keep-override" as const };
    if (!fs.existsSync(path.join(options.targetRoot, relPath))) return { path: relPath, action: "absent" as const };
    return { path: relPath, action: "move" as const };
  });
  const gitignoreClaimed = isUserOverridden(options.targetRoot, GITIGNORE_PATH, config);
  const gitignoreContent = readIfExists(path.join(options.targetRoot, GITIGNORE_PATH));
  const gitignoreBlock = !gitignoreClaimed && gitignoreContent !== undefined && inspectGitignoreBlock(gitignoreContent).state === "valid";
  return { targetRoot: options.targetRoot, entries, gitignoreBlock, gitignoreClaimed };
}

function readIfExists(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

export interface CleanupResult {
  readonly moved: string[];
  readonly keptOverrides: string[];
  readonly absent: string[];
  readonly gitignoreStripped: boolean;
  readonly gitignoreClaimed: boolean;
  readonly backupDir: string;
  readonly manifestRemoved: boolean;
}

/**
 * Applies a plan: backs up, then moves. The backup is a normal
 * `.agent-team/backups/<timestamp>-cleanup/` snapshot — previous bytes at
 * relative paths plus `manifest.json` — so `sta list-backups`/
 * `sta rollback --project-root <root>` undo it like any sync snapshot.
 */
export function applyCleanup(plan: CleanupPlan, now: string): CleanupResult {
  const backupDir = path.join(plan.targetRoot, ".agent-team", "backups", `${now.replace(/[:.]/g, "-")}-cleanup`);
  fs.mkdirSync(backupDir, { recursive: true });

  const moved: string[] = [];
  const keptOverrides: string[] = [];
  const absent: string[] = [];
  for (const entry of plan.entries) {
    if (entry.action === "keep-override") {
      keptOverrides.push(entry.path);
      continue;
    }
    if (entry.action === "absent") {
      absent.push(entry.path);
      continue;
    }
    const absPath = path.join(plan.targetRoot, entry.path);
    const backupPath = path.join(backupDir, entry.path);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(absPath, backupPath);
    fs.rmSync(absPath);
    pruneEmptyDirs(plan.targetRoot, path.dirname(absPath));
    moved.push(entry.path);
  }

  let gitignoreStripped = false;
  if (plan.gitignoreBlock) {
    const gitignorePath = path.join(plan.targetRoot, GITIGNORE_PATH);
    const content = fs.readFileSync(gitignorePath, "utf8");
    const inspection = inspectGitignoreBlock(content);
    if (inspection.state === "valid") {
      const backupPath = path.join(backupDir, GITIGNORE_PATH);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(gitignorePath, backupPath);
      fs.writeFileSync(gitignorePath, inspection.outside, "utf8");
      gitignoreStripped = true;
    }
  }

  // The manifest is removed only after every move succeeded, and its copy is
  // already in the snapshot, so a rollback restores a managed workspace whole.
  const manifestPath = path.join(plan.targetRoot, ".agent-team", "manifest.json");
  const manifestRemoved = fs.existsSync(manifestPath);
  if (manifestRemoved) fs.copyFileSync(manifestPath, path.join(backupDir, "manifest.json"));
  if (manifestRemoved) fs.rmSync(manifestPath);

  return { moved, keptOverrides, absent, gitignoreStripped, gitignoreClaimed: plan.gitignoreClaimed, backupDir, manifestRemoved };
}

/** Removes directories the cleanup left empty, stopping at the workspace root and at `.agent-team` (config/backups live there). */
function pruneEmptyDirs(targetRoot: string, dir: string): void {
  const root = path.resolve(targetRoot);
  let current = path.resolve(dir);
  while (current.startsWith(root) && current !== root && path.basename(current) !== ".agent-team") {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

export interface CleanupRender {
  readonly lines: readonly string[];
  readonly movedCount: number;
}

/** The plan text both `--dry-run` and the no-flag confirmation print — identical bytes, different verdict line. */
export function renderCleanupPlan(plan: CleanupPlan): CleanupRender {
  const moves = plan.entries.filter((e) => e.action === "move");
  const kept = plan.entries.filter((e) => e.action === "keep-override");
  const absent = plan.entries.filter((e) => e.action === "absent");
  const lines: string[] = [];
  for (const entry of moves) lines.push(`  move     ${entry.path}`);
  for (const entry of kept) lines.push(`  keep     ${entry.path} (user override — untouched)`);
  for (const entry of absent) lines.push(`  absent   ${entry.path} (already gone)`);
  if (plan.gitignoreBlock) lines.push(`  strip    ${GITIGNORE_PATH} managed block (${GITIGNORE_BLOCK_OPEN} …)`);
  else if (plan.gitignoreClaimed) lines.push(`  keep     ${GITIGNORE_PATH} (user override — managed block left alone)`);
  return { lines, movedCount: moves.length };
}

/** Shared completion report. The git-history sentence is the point of the whole command: ignore is not untrack. */
export function reportCleanupResult(result: CleanupResult, config: TargetConfig | undefined): void {
  console.log(`[software-team-agents] cleanup moved ${result.moved.length} file(s) into ${result.backupDir}`);
  if (result.keptOverrides.length > 0) console.log(`[software-team-agents]   kept (user overrides): ${result.keptOverrides.join(", ")}`);
  if (result.absent.length > 0) console.log(`[software-team-agents]   already absent: ${result.absent.length} manifest path(s)`);
  console.log(`[software-team-agents]   managed .gitignore block: ${result.gitignoreStripped ? "stripped" : result.gitignoreClaimed ? "kept (.gitignore is user-claimed)" : "none present"}`);
  console.log(`[software-team-agents]   manifest removed: ${result.manifestRemoved ? "yes" : "no"}`);
  console.log(
    "[software-team-agents]   rollback: `sta list-backups --project-root <root>` then `sta rollback --project-root <root>` restore this snapshot.",
  );
  console.log(
    "[software-team-agents]   NOTE: files already committed remain in git history — removing them here does not untrack them " +
      "(`git rm -r --cached <path>` and a commit do that). Overrides in .agent-team/config.yaml" +
      (config?.overrides.length ? ` (${config.overrides.join(", ")})` : "") +
      " were left untouched.",
  );
}
