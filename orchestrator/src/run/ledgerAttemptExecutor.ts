import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { LedgerAttempt, LedgerRun, RunLedger } from "../ledger/runLedger.js";
import { freezeAttempt } from "../ledger/attemptFreeze.js";
import { getAgent } from "../agents/registry.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import { stageWritesBoundTarget, type RuntimeTask } from "../orchestrator/runtimeTask.js";
import type { PersistedTask, TaskStore } from "../store/taskStore.js";
import type { GuardResolver } from "../runtime/runtimeGuards.js";
import type { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { resolveRuntimeRoute, type RuntimeRouteFlags } from "../runtime/runtimeRouting.js";
import { loadModelTierPolicy } from "../runtime/modelTiers.js";
import { detectRuntimeCapabilities } from "../runtime/runtimeCapabilityDetection.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { riskSignalsFromClassification } from "../qa/optimized.js";
import { failResult } from "../runtime/agentRunAssembly.js";
import { writeExecutionPacket, nextExecutionPacketAttempt } from "../state/runtimeArtifacts.js";
import type { DependencyEvidence } from "../artifacts/executionPacket.js";
import { GuardedRunError, GuardedRunSession, runningAttempts } from "../git/guardedRun.js";
import type { GitCommandLayer } from "../git/commandLayer.js";
import type { SecretScanner } from "../git/checkpoint.js";

/**
 * The bounded run's Target-mutation boundary as an executor decorator
 * (V13 TASK-007).
 *
 * A bounded run executes its tasks through the one engine
 * (`engine/taskRunService.ts`) with the same executor composition `sta run`
 * uses. What it adds is not a stage, an evidence rule or a completion rule -
 * it is where the engineer's writes land: one frozen ledger attempt per
 * engineer dispatch, one run branch, one writer at a time, and one exact Git
 * checkpoint per successful attempt (`git/guardedRun.ts`).
 *
 * The engine decides everything else. This decorator never sets a ledger
 * task or run status and never moves a task: a refused freeze or a refused
 * checkpoint is returned as a FAIL result, so the orchestrator records a
 * failed role-run and the stage stays incomplete - exactly what it would do
 * for any failed stage. A successful inner result is returned unchanged, so
 * the evidence the engine records and requires is the composition's own.
 *
 * Non-engineer stages (reviewer, QA, security) pass straight through: they
 * write no Target code and get no attempt and no checkpoint.
 */

const TARGET_WRITERS: ReadonlySet<AgentStage> = new Set([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);

/** The runtime a stage defaults to and the operator's route flags - the same selection the executor composition makes. */
export interface AttemptRuntimeSelection {
  defaultRuntimeId: string;
  routingFlags?: RuntimeRouteFlags;
}

export interface FreezeRequest {
  run: LedgerRun;
  task: PersistedTask;
  stage: AgentStage;
}

/** A frozen attempt and the checkpoint scope its packet declared, or why no attempt can be frozen. */
export type FreezeOutcome =
  | {
      kind: "frozen";
      attempt: LedgerAttempt;
      taskDescription: string;
      allowedPathGlobs: readonly string[];
      deniedPathGlobs: readonly string[];
    }
  | { kind: "refused"; reason: string };

export interface LedgerAttemptBoundaryOptions {
  ledger: RunLedger;
  runId: string;
  store: TaskStore;
  /** Where packets land (the frozen run's Knowledge root). */
  runtimeStateRoot: string;
  /** Contract/agent-registry authority for route resolution. */
  contractRoot: string;
  registry: RuntimeRegistry;
  runtimeSelection: (taskId: string) => AttemptRuntimeSelection;
  /** The plan's advisory task tier, routed exactly as the executor composition routes it (`plannedTier`). */
  taskTier?: (taskId: string) => string | undefined;
  guards: GuardResolver;
  dependencyEvidence: (taskId: string) => DependencyEvidence[];
  adapterVersion: string;
  git?: GitCommandLayer;
  secretScanner?: SecretScanner;
  now?: () => number;
  /** Test seam: freezes an attempt in place of the production route/packet compile. */
  freeze?: (request: FreezeRequest) => Promise<FreezeOutcome>;
}

/** One human-readable line for the checkpoint commit message. */
function taskDescriptionFor(taskId: string, runtimeTask: RuntimeTask | null | undefined): string {
  if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) return `execute ${taskId}`;
  return `${taskId}: ${runtimeTask.contract.title || runtimeTask.contract.objective}`;
}

function usageFrom(outcome: AgentExecutorResult["outcome"]): LedgerAttempt["usage"] {
  return {
    input_tokens: outcome.input_tokens ?? null,
    output_tokens: outcome.output_tokens ?? null,
    cache_read_tokens: outcome.cache_read_tokens ?? null,
    cache_creation_tokens: outcome.cache_creation_tokens ?? null,
    cost_usd: outcome.cost ?? null,
  };
}

/** The stage's work root in its compiled RuntimeTask, or the run's frozen Target root. */
export function workRootForStage(runtimeTask: RuntimeTask | null | undefined, stage: AgentStage, fallbackRoot: string): string {
  if (runtimeTask && "version" in runtimeTask && runtimeTask.version === 2) {
    const matching = runtimeTask.scope.work_roots.find((r) => r.stage === stage);
    if (matching?.root) return matching.root;
  }
  return fallbackRoot;
}

/**
 * Every writable root the stage resolves. A bounded run commits through one
 * `GuardedRunSession` bound to `run.target_root`, so more than one is refused
 * before any route probe, packet or adapter - naming the split to make.
 * `access` is unset on the legacy/`--target-root` path, where the stage's root
 * is its write target by construction; only an explicit "read" excludes.
 */
function writableRootsForStage(runtimeTask: RuntimeTask | null | undefined, stage: AgentStage): readonly string[] {
  if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) return [];
  return [
    ...new Set(
      runtimeTask.scope.work_roots
        .filter((r) => r.stage === stage && r.access !== "read")
        .map((r) => path.resolve(r.root)),
    ),
  ];
}

