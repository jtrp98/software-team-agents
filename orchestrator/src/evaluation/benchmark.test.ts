import { describe, expect, it } from "vitest";
import {
  checkConsistency,
  detectRegression,
  formatComparison,
  runBenchmark,
  runBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkResult,
} from "./benchmark.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import type { AgentExecutorResult } from "../orchestrator/orchestrator.js";

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 5 : 3, failed: status === "PASS" ? 0 : 1 },
    evidence: ["log"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

function securityReport(status: "PASS" | "FAIL"): SecurityReportArtifact {
  return {
    taskId: "T",
    overallStatus: status,
    findings: status === "PASS" ? [] : [{ id: "F-1", severity: "HIGH", status: "OPEN", description: "x" }],
  };
}

function makeExecutor(overrides: Partial<Record<AgentStage, (callIndex: number) => AgentExecutorResult>>) {
  const counts: Partial<Record<AgentStage, number>> = {};
  return (req: { stage: AgentStage }) => {
    const idx = counts[req.stage] ?? 0;
    counts[req.stage] = idx + 1;
    const override = overrides[req.stage];
    if (override) return override(idx);
    // Defaults still satisfy the QA_PASS/SECURITY_PASS gates so an unoverridden stage doesn't stall the benchmark.
    if (req.stage === AgentStage.QA_ENGINEER) {
      return {
        outcome: { tokens: 100, cost: 0.01, result: "PASS" as const },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      };
    }
    if (req.stage === AgentStage.SECURITY) {
      return {
        outcome: { tokens: 100, cost: 0.01, result: "PASS" as const },
        artifactType: ArtifactType.SECURITY_REPORT,
        artifact: securityReport("PASS"),
      };
    }
    return { outcome: { tokens: 100, cost: 0.01, result: "PASS" as const } };
  };
}

// Factories, not module-level consts: each executor closure carries its own
// per-stage call counter, so reusing one object across `it` blocks (or across
// cases within the same benchmark run) would leak state between them.
function makeAlwaysPassCase(id = "CASE-PASS"): BenchmarkCase {
  return {
    id,
    classification: { isClearBugFix: true, touchesBackend: true },
    executor: makeExecutor({}),
  };
}

function makeAlwaysFailQaCase(id = "CASE-FAIL"): BenchmarkCase {
  return {
    id,
    classification: { isClearBugFix: true, touchesBackend: true },
    executor: makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("FAIL"),
      }),
    }),
  };
}

function makeSecurityRetryThenPassCase(id = "CASE-SECURITY"): BenchmarkCase {
  return {
    id,
    classification: { touchesSchema: true, touchesBackend: true },
    executor: makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: {
          taskId: "T",
          feasibility: "ok",
          dataModel: [],
          risks: [],
          openQuestions: [],
          contract: ["x"],
        },
      }),
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("PASS"),
      }),
      [AgentStage.SECURITY]: (idx) => ({
        outcome: { tokens: 100, cost: 0.01, result: idx === 0 ? "FAIL" : "PASS" },
        artifactType: ArtifactType.SECURITY_REPORT,
        artifact: securityReport(idx === 0 ? "FAIL" : "PASS"),
      }),
    }),
  };
}

describe("runBenchmarkCase", () => {
  it("reports DEPLOYED for a passing case", async () => {
    const result = await runBenchmarkCase(makeAlwaysPassCase());
    expect(result.status).toBe("DEPLOYED");
    expect(result.tokens).toBeGreaterThan(0);
  });

  it("reports BLOCKED for a case that exhausts QA retries", async () => {
    const result = await runBenchmarkCase(makeAlwaysFailQaCase());
    expect(result.status).toBe("BLOCKED");
  });

  it("tracks hasSecurityStage and securityFailedAtLeastOnce independently", async () => {
    const result = await runBenchmarkCase(makeSecurityRetryThenPassCase());
    expect(result.status).toBe("DEPLOYED");
    expect(result.hasSecurityStage).toBe(true);
    expect(result.securityFailedAtLeastOnce).toBe(true);

    const noSecurity = await runBenchmarkCase(makeAlwaysPassCase());
    expect(noSecurity.hasSecurityStage).toBe(false);
  });
});

describe("runBenchmark", () => {
  it("computes a correctness (success) rate across mixed cases", async () => {
    const result = await runBenchmark([makeAlwaysPassCase("A"), makeAlwaysFailQaCase("B")]);
    expect(result.size).toBe(2);
    expect(result.successRate).toBe(0.5);
  });

  it("computes securityFailureRate only over security-gated cases", async () => {
    const result = await runBenchmark([makeAlwaysPassCase("A"), makeSecurityRetryThenPassCase("B")]);
    expect(result.securityFailureRate).toBe(1); // the one security-gated case failed once before passing
  });
});

describe("checkConsistency", () => {
  it("scores a deterministic case as fully consistent", async () => {
    const consistency = await checkConsistency([makeAlwaysPassCase()], 3);
    expect(consistency).toBe(1);
  });
});

describe("detectRegression", () => {
  const baseline: BenchmarkResult = {
    size: 100,
    successRate: 0.8,
    totalTokens: 0,
    totalCost: 0,
    totalDurationMs: 0,
    securityFailureRate: 0,
    caseResults: [],
  };

  it("flags a drop in success rate as a regression", () => {
    const candidate = { ...baseline, successRate: 0.6 };
    const result = detectRegression(baseline, candidate);
    expect(result.regressed).toBe(true);
    expect(result.successRateDelta).toBeCloseTo(-0.2);
  });

  it("does not flag an improvement as a regression", () => {
    const candidate = { ...baseline, successRate: 0.9 };
    const result = detectRegression(baseline, candidate);
    expect(result.regressed).toBe(false);
    expect(result.successRateDelta).toBeCloseTo(0.1);
  });
});

describe("formatComparison", () => {
  it("matches task-detail.md item 16's example shape", () => {
    const baseline: BenchmarkResult = { size: 100, successRate: 0.72, totalTokens: 0, totalCost: 0, totalDurationMs: 0, securityFailureRate: 0, caseResults: [] };
    const afterChange1: BenchmarkResult = { ...baseline, successRate: 0.81 };
    const text = formatComparison({ baseline, after_change_1: afterChange1 });
    expect(text).toContain("benchmark_size: 100 tasks");
    expect(text).toContain("baseline: { success_rate: 72% }");
    expect(text).toContain("after_change_1: { success_rate: 81% }");
  });
});
