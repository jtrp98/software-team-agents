import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { TaskState } from "./types.js";
import { classifyTask, type ClassificationInput } from "./classification/taskClassifier.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { TaskRegistry } from "./orchestrator/taskRegistry.js";
import { createClaudeCliExecutor } from "./agents/claudeCliExecutor.js";
import { SqliteTaskStore } from "./store/sqliteStore.js";
import { defaultStateDbPath, defaultStateViewPath } from "./store/stateView.js";
import { checkAllContracts } from "./agents/agentContract.js";
import { checkPathRules } from "./agents/pathPermissions.js";
import { checkLayout } from "./layout/repoLayout.js";
import { ApprovalType } from "./gates/approval.js";
import { checkAllWorkflows } from "./workflow/workflowDefinition.js";
import { checkProfile } from "./profile/projectProfile.js";
import { checkDecisions } from "./decisions/decisionLog.js";
import { checkTestPyramid } from "./testing/testPyramid.js";
import { describeStatus, type TaskStatusKind } from "./orchestrator/taskStatus.js";
import { RunLog } from "./observability/runLog.js";
import { acquireTaskLock, releaseTaskLock, TaskLockedError } from "./concurrency/taskLock.js";
import { actorsIn, auditTrail, decisionTrail, formatAuditTrail } from "./audit/auditTrail.js";
import { checkReviewSeparation } from "./review/reviewSeparation.js";
import { checkEscalationPolicy } from "./escalation/escalationPolicy.js";

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
  /** Continue a task that already exists in the store instead of creating one. */
  resume: boolean;
  /** Print every task in the store and exit, without running anything. */
  list: boolean;
  /** Check contracts/*.yaml against the orchestrator's registry and exit. Meant for CI as much as for a person. */
  checkContracts: boolean;
  /** Check layout.yaml against the directories that actually exist and exit. Same audience. */
  checkLayout: boolean;
  /** Check workflows/*.yml against the classifier and exit. Same audience. */
  checkWorkflows: boolean;
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
  dependsOn: string[];
  stateDb?: string;
  /** Phases of plan.md this run touches, used to slice module docs per conventions.md §10. Empty = send the plan whole. */
  phases: number[];
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
  "  orchestrate run --task-id <id> --module <name> <classification flags> [--phase <n,n>] [--depends-on <id,id>] [--project-root <path>] [--state-db <path>]\n" +
  "  orchestrate status [<task-id>] [--watch] [--interval <seconds>] [--project-root <path>]   no id = every task; with id = that task's detail\n" +
  "  orchestrate approve <task-id> [--yes|--no] [--project-root <path>]   resolve the current human gate; interactive if neither flag is given\n" +
  "  orchestrate resume  <task-id> --module <name> [--project-root <path>]   continue a task already in the store\n" +
  "  orchestrate retry   <task-id> --module <name> [--project-root <path>]   same as resume — there is no daemon here for the two to mean different things\n" +
  "  orchestrate pause  <task-id> [--project-root <path>]   freeze a task; run/resume/retry refuse it until resumed\n" +
  "  orchestrate cancel <task-id> [--reason <text>] [--project-root <path>]   give up on a task for good; run/resume/retry refuse it permanently\n" +
  "  orchestrate audit  <task-id> [--decisions] [--project-root <path>]   the WHO/WHAT/WHEN/WHY/INPUT/OUTPUT/DECISION trail; --decisions shows only the choices\n" +
  "\n" +
  "underlying flag-based form:\n" +
  "  orchestrate --task-id <id> --module <name> [--phase <n,n>] [--depends-on <id,id>] [--project-root <path>] [--state-db <path>] <classification flags>\n" +
  "  orchestrate --task-id <id> --module <name> --resume        continue a task already in the store\n" +
  "  orchestrate --list [--project-root <path>]                 show every task and stop\n" +
  "  orchestrate --check-contracts [--project-root <path>]      check contracts/*.yaml against the agent registry\n" +
  "  orchestrate --check-layout [--project-root <path>]         check layout.yaml against the real directories\n" +
  "  orchestrate --check-workflows [--project-root <path>]      check workflows/*.yml against the classifier\n" +
  "  orchestrate --check-profile [--project-root <path>]        check project.yaml and stacks/ against the agent roster\n" +
  "  orchestrate --check-decisions [--project-root <path>]      check decisions/*.md ADRs against the schema and cross-links\n" +
  "  orchestrate --check-test-pyramid [--project-root <path>]   check test-pyramid.yaml against its schema\n" +
  "  orchestrate --check-review-separation [--project-root <path>]  check that no agent can review its own work\n" +
  "  orchestrate --check-escalation-policy [--project-root <path>]  check escalation-policy.yaml against the runtime policy\n" +
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
  let checkWorkflowsFlag = false;
  let checkProfileFlag = false;
  let checkDecisionsFlag = false;
  let checkTestPyramidFlag = false;
  let checkReviewSeparationFlag = false;
  let checkEscalationPolicyFlag = false;
  let dependsOn: string[] = [];
  let phases: number[] = [];
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
    } else if (arg === "--check-workflows") {
      checkWorkflowsFlag = true;
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
    } else if (arg in FLAG_TO_CLASSIFICATION) {
      classification[FLAG_TO_CLASSIFICATION[arg]] = true;
    } else {
      throw new CliUsageError(`unrecognized argument: ${arg}`);
    }
  }

  if (
    !list &&
    !checkContracts &&
    !checkLayoutFlag &&
    !checkWorkflowsFlag &&
    !checkProfileFlag &&
    !checkDecisionsFlag &&
    !checkTestPyramidFlag &&
    !checkReviewSeparationFlag &&
    !checkEscalationPolicyFlag
  ) {
    if (!taskId) throw new CliUsageError("--task-id is required");
    if (!moduleName) throw new CliUsageError("--module is required (the _docs/module/<name>/ this task belongs to)");
  }
  if (resume && dependsOn.length > 0) {
    throw new CliUsageError("--depends-on is set when a task is created and cannot be changed on --resume");
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
    checkWorkflows: checkWorkflowsFlag,
    checkProfile: checkProfileFlag,
    checkDecisions: checkDecisionsFlag,
    checkTestPyramid: checkTestPyramidFlag,
    checkReviewSeparation: checkReviewSeparationFlag,
    checkEscalationPolicy: checkEscalationPolicyFlag,
    dependsOn,
    stateDb,
    phases,
  };
}

