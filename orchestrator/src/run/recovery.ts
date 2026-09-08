import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkPlanTask } from "../docs/planGraph.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import { parsePersistedTask, type PersistedTask, type TaskStore } from "../store/taskStore.js";
import {
  appendJournalRecord,
  isKnownJournalRecord,
  planHash,
  readJournal,
  readRunManifest,
  repairTruncatedJournal,
  type KnownJournalRecord,
  type RunManifest,
} from "./journal.js";
import { reconstructRunState, type RunState } from "./stateMachine.js";

const TERMINAL_RECORDS = new Set<KnownJournalRecord["kind"]>([
  "RUN_COMPLETED",
  "HUMAN_REVIEW_REQUIRED",
  "RUN_REFUSED",
  "RUN_STALE",
  "RUN_ABANDONED",
]);

export class WaveRunRecoveryError extends Error {
  constructor(public readonly kind: "NOT_FOUND" | "AMBIGUOUS" | "STALE" | "DIRTY" | "DISAGREEMENT", message: string) {
    super(message);
    this.name = "WaveRunRecoveryError";
  }
}

export interface ActiveWaveRun {
  manifest: RunManifest;
  records: KnownJournalRecord[];
  state: RunState;
  truncatedFinalLine: boolean;
}

export interface RecoveredWaveRun extends ActiveWaveRun {
  checkpointedTaskIds: Set<string>;
  messages: string[];
}

function canonical(value: string): string {
  return fs.realpathSync.native(path.resolve(value));
}

function knownRecords(projectRoot: string, runId: string): { records: KnownJournalRecord[]; truncatedFinalLine: boolean } {
  const read = readJournal(projectRoot, runId);
  const unknown = read.records.filter((record) => !isKnownJournalRecord(record));
  if (unknown.length > 0) {
    throw new WaveRunRecoveryError(
      "DISAGREEMENT",
      `run ${runId} contains unknown journal kind(s): ${unknown.map((record) => record.kind).join(", ")}`,
    );
  }
  return { records: read.records.filter(isKnownJournalRecord), truncatedFinalLine: read.truncatedFinalLine };
}

