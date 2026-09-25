import * as fs from "node:fs";
import { AgentStage } from "../../types.js";
import { classifyTask } from "../../classification/taskClassifier.js";
import { Orchestrator } from "../../orchestrator/orchestrator.js";
import { TaskRegistry } from "../../orchestrator/taskRegistry.js";
import { RUNTIME_IDS, type RuntimeId } from "../../runtime/runtimeSupport.js";
import { resolveFrameworkRoot } from "../../targetcli/roots.js";
import { readModuleDoc } from "../../agents/moduleDocs.js";
import { readWorkPlan } from "../../docs/planGraph.js";
import { preflightThreeRepoTask } from "../../threeRepo/preflight.js";
import {
  installationConfigOverride,
  loadInstallationConfig,
} from "../../threeRepo/installation.js";
import { assertRootMatchesFrozenIdentity, resolveInstallationRoot } from "../../threeRepo/rootSelector.js";
import { assertStandaloneFrameworkRoot, assertStandaloneKnowledgeRoot } from "../../threeRepo/installation.js";
import type { KnowledgeRootIdentity } from "../../store/taskStore.js";
import type { TaskLookup } from "../../threeRepo/cliRoots.js";
import { resolveModuleTargets } from "../../threeRepo/moduleTargetResolver.js";
import { loadTargetRegistry } from "../../threeRepo/targets.js";
import {
  hasTargetBindings,
  validateNewTaskBindings,
  type TaskBindingModuleScope,
  type TargetBindings,
} from "../../threeRepo/taskBindings.js";
import { compileWorkflowPlan, resolveWorkflowId } from "../../workflow/workflowDefinition.js";
import type { RuntimeTaskWorkRoot } from "../../orchestrator/runtimeTask.js";
import { CliUsageError, type CliArgs } from "../../cli.js";

/**
 * Three-repo tasks persist their execution scope from Framework-owned role
 * contracts.  Resolve the packet guard from that same authority: using the
 * Target's last-synced copy can silently filter a newly granted Framework
 * path out of an otherwise valid RuntimeTask.
 */
export function contractRootForTask(): string {
  return resolveFrameworkRoot();
}

/** Optional phase-tier metadata is advisory input to routing, never a runtime gate. */
export function plannedTier(args: Pick<CliArgs, "projectRoot" | "module" | "rootName">, taskId: string): string | undefined {
  if (!args.module) return undefined;
  try {
    const selected = resolveInstallationRoot(loadInstallationConfig(installationConfigOverride()), args.rootName);
    const planMd = readModuleDoc(selected.path, args.module, "plan.md");
    return planMd === null ? undefined : readWorkPlan(planMd).tasks.find((task) => task.id === taskId)?.tier;
  } catch {
    return undefined;
  }
}

/** Never called without a terminal: CI/headless execution must not read stdin. */
export function promptForCamp(defaultRuntimeId: RuntimeId): RuntimeId {
  process.stdout.write(`[orchestrator] Tiered phase: choose camp/runtime [${RUNTIME_IDS.join(", ")}] (default ${defaultRuntimeId}): `);
  const input = Buffer.alloc(128);
  const read = fs.readSync(0, input, 0, input.length, null);
  const selected = input.toString("utf8", 0, read).trim();
  return (RUNTIME_IDS as readonly string[]).includes(selected) ? selected as RuntimeId : defaultRuntimeId;
}

/**
 * Resolves the Target side of `contract globs ∩ Target work roots` before
 * RuntimeTask is persisted. This is the existing three-repo preflight, not a
 * second root resolver.
 */
export function runtimeTaskWorkRoots(
  args: CliArgs,
  taskId: string,
  classification: ReturnType<typeof classifyTask>,
  moduleScope?: TaskBindingModuleScope,
): RuntimeTaskWorkRoot[] {
  // V13 TASK-004: work-root resolution goes through the same compiled,
  // versioned plan `buildRuntimeTask` persists — not a second, independent
  // read of `classification.pipeline` — so this is never a place the two can
  // silently diverge. `compileWorkflowPlan` itself asserts the compiled
  // pipeline agrees with `classifyTask()`, so this is not a behaviour change.
  const compiled = compileWorkflowPlan(args.classification, resolveFrameworkRoot());
  const stages = compiled.pipeline.filter((stage) => stage !== AgentStage.HUMAN);
  if (!hasTargetBindings(args.targetBindings)) {
    if (stages.some((stage) => stage === AgentStage.BACKEND_ENGINEER || stage === AgentStage.FRONTEND_ENGINEER)) {
      throw new CliUsageError(`task ${taskId} has no explicit Target binding`);
    }
    preflightThreeRepoTask({ taskId, classification, targetBindings: args.targetBindings }, AgentStage.BUSINESS_ANALYST, {
      frameworkRoot: resolveFrameworkRoot(), installationConfigPath: installationConfigOverride(), knowledgeRootName: args.rootName, moduleScope,
    });
    return [];
  }

  const preview = { taskId, classification, targetBindings: args.targetBindings };
  const installationConfigPath = installationConfigOverride();
  const roots: RuntimeTaskWorkRoot[] = [];
  for (const stage of stages) {
    // Knowledge-only stages deliberately have no Target work roots. UX identity
    // remains checked at its existing execution boundary, not moved to creation.
    if (
      ![
        AgentStage.BACKEND_ENGINEER,
        AgentStage.FRONTEND_ENGINEER,
        AgentStage.REVIEWER,
        AgentStage.QA_ENGINEER,
        AgentStage.SECURITY,
        AgentStage.DEVOPS,
      ].includes(stage)
    ) {
      continue;
    }
    const resolved = preflightThreeRepoTask(preview, stage, {
      // `--project-root` is the Target workspace for a three-repo task.  The
      // local Target mapping must instead compare that Target against the real
      // Framework checkout, otherwise every valid Target appears to overlap
      // its own "Framework root".
      frameworkRoot: resolveFrameworkRoot(),
      installationConfigPath,
      knowledgeRootName: args.rootName,
      moduleScope,
      // openTask validated and logged this exact binding immediately before
      // resolving roots; repeating each warning once per stage adds no signal.
      bindingWarning: () => {},
    });
    for (const root of resolved.workRoots) {
      // Verifier stages (reviewer, QA, security) carry the read-only Target
      // roots they verify - the same rule a bounded run registers (V13 TASK-007);
      // a writer is bound only where it writes.
      const verifier = stage === AgentStage.REVIEWER || stage === AgentStage.QA_ENGINEER || stage === AgentStage.SECURITY;
      if (verifier || root.access === "write") roots.push({ stage, targetId: root.targetId, path: root.path, access: root.access });
    }
  }
  return roots;
}

