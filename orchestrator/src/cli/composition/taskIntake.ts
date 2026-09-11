import * as fs from "node:fs";
import { AgentStage } from "../../types.js";
import { classifyTask } from "../../classification/taskClassifier.js";
import { Orchestrator } from "../../orchestrator/orchestrator.js";
import { TaskRegistry } from "../../orchestrator/taskRegistry.js";
import { RUNTIME_IDS, type RuntimeId } from "../../runtime/runtimeSupport.js";
import { resolveContextDocsRoot, resolveFrameworkRoot } from "../../targetcli/roots.js";
import { readModuleDoc } from "../../agents/moduleDocs.js";
import { readWorkPlan } from "../../docs/planGraph.js";
import { preflightThreeRepoTask } from "../../threeRepo/preflight.js";
import { loadInstallationConfig } from "../../threeRepo/installation.js";
import { loadTargetRegistry } from "../../threeRepo/targets.js";
import { validateNewTaskBindings, type TargetBindings } from "../../threeRepo/taskBindings.js";
import { resolveWorkflowId } from "../../workflow/workflowDefinition.js";
import type { RuntimeTaskWorkRoot } from "../../orchestrator/runtimeTask.js";
import { CliUsageError, type CliArgs } from "../../cli.js";

/**
 * Three-repo tasks persist their execution scope from Framework-owned role
 * contracts.  Resolve the packet guard from that same authority: using the
 * Target's last-synced copy can silently filter a newly granted Framework
 * path out of an otherwise valid RuntimeTask.  Legacy tasks remain governed
 * by their single workspace's contract.
 */
export function contractRootForTask(projectRoot: string, bindings: TargetBindings): string {
  return bindings.backend_target || bindings.frontend_target ? resolveFrameworkRoot() : projectRoot;
}

/** Optional phase-tier metadata is advisory input to routing, never a runtime gate. */
export function plannedTier(args: CliArgs, taskId: string): string | undefined {
  if (!args.module) return undefined;
  try {
    const planMd = readModuleDoc(resolveContextDocsRoot(args.projectRoot), args.module, "plan.md");
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
 * second root resolver. Legacy single-repo runs retain their one shared root.
 */
export function runtimeTaskWorkRoots(
  args: CliArgs,
  taskId: string,
  classification: ReturnType<typeof classifyTask>,
): RuntimeTaskWorkRoot[] {
  const stages = classification.pipeline.filter((stage) => stage !== AgentStage.HUMAN);
  if (!args.targetBindings.frontend_target && !args.targetBindings.backend_target) {
    return stages.map((stage) => ({ stage, targetId: "legacy-project", path: args.projectRoot }));
  }

  const preview = { taskId, classification, targetBindings: args.targetBindings };
  const installationConfigPath = process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined;
  const roots: RuntimeTaskWorkRoot[] = [];
  for (const stage of stages) {
    // Knowledge-only stages deliberately have no Target work roots. UX identity
    // remains checked at its existing execution boundary, not moved to creation.
    if (
      ![
        AgentStage.BACKEND_ENGINEER,
        AgentStage.FRONTEND_ENGINEER,
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
    });
    for (const root of resolved.workRoots) {
      if (root.access === "write") roots.push({ stage, targetId: root.targetId, path: root.path });
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
export function openTask(registry: TaskRegistry, args: CliArgs, taskId: string): Orchestrator {
  const exists = registry.has(taskId);
  if (args.resume) {
    if (!exists) throw new CliUsageError(`--resume: task ${taskId} is not in this store`);
    const orchestrator = registry.open(taskId);
    console.log(
      `[orchestrator] resumed task ${taskId} at ${orchestrator.machine.current} ` +
        `(qa retries ${orchestrator.retries.qa}, security retries ${orchestrator.retries.security})`,
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
  // AGENTCLAUDE_INSTALLATION_CONFIG lets a test (or an unusual setup) point the
  // mode check at a specific file instead of the machine's real one — without
  // it, merely having configured an installation once flips every CLI test that
  // creates a legacy code task.
  const installationConfigPath = process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined;
  if (args.targetBindings.frontend_target || args.targetBindings.backend_target) {
    const installation = loadInstallationConfig(installationConfigPath);
    validateNewTaskBindings(classification, args.targetBindings, loadTargetRegistry(installation.knowledge_root));
  } else if (isCodeTask) {
    // Legacy project-mode remains supported when no installation exists. Once
    // an installation has been configured, however, this is three-repo mode
    // and a code task without an explicit binding must never be persisted.
    try {
      const installation = loadInstallationConfig(installationConfigPath);
      validateNewTaskBindings(classification, args.targetBindings, loadTargetRegistry(installation.knowledge_root));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("cannot read installation config")) throw error;
    }
  }
  // Naming the workflow makes the generated `workflows/<id>.yml` reachable from
  // a run: the file that explains *why* this pipeline is shaped this way is one
  // `cat` away, rather than something a reader has to match up by eye.
  console.log(
    `[orchestrator] task ${taskId}: workflow=${resolveWorkflowId(args.classification)} ` +
      `level=${classification.level} pipeline=${classification.pipeline.join(" -> ")}`,
  );
  for (const reason of classification.reasons) console.log(`[orchestrator]   reason: ${reason}`);
  const docsRoot = resolveContextDocsRoot(args.projectRoot);
  const created = registry.create({
    taskId,
    classification,
    dependsOn: args.dependsOn,
    adHoc: args.adHoc,
    environment: args.environment,
    targetBindings: args.targetBindings,
    workflow: resolveWorkflowId(args.classification),
    // Contracts are Framework-owned even when --project-root is a Target.
    projectRoot: resolveFrameworkRoot(),
    docsRoot,
    moduleName: args.module,
    targetWorkRoots: runtimeTaskWorkRoots(args, taskId, classification),
    changeAwareVerification: !args.noQaOptimization,
  });
  void created;
  return registry.open(taskId);
}
