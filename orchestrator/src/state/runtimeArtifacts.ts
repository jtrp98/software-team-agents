import * as fs from "node:fs";
import * as path from "node:path";

/** Regenerable V3 artifact classes stored below the VCS-ignored runtime-state root. */
export const RUNTIME_ARTIFACT_KINDS = ["packets", "evidence", "runs"] as const;
export type RuntimeArtifactKind = (typeof RUNTIME_ARTIFACT_KINDS)[number];

/**
 * A deliberately small bounded default. Callers may lower or raise it per
 * installation, but unconfigured runs retain at most ten artifacts of each
 * kind per task instead of growing `.workflow/` without bound.
 */
export const DEFAULT_RUNTIME_ARTIFACT_RETENTION = 10;

export interface RuntimeArtifactPaths {
  readonly packets: string;
  readonly evidence: string;
  readonly runs: string;
}

function taskPathSegment(taskId: string): string {
  const trimmed = taskId.trim();
  if (trimmed.length === 0) throw new Error("runtime artifact task id must not be empty");
  if (trimmed === "." || trimmed === "..") throw new Error(`runtime artifact task id "${taskId}" is not safe`);
  // Encoding keeps readable ordinary ids (`T-1`) unchanged while ensuring a
  // slash, backslash or platform-reserved punctuation cannot create a child
  // outside this task's directory.
  return encodeURIComponent(trimmed);
}

/**
 * Resolves all runtime-state homes for one task without creating them. Writers
 * create the selected directory lazily only when an artifact actually exists.
 */
export function runtimeArtifactPaths(projectRoot: string, taskId: string): RuntimeArtifactPaths {
  const workflowRoot = path.resolve(projectRoot, ".workflow");
  const task = taskPathSegment(taskId);
  return {
    packets: path.join(workflowRoot, "packets", task),
    evidence: path.join(workflowRoot, "evidence", task),
    runs: path.join(workflowRoot, "runs", task),
  };
}

export interface PruneRuntimeArtifactsOptions {
  /** One task/kind directory returned by `runtimeArtifactPaths`. */
  readonly taskDirectory: string;
  /** Current run's artifact. It must be a direct child and is always retained. */
  readonly currentArtifact: string;
  /** Maximum artifacts retained for this task and kind, including the current one. */
  readonly maxRunsPerTask?: number;
}

/**
 * Keeps the current artifact plus the newest remaining files by mtime, with a
 * filename tie-break so equal timestamps prune identically on every run.
 * Directories and symlinks are never followed or removed.
 *
 * Returns deleted absolute paths in deterministic filename order.
 */
export function pruneRuntimeArtifacts(options: PruneRuntimeArtifactsOptions): string[] {
  const limit = options.maxRunsPerTask ?? DEFAULT_RUNTIME_ARTIFACT_RETENTION;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runtime artifact retention must be a positive integer, got ${String(limit)}`);
  }

  const taskDirectory = path.resolve(options.taskDirectory);
  const currentArtifact = path.resolve(
    path.isAbsolute(options.currentArtifact) ? options.currentArtifact : path.join(taskDirectory, options.currentArtifact),
  );
  if (path.dirname(currentArtifact) !== taskDirectory) {
    throw new Error(`current runtime artifact must be a direct child of ${taskDirectory}`);
  }
  const currentStat = fs.lstatSync(currentArtifact);
  if (!currentStat.isFile()) throw new Error(`current runtime artifact is not a file: ${currentArtifact}`);

  const files = fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = path.join(taskDirectory, entry.name);
      return { name: entry.name, absolute, mtimeMs: fs.statSync(absolute).mtimeMs };
    });

  const keep = new Set<string>([currentArtifact]);
  const newest = files
    .filter((entry) => entry.absolute !== currentArtifact)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  for (const entry of newest) {
    if (keep.size >= limit) break;
    keep.add(entry.absolute);
  }

  const removed = files
    .filter((entry) => !keep.has(entry.absolute))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of removed) fs.unlinkSync(entry.absolute);
  return removed.map((entry) => entry.absolute);
}
