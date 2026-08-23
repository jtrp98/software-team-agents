import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";
import { buildMetricsExport, compareBaselines, taskQaMetrics } from "./metrics.js";

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
});
