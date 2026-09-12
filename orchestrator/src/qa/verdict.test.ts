import { describe, expect, it } from "vitest";
import { QaReportArtifactSchema, type QaReportArtifact } from "../artifacts/schemas.js";
import { selectQaMode, escalateMode } from "./mode.js";
import { buildQaScope } from "./scope.js";
import { BARE_PASS_REASON, checkQaVerdictCoverage, describeQaVerdictCoverage } from "./verdict.js";

function report(overrides: Partial<QaReportArtifact> = {}): QaReportArtifact {
  return {
    taskId: "BE-004",
    status: "PASS",
    mode: "TARGETED",
    requirements: { "BE-004": "PASS", "AC-007.2": "PASS", "DES-011": "PASS" },
    tests: { passed: 3, failed: 0 },
    evidence: ["vitest src/orders — 3 passed"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
    ...overrides,
  };
}

const REQUIRED = ["BE-004", "AC-007.2", "DES-011"];
const targeted = selectQaMode("BE-004", buildQaScope({ taskId: "BE-004", changedFiles: ["src/orders/summary.ts"] }));
const full = selectQaMode("BE-004", buildQaScope({ taskId: "BE-004", changedFiles: [] }));

describe("checkQaVerdictCoverage", () => {
  it("accepts a PASS that maps every required id", () => {
    const coverage = checkQaVerdictCoverage({ report: report(), required: REQUIRED, decision: targeted });
    expect(coverage.ok).toBe(true);
    expect(coverage.uncovered).toEqual([]);
    expect(describeQaVerdictCoverage(coverage)).toBe("verdict coverage 3/3");
  });

  it("rejects a bare PASS that maps nothing at all", () => {
    const coverage = checkQaVerdictCoverage({ report: report({ requirements: {} }), required: REQUIRED });
    expect(coverage.ok).toBe(false);
    expect(coverage.problems[0]).toContain(BARE_PASS_REASON);
    expect(coverage.problems[0]).toContain("BE-004, AC-007.2, DES-011");
  });

  it("rejects a PASS that silently leaves a required acceptance criterion unmapped", () => {
    const coverage = checkQaVerdictCoverage({
      report: report({ requirements: { "BE-004": "PASS", "DES-011": "PASS" } }),
      required: REQUIRED,
    });
    expect(coverage.ok).toBe(false);
    expect(coverage.uncovered).toEqual(["AC-007.2"]);
    expect(coverage.problems.join(" ")).toContain("PASS does not cover 1 required id(s): AC-007.2");
  });

  it("accepts the same gap when it is declared as Unverified Behaviour instead of claimed", () => {
    const coverage = checkQaVerdictCoverage({
      report: report({
        requirements: { "BE-004": "PASS", "DES-011": "PASS" },
        hasAutomatedTests: false,
        tests: { passed: 0, failed: 0 },
        unverifiedBehaviour: ["AC-007.2 — read, not executed: no suite covers the empty-order path"],
      }),
      required: REQUIRED,
    });
    expect(coverage.ok).toBe(true);
    expect(coverage.uncovered).toEqual(["AC-007.2"]);
  });

  it("does not block a FAIL for incomplete coverage — a failed round is allowed to stop early", () => {
    const coverage = checkQaVerdictCoverage({
      report: report({ status: "FAIL", requirements: { "AC-007.2": "FAIL" }, tests: { passed: 2, failed: 1 } }),
      required: REQUIRED,
    });
    expect(coverage.ok).toBe(true);
    expect(coverage.uncovered).toEqual(["BE-004", "DES-011"]);
  });

  it("records ids the round verdicted beyond what was required without treating them as problems", () => {
    const coverage = checkQaVerdictCoverage({
      report: report({ requirements: { ...report().requirements, "AC-009.1": "PASS" } }),
      required: REQUIRED,
    });
    expect(coverage.ok).toBe(true);
    expect(coverage.extra).toEqual(["AC-009.1"]);
  });

  it("refuses to let a TARGETED report close a round whose decision is FULL", () => {
    const coverage = checkQaVerdictCoverage({ report: report({ mode: "TARGETED" }), required: REQUIRED, decision: full });
    expect(coverage.ok).toBe(false);
    expect(coverage.problems.join(" ")).toContain("re-run qa-engineer in FULL mode");
  });

  it("refuses the same for a decision escalated to FULL mid-round", () => {
    const escalated = escalateMode(targeted, "fix touched files outside every finding");
    const coverage = checkQaVerdictCoverage({ report: report({ mode: "TARGETED" }), required: REQUIRED, decision: escalated });
    expect(coverage.ok).toBe(false);
  });

  it("holds a FULL report to full coverage as well — FULL is not a shortcut past the mapping", () => {
    const coverage = checkQaVerdictCoverage({
      report: report({ mode: "FULL", requirements: { "BE-004": "PASS" } }),
      required: REQUIRED,
      decision: full,
    });
    expect(coverage.ok).toBe(false);
    expect(coverage.uncovered).toEqual(["AC-007.2", "DES-011"]);
  });

  it("is a no-op when the round has no contract-derived requirement set", () => {
    const coverage = checkQaVerdictCoverage({ report: report({ requirements: {} }), required: [] });
    expect(coverage.ok).toBe(true);
  });
});

describe("QaReportArtifactSchema no-bare-PASS floor", () => {
  it("refuses a PASS with no requirement verdict at all", () => {
    const parsed = QaReportArtifactSchema.safeParse(report({ requirements: {} }));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("at least one requirement verdict");
  });

  it("still accepts a FAIL with no requirement verdict", () => {
    expect(
      QaReportArtifactSchema.safeParse(report({ status: "FAIL", requirements: {}, tests: { passed: 0, failed: 1 } }))
        .success,
    ).toBe(true);
  });
});
