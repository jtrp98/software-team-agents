#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { AgentStage, TaskState } from "./types.js";
import { classifyTask, type ClassificationInput } from "./classification/taskClassifier.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { createRuntimeExecutor } from "./runtime/runtimeExecutor.js";
import { withQaOptimization, riskSignalsFromClassification } from "./qa/optimized.js";
import { gitChangedFiles, gitDiffSummary } from "./qa/changeSource.js";
import { combineProjectRunners, createProjectRunner } from "./qa/projectRunner.js";
import { LocalWorkspace } from "./runtime/localWorkspace.js";
import { DEFAULT_BUDGET, type Budget } from "./cost/costControl.js";
import { loadStaConfig, StaConfigMissingError } from "./packaging/staConfig.js";
import { buildMetricsExport, compareBaselines, compareTokenBaselines, taskQaMetrics, tokenMetricsExport, type TaskTokenMetrics, type TokenMetricsExport } from "./qa/metrics.js";
import type { QaFindingRecord } from "./qa/evidence.js";
import { parseOpenIssues } from "./orchestrator/failureClassifier.js";
import { readModuleDoc } from "./agents/moduleDocs.js";
import { ClaudeCodeAdapter } from "./runtime/claudeCodeAdapter.js";
import { CodexAdapter } from "./runtime/codexAdapter.js";
import { OpenCodeAdapter } from "./runtime/openCodeAdapter.js";
import { RUNTIME_IDS, describeRuntimeSupport } from "./runtime/runtimeSupport.js";
import { detectRuntimeCapabilities } from "./runtime/runtimeCapabilityDetection.js";
import { resolveContextDocsRoot, resolveFrameworkRoot } from "./targetcli/roots.js";
import type { RuntimeAutonomy } from "./runtime/runtimeAdapter.js";
import { contractGuardResolver } from "./runtime/runtimeGuards.js";
import { DatabaseUnavailableError, SqliteTaskStore } from "./store/sqliteStore.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { checkAllContracts } from "./agents/agentContract.js";
import { checkPathRules } from "./agents/pathPermissions.js";
import { checkLayout } from "./layout/repoLayout.js";
import { checkPromptBudget } from "./layout/promptBudget.js";
import { ApprovalType } from "./gates/approval.js";
import { checkAllWorkflows, resolveWorkflowId } from "./workflow/workflowDefinition.js";
import { checkBindings } from "./runtime/bindingGenerator.js";
import { checkProfile } from "./profile/projectProfile.js";
import { checkDecisions } from "./decisions/decisionLog.js";
import { checkTestPyramid } from "./testing/testPyramid.js";
import { describeStatus, type TaskStatusKind } from "./orchestrator/taskStatus.js";
import { RunLog } from "./observability/runLog.js";
import { acquireTaskLock, releaseTaskLock, TaskLockedError } from "./concurrency/taskLock.js";
import { actorsIn, auditTrail, decisionTrail, formatAuditTrail } from "./audit/auditTrail.js";
import { checkReviewSeparation } from "./review/reviewSeparation.js";
import { checkEscalationPolicy } from "./escalation/escalationPolicy.js";
import { checkWorkspace, hasWorkspace, loadWorkspace, workspacePath, type Workspace } from "./workspace/workspace.js";
import { checkRepoMap, loadStageRoots } from "./repos/repoMap.js";
import { Environment, checkEnvironmentConfig, describeEnvironment, isEnvironment } from "./environment/environment.js";
import { checkDocStructure } from "./docs/docStructure.js";
import { checkPlanGraphs, planReadinessAdvisory } from "./docs/planGraph.js";
import { KnowledgeBase, checkKnowledge } from "./knowledge/knowledgeBase.js";
import { LANE_LABEL, ROLE_LANES, isRoleLane } from "./roles/roleLane.js";
import {
  acknowledge,
  checkRoleWorkspaces,
  laneView,
  loadRoleWorkspace,
  writeRoleWorkspace,
} from "./roles/roleWorkspace.js";
import { describeStage, roleWorkflowState, workflowFor, workspacesUnder } from "./roles/roleWorkflow.js";
import { recordSignoff } from "./roles/roleApproval.js";
import { approveItem, checklistFor, reviewItem } from "./roles/artifactReview.js";
import { lanesAffectedBy, notificationsFor } from "./roles/changePropagation.js";
import { laneContext, laneGet } from "./roles/laneContext.js";
import { KnowledgeContext } from "./knowledge/knowledgeContext.js";
import { renderKnowledgeRetrieval } from "./knowledge/retrievalRender.js";
import { writeKnowledgeItem } from "./knowledge/knowledgeStore.js";
import type { RoleLane } from "./roles/roleLane.js";
import { buildTemplates } from "./packaging/templateBuilder.js";
import { runInit } from "./packaging/initCommand.js";
import { runUpgrade } from "./packaging/upgradeCommand.js";
import { runThreeRepoInit, runThreeRepoUpgrade } from "./packaging/threeRepoCommand.js";
import { migrateSta } from "./packaging/migration.js";
import { configureIdentities, configureKnowledgeRoot, loadInstallationConfig } from "./threeRepo/installation.js";
import { loadTargetRegistry } from "./threeRepo/targets.js";
import { preflightThreeRepoTask } from "./threeRepo/preflight.js";
import { exitCodeFor, runDoctor } from "./threeRepo/doctor.js";
import { validateNewTaskBindings, type TargetBindings } from "./threeRepo/taskBindings.js";
import { collectMigrationManifest, confirmCutover, copyMigrationSource, readMigrationManifest, transformMigratedKnowledge, verifyMigration, writeMigrationManifest } from "./threeRepo/knowledgeMigration.js";
import { listBackups, rollbackSta } from "./packaging/rollback.js";
import { validateInstallation } from "./packaging/installValidation.js";
import {
  acknowledgePreflight,
  AdoptionBlockedError,
  ALL_ADOPTION_STAGES,
  approveAdoptionStage,
  initAdoption,
  planAdoption,
  recordAdoptionValidation,
  runAdoptionStage,
} from "./adoption/adoptionRunner.js";
import { readAdoptionState } from "./adoption/adoptionStore.js";
import { validateAdoption } from "./adoption/adoptionValidation.js";
import type { AdoptionStageId } from "./adoption/adoptionModel.js";
import { getPolicySection, listPolicySections, PolicyIndexError } from "./docs/policyIndex.js";
import { buildPlanGraph, type TaskNode } from "./graph/taskGraph.js";
import { parsePlanTasks } from "./docs/planGraph.js";
import { buildContextCommand, ContextCommandError, contextCommandJson, renderContextCommand } from "./context/contextCommand.js";

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
  runtime?: "claude-code" | "codex" | "opencode";
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
  "  sta run --task-id <id> --module <name> <classification flags> [--frontend-target <id>] [--backend-target <id>] [--phase <n,n>] [--depends-on <id,id>] [--env <local|dev|staging|production>] [--autonomy <read-only|propose|edit|full>] [--project-root <path>] [--state-db <path>]\n" +
  "  sta status [<task-id>] [--watch] [--interval <seconds>] [--project-root <path>]   no id = every task; with id = that task's detail\n" +
  "  sta approve <task-id> [--yes|--no] [--project-root <path>]   resolve the current human gate; interactive if neither flag is given\n" +
  "  sta resume  <task-id> --module <name> [--project-root <path>]   continue a task already in the store\n" +
  "  sta retry   <task-id> --module <name> [--project-root <path>]   same as resume — there is no daemon here for the two to mean different things\n" +
  "  sta pause  <task-id> [--project-root <path>]   freeze a task; run/resume/retry refuse it until resumed\n" +
  "  sta cancel <task-id> [--reason <text>] [--project-root <path>]   give up on a task for good; run/resume/retry refuse it permanently\n" +
  "  sta audit  <task-id> [--decisions] [--project-root <path>]   the WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail; --decisions shows only the choices\n" +
  "  sta qa-metrics [<task-id>] [--export-json <path>] [--baseline <path>] [--escaped-defects <n>]   QA token/mode/retry picture per task (QA07); --baseline compares against a saved export\n" +
  "  sta tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>]   token/context composition across orchestrated and interactive runs\n" +
  "  sta context <role> [--module <name>] [--phase <n,n>] [--task <id>] [--json] [--project-root <path>]   deterministic fail-open module context used by sta run\n" +
  "  sta knowledge get <id>[,<id>...] [--lane <ba|sa|uxui|dev>] [--json] [--project-root <path>]   retrieve only permitted knowledge fields (default lane: dev)\n" +
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
  "underlying flag-based form:\n" +
  "  sta --task-id <id> --module <name> [--phase <n,n>] [--depends-on <id,id>] [--project-root <path>] [--state-db <path>] [--autonomy <read-only|propose|edit|full>] [--runtime <claude-code|codex|opencode>] <classification flags>\n" +
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
  let runtime: "claude-code" | "codex" | "opencode" | undefined;
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
function approvalFieldFor(approvalType: ApprovalType | null): "requirementApproved" | "designApproved" | "humanApproved" | null {
  if (approvalType === ApprovalType.REQUIREMENT_INTERVIEW) return "requirementApproved";
  if (approvalType === ApprovalType.SCHEMA_CONFIRMATION) return "designApproved";
  if (approvalType === ApprovalType.DEPLOY) return "humanApproved";
  return null;
}

