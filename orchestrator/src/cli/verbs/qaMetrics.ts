/** `qa-metrics [<task-id>] [--export-json <path>] [--baseline <path>] [--escaped-defects <n>]` — QA07's cost/effectiveness picture off the run log. */
export async function runQaMetricsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
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
import * as fs from "node:fs";
import { CliUsageError } from "../../cli.js";
import { buildMetricsExport, compareBaselines } from "../../qa/metrics.js";
import { flagValue, openStore, positionalArg } from "../support.js";
