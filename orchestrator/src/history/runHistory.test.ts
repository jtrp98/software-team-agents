import { describe, expect, it } from "vitest";
import { RunHistory } from "./runHistory.js";
import { RunLog } from "../observability/runLog.js";
import { Orchestrator, type AgentExecutor } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 5 : 3, failed: status === "PASS" ? 0 : 2 },
    evidence: ["log"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

describe("RunHistory", () => {
  it("answers all four item-15 questions across two attempts of the same task", () => {
    const history = new RunHistory();

    // Attempt 1: exhausts QA retries and gets BLOCKED.
    const attempt1 = new RunLog();
    attempt1.record({
      task_id: "TASK-9",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 1000, cost: 0.1, result: "PASS" },
    });
    attempt1.record({
      task_id: "TASK-9",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 500, cost: 0.05, result: "FAIL", retry_count: 1, failure_reason: "REQ-001 not met" },
    });
    history.record("TASK-9", attempt1);

    // Attempt 2 (after a human fix): passes.
    const attempt2 = new RunLog();
    attempt2.record({
      task_id: "TASK-9",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 800, cost: 0.08, result: "PASS" },
    });
    attempt2.record({
      task_id: "TASK-9",
      agent: AgentStage.QA_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: { tokens: 400, cost: 0.04, result: "PASS" },
    });
    history.record("TASK-9", attempt2);

    expect(history.attemptCount("TASK-9")).toBe(2);
    expect(history.failedAgents("TASK-9")).toEqual([AgentStage.QA_ENGINEER]); // agent ไหน fail?
    expect(history.failureReasons("TASK-9")).toEqual(["REQ-001 not met"]); // ทำไม fail?
    expect(history.retryRoundsUsed("TASK-9")).toBe(1); // แก้ไปกี่รอบ?
    expect(history.totalTokens("TASK-9")).toBe(2700); // token ไปเท่าไหร่?

    const summary = history.summary("TASK-9");
    expect(summary).toContain("Run #1");
    expect(summary).toContain("Run #2");
  });

  it("tasks that never fail have empty failedAgents/failureReasons and zero retry rounds", () => {
    const history = new RunHistory();
    const log = new RunLog();
    log.record({
      task_id: "TASK-CLEAN",
      agent: AgentStage.FRONTEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: { tokens: 200, cost: 0.02, result: "PASS" },
    });
    history.record("TASK-CLEAN", log);

    expect(history.failedAgents("TASK-CLEAN")).toEqual([]);
    expect(history.failureReasons("TASK-CLEAN")).toEqual([]);
    expect(history.retryRoundsUsed("TASK-CLEAN")).toBe(0);
  });

  it("plugs directly into a real Orchestrator run as one attempt", async () => {
    const history = new RunHistory();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("TASK-LIVE", classification);
    const executor: AgentExecutor = (req) => {
      if (req.stage === AgentStage.QA_ENGINEER) {
        return {
          outcome: { tokens: 500, cost: 0.05, result: "FAIL" },
          artifactType: ArtifactType.QA_REPORT,
          artifact: qaReport("FAIL"),
        };
      }
      return { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };
    };

    // one QA failure, then give up on this attempt (simulating an escalation to a human)
    await orch.step(executor);
    await orch.step(executor);
    history.record("TASK-LIVE", orch.runLog);

    expect(history.attemptCount("TASK-LIVE")).toBe(1);
    expect(history.failedAgents("TASK-LIVE")).toEqual([AgentStage.QA_ENGINEER]);
    expect(history.totalTokens("TASK-LIVE")).toBeGreaterThan(0);
  });
});
