import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { withQaOptimization, riskSignalsFromClassification } from "./optimized.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import { runDeterministicVerification } from "./deterministic.js";

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

  it("uses concise production-style evidence references rather than blank placeholders or source diffs", async () => {
    let seen = "";
    const exec = withQaOptimization({
      inner: (req) => {
        seen = req.context.find((item) => item.source === "qa-evidence")!.content;
        return passThroughResult();
      },
      changedFiles: () => ["src/a.ts"],
      packageInputs: () => ({
        taskIntent: "Implement invoice import",
        acceptanceCriteria: ["design.md#DES-002", "contracts/backend-engineer.yaml#outputs"],
        diffSummary: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        knownRisks: ["design.md#Risks-&-Dependencies"],
      }),
      scopeInputs: () => ({ affectedTaskIds: ["BE-004"], affectedPhases: [2] }),
    });
    await exec(qaReq());
    expect(seen).toContain("design.md#DES-002");
    expect(seen).toContain("affected tasks: BE-004");
    expect(seen).not.toContain("(not supplied)");
    expect(seen).not.toContain("(none supplied)");
    expect(seen.split("\n").length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(seen)).toBeLessThan(2_000);
  });

  it("blocks a red deterministic check BEFORE the LLM runs", async () => {
    let innerCalls = 0;
    const inner: AgentExecutor = () => {
      innerCalls += 1;
      return passThroughResult();
    };
    const deterministic = await runDeterministicVerification((id) =>
      id === "typecheck" ? { id, status: "FAIL", durationMs: 5, outputSummary: "TS2345 in a.ts" } : null,
    );
    const exec = withQaOptimization({
      inner,
      changedFiles: () => ["src/a.ts"],
      deterministicVerification: () => deterministic,
    });
    const result = await exec(qaReq());
    expect(innerCalls).toBe(0);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("deterministic verification failed before LLM QA");
    expect(result.outcome.failure_reason).toContain("TS2345");
    expect(result.outcome.deterministic_gate).toBe("enabled");
    expect(result.gateEvidence?.qaModeDecision).toBeUndefined();
  });

  it("records the explicit deterministic-gate escape hatch without manufacturing a check result", async () => {
    const result = await withQaOptimization({
      inner: passingQaInner,
      changedFiles: () => ["src/a.ts"],
      deterministicGate: "disabled",
    })(qaReq());

    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.deterministic_gate).toBe("disabled");
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
        touchesSchema: true,
      }),
    );
    expect(s.touchesSchema).toBe(true);
    expect(s.securitySensitive).toBe(true);
    expect(s.migrationOrCutover).toBe(false);
  });

  it("a new feature that carries the schema signal stays FULL, even though BA now leads the pipeline", () => {
    const s = riskSignalsFromClassification(
      classification({
        pipeline: [AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST, AgentStage.QA_ENGINEER],
        requiresHumanApproval: true,
        sensitiveGate: true,
        touchesSchema: true,
      }),
    );
    expect(s.touchesSchema).toBe(true);
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
