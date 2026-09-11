import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage, TaskState } from "../../types.js";
import type { Orchestrator, AgentExecutor } from "../../orchestrator/orchestrator.js";
import { createRuntimeExecutor } from "../../runtime/runtimeExecutor.js";
import { withQaOptimization, riskSignalsFromClassification } from "../../qa/optimized.js";
import { gitChangedFiles } from "../../qa/changeSource.js";
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
import { RunLog } from "../../observability/runLog.js";
import type { TaskStore } from "../../store/taskStore.js";
import type { DeterministicVerification } from "../../qa/deterministic.js";
import type { CliArgs } from "../../cli.js";
import { contractRootForTask, plannedTier, promptForCamp } from "./taskIntake.js";
import { runtimeRegistryFor, type CliDependencies } from "./runtimeRegistry.js";

/**
 * What `composeProductionTaskExecutor` hands the single-task loop. It used to
 * live in `run/waveRunner.ts`, which T-V8-029 retired; the unified bounded run
 * composes its own services in `run/boundedRunServices.ts` instead.
 */
export interface TaskExecutorComposition {
  executor: AgentExecutor;
  verificationFor(taskId: string): DeterministicVerification | undefined;
}

/** The single production executor composition used by both manual and bounded-wave task paths. */
export async function composeProductionTaskExecutor(
  args: CliArgs,
  taskId: string,
  orchestrator: Orchestrator,
  store: TaskStore,
  dependencies: CliDependencies = {},
): Promise<TaskExecutorComposition> {
  const task = store.loadTask(taskId);
  if (!task) throw new Error(`cannot compose an executor for missing task ${taskId}`);
  const contractRoot = contractRootForTask(args.projectRoot, task.targetBindings);
  const resolvedAutonomy = args.autonomy ?? "propose";
  if (resolvedAutonomy === "propose") {
    console.error(
      "[orchestrator] WARNING: autonomy is 'propose' (the default), which maps to permission mode 'default' — " +
        "a headless child cannot approve writes or commands, so engineer stages will fail on their first write. " +
        "For an unattended run pass --autonomy edit (or full); hooks and contracts stay enforced either way.",
    );
  }

  let staConfig: ReturnType<typeof loadStaConfig> | undefined;
  try {
    staConfig = loadStaConfig(args.projectRoot);
  } catch {
    staConfig = undefined;
  }
  const executionConfig = staConfig?.execution;
  const phaseTier = plannedTier(args, taskId);
  const tierCamp = phaseTier
    ? selectTierCamp({
        flagRuntime: args.runtime,
        configuredRuntime: executionConfig?.runner,
        hasConfiguredRoleRoute: staConfig?.routing?.by_role !== undefined,
        isTTY: process.stdin.isTTY === true,
        defaultRuntimeId: DEFAULT_RUNTIME_ID,
        prompt: () => promptForCamp(DEFAULT_RUNTIME_ID),
      })
    : undefined;
  const defaultRuntimeId = tierCamp?.runtimeId ?? args.runtime ?? executionConfig?.runner ?? DEFAULT_RUNTIME_ID;
  const runtimeRegistry = runtimeRegistryFor(args.projectRoot, dependencies);
  const defaultRuntime = runtimeRegistry.tryGet(defaultRuntimeId);
  if (!defaultRuntime) throw new Error(`configured Single runner "${defaultRuntimeId}" is not registered`);
  const routingFlags = args.runtime || args.model || args.effort
    ? { runtime: args.runtime, model: args.model, effort: args.effort }
    : undefined;
  const runtimeExecutor = createRuntimeExecutor({
    runtime: defaultRuntime,
    registry: runtimeRegistry,
    routingFlags,
    planTier: (id) => plannedTier(args, id),
    classification: (id) => store.loadTask(id)?.classification,
    riskSignals: (id) => {
      const classification = store.loadTask(id)?.classification;
      return classification ? riskSignalsFromClassification(classification) : undefined;
    },
    projectRoot: args.projectRoot,
    moduleName: () => args.module!,
    guards: contractGuardResolver(contractRoot),
    phases: () => (args.phases.length > 0 ? args.phases : undefined),
    taskLevel: (id) => store.loadTask(id)?.classification.level,
    runtimeTask: (id) => store.loadTask(id)?.runtimeTask,
    dependencyEvidence: (id) => {
      const task = store.loadTask(id);
      const all = store.listTasks();
      return (task?.dependsOn ?? []).map(dependencyId => {
        const dependency = store.loadTask(dependencyId);
        if (!dependency || dependency.machine.current !== TaskState.DEPLOYED || dependency.paused || dependency.cancelled || unmetDependencies(dependency, all).length) throw new Error(`dependency ${dependencyId} lacks complete ledger evidence`);
        return {
          task_id: dependencyId, status: "complete" as const, source: `task-store:${dependencyId}`, hash: stableHash(dependency),
          outputs: Object.entries(dependency.artifacts).map(([kind, text]) => ({ source: `task-store:${dependencyId}/artifacts/${kind}`, hash: contentHash(text) })),
        };
      });
    },
    taskRunLog: (id) => new RunLog(store.runsForTask(id)),
    autonomy: args.autonomy,
    stageRoots: loadStageRoots(args.projectRoot),
    threeRepoTask: resolveThreeRepoTaskLookup(args.projectRoot, store),
    enforceRoleWorkflow: fs.existsSync(path.join(args.projectRoot, "knowledge")),
    extraInstruction: `Environment: ${orchestrator.environment} — ${describeEnvironment(orchestrator.environment, args.projectRoot)}`,
    // T-V8-011 — feeds a real diff into task-specific retrieval when one
    // exists (a QA round, a repair attempt); a fresh DEV round simply has none yet.
    changedFiles: async (id) => {
      try {
        const roots = resolveQaWorkRoots(args.projectRoot, id, store);
        const results = await Promise.allSettled(roots.map((root) => gitChangedFiles(root)));
        return [...new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])))];
      } catch {
        return [];
      }
    },
  });

  const qaRoots = resolveQaWorkRoots(args.projectRoot, taskId, store);
  const qaChangedFiles = async (): Promise<string[]> => {
    const roots = resolveQaWorkRoots(args.projectRoot, taskId, store);
    const results = await Promise.allSettled(roots.map((root) => gitChangedFiles(root)));
    return [...new Set(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])))];
  };
  // Resolved once, before composition: the contract carries the real file
  // manifest, and `withQaOptimization`'s contract hook is synchronous because
  // a packet's identity must not depend on a call that can still be in flight.
  const qaContractChangedFiles = await qaChangedFiles().catch(() => [] as string[]);
  const qaInputs = await productionQaInputs({
    docsRoot: resolveDocsRoot(args.projectRoot),
    moduleName: args.module ?? "",
    taskId,
    roots: qaRoots,
    projectRoot: args.projectRoot,
    changedFiles: qaContractChangedFiles,
  });

  const verificationHook = args.noDeterministicGate
    ? null
    : createPostDevVerificationHook({
        inner: runtimeExecutor,
        deterministicRunner: () => combineProjectRunners(qaRoots.map((root) => ({
          root,
          runner: createProjectRunner({
            root,
            workspace: new LocalWorkspace({ root }),
            staticGatePath: path.join(args.projectRoot, ".claude", "scripts", "static-analysis-gate.js"),
          }),
        }))),
        requiredVerification: () => orchestrator.runtimeTask?.required_verification,
        ...(args.noQaOptimization
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
  const documentHook = args.noDocumentGate
    ? null
    : createDocumentVerificationHook({
        inner: postDevExecutor,
        projectRoot: args.projectRoot,
        moduleName: args.module,
        blocking: true,
      });
  const docVerifiedExecutor = documentHook?.executor ?? withDocumentVerificationDisabled(postDevExecutor);
  const executor = args.noQaOptimization
    ? docVerifiedExecutor
    : withQaOptimization({
        inner: docVerifiedExecutor,
        changedFiles: qaChangedFiles,
        ...(args.noDeterministicGate
          ? { deterministicGate: "disabled" as const }
          : { deterministicGate: "enabled" as const, deterministicVerification: verificationHook!.verificationFor }),
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
        previousRound: () => previousRoundFromDocs(resolveDocsRoot(args.projectRoot), args.module ?? "", taskId),
      });

  return {
    executor,
    verificationFor: (id) => verificationHook?.verificationFor({
      stage: orchestrator.classification.pipeline[orchestrator.snapshot().pipelineCursor] ?? AgentStage.HUMAN,
      taskId: id,
      context: [],
    }),
  };
}
