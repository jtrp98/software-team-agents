#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { TEST_STRATEGY_TRIGGERS, type ClassificationInput, type TestStrategyTrigger } from "./classification/taskClassifier.js";
import { FLAG_TO_CLASSIFICATION, type BooleanClassificationKey } from "./classification/classificationFlags.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { DEFAULT_BUDGET, type Budget } from "./cost/costControl.js";
import { readModuleDoc } from "./agents/moduleDocs.js";
import { RUNTIME_IDS, type RuntimeId } from "./runtime/runtimeSupport.js";
import { resolveContextDocsRoot } from "./targetcli/roots.js";
import type { RuntimeAutonomy } from "./runtime/runtimeAdapter.js";
import { DatabaseUnavailableError, SqliteTaskStore } from "./store/sqliteStore.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { CHECKERS, runChecker } from "./cli/checkers.js";
import { configuredTokenBudget, flagValue as supportFlagValue, positionalArg } from "./cli/support.js";
import { runStatusVerb } from "./cli/verbs/status.js";
import { runApproveVerb } from "./cli/verbs/approve.js";
import { runPauseVerb } from "./cli/verbs/pause.js";
import { runCancelVerb } from "./cli/verbs/cancel.js";
import { runAuditVerb } from "./cli/verbs/audit.js";
import { runRolesVerb } from "./cli/verbs/roles.js";
import { runQaMetricsVerb } from "./cli/verbs/qaMetrics.js";
import { runPolicyVerb } from "./cli/verbs/policy.js";
import { runTokensVerb } from "./cli/verbs/tokens.js";
import { runContextVerb } from "./cli/verbs/context.js";
import { runKnowledgeVerb } from "./cli/verbs/knowledge.js";
import { runRuntimesVerb } from "./cli/verbs/runtimes.js";
import { runChangedVerb } from "./cli/verbs/changed.js";
import { runReportVerb } from "./cli/verbs/report.js";
import { runBoundedRunVerb, BOUNDED_RUN_USAGE } from "./cli/verbs/boundedRun.js";
import { runProjectsVerb } from "./cli/verbs/projects.js";
import { runInitVerb } from "./cli/verbs/init.js";
import { runRetiredAdoptVerb } from "./cli/verbs/adopt.js";
import { runConfigureVerb } from "./cli/verbs/configure.js";
import { runUpgradeVerb } from "./cli/verbs/upgrade.js";
import { runDoctorVerb } from "./cli/verbs/doctor.js";
import { runMigrateVerb } from "./cli/verbs/migrate.js";
import { runKnowledgeMigrateVerb } from "./cli/verbs/knowledgeMigrate.js";
import { runRollbackVerb } from "./cli/verbs/rollback.js";
import { runListBackupsVerb } from "./cli/verbs/listBackups.js";
import { printListing } from "./cli/rendering/taskListing.js";
import { runTaskLoop } from "./cli/runTaskLoop.js";
import { acquireTaskLock, releaseTaskLock, TaskLockedError } from "./concurrency/taskLock.js";
import { assertNoWorkspaceRunLock } from "./concurrency/workspaceRunLock.js";
import { Environment, isEnvironment } from "./environment/environment.js";
import { buildTemplates } from "./packaging/templateBuilder.js";
import { resolveQaWorkRoots } from "./threeRepo/cliRoots.js";
import { type TargetBindings } from "./threeRepo/taskBindings.js";
import { readWorkPlan } from "./docs/planGraph.js";
import { openTask } from "./cli/composition/taskIntake.js";
import { composeProductionTaskExecutor } from "./cli/composition/taskExecutor.js";
import type { CliDependencies } from "./cli/composition/runtimeRegistry.js";

