import * as fs from "node:fs";
import * as path from "node:path";

/**
 * File-level lock so two `orchestrate` processes never step the same task at once (T35).
 *
 * `--list`'s own printed note has said since T10/T11 that "the orchestrator still runs one task
 * at a time — concurrent execution needs file locking" — this is that lock. The problem it
 * prevents is concrete: two processes both holding the same task open would each spawn
 * `claude -p --agent <role>` for whatever stage they think is current, and both would write the
 * same `_docs/module/<name>/*.md` and app-code files at once. A per-task lock, held for exactly
 * the duration of one CLI invocation's step loop, is what makes that impossible without needing
 * per-file locks keyed off every contract's write globs (a much larger, separate design).
 *
 * NOT a general file lock — it locks a *task id*, not the files that task's stage happens to
 * write. Two DIFFERENT tasks that touch overlapping files (e.g. two phases of the same module)
 * are not covered; that risk already exists today and is unchanged by this.
 */

export class TaskLockedError extends Error {
  constructor(public readonly taskId: string, public readonly holderPid: number) {
    super(
      `task ${taskId} is already being worked on by another orchestrator process (pid ${holderPid}) — ` +
        "wait for it to finish, or remove the lock file yourself if you are certain that process is gone",
    );
    this.name = "TaskLockedError";
  }
}

interface LockPayload {
  pid: number;
  acquiredAt: number;
}

/** Lock files older than this are treated as abandoned even if the PID liveness check can't tell — a stage that legitimately runs this long is not realistic (claudeCliExecutor's own default timeout is 30 minutes). */
const STALE_AFTER_MS = 60 * 60_000;

export function defaultLockDir(projectRoot: string): string {
  return path.join(projectRoot, ".workflow", "locks");
}

function lockFilePath(projectRoot: string, taskId: string): string {
  // Task ids are user-supplied; sanitize to a safe filename rather than trusting one straight
  // into a path (policies/security.md §5a's "every write resolves under the project root" spirit extends
  // to this file too, even though it lives under .workflow/ rather than being agent-written).
  const safe = taskId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(defaultLockDir(projectRoot), `${safe}.lock`);
}

/** True if a process with this pid appears to still be running. Unknown (can't tell) reports true — see acquire()'s TTL fallback for what actually reclaims a lock a liveness check can't. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process, definitely gone. Anything else (e.g. EPERM, or a
    // platform quirk) is treated as "can't tell" rather than "gone" — the TTL
    // check below is what reclaims a lock this can't resolve.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(file: string): LockPayload | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // unreadable/corrupt lock file — treat as no useful info, not as held
  }
}

/**
 * Acquires the lock or throws `TaskLockedError`. A stale lock (holder process no longer alive,
 * or simply too old to trust the liveness check) is reclaimed automatically rather than
 * requiring a person to delete a file by hand — the failure mode this exists to prevent is two
 * *live* processes stepping the same task, not an orchestrator run that never got a chance to
 * clean up after a crash.
 */
export function acquireTaskLock(projectRoot: string, taskId: string, now: () => number = Date.now): void {
  const file = lockFilePath(projectRoot, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (;;) {
    try {
      const fd = fs.openSync(file, "wx"); // exclusive create — fails if the file already exists
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now() } satisfies LockPayload));
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    const existing = readLock(file);
    if (!existing) {
      // Corrupt/unreadable lock file — cannot tell who (if anyone) holds it. Reclaim it: an
      // unreadable lock is not evidence of a live process, and refusing forever on a file this
      // guard itself cannot make sense of is worse than the (already narrow) race of reclaiming it.
      fs.rmSync(file, { force: true });
      continue;
    }
    const age = now() - existing.acquiredAt;
    if (age > STALE_AFTER_MS || !isAlive(existing.pid)) {
      fs.rmSync(file, { force: true }); // reclaim: stale or the holder is gone
      continue;
    }
    throw new TaskLockedError(taskId, existing.pid);
  }
}

/** Releases the lock — a no-op if this process doesn't actually hold it, so a double-release (or releasing after someone else already reclaimed a stale lock) never throws. */
export function releaseTaskLock(projectRoot: string, taskId: string): void {
  const file = lockFilePath(projectRoot, taskId);
  const existing = readLock(file);
  if (existing && existing.pid !== process.pid) return; // not ours to release
  fs.rmSync(file, { force: true });
}

/** Acquires, runs `fn`, always releases — even if `fn` throws. */
export async function withTaskLock<T>(projectRoot: string, taskId: string, fn: () => Promise<T>): Promise<T> {
  acquireTaskLock(projectRoot, taskId);
  try {
    return await fn();
  } finally {
    releaseTaskLock(projectRoot, taskId);
  }
}
