import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { renameSyncRetrying } from "../concurrency/atomicRename.js";
import type { RuntimeAutonomy, RuntimeUsage } from "../runtime/runtimeAdapter.js";

/**
 * The run tree: one JSON file per run, grouped by the root run it descends from.
 *
 *   <store>/<rootRunId>/<runId>.json
 *
 * A file per run, never a shared index, so two sibling runs (or a nested STA
 * process) never write the same file. Parent/child links live on each record;
 * nothing central infers roles — a run is a controller relative to its
 * children and an executor relative to its parent, and the links say which.
 */

export type RunStatus = "running" | "completed" | "failed" | "needs_approval" | "partial";

/** What a run may do, resolved once at run start and narrowed for every child. */
export interface ResolvedPermissions {
  /** May change files inside `writePaths` of the run's workspace. */
  readonly write: boolean;
  /** Workspace-relative globs the run may write. Empty when `write` is false. */
  readonly writePaths: readonly string[];
  /** May start child runs. */
  readonly delegate: boolean;
  readonly autonomy: RuntimeAutonomy;
}

/** Recursion/resource limits, fixed by the root and only tightened below it. */
export interface ResolvedLimits {
  /** Deepest allowed run; the root is depth 0. */
  readonly maxDepth: number;
  /** Direct children one run may start. */
  readonly maxChildren: number;
  /** Runs the whole tree may contain, root included. */
  readonly maxTotalRuns: number;
  readonly timeoutMs?: number;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  /** Who decided, as the relaying caller reported it. STA does not authenticate this. */
  readonly by: string;
  readonly note?: string;
  readonly at: number;
}

export interface ApprovalState {
  readonly requestId: string;
  /** The declared side effects the run needs approved before it may start. */
  readonly actions: readonly string[];
  readonly reason: string;
  readonly decision: ApprovalDecision | null;
}

export interface RunError {
  readonly code: string;
  readonly message: string;
  readonly runId: string;
  readonly runtime: string;
  readonly task: string;
  readonly parentRunId: string | null;
  /** The runtime's own output/diagnostics, truncated. */
  readonly detail?: string;
  readonly exitCode?: number | null;
  /** The deepest failed descendant, when this run's failure followed one. */
  readonly cause?: RunError;
}

export interface RunRecord {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly rootRunId: string;
  readonly depth: number;
  readonly runtime: string;
  readonly role?: string;
  readonly task: string;
  readonly context?: string;
  readonly workspace: string;
  readonly permissions: ResolvedPermissions;
  readonly limits: ResolvedLimits;
  readonly actions: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  status: RunStatus;
  attempts: number;
  approval: ApprovalState | null;
  /** Run id of the descendant whose pending approval holds this run, when it is not this run's own. */
  blockedOn: string | null;
  output?: string;
  remainingWork?: string;
  error?: RunError;
  usage?: RuntimeUsage;
  diagnostics?: readonly string[];
  readonly createdAt: number;
  updatedAt: number;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`no run "${runId}" in this run store`);
    this.name = "RunNotFoundError";
  }
}

const RUN_ID = /^run-[a-z0-9-]+$/;

export function newRunId(now: number = Date.now()): string {
  return `run-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class RunStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  private file(rootRunId: string, runId: string): string {
    if (!RUN_ID.test(rootRunId) || !RUN_ID.test(runId)) throw new Error(`malformed run id "${runId}" (root "${rootRunId}")`);
    return path.join(this.dir, rootRunId, `${runId}.json`);
  }

  /**
   * Records a new run. Exclusive create, so an id can never be claimed twice;
   * the caller counts the tree *after* this and releases the record when a
   * limit is exceeded — a conservative check that two racing siblings cannot
   * both slip past.
   */
  create(record: RunRecord): void {
    const file = this.file(record.rootRunId, record.runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
  }

  save(record: RunRecord): void {
    const file = this.file(record.rootRunId, record.runId);
    const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
    renameSyncRetrying(temp, file);
  }

  /** Removes a record that never started (a limit refused it). */
  release(record: RunRecord): void {
    fs.rmSync(this.file(record.rootRunId, record.runId), { force: true });
  }

  load(runId: string): RunRecord | null {
    if (!RUN_ID.test(runId) || !fs.existsSync(this.dir)) return null;
    for (const root of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, root, `${runId}.json`);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
    }
    return null;
  }

  get(runId: string): RunRecord {
    const found = this.load(runId);
    if (!found) throw new RunNotFoundError(runId);
    return found;
  }

  /** Every run in one tree, oldest first. */
  tree(rootRunId: string): RunRecord[] {
    const dir = path.join(this.dir, rootRunId);
    if (!RUN_ID.test(rootRunId) || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RunRecord)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  children(run: RunRecord): RunRecord[] {
    return this.tree(run.rootRunId).filter((r) => r.parentRunId === run.runId);
  }

  descendants(run: RunRecord): RunRecord[] {
    const all = this.tree(run.rootRunId);
    const out: RunRecord[] = [];
    const frontier = [run.runId];
    while (frontier.length > 0) {
      const parent = frontier.shift()!;
      for (const r of all) {
        if (r.parentRunId === parent) {
          out.push(r);
          frontier.push(r.runId);
        }
      }
    }
    return out;
  }
}
