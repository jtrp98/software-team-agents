import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator, type AgentExecutor, type AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskState } from "../types.js";
import { ArtifactType, type DesignArtifact, type QaReportArtifact, type SecurityReportArtifact } from "../artifacts/schemas.js";
import { ApprovalType } from "../gates/approval.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";

/**
 * Integration tests — end to end through the real seams `orchestrator.test.ts`'s unit tests
 * deliberately isolate: Agent (a fake executor standing in for `claude -p --agent <role>`) →
 * Workflow (classifyTask's pipeline selection) → State (a real `SqliteTaskStore` on a temp
 * file, not `MemoryTaskStore`) → QA (retry on a failed round) → Approval (both human gates).
 * What this suite catches that unit tests can't: a task surviving an actual process crash —
 * the in-memory `Orchestrator` instance discarded and a fresh one rebuilt from
 * `Orchestrator.resume()` reading the same sqlite file back — continuing to completion with
 * the exact same fake executor. `orchestrator.test.ts` never discards its `Orchestrator`
 * mid-run; every test here does, at least once.
 */

const okDesign: DesignArtifact = {
  taskId: "T",
  feasibility: "feasible",
  dataModel: [{ model: "Refund", fields: [{ name: "id", type: "string" }] }],
  risks: [],
  openQuestions: [],
  contract: ["refund status must be REFUNDED"],
};

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 10 : 8, failed: status === "PASS" ? 0 : 2 },
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
    findings: status === "PASS" ? [] : [{ id: "F-1", severity: "HIGH", status: "OPEN", description: "missing authz" }],
  };
}

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

/** Steps until DEPLOYED/BLOCKED, auto-answering every human-approval gate "yes". */
async function runToCompletion(orch: Orchestrator, executor: AgentExecutor, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const status = await orch.step(executor);
    if (status.kind === "WAITING_FOR_HUMAN") {
      const field = status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved";
      orch.provideHumanApproval(field, true);
      continue;
    }
    if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
  }
  throw new Error("runToCompletion exceeded maxSteps");
}

describe("Full pipeline integration", () => {
  let tmpDb: string;
  const openStores: SqliteTaskStore[] = [];

  function openStore(): SqliteTaskStore {
    const s = new SqliteTaskStore(tmpDb);
    openStores.push(s);
    return s;
  }

  beforeEach(() => {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-integration-")), "state.db");
    openStores.length = 0;
  });

  afterEach(() => {
    for (const s of openStores) s.close();
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  });

  it("drives a LARGE_CRITICAL task through both approval gates and a QA retry, crashing and resuming from a real SqliteTaskStore mid-run", async () => {
    const store = openStore();
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const executor = makeExecutor({
      [AgentStage.SYSTEM_ANALYST]: () => ({
        outcome: { tokens: 2000, cost: 0.2, result: "PASS" },
        artifactType: ArtifactType.DESIGN,
        artifact: okDesign,
      }),
      [AgentStage.QA_ENGINEER]: (idx) => ({
        outcome: { tokens: 800, cost: 0.05, result: idx === 0 ? "FAIL" : "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport(idx === 0 ? "FAIL" : "PASS"),
      }),
      [AgentStage.SECURITY]: () => ({
        outcome: { tokens: 1200, cost: 0.1, result: "PASS" },
        artifactType: ArtifactType.SECURITY_REPORT,
        artifact: securityReport("PASS"),
      }),
    });

    let orch = new Orchestrator("T-INTEGRATION-1", classification, { store });

    // Run until the first human-approval gate (schema confirmation) — then simulate a crash:
    // discard this Orchestrator entirely and rebuild from the sqlite file alone.
    let status = await orch.step(executor);
    while (status.kind !== "WAITING_FOR_HUMAN") status = await orch.step(executor);
    expect(status.approvalType).toBe(ApprovalType.SCHEMA_CONFIRMATION);

    orch = Orchestrator.resume("T-INTEGRATION-1", store);
    orch.provideHumanApproval("designApproved", true);

    const final = await runToCompletion(orch, executor);

    expect(final.kind).toBe("DEPLOYED");
    expect(orch.retries.qa).toBe(1); // the FAIL-then-PASS round actually happened, not skipped by the crash
    expect(orch.machine.history).toEqual([
      TaskState.CREATED,
      TaskState.DESIGN,
      TaskState.PLAN,
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.QA_FAILED, // the round the crash happened in the middle of — recorded, not lost
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.SECURITY,
      TaskState.READY_TO_DEPLOY,
      TaskState.APPROVED,
      TaskState.DEPLOYED,
    ]);

    // The sqlite file itself agrees with the in-memory result — not just the object the test
    // already holds a reference to.
    const reloaded = Orchestrator.resume("T-INTEGRATION-1", store);
    expect(reloaded.machine.current).toBe(TaskState.DEPLOYED);
    expect(reloaded.retries.qa).toBe(1);
  });

  it("escalates to BLOCKED past the retry ceiling, and the block survives a crash — resuming doesn't quietly reset the retry count", async () => {
    const store = openStore();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const executor = makeExecutor({
      [AgentStage.QA_ENGINEER]: () => ({
        outcome: { tokens: 500, cost: 0.02, result: "FAIL" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: qaReport("FAIL"),
      }),
    });

    let orch = new Orchestrator("T-INTEGRATION-2", classification, { store });

    // Drive two rounds, then crash and resume for the rest — the retry ceiling must be
    // honoured across the reload, not restarted.
    await orch.step(executor);
    await orch.step(executor);
    await orch.step(executor);
    await orch.step(executor);

    orch = Orchestrator.resume("T-INTEGRATION-2", store);
    const final = await runToCompletion(orch, executor);

    expect(final.kind).toBe("BLOCKED");
    expect(orch.retries.qa).toBe(4); // 3 retries + the failure that exceeds the limit — unaffected by the mid-run reload
  });

  it("keeps a paused task from advancing even after the orchestrator driving it is rebuilt from the store", async () => {
    const store = openStore();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const executor = makeExecutor({});

    const orch = new Orchestrator("T-INTEGRATION-3", classification, { store });
    await orch.step(executor); // BACKEND_ENGINEER runs once

    // Pause is a human override applied straight to the store (TaskRegistry.pause's own
    // mechanism), orthogonal to the Orchestrator instance — set it directly here the same way.
    const task = store.loadTask("T-INTEGRATION-3")!;
    store.saveTask({ ...task, paused: true });

    const resumed = Orchestrator.resume("T-INTEGRATION-3", store);
    expect(resumed.snapshot().paused).toBe(true);
  });
});
