#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { AgentStage } from "./types.js";
import { classifyTask, type ClassificationInput } from "./classification/taskClassifier.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { createRuntimeExecutor } from "./runtime/runtimeExecutor.js";
import { withQaOptimization, riskSignalsFromClassification } from "./qa/optimized.js";
import { gitChangedFiles, gitDiffSummary } from "./qa/changeSource.js";
import { combineProjectRunners, createProjectRunner } from "./qa/projectRunner.js";
import { createPostDevVerificationHook, withPostDevVerificationDisabled } from "./qa/verificationHook.js";
import { LocalWorkspace } from "./runtime/localWorkspace.js";
import { DEFAULT_BUDGET, type Budget } from "./cost/costControl.js";
import { loadStaConfig } from "./packaging/staConfig.js";
import type { QaFindingRecord } from "./qa/evidence.js";
import { parseOpenIssues } from "./orchestrator/failureClassifier.js";
import { readModuleDoc } from "./agents/moduleDocs.js";
import { ClaudeCodeAdapter } from "./runtime/claudeCodeAdapter.js";
import { CodexAdapter } from "./runtime/codexAdapter.js";
import { OpenCodeAdapter } from "./runtime/openCodeAdapter.js";
import { ApiAdapter, PAID_API_RUNTIME_ID } from "./runtime/apiAdapter.js";
import { RUNTIME_IDS, type RuntimeId } from "./runtime/runtimeSupport.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "./runtime/runtimeRegistry.js";
import { selectTierCamp } from "./runtime/tierCampSelection.js";
import type { RoutingMode } from "./runtime/runtimeRouting.js";
import { detectRuntimeCapabilities } from "./runtime/runtimeCapabilityDetection.js";
import { resolveContextDocsRoot, resolveFrameworkRoot } from "./targetcli/roots.js";
import type { RuntimeAutonomy } from "./runtime/runtimeAdapter.js";
import { contractGuardResolver } from "./runtime/runtimeGuards.js";
import { DatabaseUnavailableError, SqliteTaskStore } from "./store/sqliteStore.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { resolveWorkflowId } from "./workflow/workflowDefinition.js";
import { CHECKERS, runChecker } from "./cli/checkers.js";
import { configuredTokenBudget, flagValue as supportFlagValue, positionalArg, positionalArgs } from "./cli/support.js";
import { runStatusVerb } from "./cli/verbs/status.js";
import { runApproveVerb } from "./cli/verbs/approve.js";
import { runPauseVerb } from "./cli/verbs/pause.js";
import { runCancelVerb } from "./cli/verbs/cancel.js";
import { runAuditVerb } from "./cli/verbs/audit.js";
import { runRolesVerb } from "./cli/verbs/roles.js";
import { runAdoptVerb } from "./cli/verbs/adopt.js";
import { runQaMetricsVerb } from "./cli/verbs/qaMetrics.js";
import { runPolicyVerb } from "./cli/verbs/policy.js";
import { runTokensVerb } from "./cli/verbs/tokens.js";
import { runContextVerb } from "./cli/verbs/context.js";
import { runKnowledgeVerb } from "./cli/verbs/knowledge.js";
import { runRuntimesVerb } from "./cli/verbs/runtimes.js";
import { runTaskLoop } from "./cli/runTaskLoop.js";
import { describeStatus, type TaskStatusKind } from "./orchestrator/taskStatus.js";
import { formatRunRouting, RunLog } from "./observability/runLog.js";
import { acquireTaskLock, releaseTaskLock, TaskLockedError } from "./concurrency/taskLock.js";
import { hasWorkspace, loadWorkspace, workspacePath, type Workspace } from "./workspace/workspace.js";
import { loadStageRoots } from "./repos/repoMap.js";
import { Environment, describeEnvironment, isEnvironment } from "./environment/environment.js";
import { planReadinessAdvisory } from "./docs/planGraph.js";
import { buildTemplates } from "./packaging/templateBuilder.js";
import { runInit } from "./packaging/initCommand.js";
import { runUpgrade } from "./packaging/upgradeCommand.js";
import { runThreeRepoInit, runThreeRepoUpgrade } from "./packaging/threeRepoCommand.js";
import { migrateSta } from "./packaging/migration.js";
import { configureIdentities, configureKnowledgeRoot, loadInstallationConfig } from "./threeRepo/installation.js";
import { loadTargetRegistry } from "./threeRepo/targets.js";
import { preflightThreeRepoTask } from "./threeRepo/preflight.js";
import { resolveDocsRoot, resolveThreeRepoTaskLookup, resolveWritableWorkRoots } from "./threeRepo/cliRoots.js";
import { exitCodeFor, runDoctor } from "./threeRepo/doctor.js";
import { validateNewTaskBindings, type TargetBindings } from "./threeRepo/taskBindings.js";
import { collectMigrationManifest, confirmCutover, copyMigrationSource, readMigrationManifest, transformMigratedKnowledge, verifyMigration, writeMigrationManifest } from "./threeRepo/knowledgeMigration.js";
import { listBackups, rollbackSta } from "./packaging/rollback.js";
import { buildPlanGraph, type TaskNode } from "./graph/taskGraph.js";
import { parsePlanTasks } from "./docs/planGraph.js";
import type { RuntimeTaskWorkRoot } from "./orchestrator/runtimeTask.js";

/**
 * Runnable bridge between this orchestrator and the real `.claude/agents/*.md`
 * pipeline in the repo root — `npm run orchestrate -- <flags>` actually shells
 * out to `claude -p --agent <role>` for each stage classifyTask() selects,
 * gated exactly the way CLAUDE.md's opt-in autonomous mode describes: it
 * stops and prints WAITING_FOR_HUMAN instead of guessing at the five points
 * a person must decide (schema confirmation, a failed QA/security round past
 * retry, deploy approval).
 *
 * Since T01 the run is durable: state lives in `.workflow/state.db` and the
 * readable copy in `.workflow/state.yaml`, so answering `N` at a gate — or
 * closing the terminal, or losing the machine — no longer throws away the
 * stages that already ran. `--resume` picks the same task back up.
 */

export interface CliArgs {
  taskId?: string;
  module?: string;
  projectRoot: string;
  classification: ClassificationInput;
  /** Print the Framework version and exit, without touching anything. */
  version: boolean;
  /** Continue a task that already exists in the store instead of creating one. */
  resume: boolean;
  /** Print every task in the store and exit, without running anything. */
  list: boolean;
  /** Check contracts/*.yaml against the orchestrator's registry and exit. Meant for CI as much as for a person. */
  checkContracts: boolean;
  /** Check layout.yaml against the directories that actually exist and exit. Same audience. */
  checkLayout: boolean;
  checkPromptBudget: boolean;
  /** Check workflows/*.yml against the classifier and exit. Same audience. */
  checkWorkflows: boolean;
  /** Check .codex/agents/*.toml renderings against their .claude/agents sources and exit (OFF10 M2). */
  checkBindings: boolean;
  /** Check project.yaml and stacks/ against the agent roster and exit. Same audience. */
  checkProfile: boolean;
  /** Check decisions/*.md ADRs against the schema and cross-links and exit. Same audience. */
  checkDecisions: boolean;
  /** Check test-pyramid.yaml against its schema and exit. Same audience. */
  checkTestPyramid: boolean;
  /** Check that no agent can review its own work, and report pipelines that ship unreviewed (T39). Same audience. */
  checkReviewSeparation: boolean;
  /** Check escalation-policy.yaml against the runtime policy and exit (T40). Same audience. */
  checkEscalationPolicy: boolean;
  /** Check workspace.yaml, if one exists, against the filesystem and exit (T41). Same audience. */
  checkWorkspace: boolean;
  /** Check repos.yaml, if one exists, against the filesystem and exit (T42). Same audience. */
  checkRepos: boolean;
  /** Check environments.yaml, if one exists, against its schema and exit (T43). Same audience. */
  checkEnvironments: boolean;
  /** Check every module's requirement/design/plan/review/security doc structure against its schema and exit (T53). Same audience. */
  checkDocStructure: boolean;
  /** Validate every module's plan.md task table as a dependency graph — duplicate ids, missing/self/cyclic dependencies, owners, statuses, DES traceability, wave ordering — and exit (T-PM1.3). `--module <name>` scopes it to one plan. */
  checkPlan: boolean;
  /** Check knowledge/*.yaml against its schema, its id/relation rules and its own cross-links, and exit (T61). Same audience. */
  checkKnowledge: boolean;
  /** Check .sta/manifest.json and .sta/config.yaml against the project's real files and exit (T98). Same audience. */
  checkInstallation: boolean;
  /** Check every role workspace under knowledge/_roles/ — each lane's watermark against the knowledge it refers to — and exit (T99). Same audience. */
  checkRoles: boolean;
  /** Snapshot every framework template file (T90) into an output directory, with manifest.json, and exit. Not a --check-*: it writes, it doesn't just report. */
  buildTemplates?: string;
  /** local/dev/staging/production (T43). Defaults to Environment.LOCAL; only used when creating a task — a --resume/--retry inherits the task's already-stored environment. */
  environment: Environment;
  dependsOn: string[];
  stateDb?: string;
  /** Phases of plan.md this run touches, used to slice module docs per `policies/documentation.md` §10. Empty = send the plan whole. */
  phases: number[];
  targetBindings: TargetBindings;
  /**
   * How much the spawned agent may do without a person answering a permission prompt.
   * Absent = the executor's own default (`propose`), which is what every run did before
   * T117 found that headless `propose` runs cannot write files or run commands at all —
   * every tool request becomes an approval nobody is there to give. Unattended runs need
   * at least `edit`; the framework's own hooks (block-git, path permissions, green-before-stop)
   * stay enforced in every mode — this flag widens Claude Code's prompt behaviour only.
   */
  autonomy?: RuntimeAutonomy;
  /**
   * Which runtime adapter drives every stage of the headless pipeline
   * (planning/v2 T-OC5). Absent/`claude-code` keeps the historical behaviour
   * byte-identical; `codex`/`opencode` route through their adapters — both are
   * partial (see each adapter's header) and say so via guard reports.
   */
  runtime?: RuntimeId;
  /**
   * Operator-visible model override for every stage of this run (T-V4-CAST-001),
   * the companion to `--runtime`. Forwarded to the runtime as an explicit
   * request; a value the selected runtime cannot reach is refused by its adapter,
   * not passed through. Absent = each role's frontmatter `model:` governs, exactly
   * as before the flag existed.
   */
  model?: string;
  /** Named V3 orchestrated execution mode. Interactive dev/ba lanes do not use this parser. */
  mode?: RoutingMode;
  /**
   * QA optimization (change-aware scope, deterministic pre-checks, TARGETED/FULL
   * routing) is on by default for qa-engineer rounds; this flag restores the exact
   * V1 executor behaviour for a task where someone explicitly wants it.
   */
  noQaOptimization: boolean;
  /** Escape hatch for a Target whose deterministic tools are known-broken. */
  noDeterministicGate: boolean;
  /** Post-hoc task token budget; pre-spawn caps remain T-V3TOK-100/101. */
  tokenBudget?: number;
}

