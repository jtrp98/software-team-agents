import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { LedgerAttempt, LedgerRun, RunLedger } from "../ledger/runLedger.js";
import { TERMINAL_RUN_STATUSES } from "../ledger/vocabulary.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import {
  acquireWorkspaceRunLock,
  releaseWorkspaceRunLock,
  refreshWorkspaceRunLock,
} from "../concurrency/workspaceRunLock.js";
import { checkpointTask, type CheckpointResult, type SecretScanner } from "./checkpoint.js";
import { GitCommandLayer } from "./commandLayer.js";
import { inspectRepositoryPreflight } from "./preflight.js";

const TARGET_WRITERS = new Set<AgentStage>([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);

export class GuardedRunError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = "GuardedRunError";
  }
}

export interface OpenGuardedRunInput {
  ledger: RunLedger;
  runId: string;
  runtimeStateRoot: string;
  git?: GitCommandLayer;
  /** A frozen attempt is required before the first Git mutation. */
  firstAttempt: LedgerAttempt;
  now?: () => number;
}

export interface GuardedCheckpointInput {
  attempt: LedgerAttempt;
  adapter: Pick<RuntimeAgentResult, "status" | "exitCode">;
  runVerification: () => Promise<DeterministicVerification>;
  taskDescription: string;
  allowedPathGlobs: readonly string[];
  secretScanner?: SecretScanner;
  usage?: LedgerAttempt["usage"];
}

function canonical(value: string): string {
  return path.resolve(value).toLocaleLowerCase("en-US");
}

function assertTargetAttempt(run: LedgerRun, attempt: LedgerAttempt): void {
  const failures: string[] = [];
  if (attempt.run_id !== run.run_id) failures.push(`attempt belongs to run ${attempt.run_id}`);
  if (!TARGET_WRITERS.has(attempt.stage)) failures.push(`stage ${attempt.stage} is analysis/proposal-only and may not open a Git mutation boundary`);
  if (!attempt.guard_evidence.target_write) failures.push("attempt was frozen as analysis/proposal-only");
  if (!attempt.guard_evidence.pre_tool_guard) failures.push("attempt has no verified pre-tool guard");
  if (attempt.guard_evidence.writable_roots.length !== 1) failures.push(`attempt resolved ${attempt.guard_evidence.writable_roots.length} writable roots`);
  if (attempt.guard_evidence.writable_roots.length === 1 && canonical(attempt.guard_evidence.writable_roots[0]!) !== canonical(run.target_root)) {
    failures.push(`attempt writable root does not equal frozen Target root ${run.target_root}`);
  }
  if (attempt.plan_hash !== run.plan_hash) failures.push("attempt plan hash differs from the frozen run");
  if (attempt.base_revision !== run.base_sha) failures.push("attempt base revision differs from the frozen run");
  if (failures.length > 0) throw new GuardedRunError("UNGUARDED_ATTEMPT", `Target mutation refused:\n- ${failures.join("\n- ")}`);
}

async function assertCleanExactBranch(git: GitCommandLayer, run: LedgerRun, ledger: RunLedger): Promise<string | null> {
  const branch = (await git.symbolicRefHead()).stdout.trim();
  const sha = (await git.revParseHead()).stdout.trim();
  const status = (await git.statusPorcelainNull()).stdout;
  if (branch !== run.run_branch || status) {
    throw new GuardedRunError(
      "RESUME_MISMATCH",
      `run ${run.run_id} resumes only on clean branch ${run.run_branch}; observed branch=${branch || "detached"}, dirty=${status ? "yes" : "no"}. Preserve and reconcile the work manually.`,
    );
  }
  const known = new Set([run.base_sha, ...ledger.checkpointsForRun(run.run_id).map((item) => item.sha)]);
  if (known.has(sha)) return null;
  const verifying = ledger.readTasks(run.run_id).filter((task) => task.status === "VERIFYING");
  const candidates = verifying.flatMap((task) =>
    ledger.attemptsForTask(run.run_id, task.task_id).filter((attempt) => attempt.status === "RUNNING"),
  );
  if (candidates.length === 1) return candidates[0]!.attempt_id;
  throw new GuardedRunError(
    "RESUME_MISMATCH",
    `clean run-branch HEAD ${sha} is neither the frozen base nor a recorded checkpoint, and no single interrupted VERIFYING attempt can own it`,
  );
}

function activeRunConflicts(ledger: RunLedger, run: LedgerRun): LedgerRun[] {
  return ledger.listRuns().filter((candidate) =>
    candidate.run_id !== run.run_id &&
    canonical(candidate.target_root) === canonical(run.target_root) &&
    !TERMINAL_RUN_STATUSES.has(candidate.status),
  );
}

