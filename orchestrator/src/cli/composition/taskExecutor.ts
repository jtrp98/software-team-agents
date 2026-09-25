import * as path from "node:path";
import { AgentStage, TaskState } from "../../types.js";
import type { Orchestrator, AgentExecutor } from "../../orchestrator/orchestrator.js";
import { createRuntimeExecutor } from "../../runtime/runtimeExecutor.js";
import { withQaOptimization, riskSignalsFromClassification } from "../../qa/optimized.js";
import { collectQaChangedFiles } from "../../qa/changeSource.js";
import { combineProjectRunners, createProjectRunner } from "../../qa/projectRunner.js";
import { createPostDevVerificationHook, withPostDevVerificationDisabled } from "../../qa/verificationHook.js";
import { createDocumentVerificationHook, withDocumentVerificationDisabled } from "../../qa/documentVerificationHook.js";
import { LocalWorkspace } from "../../runtime/localWorkspace.js";
import { loadStaConfig } from "../../packaging/staConfig.js";
import { repairQaSignals } from "../../retry/repairRoute.js";
import { previousRoundFromDocs, productionQaInputs } from "../../qa/productionQaInputs.js";
import { DEFAULT_RUNTIME_ID } from "../../runtime/runtimeRegistry.js";
import { selectTierCamp } from "../../runtime/tierCampSelection.js";
import { resolveFrameworkRoot } from "../../targetcli/roots.js";
import { contractGuardResolver } from "../../runtime/runtimeGuards.js";
import { resolveDocsRoot, resolveQaWorkRoots, resolveThreeRepoTaskLookup } from "../../threeRepo/cliRoots.js";
import { loadStageRoots } from "../../repos/repoMap.js";
import { describeEnvironment } from "../../environment/environment.js";
import { stableHash, contentHash } from "../../artifacts/executionPacket.js";
import { unmetDependencies } from "../../orchestrator/taskStatus.js";
import { verifyTaskCompletion } from "../../orchestrator/transitionGuard.js";
import { RunLog } from "../../observability/runLog.js";
import { contractDigestForStage } from "../../evidence/evidenceStore.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { CliArgs } from "../../cli.js";
import type { RuntimeAutonomy } from "../../runtime/runtimeAdapter.js";
import type { RuntimeId } from "../../runtime/runtimeSupport.js";
import type { RuntimeRouteFlags } from "../../runtime/runtimeRouting.js";
import type { LedgerAttempt } from "../../ledger/runLedger.js";
import type { DependencyEvidence } from "../../artifacts/executionPacket.js";
import type { QaWorkRoot } from "../../threeRepo/cliRoots.js";
import { contractRootForTask, plannedTier, promptForCamp } from "./taskIntake.js";
import { runtimeRegistryFor, type CliDependencies } from "./runtimeRegistry.js";

/** What `composeProductionTaskExecutor` hands the task-run service (`engine/taskRunService.ts`). */
export interface TaskExecutorComposition {
  executor: AgentExecutor;
}

/** The runtime a task's stages default to, and the operator's route flags. */
export interface RuntimeSelection {
  defaultRuntimeId: string;
  routingFlags?: RuntimeRouteFlags;
}

/**
 * Everything the one production executor composition reads (V13 TASK-007).
 * `sta run` derives it from its argv (`taskExecutorOptionsFromArgs`); a
 * bounded run derives it from its own argv plus the frozen run - the same
 * composition either way, so every stage of every task is executed, verified
 * and evidenced identically.
 */