const FLAG_TO_CLASSIFICATION: Record<string, keyof ClassificationInput> = {
  "--typo": "isTypoOrCopyOnly",
  "--bug-fix": "isClearBugFix",
  "--schema": "touchesSchema",
  "--business-rule": "touchesBusinessRuleOnly",
  "--incremental": "isIncrementalFeature",
  "--new-feature": "isNewFeatureModuleOrProject",
  "--deploy": "isProductionDeployOrMigration",
  "--sensitive": "touchesSensitiveArea",
  "--backend": "touchesBackend",
  "--frontend": "touchesFrontend",
};

export class CliUsageError extends Error {}

export const USAGE =
  "usage (T31 verbs — thin wrappers over the flag-based form below, prefer these):\n" +
  "  sta run --task-id <id> --module <name> <classification flags> [--frontend-target <id>] [--backend-target <id>] [--phase <n,n>] [--depends-on <id,id>] [--env <local|dev|staging|production>] [--autonomy <read-only|propose|edit|full>] [--mode <single|auto|manual>] [--runtime <claude-code|codex|opencode|paid-api>] [--model <name>] [--token-budget <n>] [--no-qa-optimization] [--no-deterministic-gate] [--project-root <path>] [--state-db <path>]\n" +
  "  sta status [<task-id>] [--watch] [--interval <seconds>] [--project-root <path>]   no id = every task; with id = that task's detail\n" +
  "  sta approve <task-id> [--yes|--no] [--project-root <path>]   resolve the current human gate; interactive if neither flag is given\n" +
  "  sta resume  <task-id> --module <name> [--project-root <path>]   continue a task already in the store\n" +
  "  sta retry   <task-id> --module <name> [--project-root <path>]   same as resume — there is no daemon here for the two to mean different things\n" +
  "  sta pause  <task-id> [--project-root <path>]   freeze a task; run/resume/retry refuse it until resumed\n" +
  "  sta cancel <task-id> [--reason <text>] [--project-root <path>]   give up on a task for good; run/resume/retry refuse it permanently\n" +
  "  sta audit  <task-id> [--decisions] [--project-root <path>]   the WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail; --decisions shows only the choices\n" +
  "  sta qa-metrics [<task-id>] [--export-json <path>] [--baseline <path>] [--escaped-defects <n>]   QA token/mode/retry picture per task (QA07); --baseline compares against a saved export\n" +
  "  sta tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>]   token/context composition across orchestrated and interactive runs\n" +
  "  sta context <role> [--module <name>] [--phase <n,n>] [--task <id>] [--packet] [--json] [--project-root <path>]   deterministic context, or the latest validated execution packet\n" +
  "  sta knowledge get <id>[,<id>...] [--lane <ba|sa|uxui|dev>] [--json] [--project-root <path>]   retrieve only permitted knowledge fields (default lane: dev)\n" +
  "  sta knowledge migrate-v2 [--dry-run] [--json] [--project-root <knowledge-root>]   add origin/target_ids without changing item meaning or lifecycle\n" +
  "  sta knowledge reconcile --target <id> [--json] [--project-root <knowledge-root>]   read-only current/desired evidence classifier\n" +
  "  sta policy [<area>] [<section>] [--json] [--project-root <path>]   read one policies/ section instead of the whole file; no args lists every area and section\n" +
  "  sta projects [--workspace <path>] [--project-root <path>]   read-only status summary for every project workspace.yaml names (T41)\n" +
  "  sta init    --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>] [--force]   initialize an explicit install mode\n" +
  "  sta configure knowledge-root <path> [--config-path <path>]       validate and save this installation's single Knowledge root\n" +
    "  sta configure identity --figma-email <email> --claude-email <email> [--config-path <path>]   declare the design accounts (same address; emails only, never a token)\n" +
  "  sta doctor [--project-root <path>]                               read-only diagnostics (T166); exit 1 on any FAIL, never mutates\n" +
  "  sta runtimes                                    which runtimes exist and how well each is supported (T-V1-04)\n" +
  "  sta upgrade --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>]   upgrade an explicit install mode\n" +
  "  sta migrate [--project-root <path>]   carry .sta/ across a breaking manifest schema change, if one is pending (T96)\n" +
  "  sta knowledge-migrate <dry-run|copy|verify|cutover> --source-root <path> --knowledge-root <path> [--now <ISO>] [--confirm I_CONFIRM_MIGRATION]   copy–verify–human-confirmed migration\n" +
  "  sta adopt <plan|status|start|ack|run|approve|validate> [--project-root <path>] [--source-root <path>] [--docs-root <dir>]   import legacy .claude/ docs/ planning/ into the Knowledge root (T82–T85)\n" +
  "  sta rollback [--backup <name>] [--project-root <path>]   undo the most recent upgrade/migrate, or a named one from `--list-backups` (T97)\n" +
  "  sta list-backups [--project-root <path>]   list this project's .sta/backups/ snapshots, oldest first\n" +
  "  sta roles [--module <name>] [--project-root <path>]   where BA, SA, UXUI and DEV each stand against knowledge/ (T99)\n" +
  "  sta roles ack <ba|sa|uxui|dev> <id>[,<id>...] --by <name> [--module <name>]   record that a person in that lane has seen those items\n" +
  "  sta roles signoff <ba|sa|uxui|dev> --by <name> [--reject] [--note <text>] [--module <name>]   that lane's own approval gate (T103)\n" +
  "  sta roles review <id> --as <agent>   move a knowledge item draft -> reviewed, with its checklist (T104)\n" +
  "  sta roles approve <id> --by <name>   move a reviewed item to approved — a person only (T104)\n" +
  "  sta roles inbox [<ba|sa|uxui|dev>] [--module <name>]   what each lane has to look at, derived fresh (T106)\n" +
  "  sta roles impact <id>[,<id>...]   which lanes changing those items would reach, before changing them (T105)\n" +
  "  sta roles context <ba|sa|uxui|dev> [<id>] [--full] [--module <name>]   what that lane may see, and via which role (T107)\n" +
  "\n" +
  "V3 execution: --mode defaults to single; --runtime (or --model) without --mode also means single. auto alone may hand off after UNAVAILABLE (never ERROR/TIMEOUT); manual requires an explicit per-role runner+model in .sta/config.yaml. paid-api additionally requires execution.allow_paid_fallback: true (default false). If no eligible runner remains, the task stops for a person.\n" +
  "  --model <name> overrides every stage's frontmatter model for this run (the same override .sta/config.yaml routing carries); the runtime refuses a model it cannot reach rather than passing it through. Absent, each role's own model: governs.\n" +
  "\n" +
  "underlying flag-based form:\n" +
  "  sta --task-id <id> --module <name> [--phase <n,n>] [--depends-on <id,id>] [--project-root <path>] [--state-db <path>] [--autonomy <read-only|propose|edit|full>] [--mode <single|auto|manual>] [--runtime <claude-code|codex|opencode|paid-api>] [--model <name>] <classification flags>\n" +
  "  sta --task-id <id> --module <name> --resume        continue a task already in the store\n" +
  "  sta --task-id <id> --module <name> [--token-budget <n>] [--no-qa-optimization|--no-deterministic-gate]   run with optional QA/budget controls\n" +
  "  sta --list [--project-root <path>]                 show every task and stop\n" +
  "  sta --check-contracts [--project-root <path>]      check contracts/*.yaml against the agent registry\n" +
  "  sta --check-layout [--project-root <path>]         check layout.yaml against the real directories\n" +
  "  sta --check-prompt-budget [--project-root <path>]  check the static prompt floor: CLAUDE.md + agent prompt budgets, no policies pre-read, pointers resolve\n" +
  "  sta --check-workflows [--project-root <path>]      check generated workflows/*.yml byte-match the classifier\n" +
  "  sta --check-bindings [--project-root <path>]       check generated renderings (.codex/agents, .opencode/agent, .opencode/commands, .agents/skills) byte-match their .claude sources\n" +
  "  sta --check-profile [--project-root <path>]        check project.yaml and stacks/ against the agent roster\n" +
  "  sta --check-decisions [--project-root <path>]      check decisions/*.md ADRs against the schema and cross-links\n" +
  "  sta --check-test-pyramid [--project-root <path>]   check test-pyramid.yaml against its schema\n" +
  "  sta --check-review-separation [--project-root <path>]  check that no agent can review its own work\n" +
  "  sta --check-escalation-policy [--project-root <path>]  check escalation-policy.yaml against the runtime policy\n" +
  "  sta --check-workspace [--project-root <path>]      check workspace.yaml (if any) against the filesystem\n" +
  "  sta --check-repos [--project-root <path>]          check repos.yaml (if any) against the filesystem\n" +
  "  sta --check-environments [--project-root <path>]   check environments.yaml (if any) against its schema\n" +
  "  sta --check-doc-structure [--project-root <path>]  check every _docs/module/*/*.md's sections against its schema\n" +
  "  sta --check-plan [--module <name>] [--project-root <path>]  validate every module's plan.md as a task DAG (deps/cycle/owner/status/DES/waves)\n" +
  "  sta --check-knowledge [--project-root <path>]      check knowledge/*.yaml against its schema and cross-links\n" +
  "  sta --build-templates <out-dir> [--project-root <path>]  snapshot framework template files + manifest.json (T90) into <out-dir>\n" +
  "  sta --check-installation [--project-root <path>]   check .sta/manifest.json and .sta/config.yaml against the project's real files (T98) — needs an initialized Target (.sta/ exists); fails on a bare Framework checkout by design\n" +
  "  sta --check-roles [--project-root <path>]          check each role workspace's watermark against knowledge/ (T99)\n" +
  "  sta --version                                      show the Framework version this CLI runs\n" +
  "run/retry exit codes: 0 deployed · 1 blocked · 2 unknown gate · 3 rejected by a person · 4 parked — a gate awaits `sta approve <task-id> --yes|--no`\n" +
  `  classification flags: ${Object.keys(FLAG_TO_CLASSIFICATION).join(" ")}`;