/**
 * Runnable bridge between this orchestrator and the real `.claude/agents/*.md`
 * pipeline in the repo root — `npm run orchestrate -- <flags>` actually shells
 * out to `claude -p --agent <role>` for each stage classifyTask() selects,
 * gated exactly the way CLAUDE.md's opt-in autonomous mode describes: it
 * stops and prints WAITING_FOR_HUMAN instead of guessing at the five points
 * a person must decide (schema confirmation, a failed QA/security round past
 * retry, deploy approval).
 *
 * The run is durable: state lives in `.workflow/state.db` and the
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
  /** Removed V5 surface retained only as an always-undefined parse shape for compatibility tests/callers. */
  mode?: undefined;
  /** Print every task in the store and exit, without running anything. */
  list: boolean;
  /** Check contracts/*.yaml against the orchestrator's registry and exit. Meant for CI as much as for a person. */
  checkContracts: boolean;
  /** Check layout.yaml against the directories that actually exist and exit. Same audience. */
  checkLayout: boolean;
  checkPromptBudget: boolean;
  /** Check workflows/*.yml against the classifier and exit. Same audience. */
  checkWorkflows: boolean;
  /** Check .codex/agents/*.toml renderings against their .claude/agents sources and exit. */
  checkBindings: boolean;
  /** Check project.yaml and stacks/ against the agent roster and exit. Same audience. */
  checkProfile: boolean;
  /** Check decisions/*.md ADRs against the schema and cross-links and exit. Same audience. */
  checkDecisions: boolean;
  /** Check test-pyramid.yaml against its schema and exit. Same audience. */
  checkTestPyramid: boolean;
  /** Check that no agent can review its own work, and report pipelines that ship unreviewed. Same audience. */
  checkReviewSeparation: boolean;
  /** Check escalation-policy.yaml against the runtime policy and exit. Same audience. */
  checkEscalationPolicy: boolean;
  /** Check workspace.yaml, if one exists, against the filesystem and exit. Same audience. */
  checkWorkspace: boolean;
  /** Check repos.yaml, if one exists, against the filesystem and exit. Same audience. */
  checkRepos: boolean;
  /** Check environments.yaml, if one exists, against its schema and exit. Same audience. */
  checkEnvironments: boolean;
  /** Check every module's requirement/design/plan/review/security doc structure against its schema and exit. Same audience. */
  checkDocStructure: boolean;
  /** Check every module document and `##` section against its byte ceiling and exit. Same audience. */
  checkDocSize: boolean;
  /** Validate every module's plan.md task table as a dependency graph — duplicate ids, missing/self/cyclic dependencies, owners, statuses, DES traceability, wave ordering — and exit. `--module <name>` scopes it to one plan. */
  checkPlan: boolean;
  /** Check knowledge/*.yaml against its schema, its id/relation rules and its own cross-links, and exit. Same audience. */
  checkKnowledge: boolean;
  /** Check .sta/manifest.json and .sta/config.yaml against the project's real files and exit. Same audience. */
  checkInstallation: boolean;
  /** Check every role workspace under knowledge/_roles/ — each lane's watermark against the knowledge it refers to — and exit. Same audience. */
  checkRoles: boolean;
  /** Check that only orchestrator/src/git/ can mutate Git and that remote/destructive subcommands are absent. */
  checkGitOwnership: boolean;
  /** Snapshot every framework template file into an output directory, with manifest.json, and exit. Not a --check-*: it writes, it doesn't just report. */
  buildTemplates?: string;
  /** local/dev/staging/production. Defaults to Environment.LOCAL; only used when creating a task — a --resume/--retry inherits the task's already-stored environment. */
  environment: Environment;
  dependsOn: string[];
  adHoc: boolean;
  stateDb?: string;
  /** Phases of plan.md this run touches, used to slice module docs per `policies/documentation.md` §10. Empty = send the plan whole. */
  phases: number[];
  targetBindings: TargetBindings;
  /**
   * How much the spawned agent may do without a person answering a permission prompt.
   * Absent = the executor's own default (`propose`). Unattended runs need at least `edit`;
   * the framework's own hooks (block-git, path permissions, green-before-stop) stay enforced
   * in every mode — this flag widens Claude Code's prompt behaviour only.
   */
  autonomy?: RuntimeAutonomy;
  /**
   * Which runtime adapter drives every stage of the headless pipeline.
   * Absent/`claude-code` keeps the default behaviour; `codex`/`opencode` route through
   * their adapters — both are partial (see each adapter's header) and say so via guard reports.
   */
  runtime?: RuntimeId;
  /**
   * Operator-visible model override for every stage of this run,
   * the companion to `--runtime`. Forwarded to the runtime as an explicit
   * request; a value the selected runtime cannot reach is refused by its adapter,
   * not passed through. Absent = each role's frontmatter `model:` governs.
   */
  model?: string;
  /** Operator-visible reasoning-effort override; runtime adapters validate their own vocabulary. */
  effort?: string;
  /**
   * QA optimization (change-aware scope, deterministic pre-checks, TARGETED/FULL
   * routing) is on by default for qa-engineer rounds; this flag restores the
   * unoptimized executor behaviour for a task where someone explicitly wants it.
   */
  noQaOptimization: boolean;
  /** Escape hatch for a Target whose deterministic tools are known-broken. */
  noDeterministicGate: boolean;
  noDocumentGate: boolean;
  /** Post-hoc task token budget. */
  tokenBudget?: number;
}

