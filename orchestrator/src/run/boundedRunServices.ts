import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { LedgerAttempt, LedgerRun, LedgerTask, RunLedger } from "../ledger/runLedger.js";
import { freezeAttempt } from "../ledger/attemptFreeze.js";
import type {
  AttemptExecutionResult,
  BoundedRunServices,
  PrepareTaskResult,
  PreparedTargetAttempt,
  QaControllerResult,
  RepairInstruction,
} from "./boundedRunController.js";
import { getAgent } from "../agents/registry.js";
import type { AgentExecutorResult } from "../orchestrator/orchestrator.js";
import type { RuntimeGuards, RuntimeAutonomy } from "../runtime/runtimeAdapter.js";
import type { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { resolveRuntimeRoute, type RuntimeRouteFlags } from "../runtime/runtimeRouting.js";
import { detectRuntimeCapabilities } from "../runtime/runtimeCapabilityDetection.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { writeExecutionPacket, nextExecutionPacketAttempt } from "../state/runtimeArtifacts.js";
import { createRuntimeExecutor } from "../runtime/runtimeExecutor.js";
import { createPostDevVerificationHook } from "../qa/verificationHook.js";
import { withQaOptimization, riskSignalsFromClassification } from "../qa/optimized.js";
import { routeRepair } from "../retry/repairRoute.js";
import { resolveTargetRevision } from "../codeintel/targetRevision.js";
import type { TaskGraph } from "../graph/taskGraph.js";
import type { TaskStore } from "../store/taskStore.js";
import { stableHash, type DependencyEvidence } from "../artifacts/executionPacket.js";
import { readModuleDoc } from "../agents/moduleDocs.js";
import { parseOpenIssues } from "../orchestrator/failureClassifier.js";
import { productionQaInputs } from "../qa/productionQaInputs.js";
import type { SecretScanner } from "../git/checkpoint.js";
import { combineProjectRunners, createProjectRunner } from "../qa/projectRunner.js";
import { LocalWorkspace } from "../runtime/localWorkspace.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { evaluateUnattendedGate, renderUnattendedGate } from "./unattendedGate.js";

/**
 * T-V8-021 — the real `BoundedRunServices` behind the bounded-run CLI.
 *
 * `BoundedRunController` (T-V8-020) already ships tested against fakes; this
 * is the production wiring the CLI needed and nothing built until now
 * supplied. `prepareTask` resolves the route, compiles and freezes one
 * attempt; `executeAttempt` drives the real runtime through the already-
 * shipped `frozenAttempt` seam (T-V8-018), exactly the way the single-task
 * CLI path invokes it; `runQa`/`runAnalysisRepair` reuse the same QA
 * composition (`withQaOptimization`, `productionQaInputs`) the single-task
 * path builds, against the module's own `review.md` rather than a per-
 * attempt packet — coherent QA reviews a checkpointed *set*, not one
 * RuntimeTask, so it deliberately runs unfrozen (no ledger attempt of its
 * own): the controller does not require one for the QA round the way it does
 * for a DAG task attempt.
 *
 * Known, accepted gap (recorded in Round 12 evidence, not hidden here):
 * `prepareTask` compiles a packet once to obtain the hash `freezeAttempt`
 * requires; `executeAttempt`'s call into `createRuntimeExecutor` recompiles
 * the same packet from the same deterministic inputs (a second
 * `nextExecutionPacketAttempt` counter tick, so the bytes on disk carry a
 * different `attempt` number than the frozen `packet_hash` names). Nothing in
 * the shipped T-V8-018 code cross-checks the two at first execution — only
 * `assertAttemptResumable` compares them, and only on a resume. Closing that
 * gap means changing `runtimeExecutor.ts`'s packet-compile step itself
 * (replay the frozen packet rather than recompiling), which is out of this
 * task's named scope and risk budget.
 */

export interface BoundedRunServiceOptions {
  ledger: RunLedger;
  /** Contract/agent-registry authority (the Framework root for a three-repo task; the project root otherwise). */
  projectRoot: string;
  /** Where DEV/QA actually execute and where Git checkpoints land. */
  targetRoot: string;
  /** Where `.workflow/packets/...` and other runtime artifacts are written. */
  runtimeStateRoot: string;
  store: TaskStore;
  registry: RuntimeRegistry;
  defaultRuntimeId: string;
  routingFlags?: RuntimeRouteFlags;
  moduleName: string;
  docsRoot: string;
  guards: (role: string, layoutRoot?: string) => RuntimeGuards;
  autonomy?: RuntimeAutonomy;
  adapterVersion: string;
  graph?: TaskGraph;
  secretScanner?: SecretScanner;
  now?: () => number;
}

function dependencyEvidenceFor(ledger: RunLedger, runId: string, task: LedgerTask): DependencyEvidence[] {
  return task.depends_on.map((depId) => {
    const dep = ledger.readTask(runId, depId);
    if (!dep || (dep.status !== "DONE" && dep.status !== "CHECKPOINTED")) {
      throw new Error(`dependency ${depId} lacks complete ledger evidence for task ${task.task_id}`);
    }
    return {
      task_id: depId,
      status: "complete" as const,
      source: `ledger:${runId}:${depId}`,
      hash: stableHash({ run_id: runId, task_id: depId, task_hash: dep.task_hash, status: dep.status }),
      outputs: dep.produces.map((produced) => ({
        source: `ledger:${runId}:${depId}#${produced}`,
        hash: stableHash({ run_id: runId, task_id: depId, produced, task_hash: dep.task_hash }),
      })),
    };
  });
}

/** One human-readable line for the checkpoint commit trailer/message. */
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

/** The three-way provider/runtime split the retired wave runner also used: quota and infrastructure are not task defects. */
function failureCategory(result: AgentExecutorResult): "quota" | "unavailable" | "runtime" {
  const text = `${result.outcome.failure_reason ?? ""} ${result.failure?.reason ?? ""}`;
  if (/quota|rate.?limit|usage.?limit/i.test(text)) return "quota";
  if (result.failure?.category === "infrastructure") return "unavailable";
  return "runtime";
}

export function createProductionBoundedRunServices(options: BoundedRunServiceOptions): BoundedRunServices {
  const now = options.now ?? Date.now;

  function requireDefaultRuntime() {
    const runtime = options.registry.tryGet(options.defaultRuntimeId);
    if (!runtime) throw new Error(`configured runtime "${options.defaultRuntimeId}" is not registered`);
    return runtime;
  }

  function deterministicRunner() {
    return combineProjectRunners([
      {
        root: options.targetRoot,
        runner: createProjectRunner({
          root: options.targetRoot,
          workspace: new LocalWorkspace({ root: options.targetRoot }),
          staticGatePath: path.join(options.projectRoot, ".claude", "scripts", "static-analysis-gate.js"),
        }),
      },
    ]);
  }

  async function prepareTask(task: LedgerTask, context: { repair: RepairInstruction | null }): Promise<PrepareTaskResult> {
    const run = options.ledger.readRun(task.run_id);
    if (!run) return { kind: "halt", reason: `run ${task.run_id} no longer exists` };
    const persisted = options.store.loadTask(task.task_id);
    const runtimeTask = persisted?.runtimeTask;
    if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) {
      return { kind: "halt", reason: `task ${task.task_id} has no canonical RuntimeTask; recompile the plan before a bounded run can prepare it` };
    }
    // T-V8-029 — the human boundary the retired wave path enforced in
    // `evaluateAutoEligibility`. Evaluated before any route probe or packet
    // compile, so a gated task costs nothing and mutates nothing.
    const gate = evaluateUnattendedGate({
      taskId: task.task_id,
      owner: task.owner,
      classification: persisted?.classification ?? null,
      businessInput: persisted?.gateContext.businessInput ?? null,
      approvals: persisted?.approvals ?? null,
      paused: persisted?.paused,
      cancelled: persisted?.cancelled,
      cancelReason: persisted?.cancelReason ?? null,
    });
    if (gate.length > 0) return { kind: "gate", reason: renderUnattendedGate(task.task_id, gate) };

    const role = getAgent(task.owner).role;
    const targetWrite = task.owner === AgentStage.BACKEND_ENGINEER || task.owner === AgentStage.FRONTEND_ENGINEER;
    const guards = options.guards(role, options.targetRoot);

    const availability = await options.registry.probeAll();
    const route = resolveRuntimeRoute({
      role,
      stage: task.owner,
      projectRoot: options.projectRoot,
      registry: options.registry,
      defaultRuntimeId: options.defaultRuntimeId,
      flags: options.routingFlags,
      classification: persisted?.classification,
      availability,
      hasTargetWrite: targetWrite,
    });
    if (route.error || !route.selected) {
      return { kind: "gate", reason: `no runtime route resolved for ${task.task_id}/${role}: ${route.error ?? "no candidate selected"}` };
    }
    const selected = route.selected;

    const capabilityReport = await detectRuntimeCapabilities(selected.runtime, { probe: availability[selected.runtime.id] });

    let dependencyEvidence: DependencyEvidence[];
    try {
      dependencyEvidence = dependencyEvidenceFor(options.ledger, task.run_id, task);
    } catch (error) {
      return { kind: "halt", reason: error instanceof Error ? error.message : String(error) };
    }

    let baseRevision: string;
    try {
      baseRevision = await resolveTargetRevision(options.targetRoot);
    } catch (error) {
      return { kind: "halt", reason: `cannot resolve base revision for ${options.targetRoot}: ${error instanceof Error ? error.message : String(error)}` };
    }

    const attemptNumber = nextExecutionPacketAttempt(options.runtimeStateRoot, task.task_id, task.owner);
    const repairInstruction = context.repair
      ? `## Targeted repair\n\nThis attempt repairs a QA/security finding, not a fresh implementation.\n` +
        `- reason: ${context.repair.reason}\n` +
        `- finding id(s): ${context.repair.findingIds.join(", ") || "none recorded"}\n` +
        `- invalidated evidence: ${context.repair.invalidates.join(", ") || "none"}\n`
      : undefined;

    let packet;
    try {
      packet = compileExecutionPacket({
        req: { stage: task.owner, taskId: task.task_id, context: [] },
        role,
        runtimeTask,
        contractScope: { allow: guards.writeAllow, deny: guards.writeDeny },
        attempt: attemptNumber,
        baseRevision,
        config: null,
        dependencyEvidence,
        extra: repairInstruction,
      });
    } catch (error) {
      return { kind: "halt", reason: `cannot compile execution packet for ${task.task_id}: ${error instanceof Error ? error.message : String(error)}` };
    }

    const persistedPacket = writeExecutionPacket({ projectRoot: options.runtimeStateRoot, packet });
    const packetPath = path.relative(options.runtimeStateRoot, persistedPacket.path).replace(/\\/g, "/");

    let frozen: LedgerAttempt;
    try {
      frozen = freezeAttempt({
        ledger: options.ledger,
        runId: task.run_id,
        taskId: task.task_id,
        stage: task.owner,
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
        targetWrite,
        writableRoots: targetWrite ? [options.targetRoot] : [],
        packetHash: packet.packet_hash,
        packetPath,
        startedAt: now(),
      });
    } catch (error) {
      return { kind: "gate", reason: error instanceof Error ? error.message : String(error) };
    }

    return {
      kind: "attempt",
      attempt: frozen,
      taskDescription: taskDescriptionFor(task.task_id, runtimeTask),
      allowedPathGlobs: packet.scope.allow,
      secretScanner: options.secretScanner,
    };
  }

  async function executeAttempt(prepared: PreparedTargetAttempt): Promise<AttemptExecutionResult> {
    const attempt = prepared.attempt;
    const runtimeTask = options.store.loadTask(attempt.task_id)?.runtimeTask;
    const role = getAgent(attempt.stage).role;
    const guards = options.guards(role, options.targetRoot);

    const runtimeExecutor = createRuntimeExecutor({
      runtime: requireDefaultRuntime(),
      registry: options.registry,
      projectRoot: options.projectRoot,
      moduleName: () => options.moduleName,
      guards: () => guards,
      autonomy: options.autonomy,
      classification: (id) => options.store.loadTask(id)?.classification,
      runtimeTask: (id) => (id === attempt.task_id ? runtimeTask : options.store.loadTask(id)?.runtimeTask),
      dependencyEvidence: (id) => {
        const t = options.ledger.readTask(attempt.run_id, id);
        return t ? dependencyEvidenceFor(options.ledger, attempt.run_id, t) : [];
      },
      stageRoots: { [attempt.stage]: options.targetRoot },
      frozenAttempt: attempt,
      frozenRoutingBasis: attempt.route_basis,
    });

    const hook = createPostDevVerificationHook({
      inner: runtimeExecutor,
      deterministicRunner,
      requiredVerification: () => (runtimeTask && "version" in runtimeTask && runtimeTask.version === 2 ? runtimeTask.required_verification : undefined),
    });

    const req = { stage: attempt.stage, taskId: attempt.task_id, context: [] };
    const result = await hook.executor(req);
    if (result.outcome.result === "FAIL") {
      return { kind: "halt", reason: result.outcome.failure_reason ?? result.failure?.reason ?? `${role} stage failed`, category: failureCategory(result) };
    }
    const verification = hook.verificationFor(req);
    if (!verification) {
      return { kind: "halt", reason: `no deterministic verification evidence was produced for ${attempt.task_id}`, category: "deterministic" };
    }
    return {
      kind: "completed",
      adapter: { status: "OK", exitCode: 0 },
      verification,
      usage: usageFrom(result.outcome),
    };
  }

  async function runQa(input: { run: LedgerRun; tasks: readonly LedgerTask[]; round: number }): Promise<QaControllerResult> {
    const checkpointed = input.tasks.filter((task) => task.status === "CHECKPOINTED" || task.status === "DONE");
    if (checkpointed.length === 0) return { kind: "halt", reason: "coherent QA round has no checkpointed task to review" };
    const representative = checkpointed[checkpointed.length - 1]!.task_id;
    const representativeTask = options.store.loadTask(representative);
    if (!representativeTask) return { kind: "halt", reason: `checkpointed task ${representative} is missing from the task store` };

    const role = getAgent(AgentStage.QA_ENGINEER).role;
    const guards = options.guards(role, options.targetRoot);
    const qaExecutor = createRuntimeExecutor({
      runtime: requireDefaultRuntime(),
      registry: options.registry,
      projectRoot: options.projectRoot,
      moduleName: () => options.moduleName,
      guards: () => guards,
      autonomy: options.autonomy,
      classification: (id) => options.store.loadTask(id)?.classification,
      stageRoots: { [AgentStage.QA_ENGINEER]: options.targetRoot },
    });

    const qaInputs = await productionQaInputs({
      docsRoot: options.docsRoot,
      moduleName: options.moduleName,
      taskId: representative,
      roots: [options.targetRoot],
      projectRoot: options.projectRoot,
      changedFiles: [],
    });

    const executor = withQaOptimization({
      inner: qaExecutor,
      changedFiles: async () => [],
      deterministicGate: "disabled",
      packageInputs: qaInputs.packageInputs,
      scopeInputs: qaInputs.scopeInputs,
      taskContract: qaInputs.taskContract,
      riskSignals: () => riskSignalsFromClassification(representativeTask.classification),
      taskLevel: () => representativeTask.classification.level,
    });

    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: representative, context: [], qaRound: input.round });
    if (result.outcome.result === "PASS") {
      return { kind: "pass", evidence: result.outcome.failure_reason ?? `round ${input.round}: review.md verdict PASS` };
    }
    const category = failureCategory(result);
    if (category !== "runtime" || !result.failure) {
      return { kind: category === "quota" ? "halt" : "gate", reason: result.outcome.failure_reason ?? result.failure?.reason ?? "QA round did not pass" };
    }

    const route = routeRepair({
      finding: {
        task_id: representative,
        category: result.failure.category,
        owner: result.failure.owner,
        retryable: result.failure.retryable,
        requires_human: result.failure.requiresHuman,
      },
      pipeline: representativeTask.classification.pipeline,
      graph: options.graph,
    });
    if (route.owner === "human") return { kind: "gate", reason: route.reason };

    const reviewMd = readModuleDoc(options.docsRoot, options.moduleName, "review.md") ?? "";
    const findingIds = parseOpenIssues(reviewMd).map((_, index) => `F${index + 1}`);
    return {
      kind: "repair",
      evidence: result.outcome.failure_reason ?? route.reason,
      repair: {
        taskId: representative,
        owner: route.owner,
        reason: route.reason,
        findingIds,
        invalidates: route.invalidates,
        requiresHuman: false,
      },
    };
  }

  async function runAnalysisRepair(instruction: RepairInstruction): Promise<{ kind: "completed" } | { kind: "gate"; reason: string } | { kind: "halt"; reason: string }> {
    const role = getAgent(instruction.owner).role;
    const guards = options.guards(role, options.targetRoot);
    const executor = createRuntimeExecutor({
      runtime: requireDefaultRuntime(),
      registry: options.registry,
      projectRoot: options.projectRoot,
      moduleName: () => options.moduleName,
      guards: () => guards,
      autonomy: options.autonomy,
      classification: (id) => options.store.loadTask(id)?.classification,
      stageRoots: { [instruction.owner]: options.targetRoot },
      extraInstruction: `Repair requested by coherent QA: ${instruction.reason}`,
    });
    const result = await executor({ stage: instruction.owner, taskId: instruction.taskId, context: [] });
    if (result.outcome.result === "PASS") return { kind: "completed" };
    return { kind: "gate", reason: result.outcome.failure_reason ?? `${role} analysis repair for ${instruction.taskId} did not complete` };
  }

  return { prepareTask, executeAttempt, runQa, runAnalysisRepair };
}
