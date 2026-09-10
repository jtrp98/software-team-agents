import * as path from "node:path";
import { AgentStage } from "../../types.js";
import { flagValue } from "../support.js";
import { openStore } from "../support.js";
import {
  CliUsageError,
  cliVersion,
  createProductionRuntimeRegistry,
  type CliDependencies,
} from "../../cli.js";
import { FLAG_TO_CLASSIFICATION, type BooleanClassificationKey } from "../../classification/classificationFlags.js";
import type { ClassificationInput } from "../../classification/taskClassifier.js";
import {
  PlanRegistrationError,
  classificationInputForPlanTask,
  compileAndRegisterPlan,
  previewPlanRegistration,
  type PlanRunScope,
} from "../../orchestrator/planCompilation.js";
import type { PlanReferences, PlanTask } from "../../docs/planTask.js";
import { RUN_BOUNDARIES, type RunBoundary } from "../../ledger/runLedger.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import { assertPlanUnchanged } from "../../orchestrator/planCompilation.js";
import { readModuleDoc } from "../../agents/moduleDocs.js";
import { resolveContextDocsRoot } from "../../targetcli/roots.js";
import { contractGuardResolver } from "../../runtime/runtimeGuards.js";
import { GitCommandLayer } from "../../git/commandLayer.js";
import { inspectRepositoryPreflight } from "../../git/preflight.js";
import { createRunId } from "../../run/journal.js";
import { BoundedRunController, type ControllerExitKind } from "../../run/boundedRunController.js";
import { createProductionBoundedRunServices } from "../../run/boundedRunServices.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { RUNTIME_IDS, type RuntimeId } from "../../runtime/runtimeSupport.js";
import type { RuntimeAutonomy } from "../../runtime/runtimeAdapter.js";
import { loadStaConfig, StaConfigMissingError } from "../../packaging/staConfig.js";
import { contentHash, stableHash } from "../../artifacts/executionPacket.js";

/**
 * T-V8-021 — the explicit bounded-run CLI.
 *
 * One command: gather/derive classification facts for a scope already fixed
 * by a canonical `plan.md`, preview exactly what would freeze (task
 * set/order, plan hash, gates, base revision), then — unless `--dry-run` —
 * freeze it for real with `compileAndRegisterPlan` and drive it to the
 * chosen boundary with `BoundedRunController` (T-V8-020) through the
 * production `BoundedRunServices` (T-V8-021's own new wiring,
 * `run/boundedRunServices.ts`).
 *
 * Preview and execution are provably the same computation, not two that
 * merely ought to agree: both call `resolvePlanScope`/`previewPlanRegistration`
 * (via `compileAndRegisterPlan`, which calls the identical resolver before it
 * mutates anything) against the same `plan.md` bytes, scope and classification
 * overrides.
 *
 * "AI may propose classification facts with evidence/uncertainty" (T-V8-021's
 * acceptance criteria): this codebase has no LLM-triage utility to call from
 * inside a CLI process, and inventing one here would be a fabricated
 * capability, not a real one. What exists instead — and is the mechanism
 * that satisfies "deterministic policy remains authority" and "material
 * ambiguity stops with exact choices" — is `classificationInputForPlanTask`'s
 * derivation from the canonical task's own authored `Risk:`/`Human gate:`
 * fields (the "evidence"), plus an optional CLI override the operator may
 * declare explicitly; `compileAndRegisterPlan`'s existing conflict check is
 * the ambiguity gate, and it already stops with the exact contradicting
 * fact(s) rather than guessing. A future AI proposer is a value of the same
 * shape (`ClassificationInput` with a reason attached) and would plug into
 * `--<flag>` the same way an operator's flag does today.
 */

export type BoundedRunUntil = RunBoundary;

export interface BoundedRunArgs {
  projectRoot: string;
  stateDb?: string;
  module?: string;
  scope?: PlanRunScope;
  until: BoundedRunUntil;
  dryRun: boolean;
  resumeRunId?: string;
  targetRoot?: string;
  targetId?: string;
  knowledgeRoot?: string;
  runBranch?: string;
  runtime?: RuntimeId;
  model?: string;
  effort?: string;
  autonomy?: RuntimeAutonomy;
  classification: ClassificationInput;
}

