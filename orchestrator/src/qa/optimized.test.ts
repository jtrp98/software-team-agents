import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { withQaOptimization, riskSignalsFromClassification } from "./optimized.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";

function qaReq(overrides: Partial<AgentExecutorRequest> = {}): AgentExecutorRequest {
  return {
    stage: AgentStage.QA_ENGINEER,
    taskId: "T1",
    context: [{ source: ArtifactType.REQUIREMENTS, content: "req doc" }],
    ...overrides,
  };
}

function passThroughResult(): AgentExecutorResult {
  return { outcome: { tokens: 10, cost: 0.01, result: "PASS" } };
}

const passingQaInner: AgentExecutor = (req) => {
  const evidenceItem = req.context.find((c) => c.source === "qa-evidence");
  const artifact: QaReportArtifact = {
    taskId: req.taskId,
    status: "PASS",
    mode: /SCOPE NOT BOUNDED/.test(evidenceItem?.content ?? "") ? "FULL" : "TARGETED",
    requirements: { R1: "PASS" },
    tests: { passed: 3, failed: 0 },
    evidence: ["review.md"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
  return Promise.resolve({
    outcome: { tokens: 10, cost: 0.01, result: "PASS" },
    artifactType: ArtifactType.QA_REPORT,
    artifact,
  });
};

describe("withQaOptimization", () => {
  it("passes non-QA stages through untouched", async () => {
    let innerCalls = 0;
    const inner: AgentExecutor = (req) => {
      innerCalls += 1;
      return { outcome: { tokens: 1, cost: 0, result: "PASS", context_chars: req.context.length } };
    };
    const exec = withQaOptimization({ inner, changedFiles: () => ["a.ts"] });
    await exec(qaReq({ stage: AgentStage.BACKEND_ENGINEER }));
    expect(innerCalls).toBe(1);
  });

  it("injects the bounded evidence package into the QA context", async () => {
    let seen: AgentExecutorRequest | undefined;
    const inner: AgentExecutor = (req) => {
      seen = req;
      return passThroughResult();
    };
    const exec = withQaOptimization({ inner, changedFiles: () => ["src/a.ts"] });
    await exec(qaReq());
    const pkg = seen!.context.find((c) => c.source === "qa-evidence")!;
    expect(pkg.content).toContain("QA evidence package for T1");
    expect(pkg.content).toContain("src/a.ts");
    expect(pkg.content).toContain("TARGETED");
  });

  it("blocks a red deterministic check BEFORE the LLM runs", async () => {
    let innerCalls = 0;
    const inner: AgentExecutor = () => {
      innerCalls += 1;
      return passThroughResult();
    };
    const exec = withQaOptimization({
      inner,
      changedFiles: () => ["src/a.ts"],
      deterministicRunner: (id) =>
        id === "typecheck" ? { id, status: "FAIL", durationMs: 5, outputSummary: "TS2345 in a.ts" } : null,
    });
    const result = await exec(qaReq());
    expect(innerCalls).toBe(0);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("deterministic verification failed before LLM QA");
    expect(result.outcome.failure_reason).toContain("TS2345");
    expect(result.gateEvidence?.qaModeDecision).toBeUndefined();
  });

  it("routes an unresolvable change list to FULL and attaches the decision as gate evidence", async () => {
    const exec = withQaOptimization({
      inner: passingQaInner,
      changedFiles: () => {
        throw new Error("git not a repo");
      },
    });
    const result = await exec(qaReq());
    expect(result.gateEvidence?.qaModeDecision?.mode).toBe("FULL");
    expect(result.gateEvidence?.qaModeDecision?.reasons.join(" ")).toMatch(/unbounded scope/);
  });

  it("escalates a retry whose fix reached outside previous findings to FULL", async () => {
    const exec = withQaOptimization({
      inner: passingQaInner,
      now: () => 7,
      changedFiles: () => ["api/orders.ts", "api/pricing.ts"],
      previousRound: () => ({
        findings: [
          { id: "F1", description: "wrong total", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" },
        ],
        evidence: [],
      }),
    });
    const result = await exec(qaReq({ qaRound: 2 }));
    expect(result.gateEvidence?.qaModeDecision?.mode).toBe("FULL");
    expect(result.gateEvidence?.qaModeDecision?.reasons.join(" ")).toMatch(/cross-target impact/);
  });

  it("keeps TARGETED for a retry confined to previously-seen files", async () => {
    const exec = withQaOptimization({
      inner: passingQaInner,
      changedFiles: () => ["api/orders.ts"],
      previousRound: () => ({
        findings: [
          { id: "F1", description: "wrong total", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" },
        ],
        evidence: [{ id: "E1", kind: "deterministic", files: ["other.ts"], summary: "lint PASS", createdAt: 1 }],
      }),
    });
    const result = await exec(qaReq({ qaRound: 1 }));
    expect(result.gateEvidence?.qaModeDecision?.mode).toBe("TARGETED");
  });

  it("lets caller risk signals force FULL on an otherwise bounded change", async () => {
    const exec = withQaOptimization({
      inner: passingQaInner,
      changedFiles: () => ["src/a.ts"],
      riskSignals: () => ({ securitySensitive: true }),
    });
    const result = await exec(qaReq());
    expect(result.gateEvidence?.qaModeDecision?.mode).toBe("FULL");
    expect(result.gateEvidence?.qaModeDecision?.reasons).toContain("security-sensitive change");
  });
});

describe("riskSignalsFromClassification", () => {
  function classification(partial: Partial<ClassificationResult>): ClassificationResult {
    return {
      level: "SMALL" as ClassificationResult["level"],
      pipeline: [AgentStage.BACKEND_ENGINEER],
      requiresHumanApproval: false,
      sensitiveGate: false,
      reasons: [],
      ...partial,
    };
  }

  it("maps the schema branch deterministically", () => {
    const s = riskSignalsFromClassification(
      classification({
        pipeline: [AgentStage.SYSTEM_ANALYST, AgentStage.QA_ENGINEER],
        requiresHumanApproval: true,
        sensitiveGate: true,
      }),
    );
    expect(s.touchesSchema).toBe(true);
    expect(s.securitySensitive).toBe(true);
    expect(s.migrationOrCutover).toBe(false);
  });

  it("maps production deploy/migration", () => {
    const s = riskSignalsFromClassification(
      classification({ pipeline: [AgentStage.DEVOPS], requiresHumanApproval: true }),
    );
    expect(s.migrationOrCutover).toBe(true);
  });

  it("leaves plain bug-fix tasks without high-risk signals", () => {
    const s = riskSignalsFromClassification(classification({}));
    expect(s.touchesSchema ?? false).toBe(false);
    expect(s.securitySensitive ?? false).toBe(false);
    expect(s.migrationOrCutover ?? false).toBe(false);
  });
});