/** Pure argv parser — kept separate from process.argv/console/exit so it's directly testable. */
export function parseArgs(argv: string[], defaultProjectRoot: string): CliArgs {
  let taskId: string | undefined;
  let moduleName: string | undefined;
  let projectRoot = defaultProjectRoot;
  let stateDb: string | undefined;
  let resume = false;
  let list = false;
  let checkContracts = false;
  let checkLayoutFlag = false;
  let checkPromptBudgetFlag = false;
  let checkWorkflowsFlag = false;
  let checkBindingsFlag = false;
  let checkProfileFlag = false;
  let checkDecisionsFlag = false;
  let checkTestPyramidFlag = false;
  let checkReviewSeparationFlag = false;
  let checkEscalationPolicyFlag = false;
  let checkWorkspaceFlag = false;
  let checkReposFlag = false;
  let checkEnvironmentsFlag = false;
  let checkDocStructureFlag = false;
  let checkPlanFlag = false;
  let checkKnowledgeFlag = false;
  let checkInstallationFlag = false;
  let checkRolesFlag = false;
  let buildTemplatesOutDir: string | undefined;
  let environment: Environment = Environment.LOCAL;
  let dependsOn: string[] = [];
  let phases: number[] = [];
  let autonomy: RuntimeAutonomy | undefined;
  let runtime: RuntimeId | undefined;
  let model: string | undefined;
  let mode: RoutingMode | undefined;
  let noQaOptimization = false;
  let noDeterministicGate = false;
  let tokenBudget: number | undefined;
  let version = false;
  const targetBindings: TargetBindings = { frontend_target: null, backend_target: null };
  const classification: ClassificationInput = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task-id") {
      taskId = argv[++i];
    } else if (arg === "--module") {
      moduleName = argv[++i];
    } else if (arg === "--project-root") {
      projectRoot = argv[++i];
    } else if (arg === "--state-db") {
      stateDb = argv[++i];
    } else if (arg === "--frontend-target") {
      targetBindings.frontend_target = argv[++i] ?? null;
      if (!targetBindings.frontend_target) throw new CliUsageError("--frontend-target requires a Target id");
    } else if (arg === "--backend-target") {
      targetBindings.backend_target = argv[++i] ?? null;
      if (!targetBindings.backend_target) throw new CliUsageError("--backend-target requires a Target id");
    } else if (arg === "--depends-on") {
      dependsOn = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    } else if (arg === "--phase") {
      phases = (argv[++i] ?? "")
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--check-contracts") {
      checkContracts = true;
    } else if (arg === "--check-layout") {
      checkLayoutFlag = true;
    } else if (arg === "--check-prompt-budget") {
      checkPromptBudgetFlag = true;
    } else if (arg === "--check-workflows") {
      checkWorkflowsFlag = true;
    } else if (arg === "--check-bindings") {
      checkBindingsFlag = true;
    } else if (arg === "--check-profile") {
      checkProfileFlag = true;
    } else if (arg === "--check-decisions") {
      checkDecisionsFlag = true;
    } else if (arg === "--check-test-pyramid") {
      checkTestPyramidFlag = true;
    } else if (arg === "--check-review-separation") {
      checkReviewSeparationFlag = true;
    } else if (arg === "--check-escalation-policy") {
      checkEscalationPolicyFlag = true;
    } else if (arg === "--check-workspace") {
      checkWorkspaceFlag = true;
    } else if (arg === "--check-repos") {
      checkReposFlag = true;
    } else if (arg === "--check-environments") {
      checkEnvironmentsFlag = true;
    } else if (arg === "--check-doc-structure") {
      checkDocStructureFlag = true;
    } else if (arg === "--check-plan") {
      checkPlanFlag = true;
    } else if (arg === "--check-knowledge") {
      checkKnowledgeFlag = true;
    } else if (arg === "--check-installation") {
      checkInstallationFlag = true;
    } else if (arg === "--check-roles") {
      checkRolesFlag = true;
    } else if (arg === "--build-templates") {
      buildTemplatesOutDir = argv[++i];
      if (!buildTemplatesOutDir) throw new CliUsageError("--build-templates requires an <out-dir> argument");
    } else if (arg === "--env") {
      const value = argv[++i];
      if (!value || !isEnvironment(value)) {
        throw new CliUsageError(`--env must be one of: ${Object.values(Environment).join(", ")} (got ${value ?? "nothing"})`);
      }
      environment = value;
    } else if (arg === "--autonomy") {
      const value = argv[++i];
      const valid: readonly string[] = ["read-only", "propose", "edit", "full"];
      if (!value || !valid.includes(value)) {
        throw new CliUsageError(`--autonomy must be one of: ${valid.join(", ")} (got ${value ?? "nothing"})`);
      }
      autonomy = value as RuntimeAutonomy;
    } else if (arg === "--runtime") {
      const value = argv[++i];
      if (!value || !(RUNTIME_IDS as readonly string[]).includes(value)) {
        throw new CliUsageError(`--runtime must be one of: ${RUNTIME_IDS.join(", ")} (got ${value ?? "nothing"})`);
      }
      runtime = value as NonNullable<CliArgs["runtime"]>;
    } else if (arg === "--model") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError(`--model requires a model name (got ${value ?? "nothing"})`);
      }
      model = value;
    } else if (arg === "--mode") {
      const value = argv[++i];
      const valid: readonly RoutingMode[] = ["single", "auto", "manual"];
      if (!value || !valid.includes(value as RoutingMode)) {
        throw new CliUsageError(`--mode must be one of: ${valid.join(", ")} (got ${value ?? "nothing"})`);
      }
      mode = value as RoutingMode;
    } else if (arg === "--no-qa-optimization") {
      noQaOptimization = true;
    } else if (arg === "--no-deterministic-gate") {
      noDeterministicGate = true;
    } else if (arg === "--token-budget") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new CliUsageError("--token-budget must be a positive integer");
      tokenBudget = value;
    } else if (arg === "--version") {
      version = true;
    } else if (arg in FLAG_TO_CLASSIFICATION) {
      classification[FLAG_TO_CLASSIFICATION[arg]] = true;
    } else {
      throw new CliUsageError(`unrecognized argument: ${arg}`);
    }
  }

  if (
    !version &&
    !list &&
    !checkContracts &&
    !checkLayoutFlag &&
    !checkPromptBudgetFlag &&
    !checkWorkflowsFlag &&
    !checkBindingsFlag &&
    !checkProfileFlag &&
    !checkDecisionsFlag &&
    !checkTestPyramidFlag &&
    !checkReviewSeparationFlag &&
    !checkEscalationPolicyFlag &&
    !checkWorkspaceFlag &&
    !checkReposFlag &&
    !checkEnvironmentsFlag &&
    !checkDocStructureFlag &&
    !checkPlanFlag &&
    !checkKnowledgeFlag &&
    !checkInstallationFlag &&
    !checkRolesFlag &&
    !buildTemplatesOutDir
  ) {
    if (!taskId) throw new CliUsageError("--task-id is required");
    if (!moduleName) throw new CliUsageError("--module is required (the _docs/module/<name>/ this task belongs to)");
  }
  if (resume && dependsOn.length > 0) {
    throw new CliUsageError("--depends-on is set when a task is created and cannot be changed on --resume");
  }
  if (resume && (targetBindings.frontend_target || targetBindings.backend_target)) {
    throw new CliUsageError("Target bindings are immutable; --frontend-target/--backend-target cannot be used with --resume");
  }

  // Backward compatibility: --runtime (or --model) by itself has always meant one
  // fixed adapter/model. Naming that behaviour must not silently turn handoff on.
  if ((runtime || model) && mode === undefined) mode = "single";

  return {
    taskId,
    module: moduleName,
    projectRoot,
    classification,
    resume,
    list,
    checkContracts,
    checkLayout: checkLayoutFlag,
    checkPromptBudget: checkPromptBudgetFlag,
    checkWorkflows: checkWorkflowsFlag,
    checkBindings: checkBindingsFlag,
    checkProfile: checkProfileFlag,
    checkDecisions: checkDecisionsFlag,
    checkTestPyramid: checkTestPyramidFlag,
    checkReviewSeparation: checkReviewSeparationFlag,
    checkEscalationPolicy: checkEscalationPolicyFlag,
    checkWorkspace: checkWorkspaceFlag,
    checkRepos: checkReposFlag,
    checkEnvironments: checkEnvironmentsFlag,
    checkDocStructure: checkDocStructureFlag,
    checkPlan: checkPlanFlag,
    checkKnowledge: checkKnowledgeFlag,
    checkInstallation: checkInstallationFlag,
    checkRoles: checkRolesFlag,
    buildTemplates: buildTemplatesOutDir,
    environment,
    dependsOn,
    stateDb,
    phases,
    targetBindings,
    autonomy,
    runtime,
    model,
    mode,
    noQaOptimization,
    noDeterministicGate,
    tokenBudget,
    version,
  };
}

