import { describe, expect, it } from "vitest";
import { buildQaScope } from "./scope.js";
import {
  QaModeDowngradeError,
  canCloseWith,
  downgradeMode,
  escalateMode,
  selectQaMode,
} from "./mode.js";

function boundedScope(taskId = "T1") {
  return buildQaScope({ taskId, changedFiles: ["src/a.ts"] });
}
function unboundedScope(taskId = "T1") {
  return buildQaScope({ taskId, changedFiles: [] });
}

describe("selectQaMode", () => {
  it("chooses TARGETED for a bounded scope with no risk signals", () => {
    const d = selectQaMode("T1", boundedScope(), {}, { now: () => 1 });
    expect(d.mode).toBe("TARGETED");
    expect(d.source).toBe("policy");
    expect(d.reasons.some((r) => r.includes("bounded"))).toBe(true);
  });

  it("fails closed to FULL when the scope is unbounded", () => {
    const d = selectQaMode("T1", unboundedScope(), undefined);
    expect(d.mode).toBe("FULL");
    expect(d.reasons.join(" ")).toMatch(/unbounded scope/);
  });

  it.each([
    ["touchesSchema", "schema/architecture"],
    ["changesSharedContract", "shared contract"],
    ["securitySensitive", "security-sensitive"],
    ["migrationOrCutover", "migration/cutover"],
    ["crossTargetImpact", "cross-target"],
    ["releaseGateRequiresFull", "release gate"],
  ] as const)("routes %s to FULL with a recorded reason", (key, label) => {
    const d = selectQaMode("T1", boundedScope(), { [key]: true });
    expect(d.mode).toBe("FULL");
    expect(d.reasons.join(" ")).toContain(label);
  });

  it("is deterministic for identical inputs", () => {
    const a = selectQaMode("T1", boundedScope(), { touchesSchema: true }, { now: () => 42 });
    const b = selectQaMode("T1", boundedScope(), { touchesSchema: true }, { now: () => 42 });
    expect(a).toEqual(b);
  });
});

describe("escalateMode", () => {
  it("widens TARGETED to FULL and keeps the reason trail", () => {
    const base = selectQaMode("T1", boundedScope(), {}, { now: () => 1 });
    const escalated = escalateMode(base, "fix touched files outside previous findings", () => 2);
    expect(escalated.mode).toBe("FULL");
    expect(escalated.source).toBe("escalation");
    expect(escalated.reasons.at(-1)).toMatch(/outside previous findings/);
    expect(escalated.decidedAt).toBe(2);
  });

  it("is a no-op on an already-FULL decision", () => {
    const base = selectQaMode("T1", unboundedScope());
    expect(escalateMode(base, "anything")).toBe(base);
  });
});

describe("downgradeMode", () => {
  it("refuses without an explicit policy", () => {
    const full = selectQaMode("T1", unboundedScope());
    expect(() => downgradeMode(full, { allowDowngrade: false }, "cheaper")).toThrow(QaModeDowngradeError);
  });

  it("refuses to undo an escalation even with policy", () => {
    const base = selectQaMode("T1", boundedScope(), {});
    const escalated = escalateMode(base, "unexpected impact");
    expect(() =>
      downgradeMode(escalated, { allowDowngrade: true }, "policy says ok"),
    ).toThrow(QaModeDowngradeError);
  });

  it("downgrades a policy decision when the policy explicitly allows it", () => {
    const full = selectQaMode("T1", boundedScope(), { releaseGateRequiresFull: true });
    const down = downgradeMode(full, { allowDowngrade: true }, "release gate deferred", () => 7);
    expect(down.mode).toBe("TARGETED");
    expect(down.decidedAt).toBe(7);
    expect(down.reasons.at(-1)).toMatch(/release gate deferred/);
  });
});

describe("canCloseWith", () => {
  it("allows anything when no decision exists (pre-optimization behaviour)", () => {
    expect(canCloseWith(undefined, "TARGETED").allowed).toBe(true);
  });

  it("lets a FULL report close a FULL decision", () => {
    const full = selectQaMode("T1", unboundedScope());
    expect(canCloseWith(full, "FULL").allowed).toBe(true);
  });

  it("blocks a TARGETED report from closing a FULL decision, naming the escape route", () => {
    const full = selectQaMode("T1", unboundedScope());
    const result = canCloseWith(full, "TARGETED");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/re-run qa-engineer in FULL mode/);
  });

  it("lets a TARGETED report close a TARGETED decision", () => {
    const targeted = selectQaMode("T1", boundedScope(), {});
    expect(canCloseWith(targeted, "TARGETED").allowed).toBe(true);
  });
});
