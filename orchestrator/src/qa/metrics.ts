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
  /** T-V1-13A §8.12 — tokens spent on FAILed runs, the retry waste a cheaper pipeline must shrink. Every role's failed runs count, not just QA's. */
  retryWasteTokens: number;
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
    retryWasteTokens: runs.filter((r) => r.result === "FAIL").reduce((sum, r) => sum + r.tokens, 0),
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
    /**
     * T-V1-13A §8.12 — total tokens over tasks that reached at least one PASS
     * run, divided by the number of such tasks. Total ÷ *successful* on purpose:
     * an optimization that quietly fails more tasks must look more expensive per
     * success, never cheaper overall. Null when no task succeeded.
     */
    tokensPerSuccessfulTask: number | null;
    /** Manually supplied by the caller — escaped defects are found outside this system. */
    escapedDefects?: number;
  };
}

export function buildMetricsExport(runsByTask: ReadonlyArray<{ taskId: string; runs: readonly RunRecord[] }>, opts?: { now?: () => number; escapedDefects?: number }): QaMetricsExport {
  const tasks = runsByTask.map(({ taskId, runs }) => ({ ...taskQaMetrics(runs), taskId }));
  const qaTokens = tasks.reduce((s, t) => s + t.qaTokens, 0);
  const totalTokens = tasks.reduce((s, t) => s + t.totalTokens, 0);
  const qaRuns = tasks.reduce((s, t) => s + t.qaRuns, 0);
  // Success is a run-level fact (a PASS anywhere in the task's history); the
  // denominator counts tasks, not runs, so rework doesn't inflate it.
  const successful = runsByTask.filter(({ runs }) => runs.some((r) => r.result === "PASS"));
  const successfulTokens = successful.reduce((sum, { runs }) => sum + runs.reduce((s, r) => s + r.tokens, 0), 0);
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
      tokensPerSuccessfulTask: successful.length === 0 ? null : successfulTokens / successful.length,
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

// T-V3TOK-003 deliberately lives beside QA metrics: both are read-only views
// over the same RunRecord store, not competing telemetry systems.
export interface TokenCompositionMetrics {
  static_chars: number | null;
  handoff_chars: number | null;
  doc_chars: number | null;
  doc_chars_before: number | null;
  knowledge_chars: number | null;
  code_intel_chars: number | null;
  tool_output_chars: number | null;
}

/** Warning-mode context budget telemetry; no value here implies enforcement. */
export interface ContextBudgetMetrics {
  measuredRuns: number;
  warningRuns: number;
  contextChars: number | null;
  budgetChars: number | null;
  overflowChars: number | null;
  composition: Record<"base" | "task" | "safety" | "docs" | "knowledge" | "code" | "tool_output" | "reserve", number | null>;
}

export interface TaskTokenMetrics {
  taskId: string;
  runCount: number;
  stageCount: number;
  retryCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  retryWasteTokens: number | null;
  instructionSurfaceBytes: number | null;
  composition: TokenCompositionMetrics;
  contextBudget: ContextBudgetMetrics;
  sessionKinds: Record<"orchestrated" | "interactive" | "not_reported", number>;
}

export interface TokenRoleMetrics {
  role: string;
  runCount: number;
  staticChars: number | null;
  retrievedChars: number | null;
  staticVsRetrievedRatio: number | null;
  docChars: number | null;
  docCharsBefore: number | null;
  slicingSavedPct: number | null;
  contextBudget: ContextBudgetMetrics;
}

/** One warning-mode observation, retained in JSON export for role/p95 analysis. */
export interface ContextBudgetRunMetric {
  taskId: string;
  role: string;
  startTime: number;
  contextChars: number | null;
  budgetChars: number;
  budgetSource: "role" | "model_context_window";
  overflowChars: number | null;
  warning: boolean | null;
  composition: ContextBudgetMetrics["composition"];
}

export interface TokenMetricsExport {
  exportedAt: number;
  tasks: TaskTokenMetrics[];
  roles: TokenRoleMetrics[];
  /** Every run with an authoritative context budget, never synthetic aggregate rows. */
  contextBudgetRuns: ContextBudgetRunMetric[];
  totals: Omit<TaskTokenMetrics, "taskId" | "sessionKinds">;
}

const COMPOSITION_FIELDS = ["static_chars", "handoff_chars", "doc_chars", "knowledge_chars", "code_intel_chars", "tool_output_chars"] as const;

/** A total is known only when every contributing row reported the field. */
function strictSum(runs: readonly RunRecord[], value: (run: RunRecord) => number | null): number | null {
  if (runs.length === 0 || runs.some((run) => value(run) === null)) return null;
  return runs.reduce((sum, run) => sum + (value(run) ?? 0), 0);
}

function totalTokensFor(run: RunRecord): number | null {
  return run.input_tokens === null || run.output_tokens === null ? null : run.input_tokens + run.output_tokens;
}

function compositionFor(runs: readonly RunRecord[]): TokenCompositionMetrics {
  return {
    static_chars: strictSum(runs, (run) => run.static_chars),
    handoff_chars: strictSum(runs, (run) => run.handoff_chars),
    doc_chars: strictSum(runs, (run) => run.doc_chars),
    doc_chars_before: strictSum(runs, (run) => run.doc_chars_before),
    knowledge_chars: strictSum(runs, (run) => run.knowledge_chars),
    code_intel_chars: strictSum(runs, (run) => run.code_intel_chars),
    tool_output_chars: strictSum(runs, (run) => run.tool_output_chars),
  };
}

function contextBudgetFor(runs: readonly RunRecord[]): ContextBudgetMetrics {
  const measured = runs.filter((run) => run.context_budget_chars !== null);
  const composition = (field: keyof Pick<RunRecord, "context_base_chars" | "context_task_chars" | "context_safety_chars" | "context_docs_chars" | "context_knowledge_chars" | "context_code_chars" | "context_tool_output_chars" | "context_reserve_chars">) =>
    strictSum(measured, (run) => run[field]);
  return {
    measuredRuns: measured.length,
    warningRuns: measured.filter((run) => run.context_budget_warning === true).length,
    contextChars: strictSum(measured, (run) => run.context_chars),
    budgetChars: strictSum(measured, (run) => run.context_budget_chars),
    overflowChars: strictSum(measured, (run) => run.context_overflow_chars),
    composition: {
      base: composition("context_base_chars"), task: composition("context_task_chars"), safety: composition("context_safety_chars"),
      docs: composition("context_docs_chars"), knowledge: composition("context_knowledge_chars"), code: composition("context_code_chars"),
      tool_output: composition("context_tool_output_chars"), reserve: composition("context_reserve_chars"),
    },
  };
}

export function taskTokenMetrics(runs: readonly RunRecord[]): TaskTokenMetrics {
  const sessionKinds = { orchestrated: 0, interactive: 0, not_reported: 0 };
  for (const run of runs) {
    if (run.session_kind === "orchestrated" || run.session_kind === "interactive") sessionKinds[run.session_kind]++;
    else sessionKinds.not_reported++;
  }
  const failures = runs.filter((run) => run.result === "FAIL");
  return {
    taskId: runs[0]?.task_id ?? "",
    runCount: runs.length,
    stageCount: new Set(runs.map((run) => run.agent)).size,
    retryCount: runs.reduce((sum, run) => sum + run.retry_count, 0),
    inputTokens: strictSum(runs, (run) => run.input_tokens),
    outputTokens: strictSum(runs, (run) => run.output_tokens),
    cachedTokens: strictSum(runs, (run) => run.cache_read_tokens),
    totalTokens: strictSum(runs, totalTokensFor),
    // No failed rows is a known zero; one failed row with unreported usage is
    // unknown, never a fabricated zero.
    retryWasteTokens: failures.length === 0 ? 0 : strictSum(failures, totalTokensFor),
    instructionSurfaceBytes: strictSum(runs, (run) => run.instruction_surface_bytes ?? null),
    composition: compositionFor(runs),
    contextBudget: contextBudgetFor(runs),
    sessionKinds,
  };
}

function roleMetrics(runs: readonly RunRecord[]): TokenRoleMetrics[] {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) groups.set(run.agent, [...(groups.get(run.agent) ?? []), run]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, roleRuns]) => {
    const staticChars = strictSum(roleRuns, (run) => run.static_chars);
    const retrievedChars = strictSum(roleRuns, (run) => {
      const components = [run.handoff_chars, run.doc_chars, run.knowledge_chars, run.code_intel_chars, run.tool_output_chars];
      return components.some((value) => value === null) ? null : components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    });
    const docChars = strictSum(roleRuns, (run) => run.doc_chars);
    const docCharsBefore = strictSum(roleRuns, (run) => run.doc_chars_before);
    const contextBudget = contextBudgetFor(roleRuns);
    return {
      role,
      runCount: roleRuns.length,
      staticChars,
      retrievedChars,
      staticVsRetrievedRatio: staticChars === null || retrievedChars === null || retrievedChars === 0 ? null : staticChars / retrievedChars,
      docChars,
      docCharsBefore,
      slicingSavedPct:
        docChars === null || docCharsBefore === null || docCharsBefore === 0
          ? null
          : Math.round(((docCharsBefore - docChars) / docCharsBefore) * 100),
      contextBudget,
    };
  });
}