/**
 * The only V8 Target mutation session. It holds one workspace lock from branch
 * isolation through the selected boundary and writes every task/checkpoint
 * transition through the same RunLedger.
 */
export class GuardedRunSession {
  private activeAttemptId: string | null = null;
  private pendingReconciliationAttemptId: string | null;
  private released = false;

  private constructor(
    readonly ledger: RunLedger,
    readonly run: LedgerRun,
    readonly runtimeStateRoot: string,
    readonly git: GitCommandLayer,
    private readonly now: () => number,
    pendingReconciliationAttemptId: string | null,
  ) { this.pendingReconciliationAttemptId = pendingReconciliationAttemptId; }

  static async open(input: OpenGuardedRunInput): Promise<GuardedRunSession> {
    const run = input.ledger.readRun(input.runId);
    if (!run) throw new GuardedRunError("RUN_NOT_FOUND", `run ${input.runId} does not exist`);
    assertTargetAttempt(run, input.firstAttempt);
    const persistedAttempt = input.ledger.readAttempt(input.firstAttempt.attempt_id);
    if (!persistedAttempt || JSON.stringify(persistedAttempt) !== JSON.stringify(input.firstAttempt)) {
      throw new GuardedRunError(
        "ATTEMPT_NOT_FROZEN",
        `attempt ${input.firstAttempt.attempt_id} is not the byte-identical frozen ledger record; no branch mutation is allowed`,
      );
    }
    if (!["FROZEN", "RUNNING"].includes(persistedAttempt.status)) {
      throw new GuardedRunError("ATTEMPT_STATE", `attempt ${persistedAttempt.attempt_id} is already ${persistedAttempt.status}`);
    }
    const conflicts = activeRunConflicts(input.ledger, run);
    if (conflicts.length > 0) {
      throw new GuardedRunError(
        "STALE_ACTIVE_RUN",
        `Target ${run.target_root} already has unfinished run(s) ${conflicts.map((item) => item.run_id).join(", ")}; reconcile them before any branch mutation.`,
      );
    }
    if (TERMINAL_RUN_STATUSES.has(run.status) || !["REGISTERED", "RUNNING", "HALTED"].includes(run.status)) {
      throw new GuardedRunError("RUN_STATE", `run ${run.run_id} in state ${run.status} cannot open a Target mutation boundary`);
    }

    const git = input.git ?? new GitCommandLayer({ cwd: run.target_root });
    if (canonical(git.cwd) !== canonical(run.target_root)) {
      throw new GuardedRunError("TARGET_MISMATCH", `Git root ${git.cwd} differs from frozen Target root ${run.target_root}`);
    }

    acquireWorkspaceRunLock(input.runtimeStateRoot, run.target_root, run.run_id);
    try {
      const currentBranch = await git.symbolicRefHead().then((result) => result.stdout.trim()).catch(() => "");
      const currentSha = await git.revParseHead().then((result) => result.stdout.trim()).catch(() => "");
      let pendingReconciliationAttemptId: string | null = null;
      if (run.status === "REGISTERED" && currentBranch === run.run_branch && currentSha === run.base_sha) {
        // Crash after `switch -c` but before the ledger status write. Exact run
        // identity makes this safe to adopt; no new branch command is issued.
        if ((await git.statusPorcelainNull()).stdout) throw new GuardedRunError("RESUME_MISMATCH", "new run branch is dirty after interrupted isolation");
      } else if (run.status === "REGISTERED") {
        const preflight = await inspectRepositoryPreflight(git, run.module, run.run_id);
        const mismatch = [
          preflight.baseBranch === run.base_branch ? null : `base branch ${preflight.baseBranch} != ${run.base_branch}`,
          preflight.baseSha === run.base_sha ? null : `base SHA ${preflight.baseSha} != ${run.base_sha}`,
          preflight.runBranch === run.run_branch ? null : `run branch ${preflight.runBranch} != ${run.run_branch}`,
        ].filter((item): item is string => item !== null);
        if (mismatch.length > 0) throw new GuardedRunError("PREFLIGHT_DRIFT", mismatch.join("; "));
        await git.createBranch(run.run_branch, run.base_sha);
      } else {
        pendingReconciliationAttemptId = await assertCleanExactBranch(git, run, input.ledger);
      }
      input.ledger.setRunStatus(run.run_id, "RUNNING", { reason: "guarded one-writer Target boundary opened" });
      return new GuardedRunSession(
        input.ledger,
        input.ledger.readRun(run.run_id)!,
        input.runtimeStateRoot,
        git,
        input.now ?? Date.now,
        pendingReconciliationAttemptId,
      );
    } catch (error) {
      releaseWorkspaceRunLock(input.runtimeStateRoot, run.target_root, run.run_id);
      throw error;
    }
  }