export type { BooleanClassificationKey };
export { FLAG_TO_CLASSIFICATION };

export class CliUsageError extends Error {}

/**
 * T-V8-029 - the retired wave surfaces, refused by name rather than as an
 * unrecognized argument.
 *
 * A script that still passes one of these deserves to be told what replaced
 * it. `sta bounded-run` compiles and registers a whole selected plan scope in
 * one transaction (`orchestrator/planCompilation.ts`), so the one-by-one
 * `--register-only` preparation step and the separate `--wave` execution and
 * `--resume-run` lifecycle have no successor to map onto individually.
 */
export const RETIRED_WAVE_FLAGS = new Set([
  "--register-only",
  "--wave",
  "--max-tasks",
  "--dry-run",
  "--resume-run",
  "--no-wave-runner",
]);

export function retiredWaveFlagMessage(flag: string): string {
  const replacement =
    flag === "--register-only"
      ? "`sta bounded-run` registers the whole selected plan scope atomically; there is no per-task preparation step to run first"
      : flag === "--dry-run"
        ? "use `sta bounded-run ... --dry-run`, which previews scope, order, gates and base revision without freezing anything"
        : flag === "--resume-run"
          ? "use `sta bounded-run --resume <run-id>`; `--resume` keeps its per-task meaning"
          : "use `sta bounded-run --module <name> (--all | --phase <n> | --task <id,...>) [--until next-gate|qa|done]`";
  return (
    flag + " was retired in V8 along with the wave runner: " + replacement + ". " +
    "Existing `.workflow/wave-runs/` records stay readable via `sta status`/`sta report`, but cannot be resumed."
  );
}

