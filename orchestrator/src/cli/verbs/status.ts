import { printListing, watchListing } from "../rendering/taskListing.js";
import { describeStatus } from "../../orchestrator/taskStatus.js";
import { RunLog } from "../../observability/runLog.js";
import { LEGACY_RUN_RECORD_NOTICE, observeRuns } from "../../run/observability.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import type { RunLedger } from "../../ledger/runLedger.js";
import { flagValue, openStore, positionalArg } from "../support.js";

/**
 * T-V10-031 — bounded-run blocks a gated task and keeps going, so the gate that
 * ended a run is no longer the whole story. The reason lives on the `TASK_STATUS`
 * event, not the task record, which is why this reads events rather than tasks.
 */
export function renderBlockedLedgerTasks(ledger: RunLedger, only?: string): string[] {
  const lines: string[] = [];
  for (const run of ledger.listRuns()) {
    const blocked = ledger.readTasks(run.run_id).filter((task) => task.status === "BLOCKED" && (!only || task.task_id === only));
    if (blocked.length === 0) continue;
    const reasons = new Map<string, string>();
    for (const event of ledger.eventsForRun(run.run_id)) {
      if (event.kind === "TASK_STATUS" && event.to === "BLOCKED" && event.task_id && event.reason) reasons.set(event.task_id, event.reason);
    }
    lines.push(`[orchestrator] bounded run ${run.run_id} (${run.status}) module=${run.module}: ${blocked.length} task(s) awaiting a human decision`);
    for (const task of blocked) {
      lines.push(`[orchestrator]   ⛔ ${task.task_id}: ${reasons.get(task.task_id) ?? "blocked without a recorded reason"}`);
      lines.push(`[orchestrator]      unblock with \`sta approve ${task.task_id}\``);
    }
  }
  return lines;
}

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
    const ledger = new SqliteRunLedger(store, { projectRoot });
    if (!taskId) {
      printListing(registry);
      for (const line of renderBlockedLedgerTasks(ledger)) console.log(line);
      // T-V8-029 — `.workflow/wave-runs/` is legacy: the retired wave runner was
      // its only writer, so anything here predates V8. Say so on every line
      // rather than letting an unfinished old record read as a live run.
      const runs = (await observeRuns(projectRoot)).filter((run) => ACTIVE_RUN_STATES.has(run.state) || run.state === "HALTED");
      for (const run of runs) {
        console.log(`[orchestrator] legacy wave run ${run.run_id}: ${run.state} module=${run.module} wave=${run.wave} branch=${run.run_branch}`);
        console.log(`[orchestrator]   ${LEGACY_RUN_RECORD_NOTICE}`);
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
    for (const line of renderBlockedLedgerTasks(ledger, taskId)) console.log(line);
    const runs = store.runsForTask(taskId);
    if (runs.length > 0) console.log(new RunLog(runs).summary(taskId));
    return 0;
  } finally {
    registry.close();
  }
}
