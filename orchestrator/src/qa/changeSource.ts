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

/** Capture the changed-source state at a QA or security verdict. */
export async function captureChangeSetFingerprint(cwd: string): Promise<ChangeSetFingerprint> {
  const files = [...new Set(await gitChangedFiles(cwd))].sort();
  const entries = await Promise.all(files.map(async (file) => [file, await contentFingerprint(cwd, file)] as const));
  return { files: Object.fromEntries(entries) };
}

/**
 * A missing snapshot is a truthful legacy state and preserves today's verdict
 * behaviour. For captured snapshots, only a source change invalidates it;
 * switching camp/runtime without writes leaves the verdict valid.
 */
export async function verifyChangeSetFingerprint(
  cwd: string,
  fingerprint: ChangeSetFingerprint | null | undefined,
): Promise<ChangeSetVerification> {
  if (!fingerprint) return { legacy: true, unverifiedFiles: [] };
  const current = await captureChangeSetFingerprint(cwd);
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
