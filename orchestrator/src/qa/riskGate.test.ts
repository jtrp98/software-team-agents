import { describe, expect, it } from "vitest";
import { TaskLevel } from "../types.js";
import { selectQaMode } from "./mode.js";
import { buildQaScope } from "./scope.js";
import { selectQaEffort } from "./riskGate.js";

describe("T-V3R-060 QaEffort decision matrix", () => {
  const scope = buildQaScope({ taskId: "T", changedFiles: ["src/a.ts"] });

  it.each([
    [TaskLevel.TRIVIAL, {}, true, "skip", "TARGETED"],
    [TaskLevel.SMALL, {}, true, "skip", "TARGETED"],
    [TaskLevel.SMALL, {}, false, "lightweight", "TARGETED"],
    [TaskLevel.MEDIUM, {}, true, "lightweight", "TARGETED"],
    [TaskLevel.LARGE_CRITICAL, {}, true, "full", "TARGETED"],
    [TaskLevel.UNKNOWN, {}, true, "full", "TARGETED"],
    [TaskLevel.SMALL, { changesSharedContract: true }, true, "full", "FULL"],
    [TaskLevel.SMALL, { migrationOrCutover: true }, true, "full", "FULL"],
    [TaskLevel.SMALL, { crossTargetImpact: true }, true, "full", "FULL"],
    [TaskLevel.SMALL, { releaseGateRequiresFull: true }, true, "full", "FULL"],
  ] as const)("%s with %j and allowSkip=%s -> (%s, %s)", (level, signals, allowSkip, effort, mode) => {
    expect(selectQaEffort(level, signals, { allowSkip }).effort).toBe(effort);
    expect(selectQaMode("T", scope, signals, { now: () => 1 }).mode).toBe(mode);
  });

  it("sensitiveGate is a hard veto: its mapped risk signal can never select skip", () => {
    expect(selectQaEffort(TaskLevel.SMALL, { securitySensitive: true }, { allowSkip: true })).toEqual({
      effort: "full",
      reasons: ["sensitive gate"],
    });
  });

  it("touchesSchema is a hard veto and can never select skip", () => {
    expect(selectQaEffort(TaskLevel.SMALL, { touchesSchema: true }, { allowSkip: true })).toEqual({
      effort: "full",
      reasons: ["schema/architecture change"],
    });
  });

  it("is deterministic for identical signals", () => {
    const signals = { changesSharedContract: true, crossTargetImpact: true };
    expect(selectQaEffort(TaskLevel.MEDIUM, signals, { allowSkip: true })).toEqual(
      selectQaEffort(TaskLevel.MEDIUM, signals, { allowSkip: true }),
    );
  });
});
