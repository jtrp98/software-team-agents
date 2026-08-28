import { describe, expect, it } from "vitest";
import { assessContextBudget, emptyContextBudgetComposition, resolveContextBudget } from "./contextBudget.js";

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
});
