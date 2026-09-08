import * as fs from "node:fs";
import * as path from "node:path";
import { GitCommandLayer } from "../git/commandLayer.js";
import { isConservativeBranchName } from "../git/preflight.js";
import type { KnownJournalRecord, RunManifest } from "./journal.js";
import { loadRunDiskSnapshot } from "./snapshot.js";
import type { RunState } from "./stateMachine.js";

export const CHECKPOINT_DISCLAIMER =
  "Deterministic gate only — CHECKPOINTED is a durability fact, not a QA verdict. QA evaluation is performed by qa-engineer.";

export interface RunCheckpointSummary {
  task_id: string;
  sha: string;
  subject: string;
}

export interface ChangedRunSummary {
  run_id: string;
  run_branch: string;
  checkpoints: RunCheckpointSummary[];
}

export interface RunTaskSummary {
  task_id: string;
  status: "PENDING" | "READY" | "RUNNING" | "VALIDATING" | "CHECKPOINTED" | "FAILED";
  duration_ms?: number;
  changed_files: string[];
  checkpoint_sha?: string;
  checkpoint_subject?: string;
  gate?: "passed" | "failed" | "unverified";
  gate_summary?: string;
  failure_reason?: string;
  failure_class?: string;
}

export type MergeAdvisory =
  | { kind: "none"; reason: "halted" | "not-reviewable" }
  | { kind: "ready"; command: string }
  | { kind: "diverged"; command: string; advanced_by: number; overlapping_paths: string[] }
  | { kind: "unavailable"; reason: string };