/**
 * Which `provideHumanApproval` field a gate's approval type maps to. Keyed on
 * `approvalType`, not on the edge's target state: T20 put `test-planner`
 * (and `project-manager` already did, for the "feature" pipeline) between
 * DESIGN and IMPLEMENTATION, so the schema-confirmation gate's target can be
 * PLAN rather than IMPLEMENTATION directly — the approval type is what stays
 * stable, per gatePolicy.ts/approval.ts's matching fix.
 */
function approvalFieldFor(approvalType: ApprovalType | null): "designApproved" | "humanApproved" | null {
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
  console.log(
    `[orchestrator] task ${taskId}: level=${classification.level} pipeline=${classification.pipeline.join(" -> ")}`,
  );
  for (const reason of classification.reasons) console.log(`[orchestrator]   reason: ${reason}`);
  return registry.create({ taskId, classification, dependsOn: args.dependsOn });
}

const VERBS = ["run", "status", "approve", "retry", "resume", "pause", "cancel", "audit"] as const;
type Verb = (typeof VERBS)[number];

function isVerb(s: string | undefined): s is Verb {
  return s !== undefined && (VERBS as readonly string[]).includes(s);
}

/** Flags a verb accepts that take a value — their value must never be mistaken for the positional <task-id>. */
const VERB_VALUE_FLAGS = new Set(["--project-root", "--state-db", "--reason", "--interval"]);

/** First non-flag token in a verb's remaining args — the positional <task-id>, skipping over any value-flag's own argument. */
function positionalArg(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      if (VERB_VALUE_FLAGS.has(rest[i])) i++; // skip its value, not just the flag itself
      continue;
    }
    return rest[i];
  }
  return undefined;
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
  }
}

export async function runCli(argv: string[], defaultProjectRoot: string): Promise<number> {
  if (isVerb(argv[0])) {
    return runVerb(argv[0], argv.slice(1), defaultProjectRoot);
  }

  const args = parseArgs(argv, defaultProjectRoot);

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

  const store = new SqliteTaskStore(args.stateDb ?? defaultStateDbPath(args.projectRoot));
  const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(args.projectRoot) });
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
    const executor = createClaudeCliExecutor({
      projectRoot: args.projectRoot,
      moduleName: () => args.module!,
      phases: () => (args.phases.length > 0 ? args.phases : undefined),
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
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  runCli(process.argv.slice(2), repoRoot)
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof CliUsageError) {
        console.error(`usage error: ${e.message}`);
        console.error(USAGE);
        process.exit(64);
      }
      console.error(e);
      process.exit(1);
    });
}