export const BOUNDED_RUN_USAGE =
  "sta bounded-run --module <name> (--all | --phase <n> | --task <id>[,<id>...]) [--until next-gate|qa|done] [--dry-run] [--autonomy edit|full] [--runtime <id>] [--model <name>] [--effort <name>] [--target-root <path>] [--target-id <id>] [--knowledge-root <path>] [--run-branch <name>] [--project-root <path>] [--state-db <path>] <classification override flags>\n" +
  "sta bounded-run --resume <run-id> [--module <name>] [--until next-gate|qa|done] [--dry-run] [--autonomy edit|full] [--project-root <path>] [--state-db <path>]\n" +
  "  One initial command previews scope/order/gates/routes, then (without --dry-run) freezes and runs to the chosen boundary through DEV, deterministic verification and coherent QA/repair. Never waives a hard gate.\n" +
  `  classification override flags (optional; deterministic classifyTask() remains authority): ${Object.keys(FLAG_TO_CLASSIFICATION).join(" ")}`;

/** Pure argv parser — kept separate from process/console/exit so it is directly testable. */
export function parseBoundedRunArgs(argv: string[], defaultProjectRoot: string): BoundedRunArgs {
  let projectRoot = defaultProjectRoot;
  let stateDb: string | undefined;
  let moduleName: string | undefined;
  let scope: PlanRunScope | undefined;
  let until: BoundedRunUntil = "done";
  let dryRun = false;
  let resumeRunId: string | undefined;
  let targetRoot: string | undefined;
  let targetId: string | undefined;
  let knowledgeRoot: string | undefined;
  let runBranch: string | undefined;
  let runtime: RuntimeId | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let autonomy: RuntimeAutonomy | undefined;
  const classification: ClassificationInput = {};
  let scopeFlagSeen: string | undefined;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (!value) throw new CliUsageError(`${flag} requires a value`);
    return value;
  };
  const assertOneScope = (flag: string): void => {
    if (scopeFlagSeen) throw new CliUsageError(`bounded-run: ${flag} cannot be combined with ${scopeFlagSeen}; a run has exactly one scope`);
    scopeFlagSeen = flag;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project-root") {
      projectRoot = requireValue(arg, argv[++i]);
    } else if (arg === "--state-db") {
      stateDb = requireValue(arg, argv[++i]);
    } else if (arg === "--module") {
      moduleName = requireValue(arg, argv[++i]);
    } else if (arg === "--all") {
      assertOneScope(arg);
      scope = { kind: "all" };
    } else if (arg === "--phase") {
      assertOneScope(arg);
      const value = Number(requireValue(arg, argv[++i]));
      if (!Number.isInteger(value) || value <= 0) throw new CliUsageError("--phase must be a positive integer");
      scope = { kind: "phase", phase: value };
    } else if (arg === "--task") {
      assertOneScope(arg);
      const ids = requireValue(arg, argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) throw new CliUsageError("--task requires at least one task id");
      scope = { kind: "tasks", taskIds: ids };
    } else if (arg === "--until") {
      const value = requireValue(arg, argv[++i]);
      if (!(RUN_BOUNDARIES as readonly string[]).includes(value)) {
        throw new CliUsageError(`--until must be one of: ${RUN_BOUNDARIES.join(", ")} (got ${value})`);
      }
      until = value as BoundedRunUntil;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--resume") {
      resumeRunId = requireValue(arg, argv[++i]);
    } else if (arg === "--target-root") {
      targetRoot = requireValue(arg, argv[++i]);
    } else if (arg === "--target-id") {
      targetId = requireValue(arg, argv[++i]);
    } else if (arg === "--knowledge-root") {
      knowledgeRoot = requireValue(arg, argv[++i]);
    } else if (arg === "--run-branch") {
      runBranch = requireValue(arg, argv[++i]);
    } else if (arg === "--runtime") {
      const value = requireValue(arg, argv[++i]);
      if (!(RUNTIME_IDS as readonly string[]).includes(value)) {
        throw new CliUsageError(`--runtime must be one of: ${RUNTIME_IDS.join(", ")} (got ${value})`);
      }
      runtime = value as RuntimeId;
    } else if (arg === "--model") {
      model = requireValue(arg, argv[++i]);
    } else if (arg === "--effort") {
      effort = requireValue(arg, argv[++i]);
    } else if (arg === "--autonomy") {
      const value = requireValue(arg, argv[++i]);
      const valid: readonly string[] = ["read-only", "propose", "edit", "full"];
      if (!valid.includes(value)) throw new CliUsageError(`--autonomy must be one of: ${valid.join(", ")} (got ${value})`);
      autonomy = value as RuntimeAutonomy;
    } else if (arg in FLAG_TO_CLASSIFICATION) {
      classification[FLAG_TO_CLASSIFICATION[arg] as BooleanClassificationKey] = true;
    } else {
      throw new CliUsageError(`bounded-run: unrecognized argument: ${arg}\n${BOUNDED_RUN_USAGE}`);
    }
  }

  if (resumeRunId) {
    if (scope) throw new CliUsageError("bounded-run: --resume continues an already-frozen scope; --all/--phase/--task do not apply");
    if (Object.keys(classification).length > 0) throw new CliUsageError("bounded-run: --resume continues an already-frozen classification; classification flags do not apply");
  } else {
    if (!moduleName) throw new CliUsageError(`bounded-run: --module is required\n${BOUNDED_RUN_USAGE}`);
    if (!scope) throw new CliUsageError(`bounded-run: exactly one of --all, --phase <n>, --task <id,...> is required\n${BOUNDED_RUN_USAGE}`);
    if (!dryRun && autonomy !== "edit" && autonomy !== "full") {
      throw new CliUsageError("bounded-run: an unattended run needs --autonomy edit or --autonomy full (a dry run does not)");
    }
  }

  return {
    projectRoot, stateDb, module: moduleName, scope, until, dryRun, resumeRunId,
    targetRoot, targetId, knowledgeRoot, runBranch, runtime, model, effort, autonomy, classification,
  };
}

