import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assessContextBudget, contextBudgetRejections, emptyContextBudgetComposition, estimateInputTokens, formatBudgetRejection, resolveContextBudget } from "./contextBudget.js";
import { RunLog } from "../observability/runLog.js";
import { AgentStage } from "../types.js";
import { taskTokenBudgetRejection } from "./contextBudget.js";

describe("T-V3TOK-100 context budget model", () => {
  it("requires every priority class to account exactly for the assembled prompt", () => {
    const composition = emptyContextBudgetComposition();
    composition.base = 4;
    composition.task = 3;
    composition.safety = 2;
    composition.docs = 5;
    composition.knowledge = 7;
    composition.code = 11;
    composition.tool_output = 13;
    composition.reserve = 17;
    expect(assessContextBudget(62, composition, { chars: 100, source: "role" })).toMatchObject({ warning: false, overflowChars: 0 });
    expect(() => assessContextBudget(61, composition, { chars: 100, source: "role" })).toThrow(/invariant failed/);
  });

  it("prefers the role configuration and otherwise uses only a configured model window", () => {
    const config = {
      schema_version: 1 as const,
      context_budget: { roles: { "qa-engineer": 900 }, model_context_windows: { opus: 1_000 } },
    };
    expect(resolveContextBudget(config, "qa-engineer", "opus")).toEqual({ chars: 900, source: "role" });
    expect(resolveContextBudget(config, "security", "opus")).toEqual({ chars: 1_000, source: "model_context_window" });
    expect(resolveContextBudget({ schema_version: 1 }, "security", "opus")).toBeNull();
  });

  it("estimates tokens deterministically while retaining character thresholds", () => {
    const composition = emptyContextBudgetComposition();
    composition.base = 9;
    const assessment = assessContextBudget(9, composition, { chars: 10, source: "role", estimatedTokens: 2 });
    expect(estimateInputTokens(9)).toBe(3);
    expect(assessment).toMatchObject({ contextChars: 9, estimatedInputTokens: 3, budgetChars: 10, budgetEstimatedTokens: 2, overflowEstimatedTokens: 1, warning: true });
    expect(resolveContextBudget({ schema_version: 1, context_budget: { roles: { "qa-engineer": 100 } } }, "qa-engineer", "opus")).toEqual({ chars: 100, source: "role" });
    expect(resolveContextBudget({ schema_version: 1, context_budget: { max_context_estimated_tokens: 2 } }, "qa-engineer", "opus")).toEqual({ estimatedTokens: 2 });
  });

  it("makes exactly-at-threshold and under-threshold prompts admissible in both modes", () => {
    const composition = emptyContextBudgetComposition();
    composition.base = 10;
    expect(assessContextBudget(10, composition, { chars: 10, source: "role" }, "reject")).toMatchObject({ warning: false, rejected: false, mode: "reject" });
    expect(assessContextBudget(10, composition, { chars: 9, source: "role" }, "warn")).toMatchObject({ warning: true, rejected: false, mode: "warn" });
    expect(assessContextBudget(10, composition, { chars: 9, source: "role" }, "reject")).toMatchObject({ warning: true, rejected: true, mode: "reject" });
  });

  it("T-V4-COST-003 serializes each structured context rejection and derives its message", () => {
    const composition = emptyContextBudgetComposition();
    composition.base = 12;
    const assessment = assessContextBudget(12, composition, { chars: 10, source: "role", estimatedTokens: 2 }, "reject");
    const rejections = contextBudgetRejections(assessment, {
      taskId: "T-COST", role: "backend-engineer", stage: "backend-engineer", runtime: "claude-code", model: "sonnet",
    });
    expect(rejections.map((rejection) => rejection.budgetType)).toEqual(["context_chars", "estimated_tokens"]);
    for (const rejection of rejections) {
      expect(JSON.parse(JSON.stringify(rejection))).toEqual(rejection);
      expect(formatBudgetRejection(rejection)).toContain(`${rejection.measuredValue} > ${rejection.configuredLimit}`);
      expect(formatBudgetRejection(rejection)).toContain(rejection.reason);
    }
  });

  it("T-V4-COST-004 projects prior task tokens through checkBudget at the exact threshold", () => {
    const log = new RunLog();
    log.record({ task_id: "T-PROJECT", agent: AgentStage.BACKEND_ENGINEER, start_time: 0, end_time: 1, outcome: { tokens: 6, cost: 0, result: "PASS" } });
    const scope = { taskId: "T-PROJECT", role: "backend-engineer", stage: "backend-engineer", runtime: "claude-code", model: "sonnet" };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-budget-"));
    fs.mkdirSync(path.join(root, ".sta"));
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), "schema_version: 1\ntoken_budget: 10\n", "utf8");
    expect(taskTokenBudgetRejection(root, log, "T-PROJECT", 4, scope)).toBeNull();
    const rejection = taskTokenBudgetRejection(root, log, "T-PROJECT", 5, scope);
    expect(rejection).toMatchObject({ budgetType: "task_tokens", configuredLimit: 10, measuredValue: 11, overflow: 1 });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
