import { describe, expect, it } from "vitest";
import {
  ProposalStateError,
  analyzeFailurePatterns,
  applyAndReevaluate,
  decideProposal,
  evaluateAndFindPatterns,
  markApplied,
  proposeImprovement,
} from "./selfImprovementLoop.js";
import type { BenchmarkCase, BenchmarkResult } from "../evaluation/benchmark.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
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

function makeCase(id: string, qaAlwaysFails: boolean): BenchmarkCase {
  const counts: Partial<Record<AgentStage, number>> = {};
  const executor = (req: { stage: AgentStage }): AgentExecutorResult => {
    const idx = counts[req.stage] ?? 0;
    counts[req.stage] = idx + 1;
    if (req.stage === AgentStage.QA_ENGINEER) {
      const status = qaAlwaysFails ? "FAIL" : "PASS";
      return {
        outcome: { tokens: 100, cost: 0.01, result: status },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport(status),
      };
    }
    return { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };
  };
  return { id, classification: { isClearBugFix: true, touchesBackend: true }, executor };
}

describe("analyzeFailurePatterns", () => {
  it("groups BLOCKED cases by their blockedReason", () => {
    const result: BenchmarkResult = {
      size: 3,
      successRate: 1 / 3,
      totalTokens: 0,
      totalCost: 0,
      totalDurationMs: 0,
      securityFailureRate: 0,
      caseResults: [
        { id: "A", status: "BLOCKED", blockedReason: "qa retry limit (3) exceeded", hasSecurityStage: false, securityFailedAtLeastOnce: false, tokens: 0, cost: 0, durationMs: 0 },
        { id: "B", status: "BLOCKED", blockedReason: "qa retry limit (3) exceeded", hasSecurityStage: false, securityFailedAtLeastOnce: false, tokens: 0, cost: 0, durationMs: 0 },
        { id: "C", status: "DEPLOYED", hasSecurityStage: false, securityFailedAtLeastOnce: false, tokens: 0, cost: 0, durationMs: 0 },
      ],
    };
    const patterns = analyzeFailurePatterns(result);
    expect(patterns).toEqual([{ reason: "qa retry limit (3) exceeded", count: 2, caseIds: ["A", "B"] }]);
  });
});

describe("ImprovementProposal state machine", () => {
  it("requires PROPOSED before it can be decided, and APPROVED before it can be applied", () => {
    const pattern = { reason: "qa retry limit (3) exceeded", count: 1, caseIds: ["A"] };
    const proposal = proposeImprovement(pattern, "IMP-1", "loosen the acceptance criteria wording check");
    expect(proposal.status).toBe("PROPOSED");

    expect(() => markApplied(proposal)).toThrow(ProposalStateError); // can't skip approval

    const approved = decideProposal(proposal, true);
    expect(approved.status).toBe("APPROVED");

    expect(() => decideProposal(approved, true)).toThrow(ProposalStateError); // can't re-decide

    const applied = markApplied(approved);
    expect(applied.status).toBe("APPLIED");
  });

  it("a rejected proposal can never be applied", () => {
    const pattern = { reason: "x", count: 1, caseIds: ["A"] };
    const proposal = proposeImprovement(pattern, "IMP-2", "y");
    const rejected = decideProposal(proposal, false);
    expect(rejected.status).toBe("REJECTED");
    expect(() => markApplied(rejected)).toThrow(ProposalStateError);
  });
});

describe("the full loop", () => {
  it("runs Results -> Evaluation -> Failure Patterns -> Proposal -> Human Approval -> Apply -> Evaluation again", async () => {
    // Before: one case that always fails QA (BLOCKED), one that always passes.
    const before = await evaluateAndFindPatterns([makeCase("A", true), makeCase("B", false)]);
    expect(before.before.successRate).toBe(0.5);
    expect(before.patterns).toHaveLength(1);
    expect(before.patterns[0].caseIds).toEqual(["A"]);

    const proposal = proposeImprovement(before.patterns[0], "IMP-1", "fix whatever made case A's QA always fail");
    const approved = decideProposal(proposal, true); // a human approves it
    const applied = markApplied(approved);

    // "Update Rules/Skills" happened outside this system; here we simulate the
    // fix by re-running with case A's QA now passing, proving the loop's
    // re-evaluation step actually measures improvement, not just repeats the same run.
    const after = await applyAndReevaluate(before, [applied], [makeCase("A", false), makeCase("B", false)]);
    expect(after.after?.successRate).toBe(1);
    expect(after.regressed).toBe(false);
  });

  it("refuses to re-evaluate with a proposal that was never applied", async () => {
    const cycle = await evaluateAndFindPatterns([makeCase("A", true)]);
    const proposal = proposeImprovement(cycle.patterns[0], "IMP-3", "z");
    const approvedButNotApplied = decideProposal(proposal, true);
    await expect(applyAndReevaluate(cycle, [approvedButNotApplied], [makeCase("A", false)])).rejects.toThrow(
      ProposalStateError,
    );
  });

  it("flags a regression if the re-run actually did worse", async () => {
    const cycle = await evaluateAndFindPatterns([makeCase("A", false), makeCase("B", false)]); // 100% success
    const pattern = { reason: "none", count: 0, caseIds: [] };
    const proposal = markApplied(decideProposal(proposeImprovement(pattern, "IMP-4", "risky change"), true));
    // simulate the "fix" actually breaking something
    const after = await applyAndReevaluate(cycle, [proposal], [makeCase("A", true), makeCase("B", false)]);
    expect(after.regressed).toBe(true);
  });
});
