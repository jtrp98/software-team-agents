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
  "usage:\n" +
  "  orchestrate --task-id <id> --module <name> [--phase <n,n>] [--depends-on <id,id>] [--project-root <path>] [--state-db <path>] <classification flags>\n" +
  "  orchestrate --task-id <id> --module <name> --resume        continue a task already in the store\n" +
  "  orchestrate --list [--project-root <path>]                 show every task and stop\n" +
  "  orchestrate --check-contracts [--project-root <path>]      check contracts/*.yaml against the agent registry\n" +
  "  orchestrate --check-layout [--project-root <path>]         check layout.yaml against the real directories\n" +
  "  orchestrate --check-workflows [--project-root <path>]      check workflows/*.yml against the classifier\n" +
  "  orchestrate --check-profile [--project-root <path>]        check project.yaml and stacks/ against the agent roster\n" +
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
    } else if (arg in FLAG_TO_CLASSIFICATION) {
      classification[FLAG_TO_CLASSIFICATION[arg]] = true;
    } else {
      throw new CliUsageError(`unrecognized argument: ${arg}`);
    }
  }

  if (!list && !checkContracts && !checkLayoutFlag && !checkWorkflowsFlag && !checkProfileFlag) {
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
    dependsOn,
    stateDb,
    phases,
  };
}

/** Which `provideHumanApproval` field a given gate's target state maps to. */
function approvalFieldFor(to: TaskState): "designApproved" | "humanApproved" | null {
  if (to === TaskState.IMPLEMENTATION) return "designApproved";
  if (to === TaskState.APPROVED) return "humanApproved";
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
    console.log(
      `  ${task.taskId.padEnd(12)} ${status.kind.padEnd(22)} ${status.state.padEnd(16)}${agent}${layer}${waiting}${reason}`,
    );
  }

  const stats = layerOf.size > 0 ? registry.parallelism() : null;
  if (stats && stats.widest > 1) {
    console.log(
      `[orchestrator] ${stats.tasks} tasks in ${stats.layers} batch(es); up to ${stats.widest} could run at once ` +
        "(the orchestrator still runs one at a time — concurrent execution needs file locking, T35).",
    );
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

export async function runCli(argv: string[], defaultProjectRoot: string): Promise<number> {
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

  const store = new SqliteTaskStore(args.stateDb ?? defaultStateDbPath(args.projectRoot));
  const registry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(args.projectRoot) });

  try {
    if (args.list) {
      printListing(registry);
      return 0;
    }

    const taskId = args.taskId!;
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
        const field = approvalFieldFor(status.to);
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
