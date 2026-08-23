import { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";

/**
 * QA07 — QA cost & effectiveness metrics, read off the run log.
 *
 * Everything here is derived from records that already exist: a QA round's
 * tokens/cost/duration/context size are logged per run, and `qa_mode` (this
 * optimization's addition) makes TARGETED vs FULL a queryable fact instead
 * of prose in review.md. Nothing in this module blocks or fails when usage
 * data is absent — nulls stay null and the aggregate says "not reported",
 * which is true.
 *
 * Baseline comparison (before/after optimization) is two exports of this
 * shape diffed by `compareBaselines` — no implicit state anywhere.
 */

export interface TaskQaMetrics {
  taskId: string;
  qaRuns: number;
  /** Summed input+output+cache-read tokens over the task's QA rounds. */
  qaTokens: number;
  totalTokens: number;
  /** qaTokens / totalTokens, 0 when the task spent nothing at all. */
  qaShare: number;
  fullRounds: number;
  targetedRounds: number;
  /** Rounds with no recorded mode (pre-optimization runs, blocked pre-LLM rounds). */
  unrecordedModeRounds: number;
  qaRetries: number;
  qaFailures: number;
  avgQaContextChars: number | null;
  qaDurationMs: number;
}

export function taskQaMetrics(runs: readonly RunRecord[]): TaskQaMetrics {
  const qa = runs.filter((r) => r.agent === AgentStage.QA_ENGINEER);
  const qaTokens = qa.reduce((sum, r) => sum + r.tokens, 0);
  const totalTokens = runs.reduce((sum, r) => sum + r.tokens, 0);
  const contextChars = qa.map((r) => r.context_chars).filter((c): c is number => c !== null);
  return {
    taskId: qa[0]?.task_id ?? "",
    qaRuns: qa.length,
    qaTokens,
    totalTokens,
    qaShare: totalTokens === 0 ? 0 : qaTokens / totalTokens,
    fullRounds: qa.filter((r) => r.qa_mode === "FULL").length,
    targetedRounds: qa.filter((r) => r.qa_mode === "TARGETED").length,
    unrecordedModeRounds: qa.filter((r) => r.qa_mode === null).length,
    // A retry is every QA round after the first — the first is not a redo.
    qaRetries: Math.max(0, qa.length - 1),
    qaFailures: qa.filter((r) => r.result === "FAIL").length,
    avgQaContextChars:
      contextChars.length === 0
        ? null
        : Math.round(contextChars.reduce((s, c) => s + c, 0) / contextChars.length),
    qaDurationMs: qa.reduce((sum, r) => sum + r.duration, 0),
  };
}

export interface QaMetricsExport {
  exportedAt: number;
  tasks: TaskQaMetrics[];
  totals: {
    qaRuns: number;
    qaTokens: number;
    totalTokens: number;
    qaShare: number;
    fullRounds: number;
    targetedRounds: number;
    qaRetries: number;
    /** Manually supplied by the caller — escaped defects are found outside this system. */
    escapedDefects?: number;
  };
}

export function buildMetricsExport(runsByTask: ReadonlyArray<{ taskId: string; runs: readonly RunRecord[] }>, opts?: { now?: () => number; escapedDefects?: number }): QaMetricsExport {
  const tasks = runsByTask.map(({ taskId, runs }) => ({ ...taskQaMetrics(runs), taskId }));
  const qaTokens = tasks.reduce((s, t) => s + t.qaTokens, 0);
  const totalTokens = tasks.reduce((s, t) => s + t.totalTokens, 0);
  const qaRuns = tasks.reduce((s, t) => s + t.qaRuns, 0);
  return {
    exportedAt: (opts?.now ?? Date.now)(),
    tasks,
    totals: {
      qaRuns,
      qaTokens,
      totalTokens,
      qaShare: totalTokens === 0 ? 0 : qaTokens / totalTokens,
      fullRounds: tasks.reduce((s, t) => s + t.fullRounds, 0),
      targetedRounds: tasks.reduce((s, t) => s + t.targetedRounds, 0),
      qaRetries: tasks.reduce((s, t) => s + t.qaRetries, 0),
      ...(opts?.escapedDefects !== undefined ? { escapedDefects: opts.escapedDefects } : {}),
    },
  };
}

export interface BaselineDelta {
  qaTokenDeltaPct: number | null;
  qaShareDeltaPct: number | null;
  targetedVsFullShift: string;
  retryDelta: number;
  verdict: "improved" | "regressed" | "insufficient-data";
  notes: string[];
}

/**
 * Before/after comparison. "Improved" means cheaper WITHOUT weaker routing:
 * token share down AND no drop in recorded-mode coverage that would hint the
 * gate stopped being applied. Escaped-defect comparison stays human work —
 * those numbers come from production, not from this log.
 */
export function compareBaselines(before: QaMetricsExport, after: QaMetricsExport): BaselineDelta {
  const notes: string[] = [];
  if (before.totals.totalTokens === 0 || after.totals.totalTokens === 0) {
    notes.push("one side has no recorded token spend — cannot compute a fair percentage");
    return { qaTokenDeltaPct: null, qaShareDeltaPct: null, targetedVsFullShift: describeShift(before, after), retryDelta: after.totals.qaRetries - before.totals.qaRetries, verdict: "insufficient-data", notes };
  }
  const qaTokenDeltaPct = pct(before.totals.qaTokens, after.totals.qaTokens);
  const qaShareDeltaPct = pct(before.totals.qaShare, after.totals.qaShare);

  let regressed = qaTokenDeltaPct > 0 && qaShareDeltaPct > 0;
  const modeCoverageBefore = modeCoverage(before);
  const modeCoverageAfter = modeCoverage(after);
  if (modeCoverageAfter < modeCoverageBefore - 0.05) {
    regressed = true;
    notes.push(
      `recorded QA-mode coverage fell from ${(modeCoverageBefore * 100).toFixed(0)}% to ${(modeCoverageAfter * 100).toFixed(0)}% — routing may have stopped being recorded`,
    );
  }
  return {
    qaTokenDeltaPct,
    qaShareDeltaPct,
    targetedVsFullShift: describeShift(before, after),
    retryDelta: after.totals.qaRetries - before.totals.qaRetries,
    verdict: regressed ? "regressed" : "improved",
    notes,
  };
}

// -- helpers -----------------------------------------------------------------

function pct(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((after - before) / before) * 100;
}

function modeCoverage(e: QaMetricsExport): number {
  const all = e.tasks.reduce((s, t) => s + t.qaRuns, 0);
  const known = e.tasks.reduce((s, t) => s + t.fullRounds + t.targetedRounds, 0);
  return all === 0 ? 1 : known / all;
}

function describeShift(before: QaMetricsExport, after: QaMetricsExport): string {
  const f = `${before.totals.targetedRounds}T/${before.totals.fullRounds}F -> ${after.totals.targetedRounds}T/${after.totals.fullRounds}F`;
  return f.replace(" -> ", " → ");
}
