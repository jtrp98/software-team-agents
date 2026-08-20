import { describe, expect, it } from "vitest";
import { computeAgentQualityScores, formatQualityScoreReport } from "./agentQualityScore.js";
import { RunLog } from "../observability/runLog.js";
import { AgentStage } from "../types.js";

describe("computeAgentQualityScores (T30)", () => {
  it("scores a clean run as 100% first-pass, 100% success, 0% rework", () => {
    const log = new RunLog();
    log.record({
      task_id: "T-1",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 1, result: "PASS" },
    });
    const [score] = computeAgentQualityScores(log.all());
    expect(score).toMatchObject({
      agent: AgentStage.BACKEND_ENGINEER,
      totalTasks: 1,
      successRate: 1,
      firstPassRate: 1,
      reworkRate: 0,
      avgCost: 1,
    });
  });

  it("counts a task that failed then passed as reworked, and as an eventual success, not a first pass", () => {
    const log = new RunLog();
    log.record({
      task_id: "T-1",
      agent: AgentStage.QA_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 0.1, result: "FAIL" },
    });
    log.record({
      task_id: "T-1",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 0, cost: 0.2, result: "PASS" },
    });
    const [score] = computeAgentQualityScores(log.all());
    expect(score.totalTasks).toBe(1);
    expect(score.successRate).toBe(1); // the final run passed
    expect(score.firstPassRate).toBe(0); // it needed a retry
    expect(score.reworkRate).toBe(1);
    expect(score.avgCost).toBeCloseTo(0.15); // mean over both runs, not just the successful one
  });

  it("a task still failing on its most recent run counts against successRate, not for it", () => {
    const log = new RunLog();
    log.record({
      task_id: "T-1",
      agent: AgentStage.SECURITY,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 0.1, result: "FAIL" },
    });
    const [score] = computeAgentQualityScores(log.all());
    expect(score.successRate).toBe(0);
    expect(score.reworkRate).toBe(0); // only one run so far -- not (yet) rework, just not done
  });

  it("scores every agent independently across a mix of tasks", () => {
    const log = new RunLog();
    log.record({ task_id: "T-1", agent: AgentStage.BACKEND_ENGINEER, start_time: 0, end_time: 1, outcome: { tokens: 0, cost: 1, result: "PASS" } });
    log.record({ task_id: "T-2", agent: AgentStage.BACKEND_ENGINEER, start_time: 1, end_time: 2, outcome: { tokens: 0, cost: 1, result: "PASS" } });
    log.record({ task_id: "T-1", agent: AgentStage.QA_ENGINEER, start_time: 2, end_time: 3, outcome: { tokens: 0, cost: 0.5, result: "PASS" } });

    const scores = computeAgentQualityScores(log.all());
    const be = scores.find((s) => s.agent === AgentStage.BACKEND_ENGINEER)!;
    const qa = scores.find((s) => s.agent === AgentStage.QA_ENGINEER)!;
    expect(be.totalTasks).toBe(2);
    expect(qa.totalTasks).toBe(1);
  });

  it("returns an empty array for an empty log, not a divide-by-zero", () => {
    expect(computeAgentQualityScores([])).toEqual([]);
  });
});

describe("formatQualityScoreReport", () => {
  it("matches TASKS.md T30's own example line shape", () => {
    const log = new RunLog();
    log.record({ task_id: "T-1", agent: AgentStage.BUSINESS_ANALYST, start_time: 0, end_time: 1, outcome: { tokens: 0, cost: 0.83, result: "PASS" } });
    const report = formatQualityScoreReport(computeAgentQualityScores(log.all()));
    expect(report).toBe("business-analyst: Success 100%, First-pass 100%, Rework 0%, Avg cost $0.83");
  });

  it("sorts agents alphabetically for a stable, diffable report", () => {
    const log = new RunLog();
    log.record({ task_id: "T-1", agent: AgentStage.QA_ENGINEER, start_time: 0, end_time: 1, outcome: { tokens: 0, cost: 0.1, result: "PASS" } });
    log.record({ task_id: "T-1", agent: AgentStage.BACKEND_ENGINEER, start_time: 1, end_time: 2, outcome: { tokens: 0, cost: 0.1, result: "PASS" } });
    const report = formatQualityScoreReport(computeAgentQualityScores(log.all()));
    const lines = report.split("\n");
    expect(lines[0]).toContain("backend-engineer");
    expect(lines[1]).toContain("qa-engineer");
  });
});
