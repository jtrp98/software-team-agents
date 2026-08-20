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
      model: null,
      promptVersion: null,
      tokens: 22000,
      cost: 0.33,
      result: "FAIL",
      retry_count: 1,
      failure_reason: "REQ-002 not met",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      context_chars: null,
    });
  });

  it("records model and the T28 token/context breakdown when the executor reports them", () => {
    const log = new RunLog();
    const record = log.record({
      task_id: "TASK-1",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 10,
      outcome: {
        model: "sonnet",
        tokens: 5000,
        cost: 0.02,
        result: "PASS",
        input_tokens: 4000,
        output_tokens: 1000,
        cache_read_tokens: 2500,
        context_chars: 18000,
      },
    });
    expect(record.model).toBe("sonnet");
    expect(record.input_tokens).toBe(4000);
    expect(record.output_tokens).toBe(1000);
    expect(record.cache_read_tokens).toBe(2500);
    expect(record.context_chars).toBe(18000);
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

  it("costSummary renders TASKS.md T27's own per-agent + total format", () => {
    const log = new RunLog();
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.BUSINESS_ANALYST,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 0.2, result: "PASS" },
    });
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 0, cost: 1.2, result: "PASS" },
    });
    expect(log.costSummary("TASK-1")).toBe("business-analyst: $0.20, backend-engineer: $1.20, Total: $1.40");
  });

  it("costSummary combines multiple runs by the same agent (a retry round) into one line, not one per run", () => {
    const log = new RunLog();
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.QA_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 0.1, result: "FAIL" },
    });
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 0, cost: 0.15, result: "PASS" },
    });
    expect(log.costSummary("TASK-1")).toBe("qa-engineer: $0.25, Total: $0.25");
  });

  it("costSummaryAcrossTasks aggregates cost for a feature spanning several tasks", () => {
    const log = new RunLog();
    log.record({
      task_id: "TASK-1",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 0, cost: 1, result: "PASS" },
    });
    log.record({
      task_id: "TASK-2",
      agent: AgentStage.FRONTEND_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 0, cost: 2, result: "PASS" },
    });
    expect(log.costSummaryAcrossTasks(["TASK-1", "TASK-2"])).toBe("backend-engineer: $1.00, frontend-engineer: $2.00, Total: $3.00");
  });
});
