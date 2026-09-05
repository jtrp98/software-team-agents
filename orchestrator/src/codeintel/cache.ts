import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where indexes live, and how they die.
 *
 * Machine-local, outside every repo — derived data that belongs to a
 * machine, not to a checkout. Consequences that fall out of that placement
 * on purpose:
 *
 *   - Nothing here can be committed or bundled: `npm pack` never sees this
 *     directory because it is not inside any repository.
 *   - No hook has to guard it. Writes happen through this module only; the
 *     Bash-bypass problem documented for repo-local files does not arise.
 *   - Layout checks stay quiet because no new directory appears in any repo.
 *
 * Revisions are separated deliberately: a stale index for an old revision must
 * remain usable evidence of what was true then, and pruning can drop old
 * revisions without touching the one a current task may be using.
 */

/** Escape hatch for tests and machines that must relocate the cache. */
export const CACHE_ROOT_ENV = "STA_CODE_INTEL_CACHE_ROOT";

export function defaultCacheRoot(): string {
  const fromEnv = process.env[CACHE_ROOT_ENV];
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "software-team-agents", "cache", "code-intelligence");
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "software-team-agents", "cache", "code-intelligence");
}

/** One revision's index directory: `<root>/<target-id>/<revision>/`. */
export function revisionDir(cacheRoot: string, targetId: string, revision: string): string {
  // Both components come from registries/commits, but a target id containing
  // ".." would otherwise escape the cache root — cheap to refuse outright.
  if (targetId.includes("/") || targetId.includes("\\") || targetId === "..") {
    throw new Error(`invalid target id for cache path: "${targetId}"`);
  }
  if (revision.includes("/") || revision.includes("\\") || revision === "..") {
    throw new Error(`invalid revision for cache path: "${revision}"`);
  }
  return path.join(cacheRoot, targetId, revision);
}

export function directorySizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

export interface CacheStats {
  bytes: number;
  revisions: Array<{ targetId: string; revision: string; dir: string; modifiedAt: number }>;
}

function listRevisions(cacheRoot: string): CacheStats["revisions"] {
  const out: CacheStats["revisions"] = [];
  let targets: fs.Dirent[];
  try {
    targets = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const target of targets) {
    if (!target.isDirectory()) continue;
    const targetDir = path.join(cacheRoot, target.name);
    let revisions: fs.Dirent[];
    try {
      revisions = fs.readdirSync(targetDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const rev of revisions) {
      if (!rev.isDirectory()) continue;
      const dir = path.join(targetDir, rev.name);
      out.push({ targetId: target.name, revision: rev.name, dir, modifiedAt: fs.statSync(dir).mtimeMs });
    }
  }
  return out.sort((a, b) => a.modifiedAt - b.modifiedAt);
}

export function cacheStats(cacheRoot: string): CacheStats {
  const revisions = listRevisions(cacheRoot);
  return { bytes: revisions.reduce((sum, r) => sum + directorySizeBytes(r.dir), 0), revisions };
}

/**
 * Enforces the size cap by deleting oldest-first. Oldest mtime is a fair proxy
 * for "no recent task needed it"; correctness does not depend on that guess
 * because a missing index simply reads as freshness `missing`, which falls back.
 */
export function pruneCache(cacheRoot: string, opts: { maxTotalBytes?: number; maxAgeDays?: number; now?: number } = {}): { removed: string[] } {
  const removed: string[] = [];
  const now = opts.now ?? Date.now();
  const revisions = listRevisions(cacheRoot);

  if (opts.maxAgeDays !== undefined) {
    const cutoff = now - opts.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const rev of revisions) {
      if (rev.modifiedAt < cutoff && safeRm(rev.dir)) removed.push(rev.dir);
    }
  }

  if (opts.maxTotalBytes !== undefined) {
    const survivors = listRevisions(cacheRoot).filter((r) => !removed.includes(r.dir));
    let total = survivors.reduce((sum, r) => sum + directorySizeBytes(r.dir), 0);
    for (const rev of survivors) {
      if (total <= opts.maxTotalBytes) break;
      // Measure BEFORE deleting — a deleted directory reports zero bytes,
      // which would make the loop think it never freed anything.
      const size = directorySizeBytes(rev.dir);
      if (safeRm(rev.dir)) {
        total -= size;
        removed.push(rev.dir);
      }
    }
  }

  return { removed };
}

/** Removes one revision directory entirely (used by tests and explicit cleanup). */
export function deleteRevision(cacheRoot: string, targetId: string, revision: string): boolean {
  return safeRm(revisionDir(cacheRoot, targetId, revision));
}

function safeRm(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}
