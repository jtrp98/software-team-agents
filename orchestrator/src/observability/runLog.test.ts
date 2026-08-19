import { describe, expect, it } from "vitest";
import { RunLog } from "./runLog.js";
import { AgentStage } from "../types.js";

describe("RunLog", () => {
  it("records every field task-detail.md item 11 requires", () => {
    const log = new RunLog();
    const record = log.record({
      task_id: "TASK-123",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1000,
      end_time: 4500,
      outcome: { tokens: 22000, cost: 0.33, result: "FAIL", retry_count: 1, failure_reason: "REQ-002 not met" },
    });
    expect(record).toEqual({
      task_id: "TASK-123",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1000,
      end_time: 4500,
      duration: 3500,
      tokens: 22000,
      cost: 0.33,
      result: "FAIL",
      retry_count: 1,
      failure_reason: "REQ-002 not met",
    });
  });

  it("defaults retry_count to 0 and failure_reason to null on a PASS", () => {
    const log = new RunLog();
    const record = log.record({
      task_id: "TASK-1",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 100,
      outcome: { tokens: 100, cost: 0.01, result: "PASS" },
    });
    expect(record.retry_count).toBe(0);
    expect(record.failure_reason).toBeNull();
  });

  it("aggregates tokens/cost per task across multiple runs", () => {
    const log = new RunLog();
    log.record({
      task_id: "TASK-123",
      agent: AgentStage.BUSINESS_ANALYST,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 12000, cost: 0.1, result: "PASS" },
    });
    log.record({
      task_id: "TASK-123",
      agent: AgentStage.SYSTEM_ANALYST,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 18000, cost: 0.2, result: "PASS" },
    });
    log.record({
      task_id: "TASK-OTHER",
      agent: AgentStage.QA_ENGINEER,
      start_time: 2,
      end_time: 3,
      outcome: { tokens: 5000, cost: 0.05, result: "PASS" },
    });

    expect(log.totalTokens("TASK-123")).toBe(30000);
    expect(log.runsForTask("TASK-123")).toHaveLength(2);
    expect(log.runsForTask("TASK-OTHER")).toHaveLength(1);
  });

  it("reproduces the TASK-123 example summary format", () => {
    const log = new RunLog();
    const runs: [AgentStage, number, "PASS" | "FAIL"][] = [
      [AgentStage.BUSINESS_ANALYST, 12000, "PASS"],
      [AgentStage.SYSTEM_ANALYST, 18000, "PASS"],
      [AgentStage.BACKEND_ENGINEER, 45000, "PASS"],
      [AgentStage.QA_ENGINEER, 22000, "FAIL"],
      [AgentStage.BACKEND_ENGINEER, 15000, "PASS"],
      [AgentStage.QA_ENGINEER, 20000, "PASS"],
    ];
    let t = 0;
    for (const [agent, tokens, result] of runs) {
      log.record({
        task_id: "TASK-123",
        agent,
        start_time: t,
        end_time: t + 1,
        outcome: { tokens, cost: 0, result },
      });
      t += 1;
    }
    expect(log.totalTokens("TASK-123")).toBe(132000);
    const summary = log.summary("TASK-123");
    expect(summary).toContain("TASK-123");
    expect(summary).toContain("Total: 132k tokens");
    expect(summary).toContain("FAIL");
  });
});