/** The FAIL result a refused boundary returns: a person reads why; the engine records it as a failed role-run. */
function refusal(stage: AgentStage, taskId: string, reason: string, inner?: AgentExecutorResult): AgentExecutorResult {
  const failure: StructuredFailure = {
    category: "unknown",
    owner: AgentStage.HUMAN,
    severity: "high",
    retryable: false,
    reason,
    affected: [taskId],
    requiresHuman: true,
  };
  const base = inner ?? failResult(reason);
  return { ...base, outcome: { ...base.outcome, result: "FAIL", failure_reason: reason }, failure };
}

export class LedgerAttemptBoundary {
  private readonly ledger: RunLedger;
  private readonly now: () => number;
  private session: GuardedRunSession | null = null;
  /** The attempt the inner runtime executor must run under right now, keyed `${taskId}\0${stage}`. */
  private current: { key: string; attempt: LedgerAttempt } | null = null;

  constructor(private readonly options: LedgerAttemptBoundaryOptions) {
    this.ledger = options.ledger;
    this.now = options.now ?? Date.now;
  }

  private run(): LedgerRun {
    const run = this.ledger.readRun(this.options.runId);
    if (!run) throw new Error(`run ${this.options.runId} does not exist`);
    return run;
  }

  /**
   * Before anything is dispatched: settles the one attempt a crash may have
   * left RUNNING. Keyed on the ledger *attempt* (V13 TASK-007), never on a
   * task status. A clean branch whose HEAD is an unrecorded commit carrying
   * that attempt's exact trailers is re-attributed as its checkpoint (no
   * second commit); a clean branch at a known revision means the attempt
   * never committed, so it is abandoned; a dirty branch refuses (`open`).
   * More than one RUNNING attempt violates the one-writer invariant.
   */
  async reconcileInterrupted(): Promise<{ kind: "none" } | { kind: "reattributed"; attemptId: string; sha: string } | { kind: "abandoned"; attemptId: string }> {
    const running = runningAttempts(this.ledger, this.options.runId);
    if (running.length === 0) return { kind: "none" };
    if (running.length > 1) {
      throw new GuardedRunError("MULTIPLE_WRITERS", `one-writer invariant violated: ${running.length} attempts are RUNNING (${running.map((a) => a.attempt_id).join(", ")})`);
    }
    const attempt = running[0]!;
    const session = await this.openSession(attempt);
    if (session.pendingReconciliation === attempt.attempt_id) {
      const sha = await session.reconcileHeadCheckpoint(attempt);
      return { kind: "reattributed", attemptId: attempt.attempt_id, sha };
    }
    await session.abandonInterruptedAttempt(attempt, "interrupted before any checkpoint; the run branch shows no work of this attempt");
    return { kind: "abandoned", attemptId: attempt.attempt_id };
  }

  /** What `createRuntimeExecutor`'s `frozenAttemptFor` reads: the attempt the given dispatch runs under, if any. */
  frozenAttemptFor = (taskId: string, stage: AgentStage): LedgerAttempt | undefined => {
    return this.current?.key === `${taskId}\0${stage}` ? this.current.attempt : undefined;
  };