  beginTask(attempt: LedgerAttempt): void {
    this.assertOpen();
    if (this.pendingReconciliationAttemptId !== null) {
      throw new GuardedRunError(
        "RECONCILIATION_REQUIRED",
        `interrupted attempt ${this.pendingReconciliationAttemptId} must be reconciled before another task can start`,
      );
    }
    assertTargetAttempt(this.run, attempt);
    if (attempt.status !== "FROZEN") throw new GuardedRunError("ATTEMPT_STATE", `attempt ${attempt.attempt_id} is ${attempt.status}, expected FROZEN`);
    const task = this.ledger.readTask(this.run.run_id, attempt.task_id);
    if (!task) throw new GuardedRunError("TASK_NOT_FOUND", `task ${attempt.task_id} is not registered in run ${this.run.run_id}`);
    if (task.owner !== attempt.stage) throw new GuardedRunError("OWNER_MISMATCH", `task owner ${task.owner} differs from frozen attempt stage ${attempt.stage}`);
    if (task.status !== "READY") throw new GuardedRunError("TASK_STATE", `task ${task.task_id} is ${task.status}, expected READY`);
    const inFlight = this.ledger.readTasks(this.run.run_id).filter((item) => ["RUNNING", "VERIFYING"].includes(item.status));
    if (inFlight.length > 0 || this.activeAttemptId !== null) {
      throw new GuardedRunError("MULTIPLE_WRITERS", `one-writer invariant: in-flight task(s) ${inFlight.map((item) => item.task_id).join(", ") || "none"}`);
    }
    refreshWorkspaceRunLock(this.runtimeStateRoot, this.run.target_root, this.run.run_id);
    this.ledger.transaction(() => {
      this.ledger.setTaskStatus(this.run.run_id, task.task_id, "RUNNING", { reason: `attempt ${attempt.attempt_id} started` });
      this.ledger.updateAttempt(attempt.attempt_id, { status: "RUNNING" });
    });
    this.activeAttemptId = attempt.attempt_id;
  }