export interface TaskExecutorOptions {
  projectRoot: string;
  module?: string;
  rootName?: string;
  autonomy?: RuntimeAutonomy;
  runtime?: RuntimeId;
  model?: string;
  effort?: string;
  phases: readonly number[];
  noDeterministicGate: boolean;
  noQaOptimization: boolean;
  noDocumentGate: boolean;
  /** Where packets and runtime artifacts land; absent = the executor's own rule (the Knowledge root of a three-repo task, else the project root). */
  runtimeStateRoot?: string;
  /** Per-stage execution roots; absent = `repos.yaml` (`loadStageRoots`). */
  stageRoots?: Partial<Record<AgentStage, string>>;
  /** The Target roots the deterministic sweep and QA read; absent = `resolveQaWorkRoots`. */
  qaWorkRoots?: () => QaWorkRoot[];
  /** The frozen ledger attempt a stage executes under (a bounded run's engineer stage); undefined = routed normally. */
  frozenAttemptFor?: (taskId: string, stage: AgentStage) => LedgerAttempt | undefined;
  /**
   * The revision a stage's packet (and its design-evidence check) answers to;
   * absent = the execution root's HEAD. A bounded run passes its frozen base:
   * the run branch above it carries only that run's own recorded checkpoints -
   * the same work `sta run` would have uncommitted on top of the same base.
   */
  packetBaseRevision?: (root: string) => Promise<string>;
  /** The runtime selection per task; absent = `selectRuntime`. */
  runtimeSelection?: (taskId: string) => RuntimeSelection;
}

export function taskExecutorOptionsFromArgs(args: CliArgs): TaskExecutorOptions {
  return {
    projectRoot: args.projectRoot,
    module: args.module,
    rootName: args.rootName,
    autonomy: args.autonomy,
    runtime: args.runtime,
    model: args.model,
    effort: args.effort,
    phases: args.phases,
    noDeterministicGate: args.noDeterministicGate,
    noQaOptimization: args.noQaOptimization,
    noDocumentGate: args.noDocumentGate,
  };
}

/**
 * The runtime a task's stages default to: the tier camp for a tiered phase,
 * else `--runtime`, else the configured Single runner, else the default - and
 * the operator's `--runtime/--model/--effort` as route flags.
 */
export function selectRuntime(options: TaskExecutorOptions, taskId: string): RuntimeSelection {
  let staConfig: ReturnType<typeof loadStaConfig> | undefined;
  try {
    staConfig = loadStaConfig(options.projectRoot);
  } catch {
    staConfig = undefined;
  }
  const executionConfig = staConfig?.execution;
  const phaseTier = plannedTier(options, taskId);
  const tierCamp = phaseTier
    ? selectTierCamp({
        flagRuntime: options.runtime,
        configuredRuntime: executionConfig?.runner,
        hasConfiguredRoleRoute: staConfig?.routing?.by_role !== undefined,
        isTTY: process.stdin.isTTY === true,
        defaultRuntimeId: DEFAULT_RUNTIME_ID,
        prompt: () => promptForCamp(DEFAULT_RUNTIME_ID),
      })
    : undefined;
  const defaultRuntimeId = tierCamp?.runtimeId ?? options.runtime ?? executionConfig?.runner ?? DEFAULT_RUNTIME_ID;
  const routingFlags = options.runtime || options.model || options.effort
    ? { runtime: options.runtime, model: options.model, effort: options.effort }
    : undefined;
  return { defaultRuntimeId, ...(routingFlags ? { routingFlags } : {}) };
}

/**
 * The dependency evidence a task's packet is compiled with: every dependency
 * re-verified Done against the evidence store (never read off a state name).
 */
export function dependencyEvidenceFromStore(store: TaskStore, taskId: string): DependencyEvidence[] {
  const task = store.loadTask(taskId);
  const all = store.listTasks();
  return (task?.dependsOn ?? []).map(dependencyId => {
    const dependency = store.loadTask(dependencyId);
    // Done is re-verified against the evidence store, not read off the state name.
    const completion = dependency ? verifyTaskCompletion(store, dependency) : null;
    if (!dependency || !completion?.done || dependency.paused || dependency.cancelled || unmetDependencies(dependency, all).length) throw new Error(`dependency ${dependencyId} lacks complete ledger evidence${completion && !completion.done ? ` (${completion.reason})` : ""}`);
    return {
      task_id: dependencyId, status: "complete" as const, source: `task-store:${dependencyId}`, hash: stableHash(dependency),
      outputs: Object.entries(dependency.artifacts).map(([kind, text]) => ({ source: `task-store:${dependencyId}/artifacts/${kind}`, hash: contentHash(text) })),
    };
  });
}

