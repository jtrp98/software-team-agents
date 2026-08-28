import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { Permission } from "../agents/permissions.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import {
  REVIEWER_STAGES,
  SelfReviewError,
  VERDICT_ARTIFACTS,
  assertIndependentVerdict,
  checkReviewSeparation,
  isReviewer,
  reviewCoverage,
  reviewedStages,
  reviewersFor,
} from "./reviewSeparation.js";

describe("review separation, as a property of the roster (T39)", () => {
  it("holds for this repo — nothing can review its own work", () => {
    const result = checkReviewSeparation();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names qa-engineer and security as the reviewers, and nobody else", () => {
    expect([...REVIEWER_STAGES].sort()).toEqual([AgentStage.QA_ENGINEER, AgentStage.SECURITY].sort());
    expect(isReviewer(AgentStage.BACKEND_ENGINEER)).toBe(false);
  });

  it("keeps every reviewer out of WRITE_CODE — the permission, not just the artifact list", () => {
    for (const reviewer of REVIEWER_STAGES) {
      expect(AGENT_REGISTRY[reviewer].permissions).not.toContain(Permission.WRITE_CODE);
    }
  });

  it("lets no reviewer produce anything a stage it reviews also produces", () => {
    for (const reviewed of reviewedStages()) {
      for (const reviewer of reviewersFor(reviewed)) {
        const overlap = AGENT_REGISTRY[reviewer].outputs.filter((o) =>
          AGENT_REGISTRY[reviewed].outputs.includes(o),
        );
        expect(overlap, `${reviewer} reviews ${reviewed} but shares outputs with it`).toEqual([]);
      }
    }
  });

  it("reports the one workflow that deliberately ships unreviewed, without failing on it", () => {
    const result = checkReviewSeparation();
    // workflows/typo.yml says so in as many words. A written-down right-sizing
    // decision is the user's; the check makes it visible rather than overriding it.
    expect(result.notes.some((n) => n.includes('workflow "typo"'))).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe("reviewCoverage", () => {
  it("finds the reviewer covering an engineer in a full pipeline", () => {
    const coverage = reviewCoverage([
      AgentStage.BACKEND_ENGINEER,
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
    expect(coverage.covered).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);
    expect(coverage.unreviewed).toEqual([]);
  });

  it("flags a pipeline whose engineer nobody checks", () => {
    const coverage = reviewCoverage([AgentStage.FRONTEND_ENGINEER]);
    expect(coverage.unreviewed).toEqual([AgentStage.FRONTEND_ENGINEER]);
  });

  it("accepts security as the reviewer when qa-engineer is absent", () => {
    const coverage = reviewCoverage([AgentStage.BACKEND_ENGINEER, AgentStage.SECURITY]);
    expect(coverage.unreviewed).toEqual([]);
  });

  it("ignores stages nobody reviews rather than reporting them as gaps", () => {
    // An analyst's document is checked by the next stage reading it, not by a
    // verdict — calling that "unreviewed" would make the signal meaningless.
    const coverage = reviewCoverage([AgentStage.SYSTEM_ANALYST, AgentStage.DEVOPS]);
    expect(coverage.covered).toEqual([]);
    expect(coverage.unreviewed).toEqual([]);
  });

  it("counts setup's scaffolding as reviewed work", () => {
    expect(reviewedStages()).toContain(AgentStage.SETUP);
  });
});

describe("assertIndependentVerdict — the runtime rule", () => {
  it("lets a reviewer issue its verdict", () => {
    expect(() => assertIndependentVerdict(AgentStage.QA_ENGINEER, ArtifactType.QA_REPORT)).not.toThrow();
    expect(() => assertIndependentVerdict(AgentStage.SECURITY, ArtifactType.SECURITY_REPORT)).not.toThrow();
  });

  it("refuses a verdict from a stage that does the work", () => {
    expect(() => assertIndependentVerdict(AgentStage.BACKEND_ENGINEER, ArtifactType.QA_REPORT)).toThrow(
      SelfReviewError,
    );
  });

  it("says nothing about artifacts that carry no verdict", () => {
    expect(() => assertIndependentVerdict(AgentStage.SYSTEM_ANALYST, ArtifactType.DESIGN)).not.toThrow();
    expect(VERDICT_ARTIFACTS).not.toContain(ArtifactType.DESIGN);
  });

  it("narrowly exempts HANDOFF because it is an index, while self-verdict remains forbidden", () => {
    expect(() => assertIndependentVerdict(AgentStage.BUSINESS_ANALYST, ArtifactType.HANDOFF)).not.toThrow();
    expect(VERDICT_ARTIFACTS).not.toContain(ArtifactType.HANDOFF);
    expect(() => assertIndependentVerdict(AgentStage.BACKEND_ENGINEER, ArtifactType.QA_REPORT)).toThrow(SelfReviewError);
    expect(() => assertIndependentVerdict(AgentStage.BACKEND_ENGINEER, ArtifactType.SECURITY_REPORT)).toThrow(SelfReviewError);
  });
});

describe("the orchestrator refuses a self-review at runtime", () => {
  it("rejects a QA report submitted by the engineer whose work it covers", () => {
    const orch = new Orchestrator("T-SELF", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const status = orch.status();
    expect(status.kind).toBe("RUNNING");
    if (status.kind !== "RUNNING") return;
    expect(status.stage).toBe(AgentStage.BACKEND_ENGINEER);

    const report: QaReportArtifact = {
      taskId: "T-SELF",
      status: "PASS",
      mode: "FULL",
      requirements: { "REQ-001": "PASS" },
      tests: { passed: 1, failed: 0 },
      evidence: ["trust me"],
      risks: [],
      hasAutomatedTests: false,
      unverifiedBehaviour: [],
    };

    expect(() =>
      orch.reportCompletion(
        AgentStage.BACKEND_ENGINEER,
        {
          outcome: { tokens: 10, cost: 0.01, result: "PASS" },
          artifactType: ArtifactType.QA_REPORT,
          artifact: report,
        },
        { start: 0, end: 1 },
      ),
    ).toThrow(/not registered|reviews its own work|did not do the work/);
  });
});