/** What each of the five decisions means, said in the words the person answering needs. */
const APPROVAL_PROMPT: Record<ApprovalType, string> = {
  [ApprovalType.SCHEMA_CONFIRMATION]:
    "Confirm the data model in design.md before any code is written against it",
  [ApprovalType.DEPLOY]: "Approve an actual deploy/migration to production",
  [ApprovalType.QA_FAILURE]: "A QA round came back ⚠️/❌ and needs a decision",
  [ApprovalType.SECURITY_RISK]: "A Critical/Important security finding is unresolved",
  [ApprovalType.REQUIREMENT_INTERVIEW]: "A requirement needs a person, not an inference",
  [ApprovalType.UXUI_SIGNOFF]: "Confirm the current UX/UI artifact before frontend work starts",
};

async function confirm(question: string): Promise<boolean> {
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

function printListing(registry: TaskRegistry): void {
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
    console.log(
      `  ${emoji} ${task.taskId.padEnd(12)} ${status.kind.padEnd(22)} ${status.state.padEnd(16)}${agent}${layer}${waiting}${reason}`,
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
  return registry.create({ taskId, classification, dependsOn: args.dependsOn, environment: args.environment, targetBindings: args.targetBindings });
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

/** Flags a verb accepts that take a value — their value must never be mistaken for the positional <task-id>. */
  const VERB_VALUE_FLAGS = new Set(["--project-root", "--state-db", "--reason", "--interval", "--module", "--phase", "--task", "--by", "--since", "--docs-root", "--config-path", "--source-root", "--knowledge-root", "--figma-email", "--claude-email", "--now", "--confirm", "--export-json", "--baseline", "--escaped-defects", "--runtime", "--as", "--note", "--lane"]);

/** Every non-flag token in a verb's remaining args, in order, skipping over each value-flag's own argument. */
function positionalArgs(rest: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      if (VERB_VALUE_FLAGS.has(rest[i])) i++; // skip its value, not just the flag itself
      continue;
    }
    found.push(rest[i]);
  }
  return found;
}

/** First non-flag token in a verb's remaining args — the positional <task-id> for the verbs that take one. */
function positionalArg(rest: string[]): string | undefined {
  return positionalArgs(rest)[0];
}

function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i === -1 ? undefined : rest[i + 1];
}

function openStore(projectRoot: string, stateDb?: string): { store: SqliteTaskStore; registry: TaskRegistry } {
  const store = new SqliteTaskStore(stateDb ?? defaultStateDbPath(projectRoot));
  const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(projectRoot) });
  return { store, registry };
}

/** Resolves only the existing post-hoc budget model; it never pre-emptively caps a spawn. */
function budgetFor(args: CliArgs): Budget {
  return { ...DEFAULT_BUDGET, token_budget: args.tokenBudget ?? configuredTokenBudget(args.projectRoot) };
}

function configuredTokenBudget(projectRoot: string): number {
  let configured: number | undefined;
  try {
    configured = loadStaConfig(projectRoot).token_budget;
  } catch (error) {
    // A config is optional for legacy Targets.  Invalid present configs remain
    // an installation concern; do not turn an absent one into a fake value.
    if (!(error instanceof StaConfigMissingError)) throw error;
  }
  return configured ?? DEFAULT_BUDGET.token_budget;
}

/** `status [<task-id>] [--watch] [--interval <seconds>]` — no id lists everything, an id shows one task's detail. */
async function runStatusVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  const watch = rest.includes("--watch");
  const intervalSeconds = Number(flagValue(rest, "--interval") ?? "5");

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    if (watch) {
      // Real-time is "until interrupted" outside a test; iterations is only ever overridden by
      // one, from inside the test suite, to keep watchListing from actually looping forever.
      await watchListing(registry, { intervalMs: Math.max(1, intervalSeconds) * 1000, iterations: Infinity });
      return 0;
    }
    if (!taskId) {
      printListing(registry);
      return 0;
    }
    const task = store.loadTask(taskId);
    if (!task) {
      console.error(`[orchestrator] no such task: ${taskId}`);
      return 1;
    }
    const status = describeStatus(task, store.listTasks());
    const agent = status.currentAgent ? ` agent=${status.currentAgent}` : "";
    console.log(`[orchestrator] task ${taskId}: ${status.kind} at ${status.state}${agent}`);
    if (status.reason) console.log(`[orchestrator]   ${status.reason}`);
    if (status.waitingOn?.length) console.log(`[orchestrator]   waiting on: ${status.waitingOn.join(", ")}`);
    const runs = store.runsForTask(taskId);
    if (runs.length > 0) console.log(new RunLog(runs).summary(taskId));
    return 0;
  } finally {
    registry.close();
  }
}

/** `approve <task-id> [--yes|--no]` — resolves the current WAITING_FOR_HUMAN gate without the full run loop. Interactive (like `run`'s own prompt) if neither flag is given. */
async function runApproveVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("approve: a task id is required");
  const forcedYes = rest.includes("--yes");
  const forcedNo = rest.includes("--no");

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    const stored = store.loadTask(taskId);
    if (!stored) throw new CliUsageError(`approve: task ${taskId} is not in this store`);
    if (stored.cancelled) {
      console.log(`[orchestrator] task ${taskId} is cancelled — nothing to approve.`);
      return 1;
    }

    const orchestrator = registry.resume(taskId); // read/decide only — does not check cross-task dependencies, same as inspecting any other settled task
    const status = orchestrator.status();
    if (status.kind !== "WAITING_FOR_HUMAN") {
      console.log(`[orchestrator] task ${taskId} is not waiting on a human decision right now (status: ${status.kind}).`);
      return 1;
    }

    const field = approvalFieldFor(status.approvalType);
    const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
    console.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
    if (status.approvalType) console.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);

    const approved = forcedYes ? true : forcedNo ? false : await confirm(`Approve ${label}?`);
    if (status.approvalType) {
      orchestrator.decideApproval(status.approvalType, approved, { by: process.env.USER ?? process.env.USERNAME });
    } else if (field) {
      orchestrator.provideHumanApproval(field, approved);
    } else {
      console.log(`[orchestrator] this CLI doesn't know how to resolve that gate.`);
      return 2;
    }
    registry.refreshStateView();
    console.log(approved ? `[orchestrator] approved.` : `[orchestrator] rejected — recorded, will not be asked again on resume.`);
    return approved ? 0 : 3;
  } finally {
    registry.close();
  }
}

/** `pause <task-id>` */
async function runPauseVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("pause: a task id is required");

  const { registry } = openStore(projectRoot, stateDb);
  try {
    registry.pause(taskId);
    console.log(`[orchestrator] task ${taskId} paused.`);
    return 0;
  } finally {
    registry.close();
  }
}

/** `cancel <task-id> [--reason <text>]` */
async function runCancelVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("cancel: a task id is required");
  const reason = flagValue(rest, "--reason") ?? "no reason given";

  const { registry } = openStore(projectRoot, stateDb);
  try {
    registry.cancel(taskId, reason);
    console.log(`[orchestrator] task ${taskId} cancelled: ${reason}`);
    return 0;
  } finally {
    registry.close();
  }
}