/**
 * The Framework version this CLI runs, read from the nearest `package.json`
 * named `software-team-agents` — the published root's version field is the
 * single source of truth (README). Walking up from this file keeps it correct
 * in both layouts: a dev checkout and an installed node_modules package. A CLI
 * that cannot say what version it is has no business failing on it either, so
 * every failure mode degrades to "unknown".
 */
export function cliVersion(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "software-team-agents" && typeof pkg.version === "string") return pkg.version;
      }
    } catch {
      // unreadable/unparseable package.json — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

/**
 * Which `provideHumanApproval` field a gate's approval type maps to. Keyed on
 * `approvalType`, not on the edge's target state: T20 put `test-planner`
 * (and `project-manager` already did, for the "feature" pipeline) between
 * DESIGN and IMPLEMENTATION, so the schema-confirmation gate's target can be
 * PLAN rather than IMPLEMENTATION directly — the approval type is what stays
 * stable, per gatePolicy.ts/approval.ts's matching fix.
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** TASKS.md T32's own example glyphs: ✅ 🔄 ⏳ — extended with the two states only pause/cancel can produce. */
const STATUS_EMOJI: Record<TaskStatusKind, string> = {
  DEPLOYED: "✅",
  RUNNING: "🔄",
  WAITING_FOR_HUMAN: "⏳",
  WAITING_FOR_DEPENDENCY: "⏳",
  BLOCKED: "❌",
  PAUSED: "⏸️",
  CANCELLED: "🚫",
};

export function printListing(registry: TaskRegistry): void {
  const listing = registry.list();
  if (listing.length === 0) {
    console.log("[orchestrator] no tasks in this store yet.");
    return;
  }

  // Which batch each task falls into, so the listing shows what could run
  // together rather than leaving it to be worked out from depends_on by hand.
  const layerOf = new Map<string, number>();
  try {
    registry.readyLayers().forEach((layer, i) => layer.forEach((t) => layerOf.set(t.taskId, i + 1)));
  } catch {
    // A store too broken to graph is still worth listing — the rows below are
    // what would tell someone why.
  }

  for (const { task, status } of listing) {
    const agent = status.currentAgent ? ` agent=${status.currentAgent}` : "";
    const waiting = status.waitingOn?.length ? ` waiting_on=${status.waitingOn.join(",")}` : "";
    const reason = status.reason ? ` — ${status.reason}` : "";
    const layer = layerOf.has(task.taskId) ? ` batch=${layerOf.get(task.taskId)}` : "";
    const emoji = STATUS_EMOJI[status.kind] ?? " ";
    const latestRun = registry.runsForTask(task.taskId).at(-1);
    const route = latestRun ? ` ${formatRunRouting(latestRun)}` : "";
    console.log(
      `  ${emoji} ${task.taskId.padEnd(12)} ${status.kind.padEnd(22)} ${status.state.padEnd(16)}${agent}${layer}${waiting}${route}${reason}`,
    );
  }

  const stats = layerOf.size > 0 ? registry.parallelism() : null;
  if (stats && stats.widest > 1) {
    console.log(
      `[orchestrator] ${stats.tasks} tasks in ${stats.layers} batch(es); up to ${stats.widest} could run at once ` +
        "(the orchestrator still runs one task at a time; T35's lock only makes that safe against " +
        "two processes racing on the same task, it doesn't make batches run concurrently).",
    );
  }
}

/**
 * T32's "real-time" half of the dashboard — polls the store and re-renders `printListing`'s
 * table. There is no server/UI layer in this project (CLAUDE.md's stack is Next.js for the
 * *product* this pipeline builds, not for the pipeline's own tooling), so "real-time" here means
 * a terminal view that refreshes itself, the same shape every other CLI in this space (docker
 * stats, kubectl get pods --watch) uses for the same job.
 *
 * `iterations`/`sleep`/`clear` are injectable so this is actually testable — the default `sleep`
 * really waits and `clear` really clears the screen, but a test can run a handful of iterations
 * instantly and assert on what got rendered, rather than needing to kill a runaway process.
 */
export async function watchListing(
  registry: TaskRegistry,
  opts: { intervalMs: number; iterations: number; sleep?: (ms: number) => Promise<void>; clear?: () => void },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clear = opts.clear ?? (() => console.clear());
  for (let i = 0; i < opts.iterations; i++) {
    clear();
    console.log(`[orchestrator] watching — refreshes every ${Math.round(opts.intervalMs / 1000)}s, Ctrl+C to stop`);
    printListing(registry);
    if (i < opts.iterations - 1) await sleep(opts.intervalMs);
  }
}

/**
 * What the module's plan.md thinks of the task about to start (T-V3TOK-111).
 *
 * A warning, deliberately: the plan is PM's Work Graph and the store is the
 * orchestrator's runtime, and letting an LLM-authored document decide what may
 * execute would move a gate across that boundary. Silent whenever the plan has
 * nothing to say — no module flag, no plan.md, or a task the plan never listed,
 * which is the ordinary case for ad-hoc work.
 *
 * Never throws. A malformed plan is `--check-plan`'s problem to report; it must
 * not stop a run that was otherwise going to work.
 */
function warnIfPlanSaysNotReady(args: CliArgs, taskId: string): void {
  if (!args.module) return;
  try {
    const docsRoot = resolveContextDocsRoot(args.projectRoot);
    const planMd = readModuleDoc(docsRoot, args.module, "plan.md");
    if (planMd === null) return;
    const advisory = planReadinessAdvisory(planMd, taskId);
    if (!advisory) return;
    console.warn(
      `[orchestrator] plan readiness: ${advisory.taskId} is not ready — ${advisory.reason}. ` +
        "Running anyway; this is advice from plan.md, not a gate (PM owns the work graph, the orchestrator owns runtime).",
    );
  } catch {
    // Advisory only — an unreadable plan never stops a run.
  }
}

/** Deterministic task text: prefer the caller-named plan row, preserve taskId for ad-hoc work. */
function runtimeTaskText(args: CliArgs, taskId: string, docsRoot: string): string {
  if (!args.module) return taskId;
  try {
    const planMd = readModuleDoc(docsRoot, args.module, "plan.md");
    if (planMd === null) return taskId;
    return parsePlanTasks(planMd).tasks.find((task) => task.id === taskId)?.description || taskId;
  } catch {
    return taskId;
  }
}

/** Optional phase-tier metadata is advisory input to routing, never a runtime gate. */
function plannedTier(args: CliArgs, taskId: string): string | undefined {
  if (!args.module) return undefined;
  try {
    const planMd = readModuleDoc(resolveContextDocsRoot(args.projectRoot), args.module, "plan.md");
    return planMd === null ? undefined : parsePlanTasks(planMd).tasks.find((task) => task.id === taskId)?.tier;
  } catch {
    return undefined;
  }
}

/** Never called without a terminal: CI/headless execution must not read stdin. */
function promptForCamp(defaultRuntimeId: RuntimeId): RuntimeId {
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
function runtimeTaskWorkRoots(
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
      frameworkRoot: args.projectRoot,
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
function openTask(registry: TaskRegistry, args: CliArgs, taskId: string): Orchestrator {
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
  // creates a legacy code task, which the T35 run hit on a configured machine.
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
  warnIfPlanSaysNotReady(args, taskId);
  // Naming the workflow makes the generated `workflows/<id>.yml` reachable from
  // a run: the file that explains *why* this pipeline is shaped this way is one
  // `cat` away, rather than something a reader has to match up by eye.
  console.log(
    `[orchestrator] task ${taskId}: workflow=${resolveWorkflowId(args.classification)} ` +
      `level=${classification.level} pipeline=${classification.pipeline.join(" -> ")}`,
  );
  for (const reason of classification.reasons) console.log(`[orchestrator]   reason: ${reason}`);
  const docsRoot = resolveContextDocsRoot(args.projectRoot);
  return registry.create({
    taskId,
    classification,
    dependsOn: args.dependsOn,
    environment: args.environment,
    targetBindings: args.targetBindings,
    workflow: resolveWorkflowId(args.classification),
    taskText: runtimeTaskText(args, taskId, docsRoot),
    // Contracts are Framework-owned even when --project-root is a Target.
    projectRoot: resolveFrameworkRoot(),
    docsRoot,
    moduleName: args.module,
    targetWorkRoots: runtimeTaskWorkRoots(args, taskId, classification),
  });
}

const VERBS = [
  "run",
  "status",
  "approve",
  "retry",
  "resume",
  "pause",
  "cancel",
  "audit",
  "projects",
  "init",
  "qa-metrics",
  "tokens",
  "context",
  "knowledge",
  "policy",
  "upgrade",
  "migrate",
  "knowledge-migrate",
  "rollback",
  "list-backups",
  "roles",
  "adopt",
  "configure",
  "doctor",
  "runtimes",
] as const;
type Verb = (typeof VERBS)[number];

function isVerb(s: string | undefined): s is Verb {
  return s !== undefined && (VERBS as readonly string[]).includes(s);
}

function flagValue(rest: string[], flag: string): string | undefined {
  return supportFlagValue(rest, flag);
}

/** Resolves only the existing post-hoc budget model; it never pre-emptively caps a spawn. */
function budgetFor(args: CliArgs): Budget {
  return { ...DEFAULT_BUDGET, token_budget: args.tokenBudget ?? configuredTokenBudget(args.projectRoot) };
}

/**
 * `projects [--workspace <path>]` — T41's read-only fan-out: one line per
 * project workspace.yaml names, each with its own store's status counts.
 *
 * Deliberately never opens a `SqliteTaskStore` for a project that has no
 * `.workflow/state.db` yet — the constructor creates one on open (same as
 * every other verb's first run), and a status listing should never be the
 * thing that plants an empty database in a project nobody has run yet.
 */
async function runProjectsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const workspaceFlag = flagValue(rest, "--workspace");
  const root = workspaceFlag ? path.dirname(path.resolve(workspaceFlag)) : projectRoot;

  if (!hasWorkspace(root)) {
    console.log(
      `[orchestrator] no workspace.yaml at ${workspacePath(root)} — this project runs standalone. ` +
        "Add one (T41) to list other project roots here, or use --project-root with status/audit directly.",
    );
    return 0;
  }

  let workspace: Workspace;
  try {
    workspace = loadWorkspace(root);
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  for (const project of workspace.projects) {
    const dbPath = defaultStateDbPath(project.root);
    if (!fs.existsSync(dbPath)) {
      console.log(`  ${project.name.padEnd(20)} ${project.root} — no tasks yet`);
      continue;
    }
    const store = new SqliteTaskStore(dbPath);
    try {
      const tasks = store.listTasks();
      const counts = new Map<TaskStatusKind, number>();
      for (const t of tasks) {
        const kind = describeStatus(t, tasks).kind;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([kind, n]) => `${STATUS_EMOJI[kind] ?? " "}${n}`).join(" ");
      console.log(`  ${project.name.padEnd(20)} ${project.root} — ${tasks.length} task(s)${summary ? " " + summary : ""}`);
    } finally {
      store.close();
    }
  }
  return 0;
}

/** `init --templates <dir> [--force]` — T92. */
async function runInitVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const mode = flagValue(rest, "--mode");
  if (mode !== "legacy-project" && mode !== "three-repo") {
    throw new CliUsageError("init: --mode <legacy-project|three-repo> is required; mode is never inferred from directories");
  }
  if (mode === "three-repo") {
    try {
      const result = runThreeRepoInit(projectRoot);
      console.log(`[orchestrator] initialized Knowledge root ${projectRoot}: ${result.createdDirectories.length} directory(ies), ${result.createdFiles.length} config file(s)`);
      return 0;
    } catch (e) {
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const templatesDir = flagValue(rest, "--templates");
  if (!templatesDir) throw new CliUsageError("init: --templates <dir> is required (built by `npm run build:templates`)");
  const force = rest.includes("--force");

  try {
    const result = runInit(projectRoot, path.resolve(templatesDir), new Date().toISOString(), { force });
    console.log(
      `[orchestrator] initialized ${projectRoot}: ${result.installed.length} file(s) installed` +
        (result.skippedConflicts.length > 0 ? `, ${result.skippedConflicts.length} conflict(s) left untouched` : "") +
        (result.seededDirs.length > 0 ? `, seeded ${result.seededDirs.join(", ")}` : "") +
        (result.configWritten ? ", wrote .sta/config.yaml" : ", .sta/config.yaml already existed"),
    );
    for (const conflict of result.skippedConflicts) {
      console.log(`[orchestrator]   conflict, left as-is: ${conflict} (project already has different content here)`);
    }
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function runConfigureVerb(rest: string[], frameworkRoot: string): Promise<number> {
  const [subject, knowledgeRoot] = positionalArgs(rest);
  if (subject === "identity") {
    try {
      const config = configureIdentities(
        { figma_email: flagValue(rest, "--figma-email"), claude_email: flagValue(rest, "--claude-email") },
        flagValue(rest, "--config-path"),
      );
      const ids = config.identities!;
      console.log(`[orchestrator] configured identities: figma_email=${ids.figma_email} claude_email=${ids.claude_email}`);
      if (ids.figma_email.trim().toLowerCase() !== ids.claude_email.trim().toLowerCase()) {
        console.error("[orchestrator] WARNING: the two declared emails differ — the UX/UI stage will refuse to run until they match");
      }
      return 0;
    } catch (error) {
      console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subject !== "knowledge-root" || !knowledgeRoot) {
    throw new CliUsageError("configure: use `configure knowledge-root <path>` or `configure identity --figma-email <email> --claude-email <email>`");
  }
  try {
    const config = configureKnowledgeRoot(knowledgeRoot, flagValue(rest, "--config-path"), frameworkRoot);
    console.log(`[orchestrator] configured Knowledge root: ${config.knowledge_root}`);
    return 0;
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** `upgrade --templates <dir>` — T95. */
async function runUpgradeVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const mode = flagValue(rest, "--mode");
  if (mode !== "legacy-project" && mode !== "three-repo") {
    throw new CliUsageError("upgrade: --mode <legacy-project|three-repo> is required; mode is never inferred from directories");
  }
  if (mode === "three-repo") {
    try {
      const result = runThreeRepoUpgrade(projectRoot);
      console.log(`[orchestrator] three-repo upgrade leaves ${result.knowledgePathsSkipped.length} Knowledge/Target path(s) untouched; update the installed framework package to update bindings.`);
      return 0;
    } catch (e) {
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const templatesFlag = flagValue(rest, "--templates");
  // Dogfood F9: an installed package already ships the templates this upgrade
  // should apply — walking up from this file to `templates/manifest.json` finds
  // them whether `sta` runs from a checkout or from node_modules. The explicit
  // flag stays for pointing at any other snapshot.
  let templatesDir = templatesFlag;
  if (!templatesDir) {
    try {
      templatesDir = path.join(resolveFrameworkRoot(), "templates");
      console.log(`[orchestrator] using the installed framework's templates at ${templatesDir}`);
    } catch {
      throw new CliUsageError("upgrade: --templates <dir> is required when no installed framework templates can be located (built by `npm run build:templates`)");
    }
  }

  try {
    const result = runUpgrade(projectRoot, path.resolve(templatesDir), new Date().toISOString());
    console.log(
      `[orchestrator] upgraded ${projectRoot}: ${result.overwritten.length} overwritten, ` +
        `${result.addedNew.length} new, ${result.restoredDeleted.length} restored, ` +
        `${result.skippedUserModified.length} skipped (user-modified), backup at ${result.backupDir}`,
    );
    for (const skipped of result.skippedUserModified) {
      console.log(`[orchestrator]   skipped, user-modified: ${skipped}`);
    }
    for (const dropped of result.droppedFromFramework) {
      console.log(`[orchestrator]   note: ${dropped} is no longer part of the framework — left in place, no longer tracked`);
    }
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** The production composition root. Paid transport is absent unless explicitly enabled. */
export function createProductionRuntimeRegistry(
  projectRoot: string,
  options: { allowPaidFallback?: boolean } = {},
): RuntimeRegistry {
  const adapters = [
    new ClaudeCodeAdapter({ projectRoot }),
    new CodexAdapter({ projectRoot }),
    new OpenCodeAdapter({ projectRoot }),
  ];
  return RuntimeRegistry.forProcess([
    ...adapters,
    ...(options.allowPaidFallback ? [new ApiAdapter({ projectRoot })] : []),
  ]);
}

/** `doctor` (T166) — aggregate read-only diagnostics; never mutates, exits non-zero only on FAIL. */
async function runDoctorVerb(rest: string[]): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root");
  try {
    // The composition root is the one place that may name a concrete adapter
    // (see runtimeAdapter.ts): doctor itself stays provider-blind and receives
    // the same probe a real run would use — and, through that adapter, the
    // claims-vs-install capability sweep.
    const resolvedProjectRoot = projectRoot ?? process.cwd();
    const runtimeRegistry = createProductionRuntimeRegistry(resolvedProjectRoot);
    const claude = runtimeRegistry.get(DEFAULT_RUNTIME_ID);
    const report = await runDoctor({
      projectRoot: projectRoot ?? undefined,
      probe: () => runtimeRegistry.probe(DEFAULT_RUNTIME_ID),
      capabilities: async () => {
        const probe = await runtimeRegistry.probe(DEFAULT_RUNTIME_ID);
        const r = await detectRuntimeCapabilities(claude, { probe });
        return {
          runtimeId: r.runtimeId,
          verified: r.checks.filter((c) => c.verified).map((c) => c.capability),
          unverified: r.checks.filter((c) => !c.verified).map((c) => c.capability),
          missingRequired: r.missingRequired,
          fallbacks: r.fallbacks,
        };
      },
    });
    for (const c of report.checks) {
      const mark = c.status === "PASS" ? "✓" : c.status === "WARNING" ? "!" : "✗";
      console.log(`${mark} ${c.status.padEnd(7)} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      if (c.fix && c.status !== "PASS") console.log(`    Fix: ${c.fix}`);
    }
    const failed = report.checks.filter((c) => c.status === "FAIL").length;
    const warned = report.checks.filter((c) => c.status === "WARNING").length;
    console.log(`[orchestrator] doctor: ${report.ok ? "usable" : "BLOCKED"} (${failed} fail, ${warned} warning)`);
    return exitCodeFor(report);
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** `migrate` — T96. A no-op, reported as such, when the project is already on the current .sta/ schema version. */
async function runMigrateVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  try {
    const result = migrateSta(projectRoot, new Date().toISOString());
    if (result.appliedSteps.length === 0) {
      console.log(`[orchestrator] .sta/ is already at schema_version ${result.to} — nothing to migrate.`);
      return 0;
    }
    console.log(
      `[orchestrator] migrated .sta/ from schema_version ${result.from} to ${result.to} ` +
        `(steps: ${result.appliedSteps.join(" -> ")}), backup at ${result.backupDir}`,
    );
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function runKnowledgeMigrateVerb(rest: string[], frameworkRoot: string): Promise<number> {
  const [action] = positionalArgs(rest);
  const sourceRoot = flagValue(rest, "--source-root");
  const knowledgeRoot = flagValue(rest, "--knowledge-root");
  if (!sourceRoot || !knowledgeRoot || !["dry-run", "copy", "verify", "cutover"].includes(action ?? "")) {
    throw new CliUsageError("knowledge-migrate: use <dry-run|copy|verify|cutover> --source-root <path> --knowledge-root <path>");
  }
  const options = { sourceRoot: path.resolve(sourceRoot), knowledgeRoot: path.resolve(knowledgeRoot), now: flagValue(rest, "--now") ?? new Date().toISOString() };
  try {
    if (action === "dry-run") {
      const manifest = collectMigrationManifest(options);
      console.log(`[orchestrator] migration dry-run: ${manifest.docs.length} _docs files, ${manifest.knowledge.length} knowledge YAML; no files changed.`);
      return 0;
    }
    if (action === "copy") {
      const manifest = collectMigrationManifest(options);
      copyMigrationSource(manifest, options); transformMigratedKnowledge(options); writeMigrationManifest(manifest, options.knowledgeRoot);
      console.log("[orchestrator] copied migration data; source remains the rollback source. Run verify before cutover.");
      return 0;
    }
    const manifest = readMigrationManifest(options.knowledgeRoot);
    const verification = verifyMigration(manifest, options);
    console.log(`[orchestrator] migration verification: ${verification.ok ? "PASS" : "FAIL"}; ${verification.items} items, ${verification.fresh}/${verification.items} fresh.`);
    for (const problem of verification.problems) console.error(`[orchestrator] ${problem}`);
    if (action === "verify") return verification.ok ? 0 : 1;
    const configPath = flagValue(rest, "--config-path");
    confirmCutover(verification, flagValue(rest, "--confirm"), configPath);
    configureKnowledgeRoot(options.knowledgeRoot, configPath, frameworkRoot);
    console.log("[orchestrator] cutover confirmation accepted and installation binding changed. No source deletion was performed.");
    return 0;
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}

/** `rollback [--backup <name>]` — T97. Defaults to the most recent snapshot. */
async function runRollbackVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const backup = flagValue(rest, "--backup");
  try {
    const result = rollbackSta(projectRoot, backup);
    console.log(
      `[orchestrator] rolled back ${projectRoot} to backup "${result.fromBackup}": ${result.restoredFiles.length} file(s) restored.`,
    );
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** `list-backups` — read-only listing of .sta/backups/, oldest first. */
async function runListBackupsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const backups = listBackups(projectRoot);
  if (backups.length === 0) {
    console.log(`[orchestrator] no backups under ${projectRoot}/.sta/backups/ yet.`);
    return 0;
  }
  for (const name of backups) console.log(`  ${name}`);
  return 0;
}

/**
 * The previous failed QA round's findings, read from the module's `review.md`
 * (`## Open Issues`) — the input a recheck plan needs so round N+1 verifies
 * the named findings first instead of starting over (QA06).
 *
 * Findings carry no file lists today because review.md does not name files;
 * freshness keys stay unknown, which planRecheck treats as "no cross-boundary
 * signal" rather than inventing one. Evidence reuse across processes arrives
 * when deterministic results gain their own persistence.
 */
function previousRoundFromDocs(docsRoot: string, moduleName: string, taskId: string): { findings: QaFindingRecord[]; evidence: [] } | undefined {
  if (!moduleName) return undefined;
  const reviewMd = readModuleDoc(docsRoot, moduleName, "review.md");
  if (!reviewMd) return undefined;
  const rows = parseOpenIssues(reviewMd);
  if (rows.length === 0) return undefined;
  const findings: QaFindingRecord[] = rows.map((row, i) => ({
    id: `F${i + 1}`,
    description: row.raw.replace(/\s+/g, " ").slice(0, 200),
    owner: row.owner ?? "unassigned",
    files: [],
    createdAt: Date.now(),
    status: "OPEN",
  }));
  void taskId;
  return { findings, evidence: [] };
}

/**
 * Builds concise QA inputs from the module's existing plan/design and the
 * already-derived task graph.  These are references and summaries, not copied
 * requirements or source payloads; QA may still request the named source.
 */
export async function productionQaInputs(opts: { docsRoot: string; moduleName: string; taskId: string; roots: readonly string[] }) {
  const planMd = readModuleDoc(opts.docsRoot, opts.moduleName, "plan.md") ?? "";
  const designMd = readModuleDoc(opts.docsRoot, opts.moduleName, "design.md") ?? "";
  const parsed = parsePlanTasks(planMd);
  const task = parsed.tasks.find((row) => row.id === opts.taskId);
  const nodes: TaskNode[] = parsed.tasks.map((row) => ({
    id: row.id,
    phase: row.phase,
    dependsOn: row.dependsOn,
    agent: Object.values(AgentStage).includes(row.owner as AgentStage) ? row.owner as AgentStage : undefined,
    description: row.description,
  }));
  let affectedTaskIds: string[] = [];
  let affectedPhases: number[] = [];
  if (task) {
    try {
      const graph = buildPlanGraph(nodes);
      affectedTaskIds = graph.edges
        .filter((edge) => edge.from === task.id || edge.to === task.id)
        .flatMap((edge) => [edge.from, edge.to])
        .filter((id) => id !== task.id)
        .filter((id, index, all) => all.indexOf(id) === index)
        .sort();
      affectedPhases = [...new Set([task.phase, ...affectedTaskIds.map((id) => graph.nodes.get(id)?.phase).filter((phase): phase is number => phase !== undefined)])].sort((a, b) => a - b);
    } catch {
      // Invalid plan graph is itself visible to QA through its plan reference;
      // do not invent graph impact from malformed metadata.
    }
  }
  const riskRef = /^##\s+Risks\s*&\s*Dependencies\s*$/im.test(designMd) ? ["design.md#Risks-&-Dependencies"] : [];
  const diffParts = await Promise.all(opts.roots.map(async (root) => {
    try {
      return `[${root}]\n${await gitDiffSummary(root)}`;
    } catch {
      return `[${root}] No git diff stat available; inspect the scoped files directly.`;
    }
  }));

  return {
    packageInputs: () => ({
      taskIntent: task ? task.description : `Task ${opts.taskId} in module ${opts.moduleName}; no matching plan row was found.`,
      acceptanceCriteria: task
        ? [...task.designRefs.map((ref) => `design.md#${ref}`), `plan.md#${task.id}`]
        : [`plan.md#${opts.taskId}`],
      diffSummary: diffParts.length > 0 ? diffParts.join("\n") : "No writable Target root was resolved; inspect the scoped files directly.",
      knownRisks: riskRef,
    }),
    scopeInputs: () => ({ affectedTaskIds, affectedPhases }),
  };
}

/** Dispatches a T31 verb, translating the ones that are really the existing engine in disguise (`run`, `resume`, `retry`) rather than duplicating the step loop. */
async function runVerb(verb: Verb, rest: string[], defaultProjectRoot: string): Promise<number> {
  switch (verb) {
    case "run":
      return runCli(rest, defaultProjectRoot);
    case "resume":
    case "retry": {
      const taskId = positionalArg(rest);
      if (!taskId) throw new CliUsageError(`${verb}: a task id is required`);
      const flags = rest.filter((a) => a !== taskId);
      return runCli(["--resume", "--task-id", taskId, ...flags], defaultProjectRoot);
    }
    case "status":
      return runStatusVerb(rest, defaultProjectRoot);
    case "approve":
      return runApproveVerb(rest, defaultProjectRoot);
    case "pause":
      return runPauseVerb(rest, defaultProjectRoot);
    case "cancel":
      return runCancelVerb(rest, defaultProjectRoot);
    case "audit":
      return runAuditVerb(rest, defaultProjectRoot);
    case "qa-metrics":
      return runQaMetricsVerb(rest, defaultProjectRoot);
    case "tokens":
      return runTokensVerb(rest, defaultProjectRoot);
    case "context":
      return runContextVerb(rest, defaultProjectRoot);
    case "knowledge":
      return runKnowledgeVerb(rest, defaultProjectRoot);
    case "policy":
      return runPolicyVerb(rest, defaultProjectRoot);
    case "projects":
      return runProjectsVerb(rest, defaultProjectRoot);
    case "init":
      return runInitVerb(rest, defaultProjectRoot);
    case "upgrade":
      return runUpgradeVerb(rest, defaultProjectRoot);
    case "migrate":
      return runMigrateVerb(rest, defaultProjectRoot);
    case "knowledge-migrate":
      return runKnowledgeMigrateVerb(rest, defaultProjectRoot);
    case "rollback":
      return runRollbackVerb(rest, defaultProjectRoot);
    case "list-backups":
      return runListBackupsVerb(rest, defaultProjectRoot);
    case "roles":
      return runRolesVerb(rest, defaultProjectRoot);
    case "adopt":
      return runAdoptVerb(rest, defaultProjectRoot);
    case "configure":
      return runConfigureVerb(rest, defaultProjectRoot);
    case "doctor":
      return runDoctorVerb(rest);
    case "runtimes":
      return runRuntimesVerb(rest, defaultProjectRoot);
  }
}

export async function runCli(argv: string[], defaultProjectRoot: string): Promise<number> {
  // Verbs route before anything else — the flag parser below rejects bare
  // tokens, so a version pre-check that parsed argv first (the old main-block
  // behaviour) made every verb form (`sta status`, `sta doctor`, ...) die with
  // "unrecognized argument" before routing ever ran.
  if (isVerb(argv[0])) {
    return runVerb(argv[0], argv.slice(1), defaultProjectRoot);
  }

  const args = parseArgs(argv, defaultProjectRoot);

  if (args.version) {
    console.log(cliVersion());
    return 0;
  }

  // T-V4-CLI-002: the 18 `--check-*` flags are one table in cli/checkers.ts.
  // Evaluation order is the table order, matching the pre-table if-chain: the
  // flags are mutually exclusive in practice, and the first match wins and exits.
  for (const checker of CHECKERS) {
    if (args[checker.flag]) return runChecker(checker, args.projectRoot, args.module);
  }

  if (args.buildTemplates) {
    const outDir = path.isAbsolute(args.buildTemplates)
      ? args.buildTemplates
      : path.resolve(args.projectRoot, args.buildTemplates);
    const { manifest } = buildTemplates(args.projectRoot, outDir, new Date().toISOString());
    console.log(
      `[orchestrator] wrote ${manifest.files.length} template file(s) + manifest.json to ${outDir} ` +
        `(framework_version ${manifest.framework_version}).`,
    );
    return 0;
  }

  const store = new SqliteTaskStore(args.stateDb ?? defaultStateDbPath(args.projectRoot));
  const registry = new TaskRegistry({ store, budget: budgetFor(args), stateViewPath: defaultStateViewPath(args.projectRoot) });
  let lockedTaskId: string | undefined;

  try {
    if (args.list) {
      printListing(registry);
      return 0;
    }

    const taskId = args.taskId!;

    // T35: refuse to step this task while another orchestrator process already holds it. Held
    // for the rest of this function, released in the outer `finally` below, alongside the store.
    try {
      acquireTaskLock(args.projectRoot, taskId);
    } catch (e) {
      if (e instanceof TaskLockedError) {
        console.error(`[orchestrator] ${e.message}`);
        return 4;
      }
      throw e;
    }
    lockedTaskId = taskId;

    // T31: pause/cancel are a human override the orchestrator's own state machine knows nothing
    // about (see taskRegistry.ts's pause()/cancel()) — enforced here, once, before anything else
    // touches the task, rather than inside Orchestrator itself.
    const stored = store.loadTask(taskId);
    if (stored?.cancelled) {
      console.log(`[orchestrator] task ${taskId} is cancelled (${stored.cancelReason ?? "no reason recorded"}) — nothing to run.`);
      return 1;
    }
    if (stored?.paused) {
      if (!args.resume) {
        console.log(`[orchestrator] task ${taskId} is paused — use \`resume\`/\`retry\` (or --resume) to continue it.`);
        return 1;
      }
      registry.unpause(taskId);
      console.log(`[orchestrator] task ${taskId} was paused — resuming clears the pause and continues.`);
    }

    const orchestrator = openTask(registry, args, taskId);

    // A run that resolves to `propose` (the executor's default when the flag is
    // absent) spawns every stage with Claude Code's `--permission-mode default`,
    // which headless `-p` children answer with an automatic "no": engineers
    // cannot write a single file and every stage fails on its first write. Say
    // so up front instead of letting the run burn tokens discovering it — this
    // stays a warning (not an error) because read-only stages still work and a
    // caller may want exactly that.
    const resolvedAutonomy = args.autonomy ?? "propose";
    if (resolvedAutonomy === "propose") {
      console.error(
        "[orchestrator] WARNING: autonomy is 'propose' (the default), which maps to permission mode 'default' — " +
          "a headless child cannot approve writes or commands, so engineer stages will fail on their first write. " +
          "For an unattended run pass --autonomy edit (or full); hooks and contracts stay enforced either way.",
      );
    }

    // T109: the executor is now a RuntimeAdapter-driven one (T108) rather than a
    // Claude-Code-specific spawn — swapping `runtime` here is the whole point of
    // that seam. `guards` derives from `contracts/<role>.yaml` (T15), same as before.
    // T-OC5: --runtime picks the adapter; the default stays byte-identical to
    // every run before the flag existed.
    let staConfig: ReturnType<typeof loadStaConfig> | undefined;
    try {
      staConfig = loadStaConfig(args.projectRoot);
    } catch {
      // Missing/invalid config is diagnosed by the router. Composition must
      // retain the historical Single/claude-code defaults in either case.
      staConfig = undefined;
    }
    const executionConfig = staConfig?.execution;
    const resolvedMode = args.mode ?? executionConfig?.mode;
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
    const defaultRuntimeId = tierCamp?.runtimeId ?? args.runtime ??
      ((resolvedMode ?? "single") === "single" ? executionConfig?.runner : undefined) ??
      DEFAULT_RUNTIME_ID;
    const allowPaidFallback = executionConfig?.allow_paid_fallback === true;
    if (defaultRuntimeId === PAID_API_RUNTIME_ID && !allowPaidFallback) {
      console.error(
        `[orchestrator] runtime "${PAID_API_RUNTIME_ID}" is unreachable because paid API fallback is disabled; ` +
          "set execution.allow_paid_fallback: true explicitly before selecting it",
      );
      return 1;
    }
    const runtimeRegistry = createProductionRuntimeRegistry(args.projectRoot, { allowPaidFallback });
    const defaultRuntime = runtimeRegistry.tryGet(defaultRuntimeId);
    if (!defaultRuntime) {
      console.error(`[orchestrator] configured Single runner "${defaultRuntimeId}" is not registered`);
      return 1;
    }
    const runtimeExecutor = createRuntimeExecutor({
      runtime: defaultRuntime,
      registry: runtimeRegistry,
      routingFlags: args.runtime || args.model ? { runtime: args.runtime, model: args.model } : undefined,
      planTier: (id) => plannedTier(args, id),
      classification: (id) => store.loadTask(id)?.classification,
      riskSignals: (id) => {
        const classification = store.loadTask(id)?.classification;
        return classification ? riskSignalsFromClassification(classification) : undefined;
      },
      routingMode: resolvedMode,
      allowHandoff: resolvedMode === "auto" && (executionConfig?.allow_handoff ?? true),
      allowPaidFallback,
      projectRoot: args.projectRoot,
      moduleName: () => args.module!,
      guards: contractGuardResolver(args.projectRoot),
      phases: () => (args.phases.length > 0 ? args.phases : undefined),
      // T-UX12: the gate reads the task's own stored level so TRIVIAL/SMALL
      // frontend work is not blocked on the UX-artifact precondition its
      // pipeline deliberately skipped.
      taskLevel: () => stored?.classification.level,
      runtimeTask: (id) => store.loadTask(id)?.runtimeTask,
      taskRunLog: (id) => new RunLog(store.runsForTask(id)),
      // Absent --autonomy keeps the executor's own default ("propose"), which is
      // byte-identical to every run before the flag existed. Unattended runs pass
      // it explicitly — T117's pilot showed headless "propose" cannot act.
      autonomy: args.autonomy,
      // T42: absent when there's no repos.yaml — every stage then spawns in
      // args.projectRoot exactly as before this task existed.
      stageRoots: loadStageRoots(args.projectRoot),
      // Three-repo mode is activated by the installation binding, never by a
      // per-run root override.  The persisted task is reloaded for every stage
      // so resume observes retirement/mapping changes before any adapter starts.
      threeRepoTask: resolveThreeRepoTaskLookup(args.projectRoot, store),
      // T114: projects with V1.5 role workspaces get the same BA → SA → DEV
      // handoff protection when the real orchestrator invokes an agent.
      // An absent knowledge directory means this is a legacy project, whose
      // pre-V1.5 pipeline remains unchanged.
      enforceRoleWorkflow: fs.existsSync(path.join(args.projectRoot, "knowledge")),
      // T43: every stage's prompt states which environment this task targets — the task's own
      // stored environment (survives --resume), not args.environment, which only matters on create.
      extraInstruction: `Environment: ${orchestrator.environment} — ${describeEnvironment(orchestrator.environment, args.projectRoot)}`,
    });

    // QA01–QA06 wrapped around the runtime executor: change-aware scope,
    // deterministic checks before qa-engineer runs, bounded evidence package,
    // and the TARGETED/FULL decision the gate enforces. `--no-qa-optimization`
    // restores the exact V1 behaviour for a caller that wants it.
    // Resolve the same writable roots for change discovery, deterministic
    // checks, and evidence. In three-repo mode this remains the Target, never
    // the Framework binding root. T-V4-CLI-003: one tested resolver, not four
    // inline fail-open copies.
    const qaRoots = resolveWritableWorkRoots(args.projectRoot, taskId, store);
    const qaDocsRoot = resolveDocsRoot(args.projectRoot);
    const qaInputs = await productionQaInputs({ docsRoot: qaDocsRoot, moduleName: args.module ?? "", taskId, roots: qaRoots });

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
        });
    const postDevExecutor = verificationHook?.executor ?? withPostDevVerificationDisabled(runtimeExecutor);

    const executor = args.noQaOptimization
      ? postDevExecutor
      : withQaOptimization({
          inner: postDevExecutor,
          changedFiles: async () => {
            // Read-only git inspection of every writable Target root; legacy
            // projects have exactly one — the project root itself. A root whose
            // git fails contributes nothing rather than poisoning the others;
            // a total failure yields [], which scopes as unbounded → FULL.
            const roots = resolveWritableWorkRoots(args.projectRoot, taskId, store);
            const results = await Promise.allSettled(roots.map((root) => gitChangedFiles(root)));
            return [...new Set(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])))];
          },
          ...(args.noDeterministicGate
            ? { deterministicGate: "disabled" as const }
            : {
                deterministicGate: "enabled" as const,
                deterministicVerification: verificationHook!.verificationFor,
              }),
          packageInputs: qaInputs.packageInputs,
          scopeInputs: qaInputs.scopeInputs,
          riskSignals: () => riskSignalsFromClassification(orchestrator.classification),
          taskLevel: () => orchestrator.classification.level,
          previousRound: () => {
            // In three-repo mode the module docs live under the Knowledge root.
            return previousRoundFromDocs(resolveDocsRoot(args.projectRoot), args.module ?? "", taskId);
          },
        });

    return await runTaskLoop(orchestrator, registry, executor, {
      log: (message) => console.log(message),
      error: (message) => console.error(message),
      confirm,
      isTTY: process.stdin.isTTY === true,
      actor: process.env.USER ?? process.env.USERNAME,
    });
  } finally {
    if (lockedTaskId) releaseTaskLock(args.projectRoot, lockedTaskId);
    registry.close();
  }
}

const isMain = (() => {
  // Compare realpaths: under `npm link` (a Windows junction) argv[1] carries
  // the junction path while this module resolves to the checkout — a plain
  // string compare would silently disable the whole CLI.
  try {
    if (!process.argv[1]) return false;
    const entry = fs.realpathSync.native(path.resolve(process.argv[1]));
    return entry === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  // The default project is WHERE YOU STAND, not where this CLI is installed.
  // The old default (this file's package root) made every verb answer
  // "no knowledge item / no .sta here" when a user ran `sta` inside their own
  // project without --project-root — the sandbox dogfood's F1.
  const defaultProjectRoot = process.cwd();
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  // `--version` is answered inside runCli, after verb routing — see the note there.
  runCli(process.argv.slice(2), defaultProjectRoot)
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof CliUsageError) {
        console.error(`usage error: ${e.message}`);
        console.error(USAGE);
        process.exit(64);
      }
      // T47: a clean, actionable message instead of a raw better-sqlite3/fs stack trace — the
      // same task id's resume/retry picks this back up once whatever made the file unavailable
      // clears, since DatabaseUnavailableError is only ever thrown before anything was written.
      if (e instanceof DatabaseUnavailableError) {
        console.error(`[orchestrator] ${e.message}`);
        process.exit(5);
      }
      // T-V1-09 (dogfood F6): domain failures answer what/why/how-to-fix on one
      // line; the stack is debugging detail, shown only when asked for.
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      if (process.env.STA_DEBUG) console.error(e);
      else console.error("[orchestrator] re-run with STA_DEBUG=1 for the full stack trace");
      process.exit(1);
    });
}
