import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureChangeSetFingerprint } from "../qa/changeSource.js";
import {
  deterministicAttemptId,
  ExecutorPortRefusalError,
  type ExecutorAttemptRef,
  type ExecutorCancelOutcome,
  type ExecutorEvidence,
  type PreparedExecutorAttempt,
} from "./executorPort.js";
import type { RuntimeAgentRequest, RuntimeAgentResult } from "./runtimeAdapter.js";

/**
 * V13 TASK-014 — the lifecycle every headless adapter here actually has.
 *
 * All four runtimes this framework drives (Claude Code, Codex, Antigravity,
 * OpenCode) run one synchronous spawn per attempt: `executeAgent` blocks until
 * the child exits and parses its output from the returned buffers. That single
 * fact decides what each `ExecutorPort` operation can honestly mean, and this
 * module implements exactly that — once, instead of four divergent copies:
 *
 *   prepare        mint the attempt's deterministic id and persist the whole
 *                  request to an adapter-owned journal. A record that already
 *                  finished or was cancelled is kept, never clobbered — the
 *                  same packet re-prepared after a restart is the same attempt.
 *   execute        run the prepared attempt once. Running an already-finished
 *                  attempt again would duplicate its side effects, so it
 *                  returns the stored result instead (idempotent). A cancelled
 *                  attempt refuses. On the way through, the work roots are
 *                  snapshotted before and after the spawn, so the evidence
 *                  records what the run changed — computed from the filesystem
 *                  and git, never read off the agent's report.
 *   resume         a finished attempt returns its stored result. A prepared
 *                  attempt that never finished — the owning process crashed
 *                  between spawn and collection — re-runs the persisted packet
 *                  in a fresh session, which is the recovery semantics this
 *                  invocation surface supports; there is no native mid-attempt
 *                  restore to resume into, and the evidence says so. A
 *                  cancelled attempt refuses. An unknown reference refuses.
 *   cancel         a finished or cancelled attempt answers `already-finished`.
 *                  A prepared attempt is marked cancelled — so `execute` and
 *                  `resume` refuse under this id from then on — and answers
 *                  `already-finished` ("never running") with the one honest
 *                  caveat in its detail: a spawn already in flight inside
 *                  another process cannot be stopped by this surface, and its
 *                  late result is discarded by the cancelling STA, which is
 *                  what makes the mark real. An unknown reference answers
 *                  `refused` — there is nothing known to stop.
 *   collectResult  the stored result envelope for a finished attempt; null for
 *                  one that never produced one. Unknown references refuse.
 *   collectEvidence the normalized evidence record: result, exit status, log
 *                  references, native session reference, changed files. An
 *                  unfinished attempt still yields its record — that record is
 *                  what recovery reads.
 *
 * THE JOURNAL IS THE DURABILITY BOUNDARY. It lives in the OS temp dir under
 * the runtime's own subdirectory — adapter-owned, outside every guarded
 * workspace root, the same posture as the Codex adapter's scratch files. It is
 * written by the single process that owns the attempt and is not concurrent-
 * safe by design; cross-process races (a cancel landing while the owning
 * process finalizes) resolve last-writer-wins, and STA's own state engine —
 * not this journal — remains the authority on whether an attempt's result is
 * accepted.
 */

const JOURNAL_VERSION = 1;

type AttemptState = "prepared" | "finished" | "cancelled";

/** One snapshot root — the shape `captureChangeSetFingerprint` takes (targetId namespaces keys across roots). */
type SnapshotRoot = { targetId?: string; path: string };

interface AttemptRecovery {
  readonly recovered_at: number;
  readonly basis: string;
}

interface AttemptJournal {
  readonly journal_version: number;
  readonly runtime_id: string;
  readonly attempt_id: string;
  readonly task_id?: string;
  readonly stage?: string;
  readonly role: string;
  readonly cwd: string;
  state: AttemptState;
  readonly request: RuntimeAgentRequest;
  readonly prepared_at: number;
  updated_at: number;
  result: RuntimeAgentResult | null;
  session_ref?: string;
  changed_files?: readonly string[];
  readonly logs: string[];
  recoveries: AttemptRecovery[];
}

export interface SingleShotLifecycleOptions {
  /** The adapter's own single-shot run — the one spawn-and-parse implementation every lifecycle operation reuses. */
  readonly run: (req: RuntimeAgentRequest) => Promise<RuntimeAgentResult>;
  /**
   * Lifts the runtime's native session identifier out of a finished result —
   * `session_id`, `conversation_id`, the NDJSON `sessionID`, whatever the
   * runtime actually echoes back. Returning undefined is the honest answer for
   * a runtime whose envelope carries no session reference; one is never invented.
   */
  readonly sessionRefFrom?: (result: RuntimeAgentResult) => string | undefined;
  /** Directory the journal persists under. Defaults to a per-runtime subdirectory of the OS temp dir; tests inject an isolated root. */
  readonly journalRoot?: string;
}