/**
 * Resolves the orchestrator to drive: resumes the stored task with --resume,
 * refuses to silently restart one that already exists otherwise. Re-running a
 * task id from scratch would re-pay for every stage that already ran, so it
 * has to be asked for explicitly.
 */
export function openTask(registry: TaskRegistry, args: CliArgs, taskId: string, store: TaskLookup): Orchestrator {
  const exists = registry.has(taskId);
  if (args.resume) {
    if (!exists) throw new CliUsageError(`--resume: task ${taskId} is not in this store`);
    // DR §5 invariant 5: a resume continues on the root frozen at intake; an
    // explicit --root is a drift assertion against it, never a re-selection.
    assertRootMatchesFrozenIdentity(store.loadTask(taskId)?.knowledgeRoot, args.rootName, installationConfigOverride());
    const orchestrator = registry.open(taskId);
    console.log(
      `[orchestrator] resumed task ${taskId} at ${orchestrator.machine.current} ` +
        `(review retries ${orchestrator.retries.review}, qa retries ${orchestrator.retries.qa}, security retries ${orchestrator.retries.security})`,
    );
    return orchestrator;
  }
  if (exists) {
    throw new CliUsageError(
      `task ${taskId} already exists in this store — pass --resume to continue it, or use a new --task-id`,
    );
  }
  const classification = classifyTask(args.classification);
  // A three-repo task records a resolved shared Target identity when created.
  // Do this before a durable row is written, so malformed/retired/unknown ids
  // leave no partial task history behind.
  const isCodeTask = classification.pipeline.some((stage) => stage === AgentStage.BACKEND_ENGINEER || stage === AgentStage.FRONTEND_ENGINEER);
  // The installation override is the test/E2E channel (DR §9B): a declared
  // harness points the mode check at a specific file, and an undeclared
  // production invocation is refused by `installationConfigOverride` instead
  // of silently reading the machine's real installation.
  const installationConfigPath = installationConfigOverride();
  // The selected Knowledge identity is mandatory and frozen before any task row is created.
  const installation = loadInstallationConfig(installationConfigPath);
  const selected = resolveInstallationRoot(installation, args.rootName);
  assertStandaloneFrameworkRoot(resolveFrameworkRoot());
  assertStandaloneKnowledgeRoot(selected.path);
  const frozenKnowledgeRoot: KnowledgeRootIdentity = { name: selected.name, path: selected.path };
  let moduleScope: TaskBindingModuleScope | undefined;
  const validateInstalledBindings = (): void => {
    const installation = loadInstallationConfig(installationConfigPath);
    // The run's `--root` (or the installation default) decides which root's
    // registry and module docs validate this task (DR §3).
    const selectedKnowledgeRoot = resolveInstallationRoot(installation, args.rootName).path;
    if (args.module) {
      const resolved = resolveModuleTargets(args.module, selectedKnowledgeRoot, {
        frameworkRoot: resolveFrameworkRoot(),
      });
      moduleScope = {
        module: resolved.module,
        designPath: resolved.designPath,
        declaredTargetIds: resolved.declaredTargetIds,
      };
    }
    const result = validateNewTaskBindings(
      classification,
      args.targetBindings,
      loadTargetRegistry(selectedKnowledgeRoot),
      { moduleScope },
    );
    for (const warning of result.warnings) console.warn(`[orchestrator] WARNING: ${warning}`);
  };
  if (isCodeTask && !hasTargetBindings(args.targetBindings)) throw new CliUsageError(`task ${taskId} requires an explicit Target binding`);
  validateInstalledBindings();
  // Naming the workflow makes the generated `workflows/<id>.yml` reachable from
  // a run: the file that explains *why* this pipeline is shaped this way is one
  // `cat` away, rather than something a reader has to match up by eye.
  console.log(
    `[orchestrator] task ${taskId}: workflow=${resolveWorkflowId(args.classification)} ` +
      `level=${classification.level} pipeline=${classification.pipeline.join(" -> ")}`,
  );
  for (const reason of classification.reasons) console.log(`[orchestrator]   reason: ${reason}`);
  const docsRoot = frozenKnowledgeRoot.path;
  const created = registry.create({
    taskId,
    classification,
    classificationInput: args.classification,
    dependsOn: args.dependsOn,
    adHoc: args.adHoc,
    environment: args.environment,
    targetBindings: args.targetBindings,
    workflow: resolveWorkflowId(args.classification),
    // Contracts are Framework-owned even when --project-root is a Target.
    projectRoot: resolveFrameworkRoot(),
    docsRoot,
    moduleName: args.module,
    targetWorkRoots: runtimeTaskWorkRoots(args, taskId, classification, moduleScope),
    changeAwareVerification: !args.noQaOptimization,
    knowledgeRoot: frozenKnowledgeRoot,
  });
  void created;
  return registry.open(taskId);
}