/** Read-only lookup. More than one unfinished identity is ambiguity, never "pick newest". */
export function findActiveWaveRun(
  projectRoot: string,
  match: { module: string; wave: number; targetRoot?: string },
): ActiveWaveRun {
  const root = path.join(path.resolve(projectRoot), ".workflow", "wave-runs");
  if (!fs.existsSync(root)) {
    throw new WaveRunRecoveryError("NOT_FOUND", `no bounded run exists for module ${match.module} wave ${match.wave}`);
  }
  const target = match.targetRoot ? canonical(match.targetRoot) : undefined;
  const candidates: ActiveWaveRun[] = [];
  for (const runId of fs.readdirSync(root).sort().reverse()) {
    try {
      const manifest = readRunManifest(projectRoot, runId);
      if (manifest.module !== match.module || manifest.wave !== match.wave) continue;
      if (target && canonical(manifest.target_root) !== target) continue;
      const read = knownRecords(projectRoot, runId);
      if (read.records.some((record) => TERMINAL_RECORDS.has(record.kind))) continue;
      candidates.push({
        manifest,
        records: read.records,
        state: reconstructRunState(read.records),
        truncatedFinalLine: read.truncatedFinalLine,
      });
    } catch (error) {
      if (error instanceof WaveRunRecoveryError) throw error;
      throw new WaveRunRecoveryError(
        "DISAGREEMENT",
        `wave-run directory ${runId} is unreadable and cannot be excluded safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (candidates.length === 0) {
    throw new WaveRunRecoveryError("NOT_FOUND", `no unfinished bounded run exists for module ${match.module} wave ${match.wave}`);
  }
  if (candidates.length > 1) {
    throw new WaveRunRecoveryError(
      "AMBIGUOUS",
      `multiple unfinished runs match module ${match.module} wave ${match.wave}: ${candidates.map((candidate) => candidate.manifest.run_id).join(", ")}; refuse to guess`,
    );
  }
  return candidates[0]!;
}

function lastUnfinishedTask(records: readonly KnownJournalRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind !== "TASK_STARTED") continue;
    const completedLater = records.slice(index + 1).some((later) =>
      later.task_id === record.task_id && (later.kind === "TASK_CHECKPOINTED" || later.kind === "TASK_FAILED"),
    );
    if (!completedLater) return record.task_id;
  }
  return null;
}

function lastFailedTask(records: readonly KnownJournalRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind === "TASK_FAILED") return record.task_id;
  }
  return null;
}

function attemptSnapshot(store: TaskStore, runId: string, taskId: string): PersistedTask | null {
  const event = [...store.eventsForTask(taskId)].reverse().find((candidate) =>
    candidate.type === "WAVE_ATTEMPT_STARTED" && candidate.payload.run_id === runId,
  );
  if (!event) return null;
  try {
    return parsePersistedTask(taskId, event.payload.snapshot);
  } catch {
    throw new WaveRunRecoveryError("DISAGREEMENT", `pre-stage snapshot for ${taskId} in run ${runId} is corrupt`);
  }
}

function parseTrailerCommits(output: string): Array<{ sha: string; trailers: Map<string, string> }> {
  const fields = output.split("\0").filter((field) => field !== "");
  const commits: Array<{ sha: string; trailers: Map<string, string> }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index]!.trim();
    const body = fields[index + 1]!;
    const trailers = new Map<string, string>();
    for (const line of body.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line.trim());
      if (match) trailers.set(match[1]!, match[2]!.trim());
    }
    if (sha) commits.push({ sha, trailers });
  }
  return commits;
}

async function assertCheckpointOnRunBranch(git: GitCommandLayer, sha: string, runBranch: string): Promise<void> {
  try {
    await git.catFileExists(`${sha}^{commit}`);
    const base = (await git.mergeBase(sha, runBranch)).stdout.trim();
    if (base !== sha) throw new Error("not an ancestor");
  } catch {
    throw new WaveRunRecoveryError(
      "STALE",
      `journal checkpoint ${sha} does not exist as a commit ancestor of run branch ${runBranch}; Git and journal disagree`,
    );
  }
}

function dirtyRecoveryMessage(taskId: string): string {
  return (
    `in-flight task ${taskId} left a dirty working tree. HUMAN REQUIRED: inspect with \`git diff\` and ` +
    "`git status --short`; preserve/commit the work yourself, or deliberately discard it with " +
    "`git restore . && git clean -fd`, then rerun with `--resume-run`. STA did not delete or restore any user file."
  );
}

/** Reconciles journal, store, and Git before the runner is allowed to execute another owner stage. */
export async function reconcileWaveRunForResume(options: {
  projectRoot: string;
  active: ActiveWaveRun;
  planTasks: readonly WorkPlanTask[];
  staVersion: string;
  store: TaskStore;
  git?: GitCommandLayer;
  now?: () => Date;
}): Promise<RecoveredWaveRun> {
  const { manifest } = options.active;
  const git = options.git ?? new GitCommandLayer({ cwd: manifest.target_root });
  const now = options.now ?? (() => new Date());
  const currentHash = planHash(options.planTasks);
  if (manifest.plan_hash !== currentHash) {
    throw new WaveRunRecoveryError("STALE", `plan_hash drifted: run=${manifest.plan_hash}, current=${currentHash}`);
  }
  if (manifest.sta_version !== options.staVersion) {
    throw new WaveRunRecoveryError("STALE", `sta_version drifted: run=${manifest.sta_version}, current=${options.staVersion}`);
  }

  let records = [...options.active.records];
  const messages: string[] = [];
  if (options.active.truncatedFinalLine) {
    repairTruncatedJournal(options.projectRoot, manifest.run_id);
    messages.push(`discarded the incomplete final journal fragment for run ${manifest.run_id}`);
  }

  const checkpointed = new Set<string>();
  for (const record of records) {
    if (record.kind !== "TASK_CHECKPOINTED") continue;
    await assertCheckpointOnRunBranch(git, record.sha, manifest.run_branch);
    checkpointed.add(record.task_id);
  }

  const log = await git.log({ revision: manifest.run_branch, grep: `STA-Run-Id: ${manifest.run_id}`, includeBody: true });
  const commits = parseTrailerCommits(log.stdout);
  for (const commit of commits.reverse()) {
    const taskId = commit.trailers.get("STA-Task-Id");
    if (!taskId || !manifest.task_order.includes(taskId)) continue;
    if (commit.trailers.get("STA-Run-Id") !== manifest.run_id) continue;
    if (commit.trailers.get("STA-Module") !== manifest.module || commit.trailers.get("STA-Plan-Hash") !== manifest.plan_hash) {
      throw new WaveRunRecoveryError("DISAGREEMENT", `checkpoint commit ${commit.sha} has STA trailers that disagree with the run manifest`);
    }
    await assertCheckpointOnRunBranch(git, commit.sha, manifest.run_branch);
    if (!checkpointed.has(taskId)) {
      const state = reconstructRunState(records);
      if (state !== "VALIDATING") {
        throw new WaveRunRecoveryError(
          "DISAGREEMENT",
          `Git contains checkpoint ${commit.sha} for ${taskId}, but journal state ${state} cannot accept re-attribution`,
        );
      }
      const record: KnownJournalRecord = { ts: now().toISOString(), kind: "TASK_CHECKPOINTED", task_id: taskId, sha: commit.sha };
      appendJournalRecord(options.projectRoot, manifest.run_id, record);
      records.push(record);
      checkpointed.add(taskId);
      options.store.appendEvent({
        taskId,
        at: now().getTime(),
        type: "WAVE_CHECKPOINT_REATTRIBUTED",
        payload: { run_id: manifest.run_id, sha: commit.sha },
        actor: "orchestrator",
        reason: "checkpoint commit existed in Git after a lost journal append",
        input: manifest.run_branch,
        output: commit.sha,
        decision: "reattribute-checkpoint",
      });
      messages.push(`re-attributed checkpoint ${commit.sha} to ${taskId} from verified commit trailers`);
    }
  }

  const status = (await git.statusPorcelain()).stdout.trim();
  const untracked = (await git.listUntrackedFiles()).stdout.trim();
  const unfinished = lastUnfinishedTask(records);
  if ((status || untracked) && unfinished) {
    throw new WaveRunRecoveryError("DIRTY", dirtyRecoveryMessage(unfinished));
  }

  let state = reconstructRunState(records);
  if (unfinished && !checkpointed.has(unfinished)) {
    const snapshot = attemptSnapshot(options.store, manifest.run_id, unfinished);
    if (!snapshot) {
      throw new WaveRunRecoveryError("DISAGREEMENT", `no pre-stage task snapshot exists for interrupted task ${unfinished}`);
    }
    options.store.saveTask(snapshot);
    if (state === "TASK_RUNNING" || state === "VALIDATING") {
      const failed: KnownJournalRecord = {
        ts: now().toISOString(),
        kind: "TASK_FAILED",
        task_id: unfinished,
        reason: "orchestrator process ended before a checkpoint was recorded",
        class: "interrupted",
      };
      appendJournalRecord(options.projectRoot, manifest.run_id, failed);
      records.push(failed);
      state = "HALTED";
    }
    messages.push(`restored only STA-owned task state for ${unfinished}; runtime sessions are never resumed`);
  } else if (state === "HALTED") {
    const failedTask = lastFailedTask(records);
    if (failedTask) {
      const snapshot = attemptSnapshot(options.store, manifest.run_id, failedTask);
      if (snapshot) options.store.saveTask(snapshot);
    }
  }

  state = reconstructRunState(records);
  if (state === "HALTED") {
    const resumed: KnownJournalRecord = {
      ts: now().toISOString(),
      kind: "RUN_RESUMED",
      reason: "journal, task store, and Git reconciled for explicit --resume-run",
    };
    appendJournalRecord(options.projectRoot, manifest.run_id, resumed);
    records.push(resumed);
    state = "TASK_READY";
  }

  return {
    manifest,
    records,
    state,
    truncatedFinalLine: options.active.truncatedFinalLine,
    checkpointedTaskIds: checkpointed,
    messages,
  };
}
