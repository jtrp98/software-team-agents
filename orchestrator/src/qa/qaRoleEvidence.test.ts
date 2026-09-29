import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorRequest, type AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { withQaOptimization } from "./optimized.js";
import { selectQaEffort } from "./riskGate.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { PASSING_VERIFICATION, passingQaReport, withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import { decideStageCompletion, verifyTaskCompletion } from "../orchestrator/transitionGuard.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

const human = { humanDecisionVerifier: testHumanVerifier(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };
const bugfix = () => classifyTask({ isClearBugFix: true, touchesBackend: true });
const PASS = { tokens: 10, cost: 0.001, result: "PASS" as const };
const FAIL = { tokens: 10, cost: 0.001, result: "FAIL" as const };
const reviewPass: AgentExecutor = (req) => withRequiredEvidence(req, { outcome: PASS });

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `sta-qa-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`, "state.db");
}

function cleanup(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* Windows file lock tolerance */
  }
}

describe("V13 TASK-019 — QA role evidence replaces synthetic pass", () => {
  it("missing QA role blocks completion: stage cannot pass without QA role execution", async () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      const orch = new Orchestrator("T-QA-MISSING", bugfix(), { ...human, store });
      await orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      const afterReview = await orch.step(reviewPass);

      // We are now at QA_ENGINEER stage
      expect(afterReview.kind).toBe("RUNNING");
      if (afterReview.kind === "RUNNING") {
        expect(afterReview.stage).toBe(AgentStage.QA_ENGINEER);
      }
      expect(verifyTaskCompletion(store, orch.snapshot()).done).toBe(false);

      // Attempting to evaluate completion without QA evidence returns incomplete
      const completion = decideStageCompletion(AgentStage.QA_ENGINEER, 1, store.evidenceForTask("T-QA-MISSING"));
      expect(completion.complete).toBe(false);
      if (!completion.complete) {
        expect(completion.missing).toContain("qa-engineer attempt 1: role-run-succeeded");
        expect(completion.missing).toContain("qa-engineer attempt 1: qa-report-pass");
      }
    } finally {
      cleanup(file);
    }
  });

  it("claimed PASS without artifact fails stage completion", async () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      const orch = new Orchestrator("T-QA-NO-ART", bugfix(), { ...human, store });
      await orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      await orch.step(reviewPass);

      // QA claims PASS in outcome, but produces NO QA report artifact
      const badQa: AgentExecutor = async () => ({
        outcome: PASS,
        // no artifactType or artifact
      });

      const next = await orch.step(badQa);
      // Stage did not advance to DEPLOYED because qa-report-pass evidence is missing
      expect(next.kind).toBe("RUNNING");
      if (next.kind === "RUNNING") {
        expect(next.stage).toBe(AgentStage.QA_ENGINEER);
      }

      const completion = decideStageCompletion(AgentStage.QA_ENGINEER, 1, store.evidenceForTask("T-QA-NO-ART"));
      expect(completion.complete).toBe(false);
      if (!completion.complete) {
        expect(completion.missing).toContain("qa-engineer attempt 1: qa-report-pass");
      }
    } finally {
      cleanup(file);
    }
  });

  it("failed QA records failure and routes back to backend-engineer for repair", async () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      const orch = new Orchestrator("T-QA-FAIL", bugfix(), { ...human, store });
      await orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      await orch.step(reviewPass);

      // QA reports FAIL
      const failingQaReport: QaReportArtifact = {
        taskId: "T-QA-FAIL",
        status: "FAIL",
        mode: "TARGETED",
        requirements: { "T-QA-FAIL": "FAIL" },
        tests: { passed: 2, failed: 1 },
        evidence: ["1 test failed in order.test.ts"],
        risks: ["order total calculation error"],
        hasAutomatedTests: true,
        unverifiedBehaviour: [],
      };

      const failingQa: AgentExecutor = async () => ({
        outcome: FAIL,
        artifactType: ArtifactType.QA_REPORT,
        artifact: failingQaReport,
        failure: {
          category: "test",
          owner: AgentStage.BACKEND_ENGINEER,
          severity: "medium",
          retryable: true,
          reason: "order total calculation error",
          affected: ["T-QA-FAIL"],
          requiresHuman: false,
        },
      });

      const afterQa = await orch.step(failingQa);
      // Failed QA routes back to implementation (BACKEND_ENGINEER)
      expect(afterQa.kind).toBe("RUNNING");
      if (afterQa.kind === "RUNNING") {
        expect(afterQa.stage).toBe(AgentStage.BACKEND_ENGINEER);
      }
      expect(orch.snapshot().retries.qa).toBe(1);
    } finally {
      cleanup(file);
    }
  });

  it("third QA failure escalates to human gate rather than silent pass or infinite loop", async () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      const orch = new Orchestrator("T-QA-3FAIL", bugfix(), { ...human, store });

      const executor = async (req: AgentExecutorRequest): Promise<AgentExecutorResult> => {
        if (req.stage === AgentStage.QA_ENGINEER) {
          return {
            outcome: FAIL,
            artifactType: ArtifactType.QA_REPORT,
            artifact: {
              taskId: "T-QA-3FAIL",
              status: "FAIL",
              mode: "TARGETED",
              requirements: { "T-QA-3FAIL": "FAIL" },
              tests: { passed: 0, failed: 1 },
              evidence: ["persistent test failure"],
              risks: ["bug"],
              hasAutomatedTests: true,
              unverifiedBehaviour: [],
            },
            failure: {
              category: "test",
              owner: AgentStage.BACKEND_ENGINEER,
              severity: "medium",
              retryable: true,
              reason: "persistent failure",
              affected: ["T-QA-3FAIL"],
              requiresHuman: false,
            },
          };
        }
        if (req.stage === AgentStage.REVIEWER) {
          return await reviewPass(req);
        }
        return { outcome: PASS, deterministicVerification: PASSING_VERIFICATION };
      };

      let finalStatus;
      for (let i = 0; i < 20; i++) {
        finalStatus = await orch.step(executor);
        if (finalStatus.kind === "BLOCKED" || finalStatus.kind === "DEPLOYED") break;
      }

      // Exhausted retries escalates to BLOCKED requiring human intervention
      expect(finalStatus?.kind).toBe("BLOCKED");
      expect(orch.snapshot().machine.current).toBe(TaskState.BLOCKED);
      expect(orch.snapshot().blockedReason).toMatch(/automatic round|fix attempt|persistent failure/i);
    } finally {
      cleanup(file);
    }
  });

  it("successful QA evidence survives process restart and completes deterministically", async () => {
    const file = tmpDbPath();
    try {
      // Process 1: run complete pipeline with QA
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-QA-RESTART", bugfix(), { ...human, store: store1 });
      await orch1.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      await orch1.step(reviewPass);

      const qaExec = withQaOptimization({
        inner: async (req) => ({
          outcome: PASS,
          artifactType: ArtifactType.QA_REPORT,
          artifact: passingQaReport(req.taskId),
        }),
        changedFiles: () => ["src/a.ts"],
      });

      const afterQa = await orch1.step(qaExec);
      expect(afterQa.kind).toBe("DEPLOYED");
      store1.close();

      // Process 2: restart from persisted SQLite state
      const store2 = new SqliteTaskStore(file);
      const records = store2.evidenceForTask("T-QA-RESTART");

      // Verify stage completion decision is pure and deterministic
      const qaCompletion = decideStageCompletion(AgentStage.QA_ENGINEER, 1, records);
      expect(qaCompletion.complete).toBe(true);
      if (qaCompletion.complete) {
        expect(qaCompletion.satisfied).toContain("role-run-succeeded");
        expect(qaCompletion.satisfied).toContain("qa-report-pass");
      }

      const task = store2.loadTask("T-QA-RESTART")!;
      const overall = verifyTaskCompletion(store2, task);
      expect(overall.done).toBe(true);
      expect(task.machine.current).toBe(TaskState.DEPLOYED);
      store2.close();
    } finally {
      cleanup(file);
    }
  });

  it("no synthetic skip regardless of task level (TRIVIAL / SMALL run lightweight QA role)", async () => {
    expect(selectQaEffort(TaskLevel.TRIVIAL).effort).toBe("lightweight");
    expect(selectQaEffort(TaskLevel.SMALL).effort).toBe("lightweight");

    let modelInvoked = false;
    let qaContextEvidence = "";
    const execute = withQaOptimization({
      inner: async (req: AgentExecutorRequest) => {
        modelInvoked = true;
        qaContextEvidence = req.context.find((c) => c.source === "qa-evidence")?.content ?? "";
        return {
          outcome: PASS,
          artifactType: ArtifactType.QA_REPORT,
          artifact: passingQaReport(req.taskId),
        };
      },
      changedFiles: () => ["src/trivial.ts"],
      taskLevel: () => TaskLevel.TRIVIAL,
    });

    const result = await execute({
      stage: AgentStage.QA_ENGINEER,
      taskId: "T-TRIVIAL",
      context: [],
    });

    expect(modelInvoked).toBe(true);
    expect(result.outcome.qa_effort).toBe("lightweight");
    expect(result.outcome.result).toBe("PASS");
    expect(qaContextEvidence).toContain("Effort: lightweight");
  });
});