export class SingleShotLifecycle {
  private readonly run: (req: RuntimeAgentRequest) => Promise<RuntimeAgentResult>;
  private readonly sessionRefFrom?: (result: RuntimeAgentResult) => string | undefined;
  private readonly journalDir: string;

  constructor(readonly runtimeId: string, options: SingleShotLifecycleOptions) {
    this.run = options.run;
    this.sessionRefFrom = options.sessionRefFrom;
    this.journalDir = options.journalRoot ?? path.join(os.tmpdir(), "sta-executor-attempts", runtimeId);
  }

  /** Where this attempt's durable record lives — surfaced in evidence `logs` so a person can open it. */
  journalPathFor(attemptId: string): string {
    return path.join(this.journalDir, `${attemptId}.json`);
  }

  async prepare(req: RuntimeAgentRequest): Promise<PreparedExecutorAttempt> {
    const attemptId = deterministicAttemptId(this.runtimeId, req);
    const existing = this.readJournal(attemptId);
    if (!existing) {
      const record: AttemptJournal = {
        journal_version: JOURNAL_VERSION,
        runtime_id: this.runtimeId,
        attempt_id: attemptId,
        ...(req.taskId ? { task_id: req.taskId } : {}),
        ...(req.stage ? { stage: req.stage } : {}),
        role: req.role,
        cwd: req.cwd,
        state: "prepared",
        request: req,
        prepared_at: Date.now(),
        updated_at: Date.now(),
        result: null,
        logs: [`attempt prepared for role ${req.role}`],
        recoveries: [],
      };
      this.writeJournal(record);
    }
    return {
      runtimeId: this.runtimeId,
      attemptId,
      ...(req.taskId ? { taskId: req.taskId } : {}),
      ...(req.stage ? { stage: req.stage } : {}),
      preparedAt: existing?.prepared_at ?? Date.now(),
    };
  }

  async execute(attempt: PreparedExecutorAttempt): Promise<RuntimeAgentResult> {
    const record = this.requireRecord(attempt.attemptId, "execute");
    if (record.state === "finished") {
      // The attempt's side effects already happened once. Running it again
      // would duplicate them under the same id — the stored result is the
      // answer, not a re-run.
      return record.result!;
    }
    if (record.state === "cancelled") {
      throw new ExecutorPortRefusalError(
        "attempt-cancelled",
        "execute",
        this.runtimeId,
        `attempt ${attempt.attemptId} was cancelled — start a new attempt instead`,
      );
    }
    return this.runAndFinalize(record, "executed");
  }