/** `parseCanonicalPlan`'s cross-reference validation needs both docs or neither — a lone one is not a usable reference set. */
function referencesFrom(requirementMd: string | undefined, designMd: string | undefined): PlanReferences | undefined {
  return requirementMd !== undefined && designMd !== undefined ? { requirementMd, designMd } : undefined;
}

/** A real, deterministic identity for "what execution policy was in force" — never a placeholder. Absent config hashes to the same fixed value every project without one gets, so "no config" is one stable identity, not a fake per-run one. */
function configHashFor(projectRoot: string): string {
  try {
    return stableHash(loadStaConfig(projectRoot));
  } catch (error) {
    if (error instanceof StaConfigMissingError) return stableHash({ config: "absent" });
    throw error;
  }
}

function exitCodeFor(kind: ControllerExitKind): number {
  switch (kind) {
    case "COMPLETED": return 0;
    case "HALTED": return 1;
    case "REFUSED": return 2;
    case "INTERRUPTED": return 130;
    case "GATE": return 4;
  }
}

function renderPreview(input: {
  module: string;
  scope: PlanRunScope;
  until: BoundedRunUntil;
  order: readonly string[];
  planHash: string;
  tasks: ReturnType<typeof previewPlanRegistration>["tasks"];
  targetRoot: string;
  targetId: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  defaultRuntimeId: string;
}): string[] {
  const lines = [
    `[bounded-run] module=${input.module} scope=${input.scope.kind} until=${input.until}`,
    `[bounded-run] plan_hash=${input.planHash} tasks=${input.order.length} order=${input.order.join(" -> ")}`,
    `[bounded-run] target root=${input.targetRoot} id=${input.targetId}`,
    `[bounded-run] base branch=${input.baseBranch} sha=${input.baseSha} run_branch=${input.runBranch}`,
    `[bounded-run] default runtime=${input.defaultRuntimeId}`,
  ];
  for (const [index, task] of input.tasks.entries()) {
    const gates = [
      task.classification.requiresHumanApproval ? "human-approval" : null,
      task.classification.sensitiveGate ? "security-gate" : null,
      task.classification.touchesSchema ? "schema" : null,
    ].filter((g): g is string => g !== null);
    lines.push(
      `[bounded-run] ${index + 1}. ${task.taskId} owner=${task.owner} phase=${task.phase} level=${task.classification.level} ` +
        `pipeline=${task.classification.pipeline.join(">")} ${gates.length > 0 ? `gates=${gates.join(",")}` : "gates=none"}`,
    );
  }
  return lines;
}

/** Same comparison `git/guardedRun.ts` uses for a resolved root. */
function sameRoot(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase("en-US") === path.resolve(right).toLocaleLowerCase("en-US");
}