  async checkpoint(input: GuardedCheckpointInput): Promise<CheckpointResult> {
    this.assertOpen();
    if (this.activeAttemptId !== input.attempt.attempt_id) {
      throw new GuardedRunError("ATTEMPT_STATE", `attempt ${input.attempt.attempt_id} does not own the one-writer slot`);
    }
    const current = this.ledger.readAttempt(input.attempt.attempt_id);
    if (!current || current.status !== "RUNNING") throw new GuardedRunError("ATTEMPT_STATE", `attempt ${input.attempt.attempt_id} is not RUNNING`);
    this.ledger.setTaskStatus(this.run.run_id, input.attempt.task_id, "VERIFYING", { reason: "runtime returned; deterministic and checkpoint guards running" });
    let result: CheckpointResult;
    try {
      result = await checkpointTask({
        git: this.git,
        adapter: input.adapter,
        writableRoots: current.guard_evidence.writable_roots,
        runVerification: input.runVerification,
        runId: this.run.run_id,
        taskId: current.task_id,
        module: this.run.module,
        planHash: this.run.plan_hash,
        packetHash: current.packet_hash,
        taskDescription: input.taskDescription,
        allowedPathGlobs: input.allowedPathGlobs,
        secretScanner: input.secretScanner,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.ledger.transaction(() => {
        const attempt = this.ledger.readAttempt(current.attempt_id);
        if (attempt?.status === "RUNNING") this.ledger.updateAttempt(current.attempt_id, { status: "FAILED", ended_at: this.now(), outcome_reason: reason });
        const task = this.ledger.readTask(this.run.run_id, current.task_id);
        if (task && ["RUNNING", "VERIFYING"].includes(task.status)) this.ledger.setTaskStatus(this.run.run_id, current.task_id, "FAILED", { reason });
        const run = this.ledger.readRun(this.run.run_id);
        if (run?.status === "RUNNING") this.ledger.setRunStatus(this.run.run_id, "HALTED", { reason });
      });
      this.activeAttemptId = null;
      throw error;
    }

    try {
      this.ledger.transaction(() => {
        this.ledger.recordCheckpoint({
          run_id: this.run.run_id,
          task_id: current.task_id,
          attempt_id: current.attempt_id,
          sha: result.sha,
          packet_hash: current.packet_hash,
          at: this.now(),
        });
        this.ledger.updateAttempt(current.attempt_id, {
          status: "SUCCEEDED",
          ended_at: this.now(),
          outcome_reason: "runtime and deterministic verification passed; exact local checkpoint created",
          usage: input.usage,
        });
        this.ledger.setTaskStatus(this.run.run_id, current.task_id, "CHECKPOINTED", { reason: `checkpoint ${result.sha}` });
      });
      this.activeAttemptId = null;
      return result;
    } catch (error) {
      throw new GuardedRunError(
        "CHECKPOINT_RECONCILIATION_REQUIRED",
        `checkpoint ${result.sha} was created but its ledger transaction did not complete: ${error instanceof Error ? error.message : String(error)}. ` +
          "Keep the clean run branch unchanged and resume so exact commit trailers can be reconciled.",
      );
    }
  }

  haltActiveAttempt(attempt: LedgerAttempt, reason: string, status: "FAILED" | "UNAVAILABLE" | "ABANDONED" = "FAILED"): void {
    this.assertOpen();
    if (this.activeAttemptId !== attempt.attempt_id) {
      throw new GuardedRunError("ATTEMPT_STATE", `attempt ${attempt.attempt_id} does not own the one-writer slot`);
    }
    this.ledger.transaction(() => {
      const current = this.ledger.readAttempt(attempt.attempt_id);
      if (current?.status === "RUNNING") this.ledger.updateAttempt(attempt.attempt_id, { status, ended_at: this.now(), outcome_reason: reason });
      const task = this.ledger.readTask(this.run.run_id, attempt.task_id);
      if (task && ["RUNNING", "VERIFYING"].includes(task.status)) this.ledger.setTaskStatus(this.run.run_id, task.task_id, "FAILED", { reason });
      const run = this.ledger.readRun(this.run.run_id);
      if (run?.status === "RUNNING") this.ledger.setRunStatus(this.run.run_id, "HALTED", { reason });
    });
    this.activeAttemptId = null;
  }

  /** Re-attributes a clean HEAD commit when the process died after commit but before the ledger transaction. */
  async reconcileHeadCheckpoint(attempt: LedgerAttempt): Promise<string> {
    this.assertOpen();
    const task = this.ledger.readTask(this.run.run_id, attempt.task_id);
    const currentAttempt = this.ledger.readAttempt(attempt.attempt_id);
    if (!task || task.status !== "VERIFYING" || !currentAttempt || currentAttempt.status !== "RUNNING") {
      throw new GuardedRunError("RECONCILE_STATE", `only a RUNNING attempt with a VERIFYING task may re-attribute a checkpoint`);
    }
    await assertCleanExactBranch(this.git, this.run, this.ledger);
    const log = await this.git.log({ maxCount: 1, revision: "HEAD", includeBody: true });
    const [sha = "", body = ""] = log.stdout.split("\0");
    const expected = new Map([
      ["STA-Run-Id", this.run.run_id], ["STA-Task-Id", attempt.task_id], ["STA-Module", this.run.module],
      ["STA-Plan-Hash", this.run.plan_hash], ["STA-Packet-Hash", attempt.packet_hash],
    ]);
    for (const [name, value] of expected) {
      if (!body.split(/\r?\n/).some((line) => line.trim() === `${name}: ${value}`)) {
        throw new GuardedRunError("RECONCILE_MISMATCH", `HEAD ${sha || "unknown"} does not carry exact ${name}=${value}`);
      }
    }
    this.ledger.transaction(() => {
      this.ledger.recordCheckpoint({ run_id: this.run.run_id, task_id: attempt.task_id, attempt_id: attempt.attempt_id, sha, packet_hash: attempt.packet_hash, at: this.now() });
      this.ledger.updateAttempt(attempt.attempt_id, { status: "SUCCEEDED", ended_at: this.now(), outcome_reason: "checkpoint re-attributed from exact HEAD trailers after interruption" });
      this.ledger.setTaskStatus(this.run.run_id, attempt.task_id, "CHECKPOINTED", { reason: `reconciled checkpoint ${sha}` });
    });
    this.activeAttemptId = null;
    this.pendingReconciliationAttemptId = null;
    return sha;
  }

  close(): void {
    if (this.released) return;
    releaseWorkspaceRunLock(this.runtimeStateRoot, this.run.target_root, this.run.run_id);
    this.released = true;
  }

  private assertOpen(): void {
    if (this.released) throw new GuardedRunError("SESSION_CLOSED", `guarded run ${this.run.run_id} session is closed`);
  }
}