  /** Wraps one task's production executor. */
  decorate(inner: AgentExecutor): AgentExecutor {
    return async (req) => (TARGET_WRITERS.has(req.stage) ? this.executeEngineer(inner, req) : inner(req));
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  private async openSession(firstAttempt: LedgerAttempt): Promise<GuardedRunSession> {
    if (!this.session) {
      this.session = await GuardedRunSession.open({
        ledger: this.ledger,
        runId: this.options.runId,
        runtimeStateRoot: this.options.runtimeStateRoot,
        git: this.options.git,
        firstAttempt,
        now: this.now,
      });
    }
    return this.session;
  }

  private async executeEngineer(inner: AgentExecutor, req: AgentExecutorRequest): Promise<AgentExecutorResult> {
    const run = this.run();
    const task = this.options.store.loadTask(req.taskId);
    if (!task || !this.ledger.readTask(run.run_id, req.taskId)) {
      return refusal(req.stage, req.taskId, `task ${req.taskId} is not part of bounded run ${run.run_id}; it has no attempt boundary`);
    }

    let frozen: Extract<FreezeOutcome, { kind: "frozen" }>;
    try {
      const outcome = await (this.options.freeze ?? ((request) => this.productionFreeze(request)))({ run, task, stage: req.stage });
      if (outcome.kind === "refused") return refusal(req.stage, req.taskId, outcome.reason);
      frozen = outcome;
    } catch (error) {
      return refusal(req.stage, req.taskId, `cannot freeze an attempt for ${req.taskId}/${req.stage}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const persisted = this.ledger.readAttempt(frozen.attempt.attempt_id);
    if (!persisted || persisted.status !== "FROZEN" || persisted.packet_hash !== frozen.attempt.packet_hash) {
      return refusal(req.stage, req.taskId, `attempt ${frozen.attempt.attempt_id} is not left frozen in the ledger`);
    }

    let session: GuardedRunSession;
    try {
      session = await this.openSession(persisted);
      session.beginTask(persisted);
    } catch (error) {
      return refusal(req.stage, req.taskId, error instanceof Error ? error.message : String(error));
    }

    this.current = { key: `${req.taskId}\0${req.stage}`, attempt: persisted };
    let result: AgentExecutorResult;
    try {
      result = await inner(req);
    } catch (error) {
      session.haltActiveAttempt(persisted, `executor threw: ${error instanceof Error ? error.message : String(error)}`, "ABANDONED");
      throw error;
    } finally {
      this.current = null;
    }

    if (result.outcome.result === "FAIL") {
      const reason = result.outcome.failure_reason ?? result.failure?.reason ?? `${req.stage} stage failed`;
      session.haltActiveAttempt(persisted, reason, result.failure?.category === "infrastructure" ? "UNAVAILABLE" : "FAILED");
      return result;
    }
    const verification = result.deterministicVerification;
    if (!verification) {
      const reason = `no deterministic verification evidence was produced for ${req.taskId}/${req.stage}; a bounded run checkpoints only verified work`;
      session.haltActiveAttempt(persisted, reason, "FAILED");
      return refusal(req.stage, req.taskId, reason, result);
    }

    const usage = usageFrom(result.outcome);
    try {
      const unconsumed = await this.unconsumedCheckpoint(session, run, req);
      if (unconsumed) {
        await session.completeWithoutChange(persisted, unconsumed, usage);
      } else {
        await session.checkpoint({
          attempt: persisted,
          adapter: { status: "OK", exitCode: 0 },
          runVerification: async () => verification,
          taskDescription: frozen.taskDescription,
          allowedPathGlobs: frozen.allowedPathGlobs,
          deniedPathGlobs: frozen.deniedPathGlobs,
          secretScanner: this.options.secretScanner,
          usage,
        });
      }
    } catch (error) {
      // The session already failed the attempt (or, for a commit whose ledger
      // write was lost, left it RUNNING for reconciliation on resume).
      return refusal(req.stage, req.taskId, `checkpoint refused: ${error instanceof Error ? error.message : String(error)}`, result);
    }
    return result;
  }

  /**
   * A checkpoint this run recorded for this task that the engine has not yet
   * consumed (more succeeded attempts of this stage than completed stage
   * records) and that is still exactly HEAD on a clean tree - the work of an
   * interrupted attempt that resume re-attributed. A rerun that changed
   * nothing then succeeds without a second commit.
   */
  private async unconsumedCheckpoint(session: GuardedRunSession, run: LedgerRun, req: AgentExecutorRequest): Promise<string | null> {
    const status = (await session.git.statusPorcelainNull()).stdout;
    if (status) return null;
    const checkpoints = this.ledger.checkpointsForRun(run.run_id).filter((item) => item.task_id === req.taskId);
    const latest = checkpoints[checkpoints.length - 1];
    if (!latest) return null;
    const head = (await session.git.revParseHead()).stdout.trim();
    if (head !== latest.sha) return null;
    const succeeded = this.ledger.attemptsForTask(run.run_id, req.taskId).filter((a) => a.stage === req.stage && a.status === "SUCCEEDED").length;
    const completed = this.options.store.eventsForTask(req.taskId).filter((e) => e.type === "STAGE_COMPLETED" && e.payload.stage === req.stage).length;
    return succeeded > completed ? latest.sha : null;
  }

  /** Route resolution, packet compile and attempt freeze for one engineer dispatch. */
  private async productionFreeze(request: FreezeRequest): Promise<FreezeOutcome> {
    const { run, task, stage } = request;
    const options = this.options;
    const runtimeTask = task.runtimeTask;
    if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) {
      return { kind: "refused", reason: `task ${task.taskId} has no canonical RuntimeTask; recompile the plan before a bounded run can freeze it` };
    }
    const role = getAgent(stage).role;
    const writableRoot = workRootForStage(runtimeTask, stage, run.target_root);
    const checkpointableRoots = writableRootsForStage(runtimeTask, stage);
    if (checkpointableRoots.length > 1) {
      return {
        kind: "refused",
        reason:
          `task ${task.taskId} resolves ${checkpointableRoots.length} writable Targets for ${role} ` +
          `(${checkpointableRoots.join(", ")}), but a bounded-run checkpoint commits one Target per attempt. ` +
          "Split the task into one task per Target so each write can be committed.",
      };
    }
    const guards = options.guards(role, writableRoot, { targetSide: stageWritesBoundTarget(runtimeTask, stage) });
    const availability = await options.registry.probeAll();
    const modelPolicy = loadModelTierPolicy(options.runtimeStateRoot);
    const selection = options.runtimeSelection(task.taskId);
    const route = resolveRuntimeRoute({
      role,
      stage,
      projectRoot: options.contractRoot,
      registry: options.registry,
      defaultRuntimeId: selection.defaultRuntimeId,
      flags: selection.routingFlags,
      classification: task.classification,
      riskSignals: riskSignalsFromClassification(task.classification),
      availability,
      hasTargetWrite: true,
      modelPolicy,
      taskTier: options.taskTier?.(task.taskId),
      allowLegacyPolicyCompatibility: true,
    });
    if (route.error || !route.selected) {
      return { kind: "refused", reason: `no runtime route resolved for ${task.taskId}/${role}: ${route.error ?? "no candidate selected"}` };
    }
    const selected = route.selected;
    const capabilityReport = await detectRuntimeCapabilities(selected.runtime, { probe: availability[selected.runtime.id] });

    let dependencyEvidence: DependencyEvidence[];
    try {
      dependencyEvidence = options.dependencyEvidence(task.taskId);
    } catch (error) {
      return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
    // The packet and the attempt answer to the run's frozen base: the run
    // branch above it carries only this run's own recorded checkpoints, which
    // is exactly the uncommitted work `sta run` would have on top of that base
    // (and what the composition's `packetBaseRevision` gives every other stage).
    const baseRevision = run.base_sha;

    const attemptNumber = nextExecutionPacketAttempt(options.runtimeStateRoot, task.taskId, stage);
    const packet = compileExecutionPacket({
      req: { stage, taskId: task.taskId, context: [] },
      role,
      runtimeTask,
      contractScope: { allow: guards.writeAllow, deny: guards.writeDeny },
      attempt: attemptNumber,
      baseRevision,
      config: null,
      dependencyEvidence,
    });
    const persistedPacket = writeExecutionPacket({ projectRoot: options.runtimeStateRoot, packet });
    const packetPath = path.relative(options.runtimeStateRoot, persistedPacket.path).replace(/\\/g, "/");

    let attempt: LedgerAttempt;
    try {
      attempt = freezeAttempt({
        ledger: options.ledger,
        runId: run.run_id,
        taskId: task.taskId,
        stage,
        attempt: attemptNumber,
        requested: { runtime: route.requested.runtimeId, model: route.requested.model, effort: route.requested.effort },
        observed: { runtime: selected.runtime.id, model: selected.model, effort: selected.effort ?? route.effort },
        modelExplicit: selected.modelExplicit ?? false,
        routeBasis: `level-${route.precedenceLevel}`,
        adapterVersion: options.adapterVersion,
        configHash: packet.identity.config_hash,
        planHash: run.plan_hash,
        baseRevision,
        availability: availability[selected.runtime.id],
        capabilityReport,
        targetWrite: true,
        writableRoots: [writableRoot],
        packetHash: packet.packet_hash,
        packetPath,
        startedAt: this.now(),
      });
    } catch (error) {
      return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
    return {
      kind: "frozen",
      attempt,
      taskDescription: taskDescriptionFor(task.taskId, runtimeTask),
      allowedPathGlobs: packet.scope.allow,
      deniedPathGlobs: packet.scope.deny,
    };
  }
}
