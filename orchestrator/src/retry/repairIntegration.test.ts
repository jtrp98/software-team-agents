import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AgentExecutor, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

/**
 * T-V8-015 through the real orchestrator: the route is recorded next to the
 * recovery action, and an infrastructure round does not spend a defect retry
 * no matter how often it repeats.
 */

function failingQaReport(): QaReportArtifact {
  return {
    taskId: "T-REPAIR",
    status: "FAIL",
    mode: "FULL",
    requirements: { "AC-1": "FAIL" },
    tests: { passed: 2, failed: 1 },
    evidence: ["vitest — 1 failed"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

function executorWith(qaFailure: StructuredFailure | undefined): AgentExecutor {
  return async (req): Promise<AgentExecutorResult> => {
    if (req.stage !== AgentStage.QA_ENGINEER) return { outcome: { tokens: 1, cost: 0, result: "PASS" } };
    return {
      outcome: { tokens: 1, cost: 0, result: "FAIL" },
      artifactType: ArtifactType.QA_REPORT,
      artifact: failingQaReport(),
      ...(qaFailure ? { failure: qaFailure } : {}),
    };
  };
}

const implementationDefect: StructuredFailure = {
  category: "implementation",
  owner: AgentStage.BACKEND_ENGINEER,
  severity: "medium",
  retryable: true,
  reason: "empty order still throws",
  affected: ["T-REPAIR"],
  requiresHuman: false,
};

const providerOutage: StructuredFailure = {
  category: "infrastructure",
  owner: AgentStage.BACKEND_ENGINEER,
  severity: "high",
  retryable: true,
  reason: "provider returned 429 for the whole round",
  affected: ["T-REPAIR"],
  requiresHuman: false,
};

/** One dev stage, then the QA round that reports the failure. Exactly one QA round, so the budget assertions are exact. */
async function oneQaRound(executor: AgentExecutor) {
  const orchestrator = new Orchestrator("T-REPAIR", classifyTask({ isClearBugFix: true, touchesBackend: true }));
  await orchestrator.step(executor);
  await orchestrator.step(executor);
  return orchestrator;
}

describe("orchestrator records the deterministic repair route", () => {
  it("routes an implementation defect back to its owner as a delta repair", async () => {
    const orchestrator = await oneQaRound(executorWith(implementationDefect));
    expect(orchestrator.repairRoute).toMatchObject({
      kind: "delta-repair",
      owner: AgentStage.BACKEND_ENGINEER,
      consumesDefectRetry: true,
      requiresFullQa: false,
    });
    expect(orchestrator.recovery?.kind).toBe("RETRY");
    expect(orchestrator.retries.qa).toBe(1);
  });

  it("halts a provider outage without consuming the defect retry, however often it repeats", async () => {
    const executor = executorWith(providerOutage);
    const orchestrator = new Orchestrator("T-REPAIR", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    for (let round = 0; round < 4; round++) {
      // dev stage, then the QA round that fails on infrastructure
      await orchestrator.step(executor);
      const status = await orchestrator.step(executor);
      expect(orchestrator.retries.qa).toBe(0);
      if (status.kind === "BLOCKED") break;
    }
    expect(orchestrator.repairRoute).toMatchObject({ kind: "halt-and-resume", consumesDefectRetry: false });
    expect(orchestrator.recovery?.reason).toContain("without consuming a qa defect retry");
    expect(orchestrator.retries.qa).toBe(0);
  });

  it("records no route when the QA round reported no structured failure", async () => {
    const orchestrator = await oneQaRound(executorWith(undefined));
    expect(orchestrator.repairRoute).toBeNull();
    // The pre-existing fallback still applies: back to the implementation stage.
    expect(orchestrator.recovery?.kind).toBe("RETRY");
  });
});