function contextBudgetRunsFor(runs: readonly RunRecord[]): ContextBudgetRunMetric[] {
  return runs
    .filter((run): run is RunRecord & { context_budget_chars: number; context_budget_source: "role" | "model_context_window" } =>
      run.context_budget_chars !== null && run.context_budget_source !== null,
    )
    .map((run) => ({
      taskId: run.task_id,
      role: run.agent,
      startTime: run.start_time,
      contextChars: run.context_chars,
      budgetChars: run.context_budget_chars,
      budgetSource: run.context_budget_source,
      overflowChars: run.context_overflow_chars,
      warning: run.context_budget_warning,
      composition: {
        base: run.context_base_chars, task: run.context_task_chars, safety: run.context_safety_chars, docs: run.context_docs_chars,
        knowledge: run.context_knowledge_chars, code: run.context_code_chars, tool_output: run.context_tool_output_chars, reserve: run.context_reserve_chars,
      },
    }));
}

export function tokenMetricsExport(runs: readonly RunRecord[], opts?: { now?: () => number }): TokenMetricsExport {
  const grouped = new Map<string, RunRecord[]>();
  for (const run of runs) grouped.set(run.task_id, [...(grouped.get(run.task_id) ?? []), run]);
  const tasks = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, taskRuns]) => taskTokenMetrics(taskRuns));
  const aggregate = taskTokenMetrics(runs);
  return {
    exportedAt: (opts?.now ?? Date.now)(),
    tasks,
    roles: roleMetrics(runs),
    contextBudgetRuns: contextBudgetRunsFor(runs),
    totals: {
      runCount: aggregate.runCount,
      stageCount: aggregate.stageCount,
      retryCount: aggregate.retryCount,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cachedTokens: aggregate.cachedTokens,
      totalTokens: aggregate.totalTokens,
      retryWasteTokens: aggregate.retryWasteTokens,
      instructionSurfaceBytes: aggregate.instructionSurfaceBytes,
      composition: aggregate.composition,
      contextBudget: aggregate.contextBudget,
    },
  };
}

export function compareTokenBaselines(before: TokenMetricsExport, after: TokenMetricsExport): { inputTokenDeltaPct: number | null; retryWasteDeltaPct: number | null } {
  const delta = (oldValue: number | null, newValue: number | null): number | null =>
    oldValue === null || newValue === null || oldValue === 0 ? null : ((newValue - oldValue) / oldValue) * 100;
  return {
    inputTokenDeltaPct: delta(before.totals.inputTokens, after.totals.inputTokens),
    retryWasteDeltaPct: delta(before.totals.retryWasteTokens, after.totals.retryWasteTokens),
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
