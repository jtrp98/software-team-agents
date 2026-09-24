import { printListing, watchListing } from "../rendering/taskListing.js";
import { describeStatus } from "../../orchestrator/taskStatus.js";
import { RunLog } from "../../observability/runLog.js";
import { LEGACY_RUN_RECORD_NOTICE, observeRuns } from "../../run/observability.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import type { RunLedger } from "../../ledger/runLedger.js";
import type { TaskStore } from "../../store/taskStore.js";
import { engineViewOfRun } from "../../engine/boundedRunService.js";
import { flagValue, openStore, positionalArg } from "../support.js";

/**
 * T-V10-031 — a bounded run keeps going past a gated task, so the gate that
 * ended a run is not the whole story. V13 TASK-007: this is the *engine's*
 * projection of each run task (`engineViewOfRun`, the same guard the run is
 * driven with) — never the ledger's own task status, which is only a
 * projection written from the same engine state and cannot disagree with it.
 */
export function renderBoundedRunTasksAwaitingHuman(ledger: RunLedger, store: TaskStore, only?: string): string[] {
  const lines: string[] = [];
  for (const run of ledger.listRuns()) {
    if (run.status === "CANCELLED" || run.status === "REFUSED" || run.status === "STALE") continue;
    const views = engineViewOfRun(ledger, store, run).filter((item) => (!only || item.task.task_id === only));
    if (views.length === 0) continue;
    const done = views.filter((item) => item.status === "DONE").length;
    const awaiting = views.filter((item) => item.status === "BLOCKED");
    // A completed run whose every task the engine verifies has nothing to say.
    if (run.status === "COMPLETED" && done === views.length) continue;
    lines.push(
      `[orchestrator] bounded run ${run.run_id} (${run.status}) module=${run.module}: ` +
        `${done}/${views.length} task(s) verified done by the engine, ${awaiting.length} awaiting a human decision`,
    );
    for (const item of awaiting) {
      lines.push(`[orchestrator]   ⛔ ${item.task.task_id}: ${item.reason}`);
      lines.push(item.view?.kind === "WAITING_FOR_HUMAN"
        ? `[orchestrator]      answer the pending request with \`sta approve ${item.task.task_id}\``
        : `[orchestrator]      see \`sta status ${item.task.task_id}\` for what a person must do`);
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
      for (const line of renderBoundedRunTasksAwaitingHuman(ledger, store)) console.log(line);
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
    // The same guard every engine this registry opens asks, so `status` and a run never disagree.
    const status = describeStatus(task, store.listTasks(), { stageEntryGuard: registry.stageEntryGuard });
    const agent = status.currentAgent ? ` agent=${status.currentAgent}` : "";
    console.log(`[orchestrator] task ${taskId}: ${status.kind} at ${status.state}${agent}`);
    if (status.reason) console.log(`[orchestrator]   ${status.reason}`);
    if (status.waitingOn?.length) console.log(`[orchestrator]   waiting on: ${status.waitingOn.join(", ")}`);
    for (const line of renderBoundedRunTasksAwaitingHuman(ledger, store, taskId)) console.log(line);
    const runs = store.runsForTask(taskId);
    if (runs.length > 0) console.log(new RunLog(runs).summary(taskId));
    return 0;
  } finally {
    registry.close();
  }
}
