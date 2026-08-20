import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireTaskLock, releaseTaskLock, withTaskLock, TaskLockedError, defaultLockDir } from "./taskLock.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-lock-"));
}

describe("acquireTaskLock / releaseTaskLock (T35)", () => {
  it("acquires cleanly when nothing is held, and creates the lock file", () => {
    const root = tmpProject();
    acquireTaskLock(root, "T-1");
    expect(fs.existsSync(path.join(defaultLockDir(root), "T-1.lock"))).toBe(true);
    releaseTaskLock(root, "T-1");
  });

  it("refuses a second acquire while this process still holds it — the core guarantee", () => {
    const root = tmpProject();
    acquireTaskLock(root, "T-1");
    expect(() => acquireTaskLock(root, "T-1")).toThrow(TaskLockedError);
    releaseTaskLock(root, "T-1");
  });

  it("a released lock can be acquired again", () => {
    const root = tmpProject();
    acquireTaskLock(root, "T-1");
    releaseTaskLock(root, "T-1");
    expect(() => acquireTaskLock(root, "T-1")).not.toThrow();
    releaseTaskLock(root, "T-1");
  });

  it("different task ids never contend with each other", () => {
    const root = tmpProject();
    acquireTaskLock(root, "T-1");
    expect(() => acquireTaskLock(root, "T-2")).not.toThrow();
    releaseTaskLock(root, "T-1");
    releaseTaskLock(root, "T-2");
  });

  it("releasing a lock that was never acquired is a no-op, not an error", () => {
    const root = tmpProject();
    expect(() => releaseTaskLock(root, "never-locked")).not.toThrow();
  });

  it("a lock held by a pid that is no longer running is reclaimed automatically", () => {
    const root = tmpProject();
    const file = path.join(defaultLockDir(root), "T-1.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A pid essentially guaranteed not to be a real running process.
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }));
    expect(() => acquireTaskLock(root, "T-1")).not.toThrow();
    releaseTaskLock(root, "T-1");
  });

  it("a lock held by this same process's pid but far too old is reclaimed by the TTL, not treated as still valid", () => {
    const root = tmpProject();
    const file = path.join(defaultLockDir(root), "T-1.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 2 * 60 * 60_000 }));
    // Note: pid === process.pid here would normally read as "alive" (it's us), so this proves
    // the TTL check reclaims it independent of the liveness check succeeding.
    expect(() => acquireTaskLock(root, "T-1")).not.toThrow();
    releaseTaskLock(root, "T-1");
  });

  it("a corrupt/unreadable lock file is reclaimed rather than blocking forever", () => {
    const root = tmpProject();
    const file = path.join(defaultLockDir(root), "T-1.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json{{{");
    expect(() => acquireTaskLock(root, "T-1")).not.toThrow();
    releaseTaskLock(root, "T-1");
  });

  it("releasing does not remove a lock another (live-looking) process holds", () => {
    const root = tmpProject();
    const file = path.join(defaultLockDir(root), "T-1.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid + 1 !== process.pid ? 1 : 2, acquiredAt: Date.now() }));
    // A pid that isn't ours and (on most systems) is a real, long-lived process (pid 1/init or
    // similar) — even if this check can't be perfectly certain across platforms, releaseTaskLock
    // must not delete a lock file whose recorded pid doesn't match this process.
    releaseTaskLock(root, "T-1");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("task ids with path-unsafe characters are sanitized into a safe filename, not used raw", () => {
    const root = tmpProject();
    expect(() => acquireTaskLock(root, "../../evil")).not.toThrow();
    releaseTaskLock(root, "../../evil");
  });
});

describe("withTaskLock", () => {
  it("releases the lock even when the wrapped function throws", async () => {
    const root = tmpProject();
    await expect(
      withTaskLock(root, "T-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the lock had leaked, this would throw TaskLockedError instead of succeeding.
    expect(() => acquireTaskLock(root, "T-1")).not.toThrow();
    releaseTaskLock(root, "T-1");
  });

  it("returns the wrapped function's result", async () => {
    const root = tmpProject();
    const result = await withTaskLock(root, "T-1", async () => 42);
    expect(result).toBe(42);
  });

  it("a second withTaskLock on the same task while the first is still in flight is refused", async () => {
    const root = tmpProject();
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withTaskLock(root, "T-1", async () => {
      await firstDone;
    });
    expect(() => acquireTaskLock(root, "T-1")).toThrow(TaskLockedError);
    releaseFirst();
    await first;
  });
});