export async function runBoundedRunVerb(rest: string[], defaultProjectRoot: string, dependencies: CliDependencies = {}): Promise<number> {
  const args = parseBoundedRunArgs(rest, defaultProjectRoot);
  const { store, registry } = openStore(args.projectRoot, args.stateDb);
  const ledger = new SqliteRunLedger(store, { projectRoot: args.projectRoot });
  const runtimeRegistry: RuntimeRegistry = (dependencies.createRuntimeRegistry ?? createProductionRuntimeRegistry)(args.projectRoot);
  const defaultRuntimeId = args.runtime ?? DEFAULT_RUNTIME_ID;
  // Reassigned on --resume: a frozen run owns its Target, and re-deriving it
  // from flags is how a resume ends up writing into the wrong repository.
  let targetRoot = path.resolve(args.targetRoot ?? args.projectRoot);
  let targetId = args.targetId ?? "legacy-project";
  let knowledgeRoot = path.resolve(args.knowledgeRoot ?? args.projectRoot);
  const docsRoot = resolveContextDocsRoot(args.projectRoot);
  // Contract/agent-registry authority: `resolveFrameworkRoot()` only applies to
  // a three-repo, Target-bound task (`contractRootForTask`'s existing rule) —
  // this command supports only the legacy/single-repo case today, where the
  // project root itself is that authority.
  const contractRoot = args.projectRoot;

  try {
    let runId: string;

    if (args.resumeRunId) {
      runId = args.resumeRunId;
      const run = ledger.readRun(runId);
      if (!run) {
        console.error(`[bounded-run] no such run: ${runId}`);
        return 1;
      }
      // T-V8-022 — the roots come from the frozen run, never from this
      // invocation's flags. Every attempt, checkpoint and base revision in
      // the ledger was frozen against `run.target_root`; re-deriving it from
      // `--target-root ?? --project-root` made an ordinary
      // `sta bounded-run --resume <id> --module m` point at the project root
      // instead. An explicit flag that disagrees is a refusal, not an
      // override, because the alternative is writing into another repository.
      const rootDrift = [
        args.targetRoot && !sameRoot(args.targetRoot, run.target_root)
          ? `--target-root ${path.resolve(args.targetRoot)} != frozen ${run.target_root}` : null,
        args.knowledgeRoot && !sameRoot(args.knowledgeRoot, run.knowledge_root)
          ? `--knowledge-root ${path.resolve(args.knowledgeRoot)} != frozen ${run.knowledge_root}` : null,
        args.targetId && args.targetId !== run.target_id
          ? `--target-id ${args.targetId} != frozen ${run.target_id}` : null,
      ].filter((item): item is string => item !== null);
      if (rootDrift.length > 0) {
        console.error(`[bounded-run] cannot resume ${runId}: ${rootDrift.join("; ")} — recompile explicitly rather than repointing a frozen run`);
        return 1;
      }
      targetRoot = run.target_root;
      targetId = run.target_id;
      knowledgeRoot = run.knowledge_root;
      const moduleName = args.module ?? run.module;
      const planMarkdown = readModuleDoc(docsRoot, moduleName, "plan.md");
      if (planMarkdown === null) {
        console.error(`[bounded-run] cannot resume ${runId}: module ${moduleName}'s plan.md is no longer readable`);
        return 1;
      }
      const requirementMd = readModuleDoc(docsRoot, moduleName, "requirement.md") ?? undefined;
      const designMd = readModuleDoc(docsRoot, moduleName, "design.md") ?? undefined;
      try {
        assertPlanUnchanged(run, planMarkdown, referencesFrom(requirementMd, designMd));
      } catch (error) {
        console.error(`[bounded-run] ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      console.log(
        `[bounded-run] resuming run ${runId}: status=${run.status} boundary=${run.boundary} task_order=${run.task_order.join(",")}`,
      );
      const readiness = ledger.readiness(runId);
      console.log(
        `[bounded-run] readiness: ready=${readiness.ready.join(",") || "none"} waiting=${readiness.waiting.map((w) => w.task_id).join(",") || "none"} ` +
          `blocked=${readiness.blocked.join(",") || "none"} settled=${readiness.settled.join(",") || "none"}`,
      );
      if (args.dryRun) return 0;
    } else {
      const moduleName = args.module!;
      const planMarkdown = readModuleDoc(docsRoot, moduleName, "plan.md");
      if (planMarkdown === null) {
        console.error(`[bounded-run] module ${moduleName} has no plan.md at ${docsRoot}`);
        return 1;
      }
      const requirementMd = readModuleDoc(docsRoot, moduleName, "requirement.md") ?? undefined;
      const designMd = readModuleDoc(docsRoot, moduleName, "design.md") ?? undefined;
      const references = referencesFrom(requirementMd, designMd);
      // Merge the operator's explicit override onto the plan-derived defaults
      // — never a bare replacement, or every other derived field (owner-based
      // touchesBackend/touchesFrontend, isIncrementalFeature, ...) would just
      // vanish the moment one override flag is passed.
      const classificationFor = Object.keys(args.classification).length > 0
        ? (task: PlanTask) => classificationInputForPlanTask(task, args.classification)
        : undefined;

      let preview;
      try {
        preview = previewPlanRegistration({
          registry, store, planMarkdown, references,
          scope: args.scope!, module: moduleName,
          ...(classificationFor ? { classificationFor } : {}),
        });
      } catch (error) {
        if (error instanceof PlanRegistrationError) {
          console.error(`[bounded-run] refused (${error.kind}): ${error.message}`);
          return 4;
        }
        throw error;
      }

      const git = new GitCommandLayer({ cwd: targetRoot });
      runId = createRunId();
      let preflight;
      try {
        preflight = await inspectRepositoryPreflight(git, moduleName, runId);
      } catch (error) {
        console.error(`[bounded-run] ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      const runBranch = args.runBranch ?? preflight.runBranch;

      for (const line of renderPreview({
        module: moduleName, scope: args.scope!, until: args.until,
        order: preview.order, planHash: preview.planHash, tasks: preview.tasks,
        targetRoot, targetId, baseBranch: preflight.baseBranch, baseSha: preflight.baseSha,
        runBranch, defaultRuntimeId,
      })) console.log(line);

      if (args.dryRun) return 0;

      let registered;
      try {
        registered = compileAndRegisterPlan({
          registry, store, ledger,
          planMarkdown, references,
          scope: args.scope!,
          runId, module: moduleName, boundary: args.until,
          targetId, targetRoot, knowledgeRoot,
          baseBranch: preflight.baseBranch, baseSha: preflight.baseSha, runBranch,
          configHash: configHashFor(args.projectRoot),
          requirementHash: requirementMd ? contentHash(requirementMd) : undefined,
          designHash: designMd ? contentHash(designMd) : undefined,
          staVersion: cliVersion(),
          ...(classificationFor ? { classificationFor } : {}),
          taskContextFor: (task) => ({
            projectRoot: args.projectRoot,
            docsRoot,
            workflow: "bounded-run",
            targetWorkRoots: [
              { stage: task.owner as AgentStage, targetId, path: targetRoot },
              { stage: AgentStage.QA_ENGINEER, targetId, path: targetRoot },
            ],
          }),
        });
      } catch (error) {
        if (error instanceof PlanRegistrationError) {
          console.error(`[bounded-run] refused (${error.kind}): ${error.message}`);
          return 4;
        }
        throw error;
      }
      console.log(`[bounded-run] froze run ${registered.run.run_id}: ${registered.trace.join(" | ")}`);
    }

    const services = createProductionBoundedRunServices({
      ledger, store, registry: runtimeRegistry,
      projectRoot: contractRoot, targetRoot, runtimeStateRoot: args.projectRoot,
      defaultRuntimeId,
      moduleName: args.module ?? ledger.readRun(runId)!.module,
      docsRoot,
      guards: contractGuardResolver(contractRoot),
      adapterVersion: cliVersion(),
    });
    const controller = new BoundedRunController({ ledger, runId, runtimeStateRoot: args.projectRoot, services });
    const result = await controller.run();
    console.log(`[bounded-run] ${result.kind}: ${result.reason} (attempts=${result.launchedAttempts}, qa_rounds=${result.qaRounds})`);
    if (result.kind === "GATE" || result.kind === "HALTED") {
      console.log(`[bounded-run] next: resolve the gate, then \`sta bounded-run --resume ${result.runId} --module ${args.module ?? ledger.readRun(runId)!.module}\`, or \`sta status\`/\`sta report\` for the wider picture.`);
    }
    return exitCodeFor(result.kind);
  } finally {
    ledger.close();
    registry.close();
  }
}
