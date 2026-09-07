import { printListing, watchListing } from "../../cli.js";
import { describeStatus } from "../../orchestrator/taskStatus.js";
import { RunLog } from "../../observability/runLog.js";
import { observeRuns } from "../../run/observability.js";
import { flagValue, openStore, positionalArg } from "../support.js";

const ACTIVE_RUN_STATES = new Set(["CREATED", "PREFLIGHT", "ISOLATED", "TASK_READY", "TASK_RUNNING", "VALIDATING", "CHECKPOINTED", "WAVE_COMPLETE"]);

/** `status [<task-id>] [--watch] [--interval <seconds>]` — no id lists everything, an id shows one task's detail. */
export async function runStatusVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  const watch = rest.includes("--watch");
  const intervalSeconds = Number(flagValue(rest, "--interval") ?? "5");

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    if (watch) {
      await watchListing(registry, { intervalMs: Math.max(1, intervalSeconds) * 1000, iterations: Infinity });
      return 0;
    }
    if (!taskId) {
      printListing(registry);
      const runs = (await observeRuns(projectRoot)).filter((run) => ACTIVE_RUN_STATES.has(run.state) || run.state === "HALTED");
      for (const run of runs) {
        console.log(`[orchestrator] bounded run ${run.run_id}: ${run.state} module=${run.module} wave=${run.wave} branch=${run.run_branch}`);
        console.log(`[orchestrator]   next required human action: ${run.next_required_human_action}`);
        if (run.tasks.some((task) => task.status === "CHECKPOINTED")) {
          console.log(`[orchestrator]   ${run.disclaimer}`);
        }
      }
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