export interface RunObservation {
  run_id: string;
  target_root: string;
  module: string;
  wave: number;
  state: RunState;
  base_branch: string;
  base_sha: string;
  run_branch: string;
  task_order: string[];
  runtime_id: string;
  tier: string;
  model: string;
  tasks: RunTaskSummary[];
  failure_reason?: string;
  failure_class?: string;
  next_required_human_action: string;
  merge_advisory: MergeAdvisory;
  disclaimer: string;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isSafeObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function isSafeDisplayBranch(value: string): boolean {
  return isConservativeBranchName(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function mergeCommand(manifest: RunManifest): string {
  return `git switch ${manifest.base_branch} && git merge --ff-only ${manifest.run_branch}`;
}

/** Derives display-only merge guidance. It never invokes a mutating Git command. */
export async function deriveMergeAdvisory(
  manifest: RunManifest,
  state: RunState,
  git = new GitCommandLayer({ cwd: manifest.target_root }),
): Promise<MergeAdvisory> {
  if (state === "HALTED") return { kind: "none", reason: "halted" };
  if (state !== "WAVE_COMPLETE" && state !== "HUMAN_REVIEW") {
    return { kind: "none", reason: "not-reviewable" };
  }
  if (!isSafeDisplayBranch(manifest.base_branch) || !isSafeDisplayBranch(manifest.run_branch) || !isSafeObjectId(manifest.base_sha)) {
    return { kind: "unavailable", reason: "stored base/run reference is not safe to render" };
  }

  try {
    const baseRef = `refs/heads/${manifest.base_branch}`;
    const currentBase = (await git.verifyRef(baseRef)).stdout.trim();
    if (!isSafeObjectId(currentBase)) return { kind: "unavailable", reason: "base branch did not resolve to a commit" };
    if (currentBase === manifest.base_sha) {
      return { kind: "ready", command: mergeCommand(manifest) };
    }

    const runRef = `refs/heads/${manifest.run_branch}`;
    const currentRun = (await git.verifyRef(runRef)).stdout.trim();
    if (!isSafeObjectId(currentRun)) return { kind: "unavailable", reason: "run branch did not resolve to a commit" };

    const common = (await git.mergeBase(manifest.base_sha, currentBase)).stdout.trim();
    if (common !== manifest.base_sha) {
      return {
        kind: "unavailable",
        reason: `${manifest.base_branch} no longer descends from the recorded base SHA; inspect history manually`,
      };
    }

    const baseRange = `${manifest.base_sha}..${currentBase}`;
    const runRange = `${manifest.base_sha}..${currentRun}`;
    const advancedBy = lines((await git.log({ revision: baseRange })).stdout).length;
    const basePaths = new Set(lines((await git.execute({ command: "diff", mode: "name-only", revision: baseRange })).stdout));
    const runPaths = new Set(lines((await git.execute({ command: "diff", mode: "name-only", revision: runRange })).stdout));
    const overlappingPaths = [...basePaths].filter((file) => runPaths.has(file)).sort();
    return {
      kind: "diverged",
      command: mergeCommand(manifest),
      advanced_by: advancedBy,
      overlapping_paths: overlappingPaths,
    };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function renderMergeAdvisory(manifest: Pick<RunManifest, "base_branch" | "run_branch">, advisory: MergeAdvisory): string[] {
  if (advisory.kind === "none") return [];
  if (advisory.kind === "unavailable") {
    return [`[orchestrator] merge advisory unavailable: ${advisory.reason}. No merge command was generated.`];
  }
  if (advisory.kind === "ready") return [`[orchestrator] merge advisory: ${advisory.command}`];

  const noun = advisory.advanced_by === 1 ? "commit" : "commits";
  const rendered = [
    `[orchestrator] merge advisory: base branch advanced by ${advisory.advanced_by} ${noun} (${manifest.base_branch}); --ff-only will refuse. Rebase or merge deliberately.`,
  ];
  if (advisory.overlapping_paths.length > 0) {
    rendered.push(`[orchestrator] overlapping paths: ${advisory.overlapping_paths.join(", ")}`);
  }
  rendered.push(`[orchestrator] merge advisory: ${advisory.command}`);
  return rendered;
}

function lastRecordForTask(records: readonly KnownJournalRecord[], taskId: string): KnownJournalRecord | undefined {
  return [...records].reverse().find((record) => record.task_id === taskId);
}

function taskStatus(records: readonly KnownJournalRecord[], taskId: string): RunTaskSummary["status"] {
  const record = lastRecordForTask(records, taskId);
  switch (record?.kind) {
    case "TASK_READY": return "READY";
    case "TASK_STARTED": return "RUNNING";
    case "TASK_AGENT_DONE":
    case "GATE_RESULT": return "VALIDATING";
    case "TASK_CHECKPOINTED": return "CHECKPOINTED";
    case "TASK_FAILED": return "FAILED";
    default: return "PENDING";
  }
}

function taskDuration(records: readonly KnownJournalRecord[], taskId: string): number | undefined {
  const started = records.find((record) => record.kind === "TASK_STARTED" && record.task_id === taskId);
  const ended = [...records].reverse().find((record) =>
    record.task_id === taskId && (record.kind === "TASK_CHECKPOINTED" || record.kind === "TASK_FAILED"));
  if (!started || !ended) return undefined;
  const duration = Date.parse(ended.ts) - Date.parse(started.ts);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

async function checkpointDetails(git: GitCommandLayer, sha: string): Promise<{ subject: string; changedFiles: string[] }> {
  const log = await git.log({ revision: sha, maxCount: 1, includeBody: true });
  const bodyParts = log.stdout.split("\0");
  const subject = (bodyParts[1] ?? "").split(/\r?\n/)[0]?.trim() || "(subject unavailable)";
  const changedFiles = lines((await git.execute({ command: "diff", mode: "name-only", revision: `${sha}^..${sha}` })).stdout);
  return { subject, changedFiles };
}

function nextHumanAction(state: RunState, failureReason?: string): string {
  if (state === "HUMAN_REVIEW" || state === "WAVE_COMPLETE") return "Review checkpoints with qa-engineer; only a human may declare MERGE_READY.";
  if (state === "HALTED") return `Inspect the preserved run${failureReason ? ` (${failureReason})` : ""}, fix the cause, then explicitly use --resume-run.`;
  if (state === "REFUSED") return `Resolve the refusal before starting another bounded run${failureReason ? ` (${failureReason})` : ""}.`;
  if (state === "CANCELLED" || state === "STALE") return "Inspect the preserved run branch and decide whether to keep or remove it manually.";
  return "Allow the current bounded run to reach a checkpoint or halt; do not merge its branch.";
}

export async function observeRun(projectRoot: string, runId: string): Promise<RunObservation> {
  const snapshot = loadRunDiskSnapshot(projectRoot, runId);
  let git: GitCommandLayer | undefined;
  let gitUnavailable: string | undefined;
  try {
    git = new GitCommandLayer({ cwd: snapshot.manifest.target_root });
  } catch (error) {
    gitUnavailable = error instanceof Error ? error.message : String(error);
  }
  const taskSummaries: RunTaskSummary[] = [];
  for (const taskId of snapshot.manifest.task_order) {
    const checkpoint = [...snapshot.records].reverse().find((record) => record.kind === "TASK_CHECKPOINTED" && record.task_id === taskId);
    const gate = [...snapshot.records].reverse().find((record) => record.kind === "GATE_RESULT" && record.task_id === taskId);
    const failure = [...snapshot.records].reverse().find((record) => record.kind === "TASK_FAILED" && record.task_id === taskId);
    let details: { subject: string; changedFiles: string[] } | undefined;
    if (checkpoint?.kind === "TASK_CHECKPOINTED" && git) {
      try {
        details = await checkpointDetails(git, checkpoint.sha);
      } catch {}
    }
    taskSummaries.push({
      task_id: taskId,
      status: taskStatus(snapshot.records, taskId),
      duration_ms: taskDuration(snapshot.records, taskId),
      changed_files: details?.changedFiles ?? [],
      checkpoint_sha: checkpoint?.kind === "TASK_CHECKPOINTED" ? checkpoint.sha : undefined,
      checkpoint_subject: details?.subject,
      gate: gate?.kind === "GATE_RESULT" ? gate.result : undefined,
      gate_summary: gate?.kind === "GATE_RESULT" ? gate.summary : undefined,
      failure_reason: failure?.kind === "TASK_FAILED" ? failure.reason : undefined,
      failure_class: failure?.kind === "TASK_FAILED" ? failure.class : undefined,
    });
  }
  const runFailure = [...snapshot.records].reverse().find((record) => record.kind === "RUN_HALTED" || record.kind === "RUN_REFUSED");
  const failureReason = runFailure && "reason" in runFailure ? runFailure.reason : undefined;
  const taskFailure = [...taskSummaries].reverse().find((task) => task.failure_class);
  return {
    run_id: snapshot.manifest.run_id,
    target_root: snapshot.manifest.target_root,
    module: snapshot.manifest.module,
    wave: snapshot.manifest.wave,
    state: snapshot.state,
    base_branch: snapshot.manifest.base_branch,
    base_sha: snapshot.manifest.base_sha,
    run_branch: snapshot.manifest.run_branch,
    task_order: [...snapshot.manifest.task_order],
    runtime_id: snapshot.manifest.runtime_id,
    tier: snapshot.manifest.tier,
    model: snapshot.manifest.model,
    tasks: taskSummaries,
    failure_reason: failureReason,
    failure_class: taskFailure?.failure_class,
    next_required_human_action: nextHumanAction(snapshot.state, failureReason),
    merge_advisory: git
      ? await deriveMergeAdvisory(snapshot.manifest, snapshot.state, git)
      : snapshot.state === "HALTED"
        ? { kind: "none", reason: "halted" }
        : { kind: "unavailable", reason: gitUnavailable ?? "target repository is unavailable" },
    disclaimer: CHECKPOINT_DISCLAIMER,
  };
}

export function listRunIds(projectRoot: string): string[] {
  const root = path.join(path.resolve(projectRoot), ".workflow", "wave-runs");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function observeRuns(projectRoot: string): Promise<RunObservation[]> {
  const observations: RunObservation[] = [];
  for (const runId of listRunIds(projectRoot)) observations.push(await observeRun(projectRoot, runId));
  return observations;
}

export interface OrphanRunBranch {
  target_root: string;
  branch: string;
}

export async function listOrphanRunBranches(projectRoot: string, runs: readonly RunObservation[]): Promise<OrphanRunBranch[]> {
  const activeStates = new Set<RunState>(["CREATED", "PREFLIGHT", "ISOLATED", "TASK_READY", "TASK_RUNNING", "VALIDATING", "CHECKPOINTED", "WAVE_COMPLETE"]);
  const active = new Set(runs.filter((run) => activeStates.has(run.state)).map((run) => `${path.resolve(run.target_root)}\0${run.run_branch}`));
  const targets = new Set([path.resolve(projectRoot), ...runs.map((run) => path.resolve(run.target_root))]);
  const orphans: OrphanRunBranch[] = [];
  for (const targetRoot of targets) {
    try {
      const git = new GitCommandLayer({ cwd: targetRoot });
      const branches = lines((await git.listBranches("sta/run/*")).stdout).map((branch) => branch.replace(/^\*\s+/, "").trim());
      for (const branch of branches) {
        if (!active.has(`${targetRoot}\0${branch}`)) orphans.push({ target_root: targetRoot, branch });
      }
    } catch {}
  }
  return orphans.sort((left, right) => left.branch.localeCompare(right.branch));
}

export function changedRunSummary(observation: RunObservation): ChangedRunSummary {
  return {
    run_id: observation.run_id,
    run_branch: observation.run_branch,
    checkpoints: observation.tasks.flatMap((task) => task.checkpoint_sha ? [{
      task_id: task.task_id,
      sha: task.checkpoint_sha,
      subject: task.checkpoint_subject ?? "(subject unavailable)",
    }] : []),
  };
}
