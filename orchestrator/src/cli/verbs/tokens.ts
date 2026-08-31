function displayMetric(value: number | null): string {
  return value === null ? "not reported" : value.toLocaleString();
}

function displayRate(value: number | null): string {
  return value === null ? "not reported" : `${(value * 100).toFixed(1)}%`;
}

function displayPercentDelta(value: number | null): string {
  return value === null ? "not reported" : `${value.toFixed(1)}%`;
}

function printTokenTask(metric: TaskTokenMetrics): void {
  const c = metric.composition;
  const budget = metric.contextBudget;
  console.log(
    `[orchestrator] ${metric.taskId}: input=${displayMetric(metric.inputTokens)} estimated-input=${displayMetric(metric.estimatedInputTokens)} output=${displayMetric(metric.outputTokens)} ` +
      `cached=${displayMetric(metric.cachedTokens)} total=${displayMetric(metric.totalTokens)} effort=${metric.efforts.join(",")} stages=${metric.stageCount} retries=${metric.retryCount} retryWaste=${displayMetric(metric.retryWasteTokens)} ` +
      `sessions=orchestrated:${metric.sessionKinds.orchestrated},interactive:${metric.sessionKinds.interactive},not-reported:${metric.sessionKinds.not_reported} ` +
      `always-on-instructions=${displayMetric(metric.instructionSurfaceBytes)} B`,
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

export async function runTokensVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
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
    const completedTaskIds = new Set(
      store.listTasks().filter((task) => task.machine.current === TaskState.DEPLOYED).map((task) => task.taskId),
    );
    const report = tokenMetricsExport(runs, { completedTaskIds });
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
    console.log(`[orchestrator] totals: input=${displayMetric(total.inputTokens)} estimated-input=${displayMetric(total.estimatedInputTokens)} output=${displayMetric(total.outputTokens)} cached=${displayMetric(total.cachedTokens)} total=${displayMetric(total.totalTokens)} effort=${total.efforts.join(",")} retries=${total.retryCount} retryWaste=${displayMetric(total.retryWasteTokens)}`);
    console.log(
      `[orchestrator] V3 rollups: total_token_per_completed_task=${displayMetric(total.total_token_per_completed_task)} ` +
        `first_pass_success_rate=${displayRate(total.first_pass_success_rate)} fallback_rate=${displayRate(total.fallback_rate)}`,
    );
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
      console.log(`[orchestrator] vs baseline (${baselinePath}): input ${delta.inputTokenDeltaPct === null ? "not reported" : `${delta.inputTokenDeltaPct.toFixed(1)}%`}, prompt chars ${delta.promptCharacterDeltaPct === null ? "not reported" : `${delta.promptCharacterDeltaPct.toFixed(1)}%`}, retry waste ${delta.retryWasteDeltaPct === null ? "not reported" : `${delta.retryWasteDeltaPct.toFixed(1)}%`}`);
      console.log(
        `[orchestrator] V3 rollup deltas: total_token_per_completed_task=${displayPercentDelta(delta.totalTokenPerCompletedTaskDeltaPct)} ` +
          `first_pass_success_rate=${displayPercentDelta(delta.firstPassSuccessRateDeltaPct)} fallback_rate=${displayPercentDelta(delta.fallbackRateDeltaPct)}`,
      );
    }
    return 0;
  } finally { registry.close(); }
}
import * as fs from "node:fs";
import { CliUsageError } from "../../cli.js";
import { TaskState } from "../../types.js";
import { compareTokenBaselines, tokenMetricsExport, type TaskTokenMetrics, type TokenMetricsExport } from "../../qa/metrics.js";
import { configuredTokenBudget, flagValue, openStore, positionalArg } from "../support.js";
