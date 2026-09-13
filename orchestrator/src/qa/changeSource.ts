import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The change list a QA round is scoped against: tracked modifications plus
 * untracked-but-not-ignored files, relative to the Target root.
 *
 * Both commands are read-only git inspection (`diff --name-only`,
 * `ls-files --others`) — the same class of read `require-green-before-stop.js`
 * already performs harness-side. This runs in the orchestrator process, never
 * inside an agent, so the no-state-changing-git rule for agents is untouched.
 */
export async function gitChangedFiles(cwd: string): Promise<string[]> {
  const common = { cwd, maxBuffer: 16 * 1024 * 1024 } as const;
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "HEAD"], common),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], common),
  ]);
  return [...tracked.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface QaWorkRoot {
  readonly targetId?: string;
  readonly path: string;
}

export interface QaChangedFilesResult {
  readonly files: string[];
  readonly failedTargets: string[];
}

/**
 * Collects changed files across QA work roots.
 * When multiple targets exist, paths are namespaced by targetId to prevent collisions (R-2).
 * For a single target (solo task), relative paths remain unprefixed so scope and fingerprints
 * stay byte-identical to baseline.
 */
export async function collectQaChangedFiles(
  roots: readonly QaWorkRoot[],
): Promise<QaChangedFilesResult> {
  const isMultiTarget = roots.length > 1;
  const files: string[] = [];
  const failedTargets: string[] = [];

  for (const root of roots) {
    try {
      const changed = await gitChangedFiles(root.path);
      for (const file of changed) {
        const key = isMultiTarget && root.targetId ? `${root.targetId}:${file}` : file;
        files.push(key);
      }
    } catch (error) {
      const targetName = root.targetId ?? root.path;
      failedTargets.push(targetName);
      console.error(
        `[orchestrator] QA changed-file discovery failed for Target "${targetName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    files: [...new Set(files)].sort(),
    failedTargets,
  };
}

/**
 * A verdict binds to the source snapshot, never to an adapter, session, or
 * runtime id. The file list still comes solely from gitChangedFiles above;
 * hashes distinguish a later edit to a file that remains in that list.
 */
export interface ChangeSetFingerprint {
  readonly files: Readonly<Record<string, string>>;
}

export interface ChangeSetVerification {
  readonly legacy: boolean;
  readonly unverifiedFiles: readonly string[];
}

async function contentFingerprint(cwd: string, relativePath: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(cwd, relativePath));
    return createHash("sha256").update(content).digest("hex");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "<deleted>";
    throw error;
  }
}

/** Capture the changed-source state at a QA or security verdict across one or more Targets. */
export async function captureChangeSetFingerprint(
  target: string | readonly QaWorkRoot[],
): Promise<ChangeSetFingerprint> {
  const roots: readonly QaWorkRoot[] = typeof target === "string" ? [{ path: target }] : target;
  const isMultiTarget = roots.length > 1;
  const entries: Array<readonly [string, string]> = [];

  for (const root of roots) {
    const files = [...new Set(await gitChangedFiles(root.path))].sort();
    for (const file of files) {
      const key = isMultiTarget && root.targetId ? `${root.targetId}:${file}` : file;
      const hash = await contentFingerprint(root.path, file);
      entries.push([key, hash] as const);
    }
  }

  return { files: Object.fromEntries(entries) };
}

/**
 * A missing snapshot is a truthful legacy state and preserves today's verdict
 * behaviour. For captured snapshots, only a source change invalidates it;
 * switching camp/runtime without writes leaves the verdict valid.
 */
export async function verifyChangeSetFingerprint(
  target: string | readonly QaWorkRoot[],
  fingerprint: ChangeSetFingerprint | null | undefined,
): Promise<ChangeSetVerification> {
  if (!fingerprint) return { legacy: true, unverifiedFiles: [] };
  const current = await captureChangeSetFingerprint(target);
  const paths = new Set([...Object.keys(fingerprint.files), ...Object.keys(current.files)]);
  return {
    legacy: false,
    unverifiedFiles: [...paths].filter((file) => fingerprint.files[file] !== current.files[file]).sort(),
  };
}

/**
 * Concise evidence for QA: git's file/line stat, never the full diff payload.
 * Callers may combine several writable Targets; each stat remains bounded here.
 */
export async function gitDiffSummary(cwd: string, maxChars = 1_800): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd, maxBuffer: 16 * 1024 * 1024 });
  const text = stdout.trim() || "No tracked changes detected.";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 48)}\n…(diff stat truncated; request specific files if needed)`;
}
