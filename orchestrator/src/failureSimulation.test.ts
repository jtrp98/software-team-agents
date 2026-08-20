import { describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "./orchestrator/orchestrator.js";
import { classifyTask } from "./classification/taskClassifier.js";
import { AgentStage } from "./types.js";
import { ApprovalType } from "./gates/approval.js";
import { ArtifactType, type DesignArtifact, type QaReportArtifact } from "./artifacts/schemas.js";

function qaReport(taskId: string, status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId,
    status,
    mode: "FULL",
    requirements: {},
    tests: { passed: status === "PASS" ? 10 : 8, failed: status === "PASS" ? 0 : 2 },
    evidence: ["log"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}
import { readModuleDoc } from "./agents/moduleDocs.js";
import { DatabaseUnavailableError, SchemaVersionMismatchError, SqliteTaskStore } from "./store/sqliteStore.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

/**
 * Failure Simulation (T56) — TASKS.md names six scenarios and asks that the orchestrator's
 * routing be checked for each. Every one of these already has a unit test somewhere in this
 * package (cross-referenced per scenario below); what didn't exist before this file is a
 * single place naming all six and, for the two that reach the `Orchestrator` itself (QA fail,
 * security critical), actually driving `Orchestrator.step()` through them rather than testing
 * the lower-level function that feeds it.
 *
 * A real "agent timeout" or "API unavailable" never reaches `Orchestrator` as such — by the
 * time `claudeCliExecutor.ts` (T26/T47) turns either one into an `AgentExecutorResult`, it's
 * just a FAIL with a `failure_reason` string, identical in shape to a FAIL for any other cause.
 * That's deliberate: the orchestrator's retry/escalate logic is uniform across failure *causes*
 * on purpose, so it doesn't need one code path per way an agent invocation can go wrong. This
 * file's job for those scenarios is to confirm that uniformity holds, not to re-simulate the
 * subprocess-level detail `claudeCliExecutor.test.ts` already covers.
 */

function makeExecutor(overrides: Partial<Record<AgentStage, (callIndex: number) => AgentExecutorResult>>): AgentExecutor {
  const counts: Partial<Record<AgentStage, number>> = {};
  return (req) => {
    const idx = counts[req.stage] ?? 0;
    counts[req.stage] = idx + 1;
    const override = overrides[req.stage];
    if (override) return override(idx);
    return { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };
  };
}

describe("Failure Simulation (T56)", () => {
  it("scenario: QA fail — retries the owning engineer, then escalates past the ceiling (see also orchestrator.test.ts, pipeline.test.ts)", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SIM-QA", classification);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({ outcome: { tokens: 100, cost: 0.01, result: "FAIL" } }),
    });

    let status = await orch.step(executor);
    for (let i = 0; i < 10 && status.kind === "RUNNING"; i++) status = await orch.step(executor);
    for (let i = 0; i < 10 && status.kind !== "BLOCKED"; i++) status = await orch.step(executor);

    expect(status.kind).toBe("BLOCKED");
    expect(orch.retries.qa).toBeGreaterThan(0);
  });

  it("scenario: security critical finding — escalates to a person immediately, no automatic round (see also escalationPolicy.test.ts's decideRecovery unit tests)", async () => {
    const okDesign: DesignArtifact = {
      taskId: "T-SIM-SECURITY",
      feasibility: "feasible",
      dataModel: [{ model: "Refund", fields: [{ name: "id", type: "string" }] }],
      risks: [],
      openQuestions: [],
      contract: ["refund status must be REFUNDED"],
    };
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const orch = new Orchestrator("T-SIM-SECURITY", classification);
    let securityCalls = 0;
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
      }),
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 100, cost: 0.01, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("T-SIM-SECURITY", "PASS"),
      }),
      [AgentStage.SECURITY]: () => {
        securityCalls++;
        return {
          outcome: { tokens: 100, cost: 0.01, result: "FAIL" },
          failure: {
            category: "unknown",
            owner: AgentStage.BACKEND_ENGINEER,
            severity: "critical",
            retryable: false,
            reason: "hardcoded credential found in a committed file",
            affected: ["BE-001"],
            requiresHuman: true,
          },
        };
      },
    });

    let status = await orch.step(executor);
    for (let i = 0; i < 20 && status.kind !== "DEPLOYED" && status.kind !== "BLOCKED"; i++) {
      if (status.kind === "WAITING_FOR_HUMAN") {
        // Only the schema-confirmation gate should ever show up before SECURITY runs — answer
        // that one and continue. The security escalation itself must stop the loop instead of
        // being auto-answered the same way.
        if (status.approvalType !== ApprovalType.SCHEMA_CONFIRMATION) break;
        orch.provideHumanApproval("designApproved", true);
      }
      status = await orch.step(executor);
    }

    // A critical security finding escalates straight to BLOCKED — no automatic re-run ever
    // happens — while still recording a SECURITY_RISK approval in the ledger (T08) so the stop
    // has a type and a reason, not just an opaque "blocked" string.
    expect(status.kind).toBe("BLOCKED");
    expect(securityCalls).toBe(1); // exactly one attempt — no automatic re-run
    const openApprovals = orch.snapshot().approvals.filter((a) => a.status === "pending");
    expect(openApprovals.some((a) => a.type === ApprovalType.SECURITY_RISK)).toBe(true);
  });

  it("scenario: agent timeout — a FAIL from a timed-out invocation is retried like any other FAIL, not treated as a crash (see also claudeCliExecutor.test.ts's ETIMEDOUT test)", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SIM-TIMEOUT", classification);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: (idx) => ({
        outcome: {
          tokens: 0,
          cost: 0,
          result: idx === 0 ? "FAIL" : "PASS",
          failure_reason: idx === 0 ? "spawnSync claude ETIMEDOUT" : undefined,
        },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("T-SIM-TIMEOUT", idx === 0 ? "FAIL" : "PASS"),
      }),
    });

    const first = await orch.step(executor);
    expect(first.kind).toBe("RUNNING"); // the same task retried, not aborted
    let status = first;
    for (let i = 0; i < 10 && status.kind !== "DEPLOYED" && status.kind !== "BLOCKED"; i++) status = await orch.step(executor);
    expect(status.kind).toBe("DEPLOYED");
  });

  it("scenario: API unavailable (claude CLI's is_error: true) — same uniform FAIL handling as any other cause (see also claudeCliExecutor.test.ts's is_error test)", async () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-SIM-API", classification);
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: (idx) => ({
        outcome: {
          tokens: 0,
          cost: 0,
          result: idx === 0 ? "FAIL" : "PASS",
          failure_reason: idx === 0 ? "claude CLI returned is_error: true" : undefined,
        },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("T-SIM-API", idx === 0 ? "FAIL" : "PASS"),
      }),
    });

    let status = await orch.step(executor);
    for (let i = 0; i < 10 && status.kind !== "DEPLOYED" && status.kind !== "BLOCKED"; i++) status = await orch.step(executor);
    expect(status.kind).toBe("DEPLOYED");
  });

  it("scenario: invalid schema — a state.db from a newer/incompatible schema version refuses to open, rather than silently misreading it (see also taskStore.test.ts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-failsim-"));
    try {
      const dbPath = path.join(dir, "state.db");
      const store = new SqliteTaskStore(dbPath);
      store.close();

      // A version tag newer than this build knows about — the same shape a future schema
      // migration would leave behind if this build tried to open it.
      const raw = new Database(dbPath);
      raw.pragma("user_version = 99");
      raw.close();

      let caught: unknown;
      try {
        new SqliteTaskStore(dbPath);
        expect.unreachable("constructor should have thrown");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SchemaVersionMismatchError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scenario: missing file — an agent reading a module doc that was never written gets null, not a thrown exception (see also moduleDocs.test.ts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-failsim-"));
    try {
      expect(readModuleDoc(dir, "nonexistent-module", "design.md")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scenario: database unavailable — a path the process cannot open fails as a typed, actionable error (see also taskStore.test.ts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-failsim-"));
    try {
      // A plain file sits where a directory needs to go — mkdirSync can never create it, the
      // same shape a permissions problem or a vanished mount point would produce.
      const blockingFile = path.join(dir, "blocking-file");
      fs.writeFileSync(blockingFile, "not a directory", "utf8");
      const unreachable = path.join(blockingFile, "state.db");

      let caught: unknown;
      try {
        new SqliteTaskStore(unreachable);
        expect.unreachable("constructor should have thrown");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DatabaseUnavailableError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
