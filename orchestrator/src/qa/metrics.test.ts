import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";
import { buildMetricsExport, compareBaselines, compareTokenBaselines, taskQaMetrics, taskTokenMetrics, tokenMetricsExport } from "./metrics.js";

function run(partial: Partial<RunRecord> & { agent: AgentStage }): RunRecord {
  return {
    task_id: "T1",
    start_time: 0,
    end_time: 100,
    duration: 100,
    model: null,
    promptVersion: null,
    tokens: 0,
    cost: 0,
    result: "PASS",
    retry_count: 0,
    failure_reason: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    context_chars: null,
    qa_mode: null,
    qa_effort: null,
    deterministic_gate: null,
    runtime: null,
    requested_runtime: null,
    requested_model: null,
    routing_basis: null,
    fallback_reason: null,
    fallback_count: null,
    session_kind: null,
    static_chars: null,
    handoff_chars: null,
    doc_chars: null,
    doc_chars_before: null,
    knowledge_chars: null,
    code_intel_chars: null,
    tool_output_chars: null,
    context_budget_chars: null,
    context_budget_source: null,
    context_overflow_chars: null,
    context_budget_warning: null,
    context_base_chars: null,
    context_task_chars: null,
    context_safety_chars: null,
    context_docs_chars: null,
    context_knowledge_chars: null,
    context_code_chars: null,
    context_tool_output_chars: null,
    context_reserve_chars: null,
    ...partial,
  };
}

describe("taskQaMetrics", () => {
  it("computes QA share, mode split and retries for one task", () => {
    const m = taskQaMetrics([
      run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 3000 }),
      run({ agent: AgentStage.QA_ENGINEER, tokens: 1000, qa_mode: "TARGETED", context_chars: 5000 }),
      run({ agent: AgentStage.QA_ENGINEER, tokens: 2000, qa_mode: "FULL", result: "FAIL", context_chars: 9000 }),
      run({ agent: AgentStage.QA_ENGINEER, tokens: 500, qa_mode: null }),
    ]);
    expect(m.qaRuns).toBe(3);
    expect(m.qaTokens).toBe(3500);
    expect(m.totalTokens).toBe(6500);
    expect(m.qaShare).toBeCloseTo(3500 / 6500);
    expect(m.targetedRounds).toBe(1);
    expect(m.fullRounds).toBe(1);
    expect(m.unrecordedModeRounds).toBe(1);
    expect(m.qaRetries).toBe(2);
    expect(m.qaFailures).toBe(1);
    // T-V1-13A §8.12: only the FAILed run's tokens count as waste — the dev
    // run and the passing/targeted/unrecorded QA rounds do not.
    expect(m.retryWasteTokens).toBe(2000);
    expect(m.avgQaContextChars).toBe(7000);
    expect(m.qaDurationMs).toBe(300);
  });

  it("reports zero share without division-by-zero when nothing ran", () => {
    const m = taskQaMetrics([]);
    expect(m.qaShare).toBe(0);
    expect(m.avgQaContextChars).toBeNull();
  });
});

describe("buildMetricsExport / compareBaselines", () => {
  const before = buildMetricsExport(
    [{ taskId: "T1", runs: [run({ agent: AgentStage.QA_ENGINEER, tokens: 4000, qa_mode: "FULL" }), run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 6000 })] }],
    { now: () => 1 },
  );

  it("sees improvement when the same work spends fewer QA tokens", () => {
    const after = buildMetricsExport(
      [{ taskId: "T1", runs: [run({ agent: AgentStage.QA_ENGINEER, tokens: 1500, qa_mode: "TARGETED" }), run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 6000 })] }],
      { now: () => 2 },
    );
    const delta = compareBaselines(before, after);
    expect(delta.verdict).toBe("improved");
    expect(delta.qaTokenDeltaPct).toBeCloseTo(-62.5);
    expect(delta.targetedVsFullShift).toContain("0T/1F → 1T/0F");
  });

  it("calls insufficient data when either side has no spend", () => {
    const empty = buildMetricsExport([{ taskId: "T9", runs: [] }], { now: () => 3 });
    expect(compareBaselines(before, empty).verdict).toBe("insufficient-data");
  });

  it("flags regressed routing coverage even when tokens dropped", () => {
    // After: cheaper overall but every QA round lost its recorded mode.
    const after = buildMetricsExport(
      [{ taskId: "T1", runs: [run({ agent: AgentStage.QA_ENGINEER, tokens: 500, qa_mode: null }), run({ agent: AgentStage.QA_ENGINEER, tokens: 500, qa_mode: null }), run({ agent: AgentStage.QA_ENGINEER, tokens: 500, qa_mode: null }), run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 6000 })] }],
      { now: () => 4 },
    );
    const delta = compareBaselines(before, after);
    expect(delta.verdict).toBe("regressed");
    expect(delta.notes.join(" ")).toMatch(/routing may have stopped being recorded/);
  });

  it("carries escaped defects through the totals when supplied", () => {
    const e = buildMetricsExport([{ taskId: "T1", runs: [run({ agent: AgentStage.QA_ENGINEER, tokens: 10, qa_mode: "FULL" })] }], { now: () => 5, escapedDefects: 2 });
    expect(e.totals.escapedDefects).toBe(2);
  });

  it("computes tokensPerSuccessfulTask over tasks, so rework never inflates the denominator", () => {
    // T-ok reached PASS once (6000 tokens total); T-rework burned a FAIL then
    // passed (4000+1000); T-failed never succeeded and contributes spend to the
    // numerator of nothing — it is simply excluded from the per-success figure.
    const e = buildMetricsExport([
      { taskId: "T-ok", runs: [run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 6000 })] },
      { taskId: "T-rework", runs: [run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 4000, result: "FAIL" }), run({ agent: AgentStage.QA_ENGINEER, tokens: 1000 })] },
      { taskId: "T-failed", runs: [run({ agent: AgentStage.BACKEND_ENGINEER, tokens: 9000, result: "FAIL" })] },
    ], { now: () => 6 });
    // (6000 + 5000) across the two tasks that ever PASSED.
    expect(e.totals.tokensPerSuccessfulTask).toBe(11000 / 2);
  });

  it("reports null tokensPerSuccessfulTask when nothing succeeded", () => {
    const e = buildMetricsExport([{ taskId: "T-failed", runs: [run({ agent: AgentStage.DEVOPS, tokens: 500, result: "FAIL" })] }], { now: () => 7 });
    expect(e.totals.tokensPerSuccessfulTask).toBeNull();
  });
});