  async resume(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult> {
    const record = this.requireRecord(ref.attemptId, "resume");
    if (record.state === "finished") return record.result!;
    if (record.state === "cancelled") {
      throw new ExecutorPortRefusalError(
        "attempt-cancelled",
        "resume",
        this.runtimeId,
        `attempt ${ref.attemptId} was cancelled — resume is refused; start a new attempt`,
      );
    }
    const result = await this.runAndFinalize(record, "resumed");
    const basis =
      "fresh-session resume of an interrupted attempt — this single-shot surface has no native mid-attempt restore, so the persisted packet re-ran";
    record.logs.push(basis);
    record.recoveries.push({ recovered_at: Date.now(), basis });
    this.writeJournal(record, "resume");
    return result;
  }

  async cancel(ref: ExecutorAttemptRef): Promise<ExecutorCancelOutcome> {
    const record = this.readJournal(ref.attemptId);
    if (!record) {
      return {
        status: "refused",
        detail: `attempt ${ref.attemptId} was never prepared by "${this.runtimeId}" — nothing known to stop`,
      };
    }
    if (record.state !== "prepared") {
      return {
        status: "already-finished",
        detail: `attempt ${ref.attemptId} was already ${record.state} — nothing running to stop`,
      };
    }
    record.state = "cancelled";
    record.updated_at = Date.now();
    record.logs.push(
      "cancelled before completion from outside the owning run — execute and resume refuse under this id; " +
        "a spawn already in flight in another process cannot be stopped by this single-shot surface and its late result is discarded by the cancelling STA",
    );
    this.writeJournal(record, "cancel");
    return {
      status: "already-finished",
      detail: `attempt ${ref.attemptId} was prepared but never observed running from this process — marked cancelled, so it can neither execute nor resume under this id`,
    };
  }

  async collectResult(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult | null> {
    const record = this.requireRecord(ref.attemptId, "collectResult");
    return record.state === "finished" ? record.result! : null;
  }

  async collectEvidence(ref: ExecutorAttemptRef): Promise<ExecutorEvidence> {
    const record = this.requireRecord(ref.attemptId, "collectEvidence");
    const logs = [this.journalPathFor(ref.attemptId), ...record.logs];
    if (record.result) logs.push(...record.result.diagnostics);
    return {
      attemptId: ref.attemptId,
      runtimeId: this.runtimeId,
      result: record.state === "finished" ? record.result! : null,
      logs,
      ...(record.session_ref ? { sessionRef: record.session_ref } : {}),
      ...(record.changed_files ? { changedFiles: record.changed_files } : {}),
      collectedAt: Date.now(),
    };
  }

  /** One run of the persisted packet, wrapped in the pre/post change snapshot and journalled as finished. */
  private async runAndFinalize(record: AttemptJournal, verb: string): Promise<RuntimeAgentResult> {
    const roots: readonly SnapshotRoot[] = record.request.workRoots?.length
      ? record.request.workRoots
      : [{ path: record.request.cwd }];
    const before = await this.snapshot(roots, record, `before ${verb}`);
    let result: RuntimeAgentResult;
    try {
      result = await this.run(record.request);
    } catch (error) {
      // The adapter's run is contracted never to throw; if it does anyway the
      // attempt still gets a durable, honest record instead of vanishing.
      record.state = "finished";
      record.updated_at = Date.now();
      record.result = {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards: { enforced: [], unenforced: [] },
        diagnostics: [`adapter run threw: ${String(error)}`],
      };
      record.logs.push(`run threw after ${verb} start: ${String(error)}`);
      this.writeJournal(record, verb === "resumed" ? "resume" : "execute");
      throw error;
    }
    const after = await this.snapshot(roots, record, `after ${verb}`);
    record.state = "finished";
    record.updated_at = Date.now();
    record.result = result;
    const sessionRef = this.sessionRefFrom?.(result);
    if (sessionRef) record.session_ref = sessionRef;
    if (before && after) record.changed_files = changedBetween(before, after);
    record.logs.push(`run ${verb}: status ${result.status}, exit ${result.exitCode ?? "unknown"}`);
    this.writeJournal(record, verb === "resumed" ? "resume" : "execute");
    return result;
  }

  private async snapshot(
    roots: readonly SnapshotRoot[],
    record: AttemptJournal,
    when: string,
  ): Promise<{ files: Readonly<Record<string, string>> } | null> {
    try {
      return await captureChangeSetFingerprint(roots);
    } catch (error) {
      record.logs.push(
        `changed-files capture ${when} the run unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private requireRecord(attemptId: string, operation: "execute" | "resume" | "collectResult" | "collectEvidence"): AttemptJournal {
    const record = this.readJournal(attemptId);
    if (!record) {
      throw new ExecutorPortRefusalError(
        "unknown-attempt",
        operation,
        this.runtimeId,
        `attempt ${attemptId} was never prepared by this adapter — its journal holds no record`,
      );
    }
    return record;
  }

  private readJournal(attemptId: string): AttemptJournal | null {
    try {
      const raw = fs.readFileSync(this.journalPathFor(attemptId), "utf8");
      const parsed = JSON.parse(raw) as AttemptJournal;
      if (parsed?.journal_version !== JOURNAL_VERSION || typeof parsed.state !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeJournal(
    record: AttemptJournal,
    operation: "prepare" | "execute" | "resume" | "cancel" | "collectResult" | "collectEvidence" = "prepare",
  ): void {
    try {
      fs.mkdirSync(this.journalDir, { recursive: true });
      fs.writeFileSync(this.journalPathFor(record.attempt_id), JSON.stringify(record, null, 2), "utf8");
    } catch (error) {
      throw new ExecutorPortRefusalError(
        "runtime-unavailable",
        operation,
        this.runtimeId,
        `cannot persist the attempt journal at ${this.journalPathFor(record.attempt_id)}: ${
          error instanceof Error ? error.message : String(error)
        } — without a durable record this surface cannot offer resume/recovery, so the attempt is refused before any spawn`,
      );
    }
  }
}

/** Files whose content digest differs between the two snapshots — the same comparison `exitCheckRunner` makes. */
function changedBetween(
  before: { files: Readonly<Record<string, string>> },
  after: { files: Readonly<Record<string, string>> },
): string[] {
  const files = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...files].filter((file) => before.files[file] !== after.files[file]).sort();
}