/** The single production executor composition: `sta run` and a bounded run compose every stage here. */
export async function composeProductionTaskExecutor(
  options: TaskExecutorOptions,
  taskId: string,
  orchestrator: Orchestrator,
  store: TaskStore,
  dependencies: CliDependencies = {},
): Promise<TaskExecutorComposition> {
  const task = store.loadTask(taskId);
  if (!task) throw new Error(`cannot compose an executor for missing task ${taskId}`);
  // DR §5: a resumed task answers to the root frozen at intake - the
  // invocation's --root (if any) already passed the drift assertion at
  // intake, so the frozen name is what every root resolution below uses.
  const runRootName = options.rootName ?? task.knowledgeRoot?.name ?? undefined;
  const contractRoot = contractRootForTask();
  const resolvedAutonomy = options.autonomy ?? "propose";
  if (resolvedAutonomy === "propose") {
    console.error(
      "[orchestrator] WARNING: autonomy is 'propose' (the default), which maps to permission mode 'default' — " +
        "a headless child cannot approve writes or commands, so engineer stages will fail on their first write. " +
        "For an unattended run pass --autonomy edit (or full); hooks and contracts stay enforced either way.",
    );
  }

  const { defaultRuntimeId, routingFlags } = (options.runtimeSelection ?? ((id: string) => selectRuntime(options, id)))(taskId);
  const runtimeRegistry = runtimeRegistryFor(options.projectRoot, dependencies);
  const defaultRuntime = runtimeRegistry.tryGet(defaultRuntimeId);
  if (!defaultRuntime) throw new Error(`configured Single runner "${defaultRuntimeId}" is not registered`);
  const qaWorkRoots = options.qaWorkRoots ?? (() => resolveQaWorkRoots(options.projectRoot, taskId, store, options.module, runRootName));
  const runtimeExecutor = createRuntimeExecutor({
    runtime: defaultRuntime,
    registry: runtimeRegistry,
    routingFlags,
    planTier: (id) => plannedTier(options, id),
    classification: (id) => store.loadTask(id)?.classification,
    riskSignals: (id) => {
      const classification = store.loadTask(id)?.classification;
      return classification ? riskSignalsFromClassification(classification) : undefined;
    },
    projectRoot: options.projectRoot,
    ...(options.runtimeStateRoot ? { runtimeStateRoot: options.runtimeStateRoot } : {}),
    moduleName: () => options.module!,
    guards: contractGuardResolver(contractRoot),
    phases: () => (options.phases.length > 0 ? [...options.phases] : undefined),
    runtimeTask: (id) => store.loadTask(id)?.runtimeTask,
    priorContractDigest: (id, stage) => contractDigestForStage(store.evidenceForTask(id), stage),
    dependencyEvidence: (id) => dependencyEvidenceFromStore(store, id),
    taskRunLog: (id) => new RunLog(store.runsForTask(id)),
    autonomy: options.autonomy,
    stageRoots: options.stageRoots ?? loadStageRoots(options.projectRoot),
    threeRepoTask: resolveThreeRepoTaskLookup(options.projectRoot, store, options.module, runRootName),
    ...(options.frozenAttemptFor ? { frozenAttemptFor: options.frozenAttemptFor } : {}),
    ...(options.packetBaseRevision ? { packetBaseRevision: options.packetBaseRevision } : {}),
    extraInstruction: `Environment: ${orchestrator.environment} — ${describeEnvironment(orchestrator.environment, options.projectRoot)}`,
    // T-V8-011 — feeds a real diff into task-specific retrieval when one
    // exists (a QA round, a repair attempt); a fresh DEV round simply has none yet.
    changedFiles: async (id) => {
      try {
        const roots = id === taskId ? qaWorkRoots() : resolveQaWorkRoots(options.projectRoot, id, store, options.module, runRootName);
        const { files } = await collectQaChangedFiles(roots);
        return files;
      } catch {
        return [];
      }
    },
  });

  const qaRoots = qaWorkRoots();
  const qaChangedFiles = async (): Promise<string[]> => {
    const roots = qaWorkRoots();
    const { files } = await collectQaChangedFiles(roots);
    return files;
  };
  // Resolved once, before composition: the contract carries the real file
  // manifest, and `withQaOptimization`'s contract hook is synchronous because
  // a packet's identity must not depend on a call that can still be in flight.
  const qaDiscovery = await collectQaChangedFiles(qaRoots).catch(() => ({ files: [] as string[], failedTargets: [] as string[] }));
  const qaContractChangedFiles = qaDiscovery.files;
  const qaInputs = await productionQaInputs({
    docsRoot: resolveDocsRoot(options.projectRoot, runRootName),
    moduleName: options.module ?? "",
    taskId,
    roots: qaRoots,
    projectRoot: options.projectRoot,
    changedFiles: qaContractChangedFiles,
    unreadableTargets: qaDiscovery.failedTargets.length > 0 ? qaDiscovery.failedTargets : undefined,
  });

  const verificationHook = options.noDeterministicGate
    ? null
    : createPostDevVerificationHook({
        inner: runtimeExecutor,
        deterministicRunner: () => combineProjectRunners(qaRoots.map((root) => ({
          targetId: root.targetId,
          root: root.path,
          runner: createProjectRunner({
            root: root.path,
            workspace: new LocalWorkspace({ root: root.path }),
            staticGatePath: path.join(options.projectRoot, ".claude", "scripts", "static-analysis-gate.js"),
          }),
        }))),
        requiredVerification: () => orchestrator.runtimeTask?.required_verification,
        ...(options.noQaOptimization
          ? {}
          : {
              changeAware: {
                changedFiles: qaChangedFiles,
                scopeInputs: qaInputs.scopeInputs,
                projectRoot: resolveFrameworkRoot(),
                workflow: orchestrator.runtimeTask?.workflow ?? "",
                classification: orchestrator.classification,
              },
            }),
      });
  const postDevExecutor = verificationHook?.executor ?? withPostDevVerificationDisabled(runtimeExecutor);
  const documentHook = options.noDocumentGate
    ? null
    : createDocumentVerificationHook({
        inner: postDevExecutor,
        projectRoot: resolveDocsRoot(options.projectRoot, runRootName),
        moduleName: options.module,
        blocking: true,
      });
  const docVerifiedExecutor = documentHook?.executor ?? withDocumentVerificationDisabled(postDevExecutor);
  const executor = options.noQaOptimization
    ? docVerifiedExecutor
    : withQaOptimization({
        inner: docVerifiedExecutor,
        changedFiles: qaChangedFiles,
        ...(options.noDeterministicGate
          ? { deterministicGate: "disabled" as const }
          : { deterministicGate: "enabled" as const }),
        packageInputs: qaInputs.packageInputs,
        scopeInputs: qaInputs.scopeInputs,
        taskContract: qaInputs.taskContract,
        // T-V8-015: a repair whose route demands FULL cannot be discharged by
        // a TARGETED round. Read live from the orchestrator (a derivation of
        // the persisted last failure), so a resumed repair round is held to
        // the same requirement as the one that raised it.
        riskSignals: () => ({
          ...riskSignalsFromClassification(orchestrator.classification),
          ...orchestrator.repairRoute ? repairQaSignals(orchestrator.repairRoute) : {},
        }),
        taskLevel: () => orchestrator.classification.level,
        previousRound: () => previousRoundFromDocs(resolveDocsRoot(options.projectRoot, runRootName), options.module ?? "", taskId),
      });

  return { executor };
}
