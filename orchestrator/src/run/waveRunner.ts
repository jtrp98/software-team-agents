import * as fs from "node:fs";
import * as path from "node:path";
import { taskObjective, type WorkPlanTask } from "../docs/planGraph.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { checkpointTask, CheckpointRefusal, type SecretScanner } from "../git/checkpoint.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import type { RepositoryPreflightResult } from "../git/preflight.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult, Orchestrator } from "../orchestrator/orchestrator.js";
import type { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { unmetDependencies } from "../orchestrator/taskStatus.js";
import { TaskState } from "../types.js";
import type { DeterministicCheckId, DeterministicVerification } from "../qa/deterministic.js";
import { deterministicChecksForLevels, renderDeterministicVerification } from "../qa/deterministic.js";
import type { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import type { PersistedTask, TaskStore } from "../store/taskStore.js";
import {
  acquireWorkspaceRunLock,
  assertNoManualTaskLock,
  refreshWorkspaceRunLock,
  releaseWorkspaceRunLock,
} from "../concurrency/workspaceRunLock.js";
import { applyRunJournalRecord, type RunState } from "./stateMachine.js";
import { appendJournalRecord, type KnownJournalRecord, type RunManifest, writeRunManifest } from "./journal.js";
import { evaluateAutoEligibility, renderAutoEligibility, tasksInDerivedWave, type AutoEligibilityDecision } from "./eligibility.js";
import { deriveMergeAdvisory, renderMergeAdvisory } from "./observability.js";

export interface ResolvedWaveRoute {
  runtimeId: string;
  tier: string;
  model: string;
  capabilities: ReadonlySet<RuntimeCapability>;
}

export interface WaveTaskPreview {
  row: WorkPlanTask;
  stored: PersistedTask | null;
  decision: AutoEligibilityDecision;
  targetRoot: string | null;
  targetId: string | null;
}

export interface WavePreview {
  tasks: WaveTaskPreview[];
  targetRoot: string | null;
  targetId: string | null;
  allEligible: boolean;
}

export interface TaskExecutorComposition {
  executor: AgentExecutor;
  verificationFor(taskId: string): DeterministicVerification | undefined;
}

export interface ExecuteWaveOptions {
  projectRoot: string;
  manifest: RunManifest;
  planTasks: readonly WorkPlanTask[];
  preview: WavePreview;
  preflight?: RepositoryPreflightResult;
  checkpointedTaskIds?: ReadonlySet<string>;
  initialState?: RunState;
  registry: TaskRegistry;
  store: TaskStore;
  route: ResolvedWaveRoute;
  compose: (task: WorkPlanTask, orchestrator: Orchestrator) => Promise<TaskExecutorComposition>;
  git?: GitCommandLayer;
  now?: () => Date;
  log?: (message: string) => void;
  /** Test seam; production uses the Framework-owned scanner. */
  secretScanner?: SecretScanner;
}

function canonicalExisting(value: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return null;
  }
}

function registeredOwnerRoot(task: PersistedTask, owner: string): { root: string; targetId: string } | null {
  const roots = task.runtimeTask?.scope.work_roots.filter((entry) => entry.stage === owner) ?? [];
  const canonical = roots
    .map((entry) => ({ root: canonicalExisting(entry.root), targetId: entry.target_id }))
    .filter((entry): entry is { root: string; targetId: string } => entry.root !== null);
  const unique = new Map(canonical.map((entry) => [entry.root, entry]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

/** Static discovery only: dry-run never executes a verification command. */
export function discoverExecutableVerificationChecks(targetRoot: string): DeterministicCheckId[] {
  const names = new Set<string>();
  for (const file of [path.join(targetRoot, "package.json"), path.join(targetRoot, ".agent-team", "config.yaml")]) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (file.endsWith("package.json")) {
        const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
        for (const [name, value] of Object.entries(scripts)) if (typeof value === "string") names.add(name);
      } else {
        for (const match of text.matchAll(/^\s*(lint|typecheck|test|build)\s*:/gm)) names.add(match[1]!);
      }
    } catch {
      // Missing or malformed declarations are absence, never executable evidence.
    }
  }
  const checks: DeterministicCheckId[] = [];
  if (names.has("lint")) checks.push("lint");
  if (names.has("typecheck")) checks.push("typecheck");
  if (names.has("test")) checks.push("unit-tests");
  if (names.has("build")) checks.push("build");
  return checks;
}

export function buildWavePreview(options: {
  planTasks: readonly WorkPlanTask[];
  wave: number;
  maxTasks: number;
  store: Pick<TaskStore, "loadTask">;
  route: ResolvedWaveRoute;
  repositoryState: "clean-ordinary" | "not-clean-ordinary" | null;
  checkpointedTaskIds?: ReadonlySet<string>;
}): WavePreview {
  const rows = tasksInDerivedWave(options.planTasks, options.wave).slice(0, options.maxTasks);
  const hypotheticalCheckpoints = new Set(options.checkpointedTaskIds ?? []);
  const storedTasks = options.planTasks.flatMap(t => { const stored = options.store.loadTask(t.id); return stored ? [stored] : []; });
  for (const task of storedTasks) if (task.machine.current === TaskState.DEPLOYED && !task.paused && !task.cancelled && !unmetDependencies(task, storedTasks).length) hypotheticalCheckpoints.add(task.taskId);
  const graph = taskGraphFromPlan(options.planTasks);
  const previews: WaveTaskPreview[] = [];
  let sharedRoot: string | null = null;
  let sharedTargetId: string | null = null;

  for (const row of rows) {
    const stored = options.store.loadTask(row.id);
    const resolved = stored ? registeredOwnerRoot(stored, row.owner) : null;
    const root = resolved?.root ?? null;
    if (hypotheticalCheckpoints.has(row.id)) {
      if (sharedRoot === null) sharedRoot = root;
      if (sharedTargetId === null) sharedTargetId = resolved?.targetId ?? null;
      previews.push({
        row,
        stored,
        decision: { eligible: true, action: "RUN", failures: [] },
        targetRoot: root,
        targetId: resolved?.targetId ?? null,
      });
      continue;
    }
    const required = stored?.runtimeTask?.required_verification.levels ?? [];
    const selected = deterministicChecksForLevels(required);
    const executable = root ? discoverExecutableVerificationChecks(root).filter((check) => selected.includes(check)) : null;
    const dependencyMatch = stored
      ? JSON.stringify([...stored.dependsOn].sort()) === JSON.stringify(graph.dependenciesOf(row.id).sort())
      : false;
    const cursorOwner = stored?.classification.pipeline[stored.pipelineCursor];
    const decision = evaluateAutoEligibility(
      { task: row, planTasks: options.planTasks },
      {
        classification: stored?.classification ?? null,
        checkpointedTaskIds: hypotheticalCheckpoints,
        approvals: stored?.approvals ?? null,
        runtimeId: options.route.runtimeId,
        runtimeCapabilities: options.route.capabilities,
        writableTargetRoots: root ? [root] : null,
        executableVerificationChecks: executable,
        repositoryState: options.repositoryState,
      },
    );
    if (!stored) decision.failures.push({ clause: "D", reason: "Clause D: task has not been registered with --register-only" });
    if (stored && !dependencyMatch) {
      decision.failures.push({ clause: "C", reason: "Clause C: registered dependencies do not match plan.md" });
    }
    if (stored && cursorOwner !== row.owner) {
      decision.failures.push({
        clause: "F",
        reason: `Clause F: registered next pipeline stage is ${cursorOwner ?? "none"}, but plan owner is ${row.owner}`,
      });
    }
    if (sharedRoot !== null && root !== sharedRoot) {
      decision.failures.push({ clause: "H", reason: `Clause H: task resolves Target root ${root ?? "none"}, not run root ${sharedRoot}` });
    }
    if (sharedTargetId !== null && resolved?.targetId !== sharedTargetId) {
      decision.failures.push({ clause: "H", reason: `Clause H: task resolves Target id ${resolved?.targetId ?? "none"}, not ${sharedTargetId}` });
    }
    decision.eligible = decision.failures.length === 0;
    decision.action = decision.eligible ? "RUN" : "HALT";
    if (decision.eligible) {
      hypotheticalCheckpoints.add(row.id);
      sharedRoot ??= root;
      sharedTargetId ??= resolved?.targetId ?? null;
    }
    previews.push({ row, stored, decision, targetRoot: root, targetId: resolved?.targetId ?? null });
  }
  return { tasks: previews, targetRoot: sharedRoot, targetId: sharedTargetId, allEligible: rows.length > 0 && previews.every((item) => item.decision.eligible) };
}

export function renderWavePreview(options: {
  wave: number;
  preview: WavePreview;
  route: ResolvedWaveRoute;
  baseBranch: string;
  baseSha: string;
}): string[] {
  const lines = [
    `[orchestrator] bounded wave ${options.wave}: ${options.preview.tasks.length} task(s)`,
    `[orchestrator] route runtime=${options.route.runtimeId} tier=${options.route.tier} model=${options.route.model}`,
    `[orchestrator] base branch=${options.baseBranch} sha=${options.baseSha}`,
  ];
  for (const [index, task] of options.preview.tasks.entries()) {
    lines.push(`[orchestrator] ${index + 1}. ${task.row.id} owner=${task.row.owner} ${task.decision.eligible ? "ELIGIBLE" : "HALT"}`);
    if (!task.decision.eligible) lines.push(...renderAutoEligibility(task.decision).map((line) => `[orchestrator]    ${line}`));
  }
  return lines;
}

function failureClass(result: AgentExecutorResult): string {
  const text = `${result.outcome.failure_reason ?? ""} ${result.failure?.reason ?? ""}`;
  if (/quota|rate.?limit|usage.?limit/i.test(text)) return "quota";
  if (result.failure?.category === "infrastructure") return "unavailable";
  return "runtime";
}

function failureReason(result: AgentExecutorResult): string {
  const reason = result.failure?.reason ?? result.outcome.failure_reason ?? "runtime stage failed";
  if (failureClass(result) !== "quota") return reason;
  return (
    `HUMAN REQUIRED: quota exhaustion (${reason}). Runtime reading: the provider refused this invocation; ` +
    "accounting reading: the task/run token budget may report a different remaining amount. No retry or alternate runtime was attempted."
  );
}

export async function executeWave(options: ExecuteWaveOptions): Promise<number> {
  const log = options.log ?? console.log;
  const now = options.now ?? (() => new Date());
  const git = options.git ?? new GitCommandLayer({ cwd: options.manifest.target_root });
  const checkpointed = new Set(options.checkpointedTaskIds ?? []);
  let state: RunState = options.initialState ?? "CREATED";
  let lockHeld = false;
  const append = (record: KnownJournalRecord): void => {
    state = applyRunJournalRecord(state, record).current;
    appendJournalRecord(options.projectRoot, options.manifest.run_id, record);
  };
  const ts = (): string => now().toISOString();

  try {
    if (!options.preflight && state === "CREATED") throw new Error("new wave execution requires repository preflight evidence");
    if (state === "CREATED") {
      writeRunManifest(options.projectRoot, options.manifest);
      append({ ts: ts(), kind: "RUN_STARTED" });
    }
    acquireWorkspaceRunLock(options.projectRoot, options.manifest.target_root, options.manifest.run_id);
    lockHeld = true;

    if (state === "PREFLIGHT") {
      try {
        await git.createBranch(options.manifest.run_branch, options.manifest.base_sha);
      } catch (error) {
        append({ ts: ts(), kind: "RUN_REFUSED", reason: `could not create isolated run branch: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      append({ ts: ts(), kind: "RUN_ISOLATED" });
    } else {
      const branch = (await git.symbolicRefHead()).stdout.trim();
      if (branch !== options.manifest.run_branch) {
        throw new Error(`resume requires run branch ${options.manifest.run_branch}, but HEAD is on ${branch || "detached HEAD"}`);
      }
    }

    for (const item of options.preview.tasks) {
      const task = item.row;
      if (checkpointed.has(task.id)) {
        log(`[orchestrator] ${task.id} already CHECKPOINTED in this run; not re-executing it.`);
        continue;
      }
      refreshWorkspaceRunLock(options.projectRoot, options.manifest.target_root, options.manifest.run_id);
      assertNoManualTaskLock(options.projectRoot, task.id);

      if (state === "ISOLATED" || state === "CHECKPOINTED") {
        append({ ts: ts(), kind: "TASK_READY", task_id: task.id });
      } else if (state === "TASK_READY") {
        const lastReady = [...options.manifest.task_order].find((id) => id === task.id);
        if (!lastReady) throw new Error(`journal is ready for a task outside manifest order: ${task.id}`);
      } else {
        throw new Error(`run state ${state} cannot start ${task.id}`);
      }

      const orchestrator = options.registry.openPreparedForWave(task.id, options.planTasks, checkpointed);
      const snapshot = orchestrator.snapshot();
      options.store.appendEvent({
        taskId: task.id,
        at: now().getTime(),
        type: "WAVE_ATTEMPT_STARTED",
        payload: { run_id: options.manifest.run_id, task_id: task.id, snapshot },
        actor: "orchestrator",
        reason: "pre-owner-stage snapshot for crash-safe bounded execution",
        input: task.owner,
        output: null,
        decision: "start-owner-stage",
      });
      append({ ts: ts(), kind: "TASK_STARTED", task_id: task.id });

      const composition = await options.compose(task, orchestrator);
      let result: AgentExecutorResult | undefined;
      let request: AgentExecutorRequest | undefined;
      const capture: AgentExecutor = async (req) => {
        request = req;
        result = await composition.executor(req);
        return result;
      };
      await orchestrator.step(capture);
      if (!result || !request) throw new Error(`owner executor for ${task.id} returned no result`);
      const completed = result as AgentExecutorResult;
      const verification = composition.verificationFor(task.id);

      if (!verification && completed.outcome.result === "FAIL") {
        const reason = failureReason(completed);
        append({ ts: ts(), kind: "TASK_FAILED", task_id: task.id, reason, class: failureClass(completed) });
        append({ ts: ts(), kind: "RUN_HALTED", reason });
        log(`[orchestrator] HALTED at ${task.id}: ${reason}`);
        return 1;
      }

      append({ ts: ts(), kind: "TASK_AGENT_DONE", task_id: task.id });
      const gateResult = verification?.status === "passed" && verification.passed
        ? "passed"
        : verification?.status === "failed" || verification?.passed === false
          ? "failed"
          : "unverified";
      append({
        ts: ts(),
        kind: "GATE_RESULT",
        task_id: task.id,
        result: gateResult,
        summary: verification ? renderDeterministicVerification(verification).join("\n") : "no deterministic verification evidence",
      });
      if (!verification || gateResult !== "passed" || completed.outcome.result === "FAIL") {
        const reason = verification
          ? renderDeterministicVerification(verification).join("\n")
          : failureReason(completed);
        append({ ts: ts(), kind: "TASK_FAILED", task_id: task.id, reason, class: "deterministic-gate" });
        append({ ts: ts(), kind: "RUN_HALTED", reason });
        log(`[orchestrator] HALTED at ${task.id}: ${reason}`);
        return 1;
      }

      try {
        const checkpoint = await checkpointTask({
          git,
          adapter: { status: "OK", exitCode: 0 },
          writableRoots: [options.manifest.target_root],
          runVerification: async () => verification,
          runId: options.manifest.run_id,
          taskId: task.id,
          module: options.manifest.module,
          planHash: options.manifest.plan_hash,
          taskDescription: taskObjective(task),
          secretScanner: options.secretScanner,
        });
        append({ ts: ts(), kind: "TASK_CHECKPOINTED", task_id: task.id, sha: checkpoint.sha });
        checkpointed.add(task.id);
        log(`[orchestrator] ${task.id} CHECKPOINTED at ${checkpoint.sha}; this is not VERIFIED, SECURITY_APPROVED, or MERGE_READY.`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const kind = error instanceof CheckpointRefusal ? error.kind : "git";
        append({ ts: ts(), kind: "TASK_FAILED", task_id: task.id, reason, class: kind });
        append({ ts: ts(), kind: "RUN_HALTED", reason });
        log(`[orchestrator] HALTED before checkpointing ${task.id}: ${reason}`);
        return 1;
      }
    }

    append({ ts: ts(), kind: "RUN_COMPLETED" });
    append({ ts: ts(), kind: "HUMAN_REVIEW_REQUIRED" });
    log(`[orchestrator] ${options.manifest.task_order.length} tasks CHECKPOINTED — none verified. Next: qa-engineer.`);
    log(`[orchestrator] wave ${options.manifest.wave} boundary reached; human review is required. Checkpoints are not verification or approval.`);
    const advisory = await deriveMergeAdvisory(options.manifest, state, git);
    for (const line of renderMergeAdvisory(options.manifest, advisory)) log(line);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (["TASK_READY", "TASK_RUNNING", "VALIDATING"].includes(state)) {
      const taskId = options.manifest.task_order.find((id) => !checkpointed.has(id));
      if (state === "TASK_RUNNING" || state === "VALIDATING") {
        if (taskId) append({ ts: ts(), kind: "TASK_FAILED", task_id: taskId, reason, class: "orchestrator" });
      }
      if (state === "TASK_READY" || state === "HALTED") append({ ts: ts(), kind: "RUN_HALTED", reason });
    }
    log(`[orchestrator] bounded run halted: ${reason}`);
    return 1;
  } finally {
    if (lockHeld) releaseWorkspaceRunLock(options.projectRoot, options.manifest.target_root, options.manifest.run_id);
  }
}
