import { describe, expect, it } from "vitest";
import { TaskLevel } from "../types.js";
import { selectQaMode } from "./mode.js";
import { buildQaScope } from "./scope.js";
import { selectQaEffort } from "./riskGate.js";

describe("T-V3R-060 QaEffort decision matrix", () => {
  const scope = buildQaScope({ taskId: "T", changedFiles: ["src/a.ts"] });

  it.each([
    [TaskLevel.TRIVIAL, {}, "lightweight", "TARGETED"],
    [TaskLevel.SMALL, {}, "lightweight", "TARGETED"],
    [TaskLevel.MEDIUM, {}, "lightweight", "TARGETED"],
    [TaskLevel.LARGE_CRITICAL, {}, "full", "TARGETED"],
    [TaskLevel.UNKNOWN, {}, "full", "TARGETED"],
    [TaskLevel.SMALL, { changesSharedContract: true }, "full", "FULL"],
    [TaskLevel.SMALL, { migrationOrCutover: true }, "full", "FULL"],
    [TaskLevel.SMALL, { crossTargetImpact: true }, "full", "FULL"],
    [TaskLevel.SMALL, { releaseGateRequiresFull: true }, "full", "FULL"],
  ] as const)("%s with %j -> (%s, %s)", (level, signals, effort, mode) => {
    expect(selectQaEffort(level, signals).effort).toBe(effort);
    expect(selectQaMode("T", scope, signals, { now: () => 1 }).mode).toBe(mode);
  });

  it("sensitiveGate is a hard veto: its mapped risk signal selects full effort", () => {
    expect(selectQaEffort(TaskLevel.SMALL, { securitySensitive: true })).toEqual({
      effort: "full",
      reasons: ["sensitive gate"],
    });
  });

  it("touchesSchema is a hard veto and selects full effort", () => {
    expect(selectQaEffort(TaskLevel.SMALL, { touchesSchema: true })).toEqual({
      effort: "full",
      reasons: ["schema/architecture change"],
    });
  });

  it("is deterministic for identical signals", () => {
    const signals = { changesSharedContract: true, crossTargetImpact: true };
    expect(selectQaEffort(TaskLevel.MEDIUM, signals)).toEqual(
      selectQaEffort(TaskLevel.MEDIUM, signals),
    );
  });
});
