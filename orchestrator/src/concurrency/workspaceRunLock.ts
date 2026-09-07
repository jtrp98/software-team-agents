import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspaceRunLockPayload {
  pid: number;
  acquiredAt: number;
  run_id: string;
  target_root: string;
}

interface TaskLockPayload {
  pid: number;
  acquiredAt: number;
}

export interface WorkspaceRunLockOptions {
  now?: () => number;
  processAlive?: (pid: number) => boolean;
  staleAfterMs?: number;
}

export class WorkspaceRunLockedError extends Error {
  constructor(public readonly holder: WorkspaceRunLockPayload) {
    super(
      `working tree "${holder.target_root}" is already held by bounded run ${holder.run_id} ` +
        `(pid ${holder.pid}); two modules still contend on the same working tree`,
    );
    this.name = "WorkspaceRunLockedError";
  }
}

export class ManualTaskLockedError extends Error {
  constructor(public readonly taskId: string, public readonly holderPid: number) {
    super(`bounded run cannot start task ${taskId}: its manual task lock is held by pid ${holderPid}`);
    this.name = "ManualTaskLockedError";
  }
}

const STALE_AFTER_MS = 60 * 60_000;

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function canonicalTargetRoot(targetRoot: string): string {
  return fs.realpathSync.native(path.resolve(targetRoot));
}

function lockDirectory(runtimeStateRoot: string): string {
  return path.join(path.resolve(runtimeStateRoot), ".workflow", "locks");
}

export function workspaceRunLockPath(runtimeStateRoot: string, targetRoot: string): string {
  const canonical = canonicalTargetRoot(targetRoot);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return path.join(lockDirectory(runtimeStateRoot), `run-${digest}.lock`);
}

function taskLockPath(runtimeStateRoot: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(lockDirectory(runtimeStateRoot), `${safe}.lock`);
}

function readPayload<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function held(acquiredAt: number, pid: number, options: WorkspaceRunLockOptions): boolean {
  const now = options.now ?? Date.now;
  const alive = options.processAlive ?? defaultProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  return now() - acquiredAt <= staleAfterMs && alive(pid);
}

function removeIfOwned(file: string, expected: WorkspaceRunLockPayload): void {
  const current = readPayload<WorkspaceRunLockPayload>(file);
  if (current?.pid === expected.pid && current.run_id === expected.run_id && current.target_root === expected.target_root) {
    fs.rmSync(file, { force: true });
  }
}

// Kept structurally parallel to taskLock.ts, without sharing internals: identity and refresh semantics differ.
export function acquireWorkspaceRunLock(
  runtimeStateRoot: string,
  targetRoot: string,
  runId: string,
  options: WorkspaceRunLockOptions = {},
): WorkspaceRunLockPayload {
  const file = workspaceRunLockPath(runtimeStateRoot, targetRoot);
  const now = options.now ?? Date.now;
  const payload: WorkspaceRunLockPayload = {
    pid: process.pid,
    acquiredAt: now(),
    run_id: runId,
    target_root: canonicalTargetRoot(targetRoot),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(payload), "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = readPayload<WorkspaceRunLockPayload>(file);
    if (!existing || !held(existing.acquiredAt, existing.pid, options)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    throw new WorkspaceRunLockedError(existing);
  }
}

export function refreshWorkspaceRunLock(
  runtimeStateRoot: string,
  targetRoot: string,
  runId: string,
  options: WorkspaceRunLockOptions = {},
): WorkspaceRunLockPayload {
  const file = workspaceRunLockPath(runtimeStateRoot, targetRoot);
  const existing = readPayload<WorkspaceRunLockPayload>(file);
  const canonical = canonicalTargetRoot(targetRoot);
  if (!existing || existing.pid !== process.pid || existing.run_id !== runId || existing.target_root !== canonical) {
    throw new Error(`cannot refresh workspace run lock for ${runId}: this process does not hold ${canonical}`);
  }
  const refreshed = { ...existing, acquiredAt: (options.now ?? Date.now)() };
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, JSON.stringify(refreshed), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return refreshed;
}

export function releaseWorkspaceRunLock(runtimeStateRoot: string, targetRoot: string, runId: string): void {
  const expected: WorkspaceRunLockPayload = {
    pid: process.pid,
    acquiredAt: 0,
    run_id: runId,
    target_root: canonicalTargetRoot(targetRoot),
  };
  removeIfOwned(workspaceRunLockPath(runtimeStateRoot, targetRoot), expected);
}

/** Manual task execution calls this before taking its task lock. */
export function assertNoWorkspaceRunLock(
  runtimeStateRoot: string,
  targetRoot: string,
  options: WorkspaceRunLockOptions = {},
): void {
  const file = workspaceRunLockPath(runtimeStateRoot, targetRoot);
  const existing = readPayload<WorkspaceRunLockPayload>(file);
  if (!existing) return;
  if (!held(existing.acquiredAt, existing.pid, options)) {
    fs.rmSync(file, { force: true });
    return;
  }
  throw new WorkspaceRunLockedError(existing);
}

/** A wave run calls this before each task; it never imports taskLock.ts internals. */
export function assertNoManualTaskLock(
  runtimeStateRoot: string,
  taskId: string,
  options: WorkspaceRunLockOptions = {},
): void {
  const file = taskLockPath(runtimeStateRoot, taskId);
  const existing = readPayload<TaskLockPayload>(file);
  if (!existing) return;
  if (!held(existing.acquiredAt, existing.pid, options)) {
    fs.rmSync(file, { force: true });
    return;
  }
  throw new ManualTaskLockedError(taskId, existing.pid);
}

export async function withWorkspaceRunLock<T>(
  runtimeStateRoot: string,
  targetRoot: string,
  runId: string,
  fn: () => Promise<T>,
  options: WorkspaceRunLockOptions = {},
): Promise<T> {
  acquireWorkspaceRunLock(runtimeStateRoot, targetRoot, runId, options);
  try {
    return await fn();
  } finally {
    releaseWorkspaceRunLock(runtimeStateRoot, targetRoot, runId);
  }
}