describe("T-V3TOK-100 context budget token reporting", () => {
  it("reports warning frequency, overflow, and the complete priority composition", () => {
    const metric = taskTokenMetrics([run({
      agent: AgentStage.BACKEND_ENGINEER, context_chars: 100, context_budget_chars: 90, context_budget_source: "role",
      context_overflow_chars: 10, context_budget_warning: true,
      context_base_chars: 10, context_task_chars: 20, context_safety_chars: 0, context_docs_chars: 30,
      context_knowledge_chars: 15, context_code_chars: 10, context_tool_output_chars: 15, context_reserve_chars: 0,
    })]);
    expect(metric.contextBudget).toMatchObject({ measuredRuns: 1, warningRuns: 1, contextChars: 100, budgetChars: 90, overflowChars: 10 });
    expect(Object.values(metric.contextBudget.composition).reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(100);
    const exported = tokenMetricsExport([run({
      agent: AgentStage.BACKEND_ENGINEER, context_chars: 100, context_budget_chars: 90, context_budget_source: "role",
      context_overflow_chars: 10, context_budget_warning: true,
      context_base_chars: 10, context_task_chars: 20, context_safety_chars: 0, context_docs_chars: 30,
      context_knowledge_chars: 15, context_code_chars: 10, context_tool_output_chars: 15, context_reserve_chars: 0,
    })]);
    expect(exported.contextBudgetRuns).toEqual([expect.objectContaining({ role: AgentStage.BACKEND_ENGINEER, contextChars: 100, budgetChars: 90, overflowChars: 10, warning: true })]);
  });
});

describe("T-V3TOK-003 token metrics", () => {
  it("aggregates orchestrated and interactive rows without treating missing token usage as zero", () => {
    const orchestrated = run({
      agent: AgentStage.BACKEND_ENGINEER,
      task_id: "T-orch",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      static_chars: 40,
      handoff_chars: 10,
      doc_chars: 20,
      knowledge_chars: 0,
      code_intel_chars: 0,
      tool_output_chars: 0,
      session_kind: "orchestrated",
    });
    const interactive = run({
      agent: AgentStage.BACKEND_ENGINEER,
      task_id: "session:dev:2026-08-26T00:00:00.000Z",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      static_chars: 900,
      session_kind: "interactive",
    });
    const exportData = tokenMetricsExport([orchestrated, interactive], { now: () => 1 });
    expect(exportData.tasks).toHaveLength(2);
    expect(exportData.totals.inputTokens).toBeNull();
    expect(exportData.tasks.find((metric) => metric.taskId === "T-orch")?.totalTokens).toBe(120);
    expect(exportData.tasks.find((metric) => metric.taskId === "T-orch")?.retryWasteTokens).toBe(0);
    expect(exportData.tasks.find((metric) => metric.taskId.startsWith("session:"))?.inputTokens).toBeNull();
    expect(exportData.roles[0]).toMatchObject({ role: AgentStage.BACKEND_ENGINEER, staticChars: 940, retrievedChars: null, staticVsRetrievedRatio: null });
  });

  it("counts retries and failure spend only when every failed row reported true usage", () => {
    const metrics = taskTokenMetrics([
      run({ agent: AgentStage.BACKEND_ENGINEER, result: "FAIL", retry_count: 1, input_tokens: 8, output_tokens: 2 }),
      run({ agent: AgentStage.BACKEND_ENGINEER, result: "FAIL", retry_count: 1, input_tokens: null, output_tokens: null }),
    ]);
    expect(metrics.retryCount).toBe(2);
    expect(metrics.retryWasteTokens).toBeNull();
  });

  it("does not calculate a baseline percentage from incomplete token data", () => {
    const before = tokenMetricsExport([run({ agent: AgentStage.BACKEND_ENGINEER, input_tokens: 10, output_tokens: 2 })]);
    const after = tokenMetricsExport([run({ agent: AgentStage.BACKEND_ENGINEER, input_tokens: null, output_tokens: null })]);
    expect(compareTokenBaselines(before, after).inputTokenDeltaPct).toBeNull();
  });

  it("reports measured slicing savings per role and leaves incomplete rows unknown", () => {
    const measured = tokenMetricsExport([
      run({ agent: AgentStage.BACKEND_ENGINEER, doc_chars: 600, doc_chars_before: 1_000 }),
    ]);
    expect(measured.roles[0]).toMatchObject({ docChars: 600, docCharsBefore: 1_000, slicingSavedPct: 40 });
    const unknown = tokenMetricsExport([
      run({ agent: AgentStage.BACKEND_ENGINEER, doc_chars: 600, doc_chars_before: null }),
    ]);
    expect(unknown.roles[0].slicingSavedPct).toBeNull();
  });
});