/**
 * `audit <task-id> [--decisions]` — T37's trail, for the question "why did the
 * pipeline do that?".
 *
 * Read-only and store-only: it never opens an `Orchestrator`, because
 * reconstructing a task's state to explain its past is both unnecessary and a
 * way to accidentally advance it while looking at it.
 */
async function runAuditVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("audit: a task id is required");
  const decisionsOnly = rest.includes("--decisions");

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    if (!store.loadTask(taskId)) {
      console.error(`[orchestrator] no such task: ${taskId}`);
      return 1;
    }
    const entries = auditTrail(store, taskId);
    const actors = actorsIn(entries);
    console.log(
      `[orchestrator] audit trail for ${taskId}: ${entries.length} event(s), ` +
        `${decisionTrail(entries).length} decision(s)${actors.length > 0 ? `, actors: ${actors.join(", ")}` : ""}`,
    );
    console.log(formatAuditTrail(entries, { decisionsOnly }));
    return 0;
  } finally {
    registry.close();
  }
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

/** `doctor` (T166) — aggregate read-only diagnostics; never mutates, exits non-zero only on FAIL. */
async function runDoctorVerb(rest: string[]): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root");
  try {
    // The composition root is the one place that may name a concrete adapter
    // (see runtimeAdapter.ts): doctor itself stays provider-blind and receives
    // the same probe a real run would use — and, through that adapter, the
    // claims-vs-install capability sweep.
    const report = await runDoctor({
      projectRoot: projectRoot ?? undefined,
      probe: () => new ClaudeCodeAdapter({ projectRoot: projectRoot ?? process.cwd() }).probe(),
      capabilities: async () => {
        const r = await detectRuntimeCapabilities(new ClaudeCodeAdapter({ projectRoot: projectRoot ?? process.cwd() }));
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
 * The `roles` sub-commands that are not `ack`, split out so `runRolesVerb` stays
 * the readable "show me the lanes" path it started as (T103-T107).
 *
 * Every writing one takes `--by`, and every one of them writes something only a
 * person may write. That is not politeness: `knowledge/_roles/**` is denied to
 * every agent at the tool level, and `approve` goes through `applyTransition`,
 * which refuses any actor but a person.
 */
async function runRolesSubCommand(
  args: string[],
  rest: string[],
  projectRoot: string,
  moduleFlag: string | undefined,
  kb: KnowledgeBase,
  now: string,
): Promise<number> {
  const module = moduleFlag ?? null;
  const by = flagValue(rest, "--by");
  const workspaces = workspacesUnder(projectRoot, module, now);

  const requireLane = (): RoleLane => {
    const lane = args[1];
    if (lane === undefined || !isRoleLane(lane)) {
      throw new CliUsageError(`roles ${args[0]}: a lane is required — one of ${ROLE_LANES.join(", ")}`);
    }
    return lane;
  };
  const requireBy = (): string => {
    if (by === undefined) throw new CliUsageError(`roles ${args[0]}: --by <name> is required — this is a person's decision`);
    return by;
  };

  switch (args[0]) {
    case "signoff": {
      const lane = requireLane();
      const signer = requireBy();
      const spec = workflowFor(lane);
      if (!spec) throw new CliUsageError(`roles signoff: no lane workflow is defined for ${lane}`);

      const state = roleWorkflowState(spec, module, kb, workspaces);
      const approved = kb.query({ module }).filter((item) => state.approved.includes(item.id));
      // Dogfood F3: project-wide scope (no --module) sees nothing when the lane's
      // approved work sits in modules. Say which, instead of the misleading
      // "nothing approved" that contradicts what `sta roles` just displayed.
      if (module === null && approved.length === 0) {
        const withApproved = [...new Set(kb.query({}).filter((i) => i.status === "approved").map((i) => i.module ?? "(project-wide)"))];
        if (withApproved.length > 0) {
          throw new CliUsageError(
            `roles signoff: nothing is approved at project-wide scope; approved items live in module(s): ${withApproved.join(", ")} — add --module <name>`,
          );
        }
      }
      const reject = rest.includes("--reject");

      // Refusing to sign off over a blocker is the whole point of having one: a
      // person waving through work already known to be unusable spends the single
      // step in this pipeline that cannot be redone cheaply.
      if (!reject && state.handoff.blockers.length > 0) {
        console.error(`[orchestrator] the ${LANE_LABEL[lane]} lane cannot be signed off while these stand:`);
        for (const blocker of state.handoff.blockers) console.error(`  - ${blocker}`);
        return 1;
      }

      try {
        const updated = recordSignoff(workspaces(lane), {
          approved,
          approve: !reject,
          by: signer,
          note: flagValue(rest, "--note"),
          now,
        });
        writeRoleWorkspace(updated, projectRoot);
      } catch (e) {
        console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }

      console.log(
        `[orchestrator] ${LANE_LABEL[lane]} on ${module ?? "(project-wide)"}: ${signer} ` +
          `${reject ? "rejected" : "signed off"} ${state.approved.join(", ")}.`,
      );
      for (const carried of state.handoff.carries) console.log(`[orchestrator] carries: ${carried}`);
      return 0;
    }

    case "review": {
      // One id-list token: commas separate items, exactly like `roles ack`'s.
      // Extra positional tokens are ignored rather than mistaken for more ids —
      // unknown value-flags must never turn their values into item names.
      const ids = (args[1] ?? "").split(",").filter((a) => a !== "");
      const as = flagValue(rest, "--as");
      if (ids.length === 0) throw new CliUsageError("roles review: an item id is required");
      if (!as) throw new CliUsageError("roles review: --as <agent> is required — a review's content is which discipline looked");
      if (!Object.values(AgentStage).includes(as as AgentStage)) {
        throw new CliUsageError(`roles review: "${as}" is not an agent role`);
      }
      for (const id of ids) {
        const item = kb.get(id);
        if (!item) {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        try {
          writeKnowledgeItem(reviewItem(item, as as AgentStage, now), projectRoot);
        } catch (e) {
          console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
        console.log(`[orchestrator] ${id} reviewed as ${as}. It confirmed:`);
        for (const line of checklistFor(item.kind)) console.log(`  - ${line}`);
      }
      return 0;
    }

    case "approve": {
      const ids = (args[1] ?? "").split(",").filter((a) => a !== "");
      const approver = requireBy();
      if (ids.length === 0) throw new CliUsageError("roles approve: an item id is required");
      for (const id of ids) {
        const item = kb.get(id);
        if (!item) {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        try {
          writeKnowledgeItem(approveItem(item, now), projectRoot);
        } catch (e) {
          console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
        // The approver's name is not written into the item on purpose — see
        // artifactReview.ts. It is echoed so the person sees their own act recorded
        // in the terminal, and git carries the rest.
        console.log(`[orchestrator] ${id} approved by ${approver}. It is binding now; downstream lanes may rely on it.`);
      }
      return 0;
    }

    case "inbox": {
      const lanes = args[1] !== undefined && isRoleLane(args[1]) ? [args[1] as RoleLane] : [...ROLE_LANES];
      let total = 0;
      for (const lane of lanes) {
        const notifications = notificationsFor(lane, module, kb, workspaces(lane));
        total += notifications.length;
        console.log(`\n${LANE_LABEL[lane]} — ${notifications.length} to look at`);
        for (const n of notifications) console.log(`  [${n.reason}] ${n.message}`);
      }
      if (total === 0) console.log("\n[orchestrator] every lane is up to date.");
      return 0;
    }

    case "impact": {
      const ids = args.slice(1).flatMap((a) => a.split(",")).filter((a) => a !== "");
      if (ids.length === 0) throw new CliUsageError("roles impact: name at least one item id");
      const unknown = ids.filter((id) => kb.get(id) === null);
      if (unknown.length > 0) {
        console.error(`[orchestrator] no knowledge item with id ${unknown.join(", ")}`);
        return 1;
      }
      const affected = lanesAffectedBy(kb, ids);
      console.log(`[orchestrator] changing ${ids.join(", ")} would reach:`);
      for (const lane of ROLE_LANES) {
        const items = affected.get(lane) ?? [];
        console.log(`  ${LANE_LABEL[lane].padEnd(4)} ${items.length === 0 ? "nothing" : items.map((i) => i.id).join(", ")}`);
      }
      return 0;
    }

    case "context": {
      const lane = requireLane();
      const id = args[2];
      const context = KnowledgeContext.load(projectRoot, now);

      if (id !== undefined) {
        const outcome = laneGet(lane, context, id);
        if (rest.includes("--full")) {
          const rendered = renderKnowledgeRetrieval(lane, id, outcome);
          if (outcome.status === "not-found") console.error(rendered.text);
          else console.log(rest.includes("--json") ? JSON.stringify(rendered.json, null, 2) : rendered.text);
          return outcome.status === "not-found" ? 1 : 0;
        }
        if (outcome.status === "not-found") {
          console.error(`[orchestrator] no knowledge item with id ${id}`);
          return 1;
        }
        if (outcome.status === "withheld") {
          // Withheld is not an error: the lane asked a legitimate question and the
          // answer is "not for you". Exit 0 and say which, so it is never confused
          // with the item not existing.
          console.log(`[orchestrator] ${id}: withheld — ${outcome.reason}`);
          return 0;
        }
        const { item, viaRole, provenance } = outcome.item;
        console.log(`[orchestrator] ${id} as the ${LANE_LABEL[lane]} lane sees it (via ${viaRole}):`);
        console.log(`  ${item.title} [${item.kind}, ${item.status}, owned by ${item.owner}]`);
        if (item.withheld.length > 0) console.log(`  withheld: ${item.withheld.join(", ")}`);
        console.log(`  ${provenance.citation}`);
        return 0;
      }

      const result = laneContext(lane, context, module === null ? {} : { module });
      console.log(`[orchestrator] the ${LANE_LABEL[lane]} lane sees ${result.items.length} item(s):`);
      for (const entry of result.items) {
        const withheld = entry.item.withheld.length > 0 ? ` (withheld: ${entry.item.withheld.join(", ")})` : "";
        console.log(`  ${entry.item.id.padEnd(18)} ${entry.item.kind.padEnd(14)} via ${entry.viaRole}${withheld}`);
      }
      if (result.hidden.length > 0) console.log(`  hidden from every role in this lane: ${result.hidden.join(", ")}`);
      if (result.kindsNotInLane.length > 0) console.log(`  kinds outside this lane's view: ${result.kindsNotInLane.join(", ")}`);
      return 0;
    }
  }
  throw new CliUsageError(`roles: unhandled sub-command "${args[0]}"`);
}

/**
 * `roles [--module <name>]` — where each lane stands, and
 * `roles ack <lane> <id>[,<id>...] --by <name>` — record that a person in that lane has
 * seen the current version of those items (T99).
 *
 * This verb is the *only* writer of a role workspace. `knowledge/_roles/**` is in
 * `UNIVERSAL_DENY`, so no agent can write one in any mode — an acknowledgement is a human
 * act, and an agent able to record one could mark its own work seen on a person's behalf.
 * `--by` is required for the same reason: the file has to say who.
 */
async function runRolesVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const moduleFlag = flagValue(rest, "--module");
  const args = positionalArgs(rest);
  const kb = KnowledgeBase.load(projectRoot);
  const now = new Date().toISOString();

  const SUB_COMMANDS = ["ack", "signoff", "review", "approve", "inbox", "impact", "context"];
  if (args.length > 0 && !SUB_COMMANDS.includes(args[0])) {
    throw new CliUsageError(`roles: unknown sub-command "${args[0]}" — one of ${SUB_COMMANDS.join(", ")}`);
  }
  if (args.length > 0 && args[0] !== "ack") {
    return runRolesSubCommand(args, rest, projectRoot, moduleFlag, kb, now);
  }

  if (args.length === 0) {
    // No --module shows every module that has knowledge in it, so a lane sitting behind
    // in a module the caller forgot about is still visible.
    const modules: (string | null)[] =
      moduleFlag !== undefined
        ? [moduleFlag]
        : [...new Set(kb.query({}).map((item) => item.module))].sort((a, b) =>
            a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0,
          );
    if (modules.length === 0) {
      console.log("[orchestrator] no knowledge captured yet — a lane has nothing to stand on.");
      return 0;
    }
    for (const module of modules) {
      console.log(`\n${module ?? "(project-wide)"}`);
      const workspaces = workspacesUnder(projectRoot, module, now);
      for (const lane of ROLE_LANES) {
        const view = laneView(workspaces(lane), kb);
        const spec = workflowFor(lane);
        const state = spec ? roleWorkflowState(spec, module, kb, workspaces) : null;

        // Two different questions, both printed: `stage` is where the lane's own
        // work has got to (T100), `deps` is whether what it depends on moved
        // under it (T99). A lane can be `ready` and `behind` at the same time.
        console.log(`  ${LANE_LABEL[lane].padEnd(4)} ${describeStage(state).padEnd(20)} deps: ${view.status}`);
        if (state) {
          console.log(`       next (${state.nextAction.actor}): ${state.nextAction.what}`);
          for (const carried of state.handoff.carries) console.log(`       carries: ${carried}`);
        }
        if (view.stale.length > 0) {
          console.log(`       changed since acknowledged: ${view.stale.map((s) => `${s.id} v${s.version}->v${s.currentVersion}`).join(", ")}`);
        }
        if (view.unseen.length > 0) console.log(`       never acknowledged: ${view.unseen.join(", ")}`);
        if (view.awaitingApproval.length > 0) console.log(`       waiting on a person: ${view.awaitingApproval.join(", ")}`);
      }
    }
    return 0;
  }

  const lane = args[1];
  if (lane === undefined || !isRoleLane(lane)) {
    throw new CliUsageError(`roles ack: a lane is required — one of ${ROLE_LANES.join(", ")}`);
  }
  const ids = args.slice(2).flatMap((a) => a.split(",")).filter((a) => a !== "");
  const by = flagValue(rest, "--by");
  if (by === undefined) {
    throw new CliUsageError("roles ack: --by <name> is required — an acknowledgement records who made it");
  }

  const module = moduleFlag ?? null;
  try {
    const updated = acknowledge(loadRoleWorkspace(lane, module, projectRoot, now), kb, ids, by, now);
    writeRoleWorkspace(updated, projectRoot);
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(
    `[orchestrator] ${LANE_LABEL[lane]} on ${module ?? "(project-wide)"}: ${by} acknowledged ${ids.join(", ")}.`,
  );
  return 0;
}

/**
 * `adopt` (T81, wired to the CLI as part of T113's pilot — the library existed
 * since V1.3 but nothing exposed it to a person before this).
 *
 * `plan` is deliberately the sub-command with no state requirement and no
 * writes at all: it is meant to be runnable as the very first thing anyone
 * does against a real legacy project, before `start` even creates
 * `knowledge/_adoption/state.json`. Every other sub-command requires the state
 * `initAdoption()` created, and reports the same "no adoption in progress" a
 * person would get from calling the library directly rather than a CLI-only
 * error shape.
 */
async function runAdoptVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const sourceRoot = flagValue(rest, "--source-root") ?? projectRoot;
  if (sourceRoot !== projectRoot) {
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new CliUsageError(`adopt: Knowledge root is not an existing directory: ${projectRoot}`);
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new CliUsageError(`adopt: legacy source root is not an existing directory: ${sourceRoot}`);
    const knowledgeCanonical = fs.realpathSync.native(projectRoot);
    const sourceCanonical = fs.realpathSync.native(sourceRoot);
    if (knowledgeCanonical === sourceCanonical || knowledgeCanonical.startsWith(`${sourceCanonical}${path.sep}`) || sourceCanonical.startsWith(`${knowledgeCanonical}${path.sep}`)) {
      throw new CliUsageError("adopt: --source-root must be separate from the Knowledge root; refusing a source/destination overlap");
    }
  }
  // T113 pilot finding: not every real adoption target has its own `_docs/`
  // right at the repo root — a monorepo or a per-client subtree may nest it.
  // Repo-relative so a person types the same thing they'd see in a listing
  // (`--docs-root _docs/hkt`), resolved against `sourceRoot` so a three-repo
  // adoption reads the Target while writing only to the Knowledge root.
  // every other path this CLI reports already is. No state persists this
  // across invocations (same as `--project-root` itself) — pass it on every
  // `adopt` call for this project, `plan` included.
  const docsRootFlag = flagValue(rest, "--docs-root");
  const docsRoot = docsRootFlag !== undefined ? path.join(sourceRoot, docsRootFlag) : undefined;
  const args = positionalArgs(rest);
  const now = new Date().toISOString();
  const SUB_COMMANDS = ["plan", "status", "start", "ack", "run", "approve", "validate"];
  const sub = args[0];
  if (sub === undefined || !SUB_COMMANDS.includes(sub)) {
    throw new CliUsageError(`adopt: a sub-command is required — one of ${SUB_COMMANDS.join(", ")}`);
  }

  if (sub === "plan") {
    const plan = planAdoption(projectRoot, now, docsRoot, sourceRoot);
    if (plan.preflight.blockers.length > 0) {
      console.log(`[orchestrator] preflight found work in flight — this would block \`adopt start\` until acknowledged:`);
      for (const b of plan.preflight.blockers) console.log(`  ! ${b}`);
    }
    for (const stage of plan.stages) {
      console.log(`\n${stage.id}${stage.skipped ? " (nothing to import)" : ""}`);
      for (const w of stage.writes) console.log(`  ${w.action.padEnd(9)} ${w.path}  (${w.subject})`);
      for (const c of stage.conflicts) console.log(`  ! conflict: ${c} — already reviewed, legacy material now disagrees`);
      for (const n of stage.notes) console.log(`  · ${n}`);
    }
    console.log(
      `\n[orchestrator] plan: ${plan.totals.create} to create, ${plan.totals.update} to update, ` +
        `${plan.totals.unchanged} unchanged, ${plan.totals.conflict} conflict(s). Nothing was written — this is a dry run (T87).`,
    );
    return 0;
  }

  try {
    if (sub === "status") {
      const { state, problems } = readAdoptionState(projectRoot);
      if (problems.length > 0) {
        for (const p of problems) console.error(`[orchestrator] ${p}`);
        return 1;
      }
      if (!state) {
        console.log("[orchestrator] no adoption in progress — run `adopt plan` first, then `adopt start`.");
        return 0;
      }
      console.log(`[orchestrator] status: ${state.status}`);
      for (const s of state.stages) {
        console.log(`  ${s.id.padEnd(14)} ${s.status}${s.approved_by ? ` (approved by ${s.approved_by})` : ""}`);
      }
      return 0;
    }

    if (sub === "start") {
      const state = initAdoption(projectRoot, now, docsRoot, sourceRoot);
      console.log(`[orchestrator] adoption started — status: ${state.status}`);
      if (state.preflight && state.preflight.blockers.length > 0) {
        console.log("  blocked on:");
        for (const b of state.preflight.blockers) console.log(`  ! ${b}`);
        console.log('  run `adopt ack --by <name>` once a person has decided it is safe to import over this.');
      }
      return 0;
    }

    if (sub === "ack") {
      const by = flagValue(rest, "--by");
      if (!by) throw new CliUsageError("adopt ack: --by <name> is required");
      const state = acknowledgePreflight(by, projectRoot, now);
      console.log(`[orchestrator] preflight acknowledged by ${by} — status: ${state.status}`);
      return 0;
    }

    if (sub === "run") {
      const stageId = args[1];
      if (!stageId || !(ALL_ADOPTION_STAGES as readonly string[]).includes(stageId)) {
        throw new CliUsageError(`adopt run: a stage id is required — one of ${ALL_ADOPTION_STAGES.join(", ")}`);
      }
      const state = runAdoptionStage(stageId as AdoptionStageId, projectRoot, now, docsRoot, sourceRoot);
      const record = state.stages.find((s) => s.id === stageId)!;
      console.log(
        `[orchestrator] ${stageId}: ${record.status}${record.note ? ` — ${record.note}` : ""} — status: ${state.status}`,
      );
      return 0;
    }

    if (sub === "approve") {
      const stageId = args[1];
      const by = flagValue(rest, "--by");
      if (!stageId || !(ALL_ADOPTION_STAGES as readonly string[]).includes(stageId)) {
        throw new CliUsageError(`adopt approve: a stage id is required — one of ${ALL_ADOPTION_STAGES.join(", ")}`);
      }
      if (!by) throw new CliUsageError("adopt approve: --by <name> is required");
      const state = approveAdoptionStage(stageId as AdoptionStageId, by, projectRoot, now);
      console.log(`[orchestrator] ${stageId} approved by ${by} — status: ${state.status}`);
      return 0;
    }

    // validate
    const by = flagValue(rest, "--by");
    if (!by) throw new CliUsageError("adopt validate: --by <name> is required");
    const report = validateAdoption(projectRoot, now, docsRoot, sourceRoot);
    if (!report.ok) {
      console.error("[orchestrator] adoption validation failed:");
      for (const problem of report.problems) console.error(`  ! ${problem}`);
      return 1;
    }
    const state = recordAdoptionValidation(by, projectRoot, now);
    console.log(`[orchestrator] adoption validated by ${by} — status: ${state.status}`);
    return 0;
  } catch (e) {
    if (e instanceof AdoptionBlockedError) {
      console.error("[orchestrator] adoption is blocked:");
      for (const b of e.blockers) console.error(`  ! ${b}`);
      console.error('  run `adopt ack --by <name>` once a person has decided it is safe to import over this.');
      return 1;
    }
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
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

/** `qa-metrics [<task-id>] [--export-json <path>] [--baseline <path>] [--escaped-defects <n>]` — QA07's cost/effectiveness picture off the run log. */
async function runQaMetricsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  const exportPath = flagValue(rest, "--export-json");
  const baselinePath = flagValue(rest, "--baseline");
  const escapedRaw = flagValue(rest, "--escaped-defects");
  const escapedDefects = escapedRaw !== undefined ? Number(escapedRaw) : undefined;
  if (escapedDefects !== undefined && !Number.isInteger(escapedDefects)) {
    throw new CliUsageError(`--escaped-defects must be an integer (got ${escapedRaw})`);
  }

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    const ids = taskId ? [taskId] : store.listTasks().map((t) => t.taskId);
    if (ids.length === 0) {
      console.log("[orchestrator] no tasks in this state database yet — nothing to measure.");
      return 0;
    }
    const entries = ids.map((id) => ({ taskId: id, runs: store.runsForTask(id) }));
    const metricsExport = buildMetricsExport(entries, { escapedDefects });

    for (const t of metricsExport.tasks) {
      const share = `${(t.qaShare * 100).toFixed(0)}%`;
      console.log(
        `[orchestrator] ${t.taskId}: QA ${t.qaRuns} round(s), ${t.qaTokens} tokens ` +
          `(${share} of task total), FULL=${t.fullRounds} TARGETED=${t.targetedRounds}` +
          `${t.unrecordedModeRounds > 0 ? ` unrecorded=${t.unrecordedModeRounds}` : ""}, retries=${t.qaRetries}, failures=${t.qaFailures}`,
      );
    }
    const tot = metricsExport.totals;
    console.log(
      `[orchestrator] totals: QA ${tot.qaRuns} round(s) — ${tot.qaTokens}/${tot.totalTokens} tokens ` +
        `(${(tot.qaShare * 100).toFixed(0)}%), FULL=${tot.fullRounds} TARGETED=${tot.targetedRounds} retries=${tot.qaRetries}` +
        `${tot.escapedDefects !== undefined ? ` escapedDefects=${tot.escapedDefects}` : ""}`,
    );

    if (exportPath) {
      fs.writeFileSync(exportPath, JSON.stringify(metricsExport, null, 2), "utf8");
      console.log(`[orchestrator] wrote baseline JSON to ${exportPath}`);
    }
    if (baselinePath) {
      const before = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as ReturnType<typeof buildMetricsExport>;
      const delta = compareBaselines(before, metricsExport);
      console.log(
        `[orchestrator] vs baseline (${baselinePath}): verdict=${delta.verdict}, ` +
          `qa tokens ${delta.qaTokenDeltaPct === null ? "n/a" : `${delta.qaTokenDeltaPct.toFixed(1)}%`}, ` +
          `qa share ${delta.qaShareDeltaPct === null ? "n/a" : `${delta.qaShareDeltaPct.toFixed(1)}%`}, ` +
          `modes ${delta.targetedVsFullShift}, retry delta ${delta.retryDelta}`,
      );
      for (const note of delta.notes) console.log(`[orchestrator]   note: ${note}`);
    }
    return 0;
  } finally {
    registry.close();
  }
}

function displayMetric(value: number | null): string {
  return value === null ? "not reported" : value.toLocaleString();
}

function printTokenTask(metric: TaskTokenMetrics): void {
  const c = metric.composition;
  const budget = metric.contextBudget;
  console.log(
    `[orchestrator] ${metric.taskId}: input=${displayMetric(metric.inputTokens)} output=${displayMetric(metric.outputTokens)} ` +
      `cached=${displayMetric(metric.cachedTokens)} total=${displayMetric(metric.totalTokens)} stages=${metric.stageCount} retries=${metric.retryCount} retryWaste=${displayMetric(metric.retryWasteTokens)} ` +
      `sessions=orchestrated:${metric.sessionKinds.orchestrated},interactive:${metric.sessionKinds.interactive},not-reported:${metric.sessionKinds.not_reported}`,
  );
  console.log(
    `[orchestrator]   composition: static=${displayMetric(c.static_chars)} handoff=${displayMetric(c.handoff_chars)} docs=${displayMetric(c.doc_chars)}/${displayMetric(c.doc_chars_before)} before-slice ` +
      `knowledge=${displayMetric(c.knowledge_chars)} code-intel=${displayMetric(c.code_intel_chars)} tool-output=${displayMetric(c.tool_output_chars)}`,
  );
  console.log(
    `[orchestrator]   context budget (warning-only): measured-runs=${budget.measuredRuns} warnings=${budget.warningRuns} ` +
      `actual=${displayMetric(budget.contextChars)} budget=${displayMetric(budget.budgetChars)} overflow=${displayMetric(budget.overflowChars)} ` +
      `composition=base:${displayMetric(budget.composition.base)} task:${displayMetric(budget.composition.task)} safety:${displayMetric(budget.composition.safety)} ` +
      `docs:${displayMetric(budget.composition.docs)} knowledge:${displayMetric(budget.composition.knowledge)} code:${displayMetric(budget.composition.code)} ` +
      `tool_output:${displayMetric(budget.composition.tool_output)} reserve:${displayMetric(budget.composition.reserve)}`,
  );
}

/** `tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>]`. */
/**
 * T-V3TOK-013 — `sta policy` reads one section, not one file.
 *
 * A miss is exit 0 with the available sections printed: an agent that gets an
 * error here falls back to reading the whole file, which is exactly the cost
 * this verb removes.
 */
async function runPolicyVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  if (rest.includes("--help")) {
    console.log("usage: sta policy [<area>] [<section>] [--json] [--project-root <path>]");
    console.log("  no args        every policy area and the sections inside it");
    console.log("  <area>         one area's sections (documentation, coding, security, ...)");
    console.log("  <area> <sec>   that section's text; accepts §10, 10, 5c, or part of the heading");
    return 0;
  }
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const json = rest.includes("--json");
  const [area, section] = positionalArgs(rest);

  try {
    if (area === undefined) {
      const index = listPolicySections(projectRoot);
      if (json) {
        console.log(JSON.stringify(index, null, 2));
        return 0;
      }
      for (const entry of index) {
        console.log(`${entry.relPath} (${entry.bytes} B, ${entry.sections.length} section(s))`);
        for (const s of entry.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      }
      return 0;
    }

    if (section === undefined) {
      const entry = listPolicySections(projectRoot).find((e) => e.area === area.replace(/^policies\//, "").replace(/\.md$/, ""));
      if (!entry) throw new PolicyIndexError(`no policy area "${area}" — available: ${listPolicySections(projectRoot).map((e) => e.area).join(", ")}`);
      if (json) {
        console.log(JSON.stringify(entry, null, 2));
        return 0;
      }
      console.log(`${entry.relPath} (${entry.bytes} B)`);
      for (const s of entry.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      return 0;
    }

    const result = getPolicySection(projectRoot, area, section);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!result.found) {
      console.log(`[orchestrator] ${result.relPath} has no section matching "${section}". It has:`);
      for (const s of result.sections) console.log(`  ${s.number === null ? "-" : `§${s.number}`}  ${s.heading}  (${s.bytes} B)`);
      return 0;
    }
    console.log(`# ${result.relPath} — ${result.heading}  (${result.bytes} B of ${result.areaBytes} B)`);
    console.log("");
    console.log(result.text);
    return 0;
  } catch (error) {
    if (error instanceof PolicyIndexError) throw new CliUsageError(error.message);
    throw error;
  }
}

async function runTokensVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  if (rest.includes("--help")) {
    console.log("usage: sta tokens [<task-id>] [--since <iso>] [--by <role|stage|session>] [--export-json <path>] [--baseline <path>] [--project-root <path>] [--state-db <path>]");
    return 0;
  }
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  const sinceRaw = flagValue(rest, "--since");
  const since = sinceRaw === undefined ? undefined : Date.parse(sinceRaw);
  if (sinceRaw !== undefined && Number.isNaN(since)) throw new CliUsageError(`--since must be an ISO timestamp (got ${sinceRaw})`);
  const by = flagValue(rest, "--by") ?? "task";
  if (by !== "task" && by !== "role" && by !== "stage" && by !== "session") throw new CliUsageError(`--by must be role, stage, or session (got ${by})`);
  const exportPath = flagValue(rest, "--export-json");
  const baselinePath = flagValue(rest, "--baseline");
  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    const runs = store.allRuns().filter((run) => (taskId === undefined || run.task_id === taskId) && (since === undefined || run.start_time >= since));
    if (runs.length === 0) {
      console.log("[orchestrator] no recorded runs match this token query — nothing to measure.");
      return 0;
    }
    const report = tokenMetricsExport(runs);
    if (by === "task") for (const metric of report.tasks) printTokenTask(metric);
    else if (by === "role" || by === "stage") {
      for (const role of report.roles) console.log(
        `[orchestrator] ${by} ${role.role}: runs=${role.runCount} static=${displayMetric(role.staticChars)} retrieved=${displayMetric(role.retrievedChars)} ` +
          `static/retrieved=${role.staticVsRetrievedRatio === null ? "not reported" : role.staticVsRetrievedRatio.toFixed(2)} ` +
          `docs=${displayMetric(role.docChars)}/${displayMetric(role.docCharsBefore)} before-slice slicing-saved=${role.slicingSavedPct === null ? "not reported" : `${role.slicingSavedPct}%`} ` +
          `context-budget-warnings=${role.contextBudget.warningRuns}/${role.contextBudget.measuredRuns} overflow=${displayMetric(role.contextBudget.overflowChars)}`,
      );
    } else {
      for (const kind of ["orchestrated", "interactive", "not_reported"] as const) {
        const count = report.tasks.reduce((sum, metric) => sum + metric.sessionKinds[kind], 0);
        console.log(`[orchestrator] session ${kind === "not_reported" ? "not reported" : kind}: ${count} run(s)`);
      }
    }
    const total = report.totals;
    console.log(`[orchestrator] totals: input=${displayMetric(total.inputTokens)} output=${displayMetric(total.outputTokens)} cached=${displayMetric(total.cachedTokens)} total=${displayMetric(total.totalTokens)} retries=${total.retryCount} retryWaste=${displayMetric(total.retryWasteTokens)}`);
    const budget = configuredTokenBudget(projectRoot);
    console.log(`[orchestrator] configured post-hoc token budget: ${budget.toLocaleString()} vs actual input ${displayMetric(total.inputTokens)} (pre-spawn caps are not part of this control)`);
    console.log(`[orchestrator] context-budget warnings: ${total.contextBudget.warningRuns}/${total.contextBudget.measuredRuns} measured run(s), overflow=${displayMetric(total.contextBudget.overflowChars)} (warning-only; prompts were not changed)`);
    if (exportPath) {
      fs.writeFileSync(exportPath, JSON.stringify(report, null, 2), "utf8");
      console.log(`[orchestrator] wrote token metrics JSON to ${exportPath}`);
    }
    if (baselinePath) {
      const before = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as TokenMetricsExport;
      const delta = compareTokenBaselines(before, report);
      console.log(`[orchestrator] vs baseline (${baselinePath}): input ${delta.inputTokenDeltaPct === null ? "not reported" : `${delta.inputTokenDeltaPct.toFixed(1)}%`}, retry waste ${delta.retryWasteDeltaPct === null ? "not reported" : `${delta.retryWasteDeltaPct.toFixed(1)}%`}`);
    }
    return 0;
  } finally { registry.close(); }
}

/** `context <role> [--module <m>] [--phase <n,n>] [--task <id>] [--json]`. */
async function runContextVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const role = positionalArg(rest);
  if (!role) throw new CliUsageError("context: an agent role is required");
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  const phaseRaw = flagValue(rest, "--phase");
  let phases: number[] | undefined;
  if (phaseRaw !== undefined) {
    phases = phaseRaw.split(",").map((value) => Number(value.trim()));
    if (phases.length === 0 || phases.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new CliUsageError("context: --phase must be a comma-separated list of positive integers");
    }
  }
  try {
    const result = await buildContextCommand({
      role,
      moduleHint: flagValue(rest, "--module"),
      phases,
      taskId: flagValue(rest, "--task"),
      projectRoot,
    });
    console.log(rest.includes("--json") ? JSON.stringify(contextCommandJson(result), null, 2) : renderContextCommand(result));
    return 0;
  } catch (error) {
    if (error instanceof ContextCommandError) {
      console.error(`[orchestrator] ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

/** `knowledge get <id>[,<id>...] [--lane <lane>] [--json]`: one policy-filtered retrieval door. */
async function runKnowledgeVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const args = positionalArgs(rest);
  if (args[0] !== "get") throw new CliUsageError("knowledge: expected sub-command get");
  const ids = (args[1] ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length === 0) throw new CliUsageError("knowledge get: an item id is required");
  if (args.length > 2) throw new CliUsageError("knowledge get: ids must be one comma-separated argument");

  const laneRaw = flagValue(rest, "--lane") ?? "dev";
  if (!isRoleLane(laneRaw)) {
    throw new CliUsageError(`knowledge get: "${laneRaw}" is not a lane — use ba, sa, uxui, or dev`);
  }
  const lane = laneRaw as RoleLane;
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const context = KnowledgeContext.load(projectRoot, new Date().toISOString());
  const rendered = ids.map((id) => ({ id, result: renderKnowledgeRetrieval(lane, id, laneGet(lane, context, id)) }));
  const json = rest.includes("--json");
  if (json) console.log(JSON.stringify({ lane, items: rendered.map((entry) => entry.result.json) }, null, 2));
  else for (const entry of rendered) console.log(entry.result.text);
  return rendered.some((entry) => (entry.result.json.status as string | undefined) === "not_found") ? 1 : 0;
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
      return runRuntimesVerb();
  }
}

/**
 * T-V1-04 — the support table, from `runtimeSupport.ts` so CLI, README and
 * tests read one record. A person picking a runtime for a machine should not
 * have to trust prose that can drift from what the adapters actually do.
 */
function runRuntimesVerb(): number {
  console.log("[orchestrator] runtime support (raise a level only when T-V1-05 conformance passes):");
  for (const line of describeRuntimeSupport()) console.log(`  ${line}`);
  return 0;
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

  if (args.checkContracts) {
    const result = checkAllContracts(args.projectRoot);
    // Path rules live in the same files, so they are checked in the same pass —
    // a write glob that can never match is a role that silently cannot do its job.
    const paths = checkPathRules(args.projectRoot);
    const problems = [...result.problems, ...paths.problems];
    if (problems.length === 0) {
      console.log("[orchestrator] contracts/*.yaml agree with the agent registry, and their path rules are sane.");
      return 0;
    }
    console.error("[orchestrator] contracts/*.yaml have problems:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkLayout) {
    const result = checkLayout(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] layout.yaml agrees with the repo.");
      return 0;
    }
    console.error("[orchestrator] layout.yaml and the repo disagree:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkPromptBudget) {
    const result = checkPromptBudget(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] static prompt budget holds.");
      for (const note of result.notes) console.log(`  - ${note}`);
      return 0;
    }
    console.error("[orchestrator] static prompt budget exceeded:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkWorkflows) {
    const result = checkAllWorkflows(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] workflows/*.yml agree with the classifier.");
      return 0;
    }
    console.error("[orchestrator] workflows/*.yml and the classifier disagree:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkBindings) {
    const result = checkBindings(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] .codex/agents bindings match the .claude/agents sources.");
      return 0;
    }
    console.error("[orchestrator] codex role bindings have drifted from their sources:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkProfile) {
    const result = checkProfile(args.projectRoot);
    // Notes print either way: a tracked migration is worth seeing on a green run,
    // and burying it until something breaks is how it stops being tracked.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] project.yaml and stacks/ agree with the agent roster.");
      return 0;
    }
    console.error("[orchestrator] project.yaml and the agent roster disagree:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkDecisions) {
    const result = checkDecisions(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] decisions/*.md agree with the schema and cross-link cleanly.");
      return 0;
    }
    console.error("[orchestrator] decisions/*.md have problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkTestPyramid) {
    const result = checkTestPyramid(args.projectRoot);
    if (result.ok) {
      console.log("[orchestrator] test-pyramid.yaml agrees with its schema.");
      return 0;
    }
    console.error("[orchestrator] test-pyramid.yaml has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkReviewSeparation) {
    const result = checkReviewSeparation(args.projectRoot);
    // Notes print either way. An unreviewed pipeline is a right-sizing decision
    // the user owns (workflows/typo.yml says so outright), so it is shown and not failed.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] no agent can review its own work.");
      return 0;
    }
    console.error("[orchestrator] creator/reviewer separation is broken:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkEscalationPolicy) {
    const result = checkEscalationPolicy(args.projectRoot);
    // Notes print either way: a severity that can never retry changes how the whole
    // pipeline behaves, and burying it until something stops is how it stops being known.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] escalation-policy.yaml agrees with the runtime policy.");
      return 0;
    }
    console.error("[orchestrator] escalation-policy.yaml has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkWorkspace) {
    const result = checkWorkspace(args.projectRoot);
    // Notes print either way: "no workspace.yaml" is the normal, expected state for a
    // standalone project, and burying that note would make silence indistinguishable
    // from a workspace nobody remembered to validate.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] workspace.yaml is fine.");
      return 0;
    }
    console.error("[orchestrator] workspace.yaml has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkRepos) {
    const result = checkRepoMap(args.projectRoot);
    // Notes print either way: "no repos.yaml" is the normal, expected state for a
    // single-repo project, same reasoning as --check-workspace's note above.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] repos.yaml is fine.");
      return 0;
    }
    console.error("[orchestrator] repos.yaml has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkEnvironments) {
    const result = checkEnvironmentConfig(args.projectRoot);
    // Notes print either way: "no environments.yaml" is the normal, expected state — every
    // project gets the four built-in descriptions even without one.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] environments.yaml is fine.");
      return 0;
    }
    console.error("[orchestrator] environments.yaml has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkDocStructure) {
    const result = checkDocStructure(args.projectRoot);
    // Notes print either way: "no _docs/module/ yet" is the normal, expected state before
    // business-analyst has run once.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] every module document present has the sections its schema requires.");
      return 0;
    }
    console.error("[orchestrator] module documents have structural problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkPlan) {
    const result = checkPlanGraphs(args.projectRoot, args.module);
    // Notes print either way: a project before its first module, or a module
    // whose plan.md isn't written yet, are normal states — not findings.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] every plan.md checked is a valid task graph.");
      return 0;
    }
    console.error("[orchestrator] plan task graphs have problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkKnowledge) {
    const result = checkKnowledge(args.projectRoot);
    // Notes print either way: a repo with nothing captured in knowledge/ yet is the normal
    // state, the same reading --check-doc-structure gives a project before its first module.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] knowledge/ is consistent.");
      return 0;
    }
    console.error("[orchestrator] knowledge/ has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkInstallation) {
    const result = validateInstallation(args.projectRoot);
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] .sta/ agrees with the project's real files.");
      return 0;
    }
    console.error("[orchestrator] .sta/ has problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }

  if (args.checkRoles) {
    const result = checkRoleWorkspaces(args.projectRoot);
    // Notes print either way. "BA is behind on sales-crm" is the check working —
    // it is what a lane needs to be told, not a repo inconsistency to fail on.
    for (const note of result.notes) console.log(`[orchestrator] note: ${note}`);
    if (result.ok) {
      console.log("[orchestrator] every role workspace agrees with knowledge/.");
      return 0;
    }
    console.error("[orchestrator] role workspaces have problems:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
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
    const runtimeExecutor = createRuntimeExecutor({
      runtime: (() => {
        switch (args.runtime ?? "claude-code") {
          case "codex":
            return new CodexAdapter({ projectRoot: args.projectRoot });
          case "opencode":
            return new OpenCodeAdapter({ projectRoot: args.projectRoot });
          default:
            return new ClaudeCodeAdapter({ projectRoot: args.projectRoot });
        }
      })(),
      projectRoot: args.projectRoot,
      moduleName: () => args.module!,
      guards: contractGuardResolver(args.projectRoot),
      phases: () => (args.phases.length > 0 ? args.phases : undefined),
      // T-UX12: the gate reads the task's own stored level so TRIVIAL/SMALL
      // frontend work is not blocked on the UX-artifact precondition its
      // pipeline deliberately skipped.
      taskLevel: () => stored?.classification.level,
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
      threeRepoTask: (() => {
        try {
          loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
          return (id: string, stage: AgentStage) => {
            const task = store.loadTask(id);
            if (!task) throw new Error(`task ${id} disappeared from the state store`);
            return { task, roots: preflightThreeRepoTask(task, stage, { frameworkRoot: args.projectRoot, installationConfigPath: process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined }) };
          };
        } catch {
          return undefined;
        }
      })(),
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
    // the Framework binding root.
    let qaRoots: string[] = [args.projectRoot];
    try {
      loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
      const task = store.loadTask(taskId);
      if (task) {
        const roots3 = preflightThreeRepoTask(task, AgentStage.QA_ENGINEER, {
          frameworkRoot: args.projectRoot,
          installationConfigPath: process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined,
        });
        const writes = roots3.workRoots.filter((root) => root.access === "write").map((root) => root.path);
        if (writes.length > 0) qaRoots = [...new Set(writes)];
      }
    } catch {
      // legacy project: projectRoot stands
    }
    let qaDocsRoot = args.projectRoot;
    try {
      const installation = loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
      if (installation.knowledge_root) qaDocsRoot = installation.knowledge_root;
    } catch {
      // legacy project: projectRoot stands
    }
    const qaInputs = await productionQaInputs({ docsRoot: qaDocsRoot, moduleName: args.module ?? "", taskId, roots: qaRoots });

    const executor = args.noQaOptimization
      ? runtimeExecutor
      : withQaOptimization({
          inner: runtimeExecutor,
          changedFiles: async () => {
            // Read-only git inspection of every writable Target root; legacy
            // projects have exactly one — the project root itself. A root whose
            // git fails contributes nothing rather than poisoning the others;
            // a total failure yields [], which scopes as unbounded → FULL.
            let roots: string[] = qaRoots;
            try {
              loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
              const task = store.loadTask(taskId);
              if (task) {
                const roots3 = preflightThreeRepoTask(task, AgentStage.QA_ENGINEER, {
                  frameworkRoot: args.projectRoot,
                  installationConfigPath: process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined,
                });
                const writes = roots3.workRoots.filter((r) => r.access === "write").map((r) => r.path);
                if (writes.length > 0) roots = [...new Set(writes)];
              }
            } catch {
              // legacy project — projectRoot stands
            }
            const results = await Promise.allSettled(roots.map((root) => gitChangedFiles(root)));
            return [...new Set(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])))];
          },
          ...(args.noDeterministicGate
            ? { deterministicGate: "disabled" as const }
            : {
                deterministicGate: "enabled" as const,
                deterministicRunner: combineProjectRunners(qaRoots.map((root) => ({
                  root,
                  runner: createProjectRunner({
                    root,
                    workspace: new LocalWorkspace({ root }),
                    staticGatePath: path.join(args.projectRoot, ".claude", "scripts", "static-analysis-gate.js"),
                  }),
                }))),
              }),
          packageInputs: qaInputs.packageInputs,
          scopeInputs: qaInputs.scopeInputs,
          riskSignals: () => riskSignalsFromClassification(orchestrator.classification),
          previousRound: () => {
            // In three-repo mode the module docs live under the Knowledge root.
            let docsRoot = args.projectRoot;
            try {
              const installation = loadInstallationConfig(process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined);
              if (installation.knowledge_root) docsRoot = installation.knowledge_root;
            } catch {
              // legacy project — projectRoot stands
            }
            return previousRoundFromDocs(docsRoot, args.module ?? "", taskId);
          },
        });

    for (;;) {
      const status = orchestrator.status();
      registry.refreshStateView();

      if (status.kind === "DEPLOYED") {
        console.log(`[orchestrator] task ${taskId} DEPLOYED.`);
        console.log(orchestrator.runLog.summary(taskId));
        return 0;
      }
      if (status.kind === "BLOCKED") {
        console.log(`[orchestrator] task ${taskId} BLOCKED: ${status.reason}`);
        return 1;
      }
      if (status.kind === "WAITING_FOR_HUMAN") {
        const field = approvalFieldFor(status.approvalType);
        if (!field) {
          console.log(
            `[orchestrator] task ${taskId} stuck waiting: ${status.from} -> ${status.to} (${status.reason}), ` +
              "and this CLI doesn't know how to resolve that gate interactively.",
          );
          return 2;
        }
        const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
        console.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
        if (status.approvalType) console.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);

        // No TTY, no question: a headless `run` that called confirm() here would
        // hang on a stdin nobody is attached to (or crash on a closed one) while
        // looking alive. The gate stays pending in the ledger either way — the
        // task is parked, deterministically resumable once a person answers:
        //   sta approve <task-id> --yes|--no
        if (!process.stdin.isTTY) {
          console.log(
            `[orchestrator] no terminal attached — parking task ${taskId} with the gate unanswered. ` +
              `Resolve it with: node orchestrator/dist/cli.js approve ${taskId} --yes|--no ` +
              `(or rerun this command in an interactive terminal), then --resume.`,
          );
          return 4; // 4 = PARKED — distinct from blocked(1), stuck(2), rejected(3)
        }

        const approved = await confirm(`Approve ${label}?`);
        if (!approved) {
          // Recorded as a rejection, not left unanswered: resuming must not
          // re-ask a question this person already said no to (T08).
          if (status.approvalType) {
            orchestrator.decideApproval(status.approvalType, false, { by: process.env.USER ?? process.env.USERNAME });
          }
          registry.refreshStateView();
          console.log(
            `[orchestrator] rejected — task ${taskId} is stopped and the decision is recorded. ` +
              `Resuming will not ask again; revisit it deliberately if that was wrong.`,
          );
          return 3;
        }
        if (status.approvalType) {
          orchestrator.decideApproval(status.approvalType, true, { by: process.env.USER ?? process.env.USERNAME });
        } else {
          orchestrator.provideHumanApproval(field, true);
        }
        registry.refreshStateView();
        continue;
      }

      console.log(`[orchestrator] running ${status.stage}...`);
      const nextStatus = await orchestrator.step(executor);
      registry.refreshStateView();
      if (nextStatus.kind === "RUNNING" && nextStatus.stage === status.stage) {
        // Defensive: step() should always move the cursor forward or change status kind.
        console.log(`[orchestrator] ${status.stage} did not advance the task — stopping to avoid a spin loop.`);
        return 1;
      }
    }
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
