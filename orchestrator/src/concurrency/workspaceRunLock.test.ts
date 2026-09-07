import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTaskLock, releaseTaskLock } from "./taskLock.js";
import {
  acquireWorkspaceRunLock,
  assertNoManualTaskLock,
  assertNoWorkspaceRunLock,
  refreshWorkspaceRunLock,
  releaseWorkspaceRunLock,
  withWorkspaceRunLock,
  workspaceRunLockPath,
  WorkspaceRunLockedError,
} from "./workspaceRunLock.js";

const roots: string[] = [];
function tempRoot(prefix = "sta-workspace-lock-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace run lock", () => {
  it("hashes the canonical Target root into a Windows-safe name and records useful identity", () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    const payload = acquireWorkspaceRunLock(runtime, target, "run-1");
    expect(path.basename(workspaceRunLockPath(runtime, target))).toMatch(/^run-[a-f0-9]{16}\.lock$/);
    const canonical = fs.realpathSync.native(target);
    expect(payload).toEqual({ pid: process.pid, acquiredAt: expect.any(Number), run_id: "run-1", target_root: canonical });
    releaseWorkspaceRunLock(runtime, target, "run-1");
  });

  it("refuses a second run on the same working tree, even for a different module", () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    acquireWorkspaceRunLock(runtime, target, "module-a-run");
    expect(() => acquireWorkspaceRunLock(runtime, target, "module-b-run")).toThrow(WorkspaceRunLockedError);
    expect(() => acquireWorkspaceRunLock(runtime, target, "module-b-run")).toThrow(/working tree.*module-a-run.*pid/i);
    releaseWorkspaceRunLock(runtime, target, "module-a-run");
  });

  it("allows runs on different Target roots", () => {
    const runtime = tempRoot();
    const first = tempRoot("sta-target-a-");
    const second = tempRoot("sta-target-b-");
    expect(() => acquireWorkspaceRunLock(runtime, first, "run-a")).not.toThrow();
    expect(() => acquireWorkspaceRunLock(runtime, second, "run-b")).not.toThrow();
    releaseWorkspaceRunLock(runtime, first, "run-a");
    releaseWorkspaceRunLock(runtime, second, "run-b");
  });

  it("refuses both directions against the manual task lock", () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    acquireWorkspaceRunLock(runtime, target, "wave-run");
    expect(() => assertNoWorkspaceRunLock(runtime, target)).toThrow(/wave-run/);
    releaseWorkspaceRunLock(runtime, target, "wave-run");

    acquireTaskLock(runtime, "BE-1");
    expect(() => assertNoManualTaskLock(runtime, "BE-1")).toThrow(/manual task lock.*pid/i);
    releaseTaskLock(runtime, "BE-1");
  });

  it("reclaims a dead-pid lock but never a live one", () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    const file = workspaceRunLockPath(runtime, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const canonical = fs.realpathSync.native(target);
    const target_root = canonical;
    fs.writeFileSync(file, JSON.stringify({ pid: 999, acquiredAt: 10, run_id: "dead", target_root }));
    expect(() => acquireWorkspaceRunLock(runtime, target, "new", { now: () => 11, processAlive: () => false })).not.toThrow();
    releaseWorkspaceRunLock(runtime, target, "new");

    fs.writeFileSync(file, JSON.stringify({ pid: 999, acquiredAt: 10, run_id: "live", target_root }));
    expect(() => acquireWorkspaceRunLock(runtime, target, "new", { now: () => 11, processAlive: () => true })).toThrow(/live/);
  });

  it("refreshes between tasks so a run outliving the shortened TTL remains held", () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    let now = 0;
    const options = { now: () => now, processAlive: () => true, staleAfterMs: 10 };
    acquireWorkspaceRunLock(runtime, target, "long-run", options);
    now = 100;
    expect(refreshWorkspaceRunLock(runtime, target, "long-run", options).acquiredAt).toBe(100);
    now = 105;
    expect(() => assertNoWorkspaceRunLock(runtime, target, options)).toThrow(/long-run/);
    releaseWorkspaceRunLock(runtime, target, "long-run");
  });

  it("releases in finally on the throwing path", async () => {
    const runtime = tempRoot();
    const target = tempRoot("sta-target-");
    await expect(withWorkspaceRunLock(runtime, target, "throwing", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(() => acquireWorkspaceRunLock(runtime, target, "after")).not.toThrow();
    releaseWorkspaceRunLock(runtime, target, "after");
  });
});
