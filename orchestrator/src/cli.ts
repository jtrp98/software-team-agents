import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { TaskState } from "./types.js";
import { classifyTask, type ClassificationInput } from "./classification/taskClassifier.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createClaudeCliExecutor } from "./agents/claudeCliExecutor.js";

/**
 * Runnable bridge between this orchestrator and the real `.claude/agents/*.md`
 * pipeline in the repo root — `npm run orchestrate -- <flags>` actually shells
 * out to `claude -p --agent <role>` for each stage classifyTask() selects,
 * gated exactly the way CLAUDE.md's opt-in autonomous mode describes: it
 * stops and prints WAITING_FOR_HUMAN instead of guessing at the five points
 * a person must decide (schema confirmation, a failed QA/security round past
 * retry, deploy approval).
 */

export interface CliArgs {
  taskId: string;
  module: string;
  projectRoot: string;
  classification: ClassificationInput;
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

/** Pure argv parser — kept separate from process.argv/console/exit so it's directly testable. */
export function parseArgs(argv: string[], defaultProjectRoot: string): CliArgs {
  let taskId: string | undefined;
  let moduleName: string | undefined;
  let projectRoot = defaultProjectRoot;
  const classification: ClassificationInput = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task-id") {
      taskId = argv[++i];
    } else if (arg === "--module") {
      moduleName = argv[++i];
    } else if (arg === "--project-root") {
      projectRoot = argv[++i];
    } else if (arg in FLAG_TO_CLASSIFICATION) {
      classification[FLAG_TO_CLASSIFICATION[arg]] = true;
    } else {
      throw new CliUsageError(`unrecognized argument: ${arg}`);
    }
  }

  if (!taskId) throw new CliUsageError("--task-id is required");
  if (!moduleName) throw new CliUsageError("--module is required (the _docs/module/<name>/ this task belongs to)");

  return { taskId, module: moduleName, projectRoot, classification };
}

/** Which `provideHumanApproval` field a given gate's target state maps to — the orchestrator has no persistence layer (yet), so this CLI resolves a WAITING_FOR_HUMAN gate by asking right there in the same run rather than exiting and hoping for a resume path that doesn't exist. */
function approvalFieldFor(to: TaskState): "designApproved" | "humanApproved" | null {
  if (to === TaskState.IMPLEMENTATION) return "designApproved";
  if (to === TaskState.APPROVED) return "humanApproved";
  return null;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runCli(argv: string[], defaultProjectRoot: string): Promise<number> {
  const args = parseArgs(argv, defaultProjectRoot);
  const classification = classifyTask(args.classification);

  console.log(`[orchestrator] task ${args.taskId}: level=${classification.level} pipeline=${classification.pipeline.join(" -> ")}`);
  for (const reason of classification.reasons) console.log(`[orchestrator]   reason: ${reason}`);

  const orchestrator = new Orchestrator(args.taskId, classification);
  const executor = createClaudeCliExecutor({
    projectRoot: args.projectRoot,
    moduleName: () => args.module,
  });

  for (;;) {
    const status = orchestrator.status();

    if (status.kind === "DEPLOYED") {
      console.log(`[orchestrator] task ${args.taskId} DEPLOYED.`);
      console.log(orchestrator.runLog.summary(args.taskId));
      return 0;
    }
    if (status.kind === "BLOCKED") {
      console.log(`[orchestrator] task ${args.taskId} BLOCKED: ${status.reason}`);
      return 1;
    }
    if (status.kind === "WAITING_FOR_HUMAN") {
      const field = approvalFieldFor(status.to);
      if (!field) {
        console.log(
          `[orchestrator] task ${args.taskId} stuck waiting: ${status.from} -> ${status.to} (${status.reason}), ` +
            "and this CLI doesn't know how to resolve that gate interactively.",
        );
        return 2;
      }
      console.log(`[orchestrator] human decision required: ${status.from} -> ${status.to} — ${status.reason}`);
      const approved = await confirm(`Approve ${status.from} -> ${status.to}?`);
      if (!approved) {
        console.log(`[orchestrator] not approved — stopping task ${args.taskId} here.`);
        return 3;
      }
      orchestrator.provideHumanApproval(field, true);
      continue;
    }

    console.log(`[orchestrator] running ${status.stage}...`);
    const nextStatus = await orchestrator.step(executor);
    if (nextStatus.kind === "RUNNING" && nextStatus.stage === status.stage) {
      // Defensive: step() should always move the cursor forward or change status kind.
      console.log(`[orchestrator] ${status.stage} did not advance the task — stopping to avoid a spin loop.`);
      return 1;
    }
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
        console.error(
          "usage: orchestrate --task-id <id> --module <name> [--project-root <path>] " +
            Object.keys(FLAG_TO_CLASSIFICATION).join(" | "),
        );
        process.exit(64);
      }
      console.error(e);
      process.exit(1);
    });
}
