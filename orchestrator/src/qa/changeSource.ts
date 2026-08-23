import { execFile } from "node:child_process";
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