export const USAGE =
  "usage (verbs — thin wrappers over the flag-based form below, prefer these):\n" +
  "  sta run --task-id <id> --module <name> <classification flags> [--test-strategy <cross-task,multi-system,migration,security,release>] [--frontend-target <id>] [--backend-target <id>] [--phase <n,n>] [--depends-on <id,id>] [--ad-hoc] [--env <local|dev|staging|production>] [--autonomy <read-only|propose|edit|full>] [--runtime <claude-code|codex|opencode|antigravity>] [--model <name>] [--effort <name>] [--token-budget <n>] [--no-qa-optimization] [--no-deterministic-gate] [--project-root <path>] [--state-db <path>]\n" +
  "  sta status [<task-id>] [--watch] [--interval <seconds>] [--project-root <path>]   no id = every task; with id = that task's detail\n" +
  "  sta approve <task-id> [--yes|--no] [--project-root <path>]   resolve the current human gate; interactive if neither flag is given\n" +
  "  sta resume  <task-id> --module <name> [--project-root <path>]   continue a task already in the store\n" +
  "  sta retry   <task-id> --module <name> [--project-root <path>]   same as resume — there is no daemon here for the two to mean different things\n" +
  "  sta pause  <task-id> [--project-root <path>]   freeze a task; run/resume/retry refuse it until resumed\n" +
  "  sta cancel <task-id> [--reason <text>] [--project-root <path>]   give up on a task for good; run/resume/retry refuse it permanently\n" +
  "  sta audit  <task-id> [--decisions] [--project-root <path>]   the WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail; --decisions shows only the choices\n" +
  "  sta qa-metrics [<task-id>] [--export-json <path>] [--baseline <path>] [--escaped-defects <n>]   QA token/mode/retry picture per task; --baseline compares against a saved export\n" +
  "  sta tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>]   token/context composition across orchestrated and interactive runs\n" +
  "  sta context <role> [--module <name>] [--phase <n,n>] [--task <id>] [--packet] [--views] [--json] [--project-root <path>]   deterministic context, latest validated packet, or read-only generated checklist/prompt views\n" +
  "  sta knowledge get <id>[,<id>...] [--lane <ba|sa|uxui|dev>] [--json] [--project-root <path>]   retrieve only permitted knowledge fields (default lane: dev)\n" +
  "  sta knowledge migrate-v2 [--dry-run] [--json] [--project-root <knowledge-root>]   add origin/target_ids without changing item meaning or lifecycle\n" +
  "  sta knowledge reconcile --target <id> [--json] [--project-root <knowledge-root>]   read-only current/desired evidence classifier\n" +
  "  sta policy [<area>] [<section>] [--json] [--project-root <path>]   read one policies/ section instead of the whole file; no args lists every area and section\n" +
  "  sta projects [--workspace <path>] [--project-root <path>]   read-only status summary for every project workspace.yaml names\n" +
  "  sta init    --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>] [--force]   initialize an explicit install mode\n" +
  "  sta configure knowledge-root <path> [--config-path <path>]       validate and save this installation's single Knowledge root\n" +
  "  sta configure identity --figma-email <email> --claude-email <email> [--config-path <path>]   declare the design accounts (same address; emails only, never a token)\n" +
  "  sta doctor [--project-root <path>]                               read-only diagnostics; exit 1 on any FAIL, never mutates\n" +
  "  sta runtimes                                    which runtimes exist and how well each is supported\n" +
  "  sta changed [--project-root <path>] [--json]     surface working-tree changes and deterministic green/red gate status\n" +
  "  sta report  [--output <path>] [--module <name>] [--project-root <path>]   visual dashboard as a static offline HTML page\n" +
  `  ${BOUNDED_RUN_USAGE.split("\n").join("\n  ")}   explicit bounded run: intake/preview/freeze, then DEV -> verification -> checkpoint -> coherent QA/repair to a chosen boundary\n` +
  "  sta upgrade --mode <legacy-project|three-repo> [--templates <dir>] [--project-root <path>]   upgrade an explicit install mode\n" +
  "  sta migrate [--project-root <path>]   carry .sta/ across a breaking manifest schema change, if one is pending\n" +
  "  sta knowledge-migrate <dry-run|copy|verify|cutover> --source-root <path> --knowledge-root <path> [--now <ISO>] [--confirm I_CONFIRM_MIGRATION]   copy–verify–human-confirmed migration\n" +
  "  sta adopt   retired in V5 (ADR-024) — the one-time legacy import has run; no replacement\n" +
  "  sta rollback [--backup <name>] [--project-root <path>]   undo the most recent upgrade/migrate, or a named one from `--list-backups`\n" +
  "  sta list-backups [--project-root <path>]   list this project's .sta/backups/ snapshots, oldest first\n" +
  "  sta roles [--module <name>] [--project-root <path>]   where BA, SA, UXUI and DEV each stand against knowledge/\n" +
  "  sta roles ack <ba|sa|uxui|dev> <id>[,<id>...] --by <name> [--module <name>]   record that a person in that lane has seen those items\n" +
  "  sta roles signoff <ba|sa|uxui|dev> --by <name> [--reject] [--note <text>] [--module <name>]   that lane's own approval gate\n" +
  "  sta roles review <id> --as <agent>   move a knowledge item draft -> reviewed, with its checklist\n" +
  "  sta roles approve <id> --by <name>   move a reviewed item to approved — a person only\n" +
  "  sta roles inbox [<ba|sa|uxui|dev>] [--module <name>]   what each lane has to look at, derived fresh\n" +
  "  sta roles impact <id>[,<id>...]   which lanes changing those items would reach, before changing them\n" +
  "  sta roles context <ba|sa|uxui|dev> [<id>] [--full] [--module <name>]   what that lane may see, and via which role\n" +
  "\n" +
  "Runtime selection and model policy are separate: --runtime <id>, routing.by_role, then the configured runtime/order choose the camp. Model/effort resolve as explicit --model/--effort (or routing.by_role values), canonical task Tier, model-tiers.yaml role default, then an intentional runtime default. Legacy frontmatter is read only when the tier file predates role_defaults.\n" +
  "  --model <name> and --effort <name> are explicit operator overrides for this run; adapters validate their own vocabulary. Task/role Tier cells are validated and fail closed when unsupported.\n" +
  "\n" +
  "underlying flag-based form:\n" +
  "  sta --task-id <id> --module <name> [--phase <n,n>] [--depends-on <id,id>] [--ad-hoc] [--project-root <path>] [--state-db <path>] [--autonomy <read-only|propose|edit|full>] [--runtime <claude-code|codex|opencode|antigravity>] [--model <name>] [--effort <name>] <classification flags>\n" +
  "  sta --task-id <id> --module <name> --resume        continue a task already in the store\n" +
  "  sta --task-id <id> --module <name> [--token-budget <n>] [--no-qa-optimization|--no-deterministic-gate]   run with optional QA/budget controls\n" +
  "  sta --list [--project-root <path>]                 show every task and stop\n" +
  "  sta --check-contracts [--project-root <path>]      check contracts/*.yaml against the agent registry\n" +
  "  sta --check-layout [--project-root <path>]         check layout.yaml against the real directories\n" +
  "  sta --check-prompt-budget [--project-root <path>]  check the static prompt floor: CLAUDE.md + agent prompt budgets, no policies pre-read, pointers resolve\n" +
  "  sta --check-workflows [--project-root <path>]      check generated workflows/*.yml byte-match the classifier\n" +
  "  sta --check-bindings [--project-root <path>]       check generated renderings (.codex/agents, .opencode/agent, .opencode/commands, .agents/skills), the .codex/hooks mirrors and each hook's generated guard-rule block byte-match their sources\n" +
  "  sta --check-profile [--project-root <path>]        check project.yaml and stacks/ against the agent roster\n" +
  "  sta --check-decisions [--project-root <path>]      check decisions/*.md ADRs against the schema and cross-links\n" +
  "  sta --check-test-pyramid [--project-root <path>]   check test-pyramid.yaml against its schema\n" +
  "  sta --check-review-separation [--project-root <path>]  check that no agent can review its own work\n" +
  "  sta --check-escalation-policy [--project-root <path>]  check escalation-policy.yaml against the runtime policy\n" +
  "  sta --check-workspace [--project-root <path>]      check workspace.yaml (if any) against the filesystem\n" +
  "  sta --check-repos [--project-root <path>]          check repos.yaml (if any) against the filesystem\n" +
  "  sta --check-environments [--project-root <path>]   check environments.yaml (if any) against its schema\n" +
  "  sta --check-doc-structure [--project-root <path>]  check every _docs/module/*/*.md's sections against its schema, and that every design.md contract section carries a DES-NNN id (report-only until wired into CI)\n" +
  "  sta --check-doc-size [--project-root <path>]       check every _docs/module/*/*.md document and `##` section against its byte ceiling (report-only until wired into CI)\n" +
  "  sta --check-plan [--module <name>] [--project-root <path>]  validate every module's plan.md as a task DAG (deps/cycle/owner/status/DES/waves)\n" +
  "  sta --check-knowledge [--project-root <path>]      check knowledge/*.yaml against its schema and cross-links\n" +
  "  sta --build-templates <out-dir> [--project-root <path>]  snapshot framework template files + manifest.json into <out-dir>\n" +
  "  sta --check-installation [--project-root <path>]   check .agent-team/manifest.json against the project's real files — needs an initialized workspace; fails on a bare Framework checkout by design\n" +
  "  sta --check-roles [--project-root <path>]          check each role workspace's watermark against knowledge/\n" +
  "  sta --check-git-ownership [--project-root <path>]  check that Git mutation stays inside orchestrator/src/git/ and forbidden subcommands are absent\n" +
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
  let checkDocSizeFlag = false;
  let checkPlanFlag = false;
  let checkKnowledgeFlag = false;
  let checkInstallationFlag = false;
  let checkRolesFlag = false;
  let checkGitOwnershipFlag = false;
  let buildTemplatesOutDir: string | undefined;
  let environment: Environment = Environment.LOCAL;
  let dependsOn: string[] = [];
  let adHoc = false;
  let phases: number[] = [];
  let autonomy: RuntimeAutonomy | undefined;
  let runtime: RuntimeId | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let noQaOptimization = false;
  let noDeterministicGate = false;
  let noDocumentGate = false;
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
    } else if (arg === "--ad-hoc") {
      adHoc = true;
    } else if (arg === "--depends-on") {
      dependsOn = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    } else if (arg === "--test-strategy") {
      const values = (argv[++i] ?? "").split(",").map(value => value.trim()).filter(Boolean);
      const invalid = values.filter(value => !(TEST_STRATEGY_TRIGGERS as readonly string[]).includes(value));
      if (values.length === 0 || invalid.length > 0) {
        throw new CliUsageError(`--test-strategy must contain one or more of: ${TEST_STRATEGY_TRIGGERS.join(", ")} (got ${invalid.join(", ") || "nothing"})`);
      }
      classification.testStrategyTriggers = [...new Set(values)] as TestStrategyTrigger[];
    } else if (arg === "--phase") {
      phases = (argv[++i] ?? "")
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
    } else if (arg === "--resume") {
      resume = true;
    } else if (RETIRED_WAVE_FLAGS.has(arg)) {
      throw new CliUsageError(retiredWaveFlagMessage(arg));
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
    } else if (arg === "--check-doc-size") {
      checkDocSizeFlag = true;
    } else if (arg === "--check-plan") {
      checkPlanFlag = true;
    } else if (arg === "--check-knowledge") {
      checkKnowledgeFlag = true;
    } else if (arg === "--check-installation") {
      checkInstallationFlag = true;
    } else if (arg === "--check-roles") {
      checkRolesFlag = true;
    } else if (arg === "--check-git-ownership") {
      checkGitOwnershipFlag = true;
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
    } else if (arg === "--effort") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError(`--effort requires a runtime-supported effort name (got ${value ?? "nothing"})`);
      }
      effort = value;
    } else if (arg === "--mode") {
      // Execution modes are removed: there is one route. The flag
      // errors with its replacement for this release rather than being
      // silently accepted and ignored, which would change where a run lands
      // without telling anyone.
      throw new CliUsageError(
        "--mode is removed: `sta run` has one route (execution modes single/auto/manual no longer exist). " +
          "Use --runtime <id>, --model <name> and/or --effort <name> for this run, or routing.by_role in .sta/config.yaml for a per-role override. " +
          "A route that cannot execute always stops for a person; nothing hands off to another runner.",
      );
    } else if (arg === "--no-qa-optimization") {
      noQaOptimization = true;
    } else if (arg === "--no-deterministic-gate") {
      noDeterministicGate = true;
    } else if (arg === "--no-document-gate") {
      noDocumentGate = true;
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
    !checkDocSizeFlag &&
    !checkPlanFlag &&
    !checkKnowledgeFlag &&
    !checkInstallationFlag &&
    !checkRolesFlag &&
    !checkGitOwnershipFlag &&
    !buildTemplatesOutDir
  ) {
    if (!taskId) throw new CliUsageError("--task-id is required (a whole plan scope is `sta bounded-run` instead)");
    if (!moduleName) throw new CliUsageError("--module is required (the _docs/module/<name>/ this task belongs to)");
  }
  if (resume && dependsOn.length > 0) {
    throw new CliUsageError("--depends-on is set when a task is created and cannot be changed on --resume");
  }
  if (resume && (targetBindings.frontend_target || targetBindings.backend_target)) {
    throw new CliUsageError("Target bindings are immutable; --frontend-target/--backend-target cannot be used with --resume");
  }
  return {
    taskId,
    module: moduleName,
    projectRoot,
    classification,
    resume,
    mode: undefined,
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
    checkDocSize: checkDocSizeFlag,
    checkPlan: checkPlanFlag,
    checkKnowledge: checkKnowledgeFlag,
    checkInstallation: checkInstallationFlag,
    checkRoles: checkRolesFlag,
    checkGitOwnership: checkGitOwnershipFlag,
    buildTemplates: buildTemplatesOutDir,
    environment,
    dependsOn,
    adHoc,
    stateDb,
    phases,
    targetBindings,
    autonomy,
    runtime,
    model,
    effort,
    noQaOptimization,
    noDeterministicGate,
    noDocumentGate,
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
 * `approvalType`, not on the edge's target state: `test-planner`
 * (and `project-manager` already did, for the "feature" pipeline) sits between
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
  "changed",
  "report",
  "bounded-run",
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

/** Dispatches a verb, translating the ones that are really the existing engine in disguise (`run`, `resume`, `retry`) rather than duplicating the step loop. */
async function runVerb(verb: Verb, rest: string[], defaultProjectRoot: string, dependencies: CliDependencies): Promise<number> {
  switch (verb) {
    case "run":
      return runCli(rest, defaultProjectRoot, dependencies);
    case "resume":
    case "retry": {
      const taskId = positionalArg(rest);
      if (!taskId) throw new CliUsageError(`${verb}: a task id is required`);
      const flags = rest.filter((a) => a !== taskId);
      return runCli(["--resume", "--task-id", taskId, ...flags], defaultProjectRoot, dependencies);
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
      return runRetiredAdoptVerb();
    case "configure":
      return runConfigureVerb(rest, defaultProjectRoot);
    case "doctor":
      return runDoctorVerb(rest);
    case "runtimes":
      return runRuntimesVerb(rest, defaultProjectRoot);
    case "changed":
      return runChangedVerb(rest, defaultProjectRoot);
    case "report":
      return runReportVerb(rest, defaultProjectRoot);
    case "bounded-run":
      return runBoundedRunVerb(rest, defaultProjectRoot, dependencies);
  }
}

export async function runCli(argv: string[], defaultProjectRoot: string, dependencies: CliDependencies = {}): Promise<number> {
  // Verbs route before anything else — the flag parser below rejects bare
  // tokens, so a version pre-check that parsed argv first (the old main-block
  // behaviour) made every verb form (`sta status`, `sta doctor`, ...) die with
  // "unrecognized argument" before routing ever ran.
  if (isVerb(argv[0])) {
    return runVerb(argv[0], argv.slice(1), defaultProjectRoot, dependencies);
  }

  const args = parseArgs(argv, defaultProjectRoot);

  if (args.version) {
    console.log(cliVersion());
    return 0;
  }

  // The 18 `--check-*` flags are one table in cli/checkers.ts.
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
  const registry = new TaskRegistry({
    store,
    planTasks: () => {
      const md = args.module ? readModuleDoc(resolveContextDocsRoot(args.projectRoot), args.module, "plan.md") : null;
      if (md === null) return null;
      const plan = readWorkPlan(md);
      if (plan.problems.length) throw new CliUsageError(`invalid plan: ${plan.problems.join("; ")}`);
      return plan.tasks;
    },
    budget: budgetFor(args),
    stateViewPath: defaultStateViewPath(args.projectRoot),
  });
  let lockedTaskId: string | undefined;

  try {
    if (args.list) {
      printListing(registry);
      return 0;
    }

    const taskId = args.taskId!;

    // Refuse to step this task while another orchestrator process already holds it. Held
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

    // Pause/cancel are a human override the orchestrator's own state machine knows nothing
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
    for (const targetRoot of resolveQaWorkRoots(args.projectRoot, taskId, store)) {
      assertNoWorkspaceRunLock(args.projectRoot, targetRoot);
    }

    const composition = await composeProductionTaskExecutor(args, taskId, orchestrator, store, dependencies);

    return await runTaskLoop(orchestrator, registry, composition.executor, {
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
  // project without --project-root.
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
      // A clean, actionable message instead of a raw better-sqlite3/fs stack trace — the
      // same task id's resume/retry picks this back up once whatever made the file unavailable
      // clears, since DatabaseUnavailableError is only ever thrown before anything was written.
      if (e instanceof DatabaseUnavailableError) {
        console.error(`[orchestrator] ${e.message}`);
        process.exit(5);
      }
      // Domain failures answer what/why/how-to-fix on one
      // line; the stack is debugging detail, shown only when asked for.
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      if (process.env.STA_DEBUG) console.error(e);
      else console.error("[orchestrator] re-run with STA_DEBUG=1 for the full stack trace");
      process.exit(1);
    });
}
