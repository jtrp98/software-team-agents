import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult, PersistedVerificationRef } from "../orchestrator/orchestrator.js";
import type { DeterministicVerification } from "../qa/deterministic.js";

/**
 * Test-only: the evidence a real composition attaches to a successful stage
 * (V13 TASK-003 requires it before a stage completes). Production never
 * composes this — its evidence comes from `qa/verificationHook.ts` and the
 * QA/security agents' own reports.
 */
export const PASSING_VERIFICATION: DeterministicVerification = {
  required: ["typecheck"],
  ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "ok" }],
  failures: [],
  skipped: [],
  missingRequired: [],
  status: "passed",
  enforcement: "enforce",
  passed: true,
};

export function passingQaReport(taskId: string): QaReportArtifact {
  return {
    taskId,
    status: "PASS",
    mode: "FULL",
    requirements: { [taskId]: "PASS" },
    tests: { passed: 1, failed: 0 },
    evidence: ["deterministic sweep green"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

export function passingSecurityReport(taskId: string): SecurityReportArtifact {
  return { taskId, overallStatus: "PASS", findings: [] };
}

/**
 * Fills in the required evidence a successful stage result omitted: a passing
 * post-Dev sweep for a code-producing stage, a PASS report for QA/security.
 * A FAIL result, or one that already carries the evidence, is returned as is —
 * so a test that means "this stage produced no evidence" must not use this.
 */
export function withRequiredEvidence(req: Pick<AgentExecutorRequest, "stage" | "taskId">, result: AgentExecutorResult): AgentExecutorResult {
  if (result.outcome.result === "FAIL") return result;
  if (
    (req.stage === AgentStage.BACKEND_ENGINEER || req.stage === AgentStage.FRONTEND_ENGINEER) &&
    result.deterministicVerification === undefined
  ) {
    return { ...result, deterministicVerification: PASSING_VERIFICATION };
  }
  if (req.stage === AgentStage.QA_ENGINEER && result.artifact === undefined) {
    return { ...result, artifactType: ArtifactType.QA_REPORT, artifact: passingQaReport(req.taskId) };
  }
  if (req.stage === AgentStage.SECURITY && result.artifact === undefined) {
    return { ...result, artifactType: ArtifactType.SECURITY_REPORT, artifact: passingSecurityReport(req.taskId) };
  }
  return result;
}

/** Wraps an executor so every successful stage carries its required evidence (see `withRequiredEvidence`). */
export function withStageEvidence(inner: AgentExecutor): AgentExecutor {
  return async (req) => withRequiredEvidence(req, await inner(req));
}

/** A persisted-sweep reference as STA hands it to a QA round (the id is a fixture; no store backs it). */
export function persistedSweep(verification: DeterministicVerification = PASSING_VERIFICATION): PersistedVerificationRef {
  return { evidenceId: `evd_${"0".repeat(32)}`, verification };
}
