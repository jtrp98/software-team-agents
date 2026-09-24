import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "../store/sqliteDatabase.js";
import { Orchestrator, type AgentExecutor, type AgentExecutorRequest, type AgentExecutorResult } from "./orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage, TaskState } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { withQaOptimization } from "../qa/optimized.js";
import { decidePending, testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { PASSING_VERIFICATION, passingQaReport, withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import type { EvidenceRecord } from "../evidence/evidenceStore.js";
import { STAGE_EVIDENCE_REQUIREMENTS, verifyTaskCompletion } from "./transitionGuard.js";

const human = { humanDecisionVerifier: testHumanVerifier() };
/** backend-engineer -> qa-engineer; no human gate. */
const bugfix = () => classifyTask({ isClearBugFix: true, touchesBackend: true });
/** devops "prepare" -> human deploy approval -> devops "execute". */
const deploy = () => classifyTask({ isProductionDeployOrMigration: true });
const PASS = { tokens: 10, cost: 0.001, result: "PASS" as const };
const FAIL = { tokens: 10, cost: 0.001, result: "FAIL" as const };

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `sta-transitions-${Date.now()}-${Math.random().toString(36).slice(2)}`, "state.db");
}

function cleanup(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* Windows can hold the WAL handle briefly; a leaked temp dir is harmless */
  }
}

function kinds(records: readonly EvidenceRecord[]): string[] {
  return records.map((r) => `${r.stage}#${r.attempt}:${r.kind}`);
}

describe("persisted evidence across a process boundary (V13 TASK-002)", () => {
  it("Engineer in one process, QA in a fresh one: QA receives the persisted sweep, and Done carries queryable evidence ids", async () => {
    const file = tmpDbPath();
    try {
      // Process 1: the engineer attempt and its post-Dev sweep, then the process exits.
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-XP", bugfix(), { ...human, store: store1 });
      const afterDev = await orch1.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      expect(afterDev).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
      store1.close();

      // Process 2: nothing in memory survives — only the file connects them.
      const store2 = new SqliteTaskStore(file);
      const orch2 = Orchestrator.resume("T-XP", store2, human);
      const seen: AgentExecutorRequest[] = [];
      const qa = withQaOptimization({
        inner: (req) => {
          seen.push(req);
          return { outcome: PASS, artifactType: ArtifactType.QA_REPORT, artifact: passingQaReport("T-XP") };
        },
        changedFiles: () => ["src/a.ts"],
        deterministicGate: "enabled",
      });
      const afterQa = await orch2.step(qa);
      expect(seen[0]!.deterministicVerification?.verification).toEqual(PASSING_VERIFICATION);
      const qaRun = store2.runsForTask("T-XP").find((r) => r.agent === AgentStage.QA_ENGINEER)!;
      // "enabled" means a real, persisted sweep reached the round — not that one was requested.
      expect(qaRun.deterministic_gate).toBe("enabled");
      const sweepId = seen[0]!.deterministicVerification!.evidenceId;
      const qaRoleRun = store2.evidenceForTask("T-XP").find((r) => r.stage === AgentStage.QA_ENGINEER && r.kind === "role-run")!;
      expect(qaRoleRun.refs).toEqual([sweepId]);

      expect(afterQa.kind).toBe("DEPLOYED");
      store2.close();

      // Process 3: Done is queryable from the store alone.
      const store3 = new SqliteTaskStore(file);
      const task = store3.loadTask("T-XP")!;
      expect(task.machine.current).toBe(TaskState.DEPLOYED);
      const done = verifyTaskCompletion(store3, task);
      expect(done.done).toBe(true);
      if (!done.done) throw new Error("unreachable");
      expect(done.completionEvidenceId).toBe(task.completionEvidenceId);
      const referenced = done.evidenceIds.map((id) => store3.loadEvidence(id)!);
      expect(referenced.map((r) => `${r.stage}:${r.kind}`).sort()).toEqual([
        "backend-engineer:stage-completion",
        "qa-engineer:stage-completion",
      ]);
      expect(kinds(store3.evidenceForTask("T-XP"))).toEqual([
        "backend-engineer#1:role-run",
        "backend-engineer#1:deterministic-verification",
        "backend-engineer#1:stage-completion",
        "qa-engineer#1:role-run",
        "qa-engineer#1:artifact",
        "qa-engineer#1:stage-completion",
        "human#1:task-completion",
      ]);
      store3.close();
    } finally {
      cleanup(file);
    }
  });

  it("a crash before completion is reported persists nothing; the restarted run repeats the same attempt number", async () => {
    const file = tmpDbPath();
    try {
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-CRASH", bugfix(), { ...human, store: store1 });
      await expect(
        orch1.step(() => {
          throw new Error("runtime process killed");
        }),
      ).rejects.toThrow("runtime process killed");
      store1.close();

      const store2 = new SqliteTaskStore(file);
      expect(store2.evidenceForTask("T-CRASH")).toEqual([]);
      expect(store2.runsForTask("T-CRASH")).toEqual([]);
      const orch2 = Orchestrator.resume("T-CRASH", store2, human);
      await orch2.step((req) => withRequiredEvidence(req, { outcome: PASS }));
      expect(kinds(store2.evidenceForTask("T-CRASH")).slice(0, 1)).toEqual(["backend-engineer#1:role-run"]);
      store2.close();
    } finally {
      cleanup(file);
    }
  });

  it("a refused result rolls the whole attempt back: no run, no event, no evidence, no listener notification", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-RB", bugfix(), { ...human, store });
    orch.status();
    const heard: string[] = [];
    orch.events.on("AGENT_COMPLETED", () => heard.push("AGENT_COMPLETED"));
    orch.events.on("STAGE_COMPLETED", () => heard.push("STAGE_COMPLETED"));
    const eventsBefore = store.eventsForTask("T-RB").length;

    expect(() =>
      orch.reportCompletion(
        AgentStage.BACKEND_ENGINEER,
        {
          outcome: PASS,
          deterministicVerification: PASSING_VERIFICATION,
          gateEvidence: { humanApproved: true } as unknown as AgentExecutorResult["gateEvidence"],
        },
        { start: 0, end: 1 },
      ),
    ).toThrow(/gateEvidence refused/);

    expect(store.runsForTask("T-RB")).toEqual([]);
    expect(store.evidenceForTask("T-RB")).toEqual([]);
    expect(store.eventsForTask("T-RB")).toHaveLength(eventsBefore);
    expect(heard).toEqual([]);
    expect(orch.runLog.runsForTask("T-RB")).toEqual([]);
    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
  });

  it("a store failure while writing evidence rolls back the run, the cursor and every evidence record", async () => {
    const inner = new MemoryTaskStore();
    let failOn: string | null = null;
    const store: TaskStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "appendEvidence") {
          return (record: EvidenceRecord) => {
            if (record.kind === failOn) throw new Error(`disk full while writing ${record.kind}`);
            return target.appendEvidence(record);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const orch = new Orchestrator("T-DISK", bugfix(), { ...human, store });
    failOn = "stage-completion";
    await expect(orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }))).rejects.toThrow(/disk full/);
    expect(inner.evidenceForTask("T-DISK")).toEqual([]);
    expect(inner.runsForTask("T-DISK")).toEqual([]);
    expect(inner.loadTask("T-DISK")!.pipelineCursor).toBe(0);

    failOn = null;
    const retried = await orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
    expect(retried).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
    expect(kinds(inner.evidenceForTask("T-DISK"))[0]).toBe("backend-engineer#1:role-run");
  });
});

describe("fail-closed transitions (V13 TASK-003)", () => {
  it("has one requirement table and every running stage needs at least a successful role run", () => {
    for (const [stage, requirements] of Object.entries(STAGE_EVIDENCE_REQUIREMENTS)) {
      if (stage === AgentStage.HUMAN) expect(requirements).toEqual([]);
      else expect(requirements[0]).toBe("role-run-succeeded");
    }
  });

  it("a failed role never advances: the cursor stays and the next status assigns the same stage", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-FAILROLE", classifyTask({ isIncrementalFeature: true, touchesBackend: true }), { ...human, store });
    const first = orch.status();
    expect(first.kind).toBe("RUNNING");
    const stage = first.kind === "RUNNING" ? first.stage : AgentStage.HUMAN;
    const after = await orch.step(() => ({ outcome: { ...FAIL, failure_reason: "tool crashed" } }));
    expect(after).toEqual({ kind: "RUNNING", stage });
    expect(store.loadTask("T-FAILROLE")!.pipelineCursor).toBe(0);
    expect(orch.stageDecision).toMatchObject({ stage, attempt: 1, decision: { complete: false } });
    expect(store.evidenceForTask("T-FAILROLE").some((r) => r.kind === "stage-completion")).toBe(false);
    expect(store.eventsForTask("T-FAILROLE").some((e) => e.type === "STAGE_INCOMPLETE")).toBe(true);

    // The retry is attempt 2 of the same stage, not the next stage.
    await orch.step((req) => withRequiredEvidence(req, { outcome: PASS }));
    expect(store.evidenceForTask("T-FAILROLE").filter((r) => r.stage === stage && r.kind === "role-run").map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("an engineer PASS without a post-Dev sweep is incomplete — QA is never reached", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-NOSWEEP", bugfix(), { ...human, store });
    const after = await orch.step(() => ({ outcome: PASS }));
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(orch.stageDecision?.decision).toEqual({
      complete: false,
      missing: ["backend-engineer attempt 1: deterministic-verification-passed"],
      evidenceIds: [expect.stringMatching(/^evd_/)],
    });
  });

  it("a failed post-Dev sweep is persisted as evidence and keeps the task on the engineer", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-REDSWEEP", bugfix(), { ...human, store });
    const red = { ...PASSING_VERIFICATION, status: "failed" as const, passed: false, failures: [PASSING_VERIFICATION.ran[0]!] };
    const after = await orch.step(() => ({ outcome: { ...FAIL, failure_reason: "typecheck red" }, deterministicVerification: red }));
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    const sweep = store.evidenceForTask("T-REDSWEEP").find((r) => r.kind === "deterministic-verification")!;
    expect(sweep.payload).toMatchObject({ verification: { passed: false } });
  });

  it("only a code-producing stage may carry a post-Dev sweep", () => {
    const orch = new Orchestrator("T-WRONGSWEEP", classifyTask({ isIncrementalFeature: true, touchesBackend: true }), human);
    const status = orch.status();
    const stage = status.kind === "RUNNING" ? status.stage : AgentStage.HUMAN;
    expect(stage).not.toBe(AgentStage.BACKEND_ENGINEER);
    expect(() =>
      orch.reportCompletion(stage, { outcome: PASS, deterministicVerification: PASSING_VERIFICATION }, { start: 0, end: 1 }),
    ).toThrow(/only a code-producing stage/);
  });

  it("a QA PASS outcome without a QA report is no verdict and does not advance", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-NOREPORT", bugfix(), { ...human, store });
    await orch.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
    const after = await orch.step(() => ({ outcome: PASS }));
    expect(after).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
    const types = store.eventsForTask("T-NOREPORT").map((e) => e.type);
    expect(types).not.toContain("QA_PASSED");
    expect(types).toContain("STAGE_INCOMPLETE");
  });

  it("a QA failure routes back and never completes QA; restart reaches the same decision", async () => {
    const file = tmpDbPath();
    try {
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-QAFAIL", bugfix(), { ...human, store: store1 });
      await orch1.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      const afterQa = await orch1.step(() => ({
        outcome: FAIL,
        artifactType: ArtifactType.QA_REPORT,
        artifact: { ...passingQaReport("T-QAFAIL"), status: "FAIL" },
      }));
      expect(afterQa).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
      store1.close();

      const store2 = new SqliteTaskStore(file);
      const orch2 = Orchestrator.resume("T-QAFAIL", store2, human);
      expect(orch2.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
      expect(store2.evidenceForTask("T-QAFAIL").some((r) => r.stage === AgentStage.QA_ENGINEER && r.kind === "stage-completion")).toBe(false);
      store2.close();
    } finally {
      cleanup(file);
    }
  });

  it("an incomplete attempt stays incomplete after a restart — the decision is derived from the store", async () => {
    const file = tmpDbPath();
    try {
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-RESTART", bugfix(), { ...human, store: store1 });
      await orch1.step(() => ({ outcome: PASS })); // no sweep: incomplete
      store1.close();

      const store2 = new SqliteTaskStore(file);
      const orch2 = Orchestrator.resume("T-RESTART", store2, human);
      expect(orch2.status()).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
      const next = await orch2.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      expect(next).toEqual({ kind: "RUNNING", stage: AgentStage.QA_ENGINEER });
      expect(store2.evidenceForTask("T-RESTART").filter((r) => r.kind === "stage-completion").map((r) => r.attempt)).toEqual([2]);
      store2.close();
    } finally {
      cleanup(file);
    }
  });

  it("a cursor moved past a stage with no completion record is refused at the transition", () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-CURSOR", bugfix(), { ...human, store });
    orch.status(); // IMPLEMENTATION, backend-engineer assigned
    const row = store.loadTask("T-CURSOR")!;
    store.saveTask({ ...row, pipelineCursor: row.machine.pipeline.length }); // skip every stage
    const status = Orchestrator.resume("T-CURSOR", store, human).status();
    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") expect(status.reason).toMatch(/refused: backend-engineer has no recorded completion/);
  });

  it("an approved ledger entry without its approval-decision evidence does not open the edge", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-APPROVAL", deploy(), { ...human, store });
    const waiting = await orch.step(() => ({ outcome: PASS })); // devops prepare
    expect(waiting.kind).toBe("WAITING_FOR_HUMAN");
    decidePending(orch, true);
    // Simulate a ledger whose decision was written without passing through STA:
    // same approved record, but the decision evidence is gone.
    const row = store.loadTask("T-APPROVAL")!;
    const fresh = new MemoryTaskStore();
    fresh.createTask({ ...row, machine: { ...row.machine, current: TaskState.READY_TO_DEPLOY } });
    for (const record of store.evidenceForTask("T-APPROVAL")) {
      if (record.kind !== "approval-decision" && record.kind !== "task-completion") fresh.appendEvidence(record);
    }
    const status = Orchestrator.resume("T-APPROVAL", fresh, human).status();
    expect(status.kind).toBe("BLOCKED");
    if (status.kind === "BLOCKED") expect(status.reason).toMatch(/has no approval-decision evidence/);
  });

  it("a DEPLOYED row whose completion evidence is missing or broken is reported blocked, not Done", async () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-DONE", deploy(), { ...human, store });
    await orch.step(() => ({ outcome: PASS })); // devops prepare
    decidePending(orch, true);
    expect(await orch.step(() => ({ outcome: PASS }))).toEqual({ kind: "DEPLOYED" }); // devops execute
    expect(kinds(store.evidenceForTask("T-DONE"))).toEqual([
      "devops#1:role-run",
      "devops#1:stage-completion",
      "human#1:approval-decision",
      "devops#2:role-run",
      "devops#2:stage-completion",
      "human#1:task-completion",
    ]);
    const row = store.loadTask("T-DONE")!;
    expect(verifyTaskCompletion(store, row).done).toBe(true);

    const forged = new MemoryTaskStore();
    forged.createTask({ ...row, completionEvidenceId: null });
    expect(Orchestrator.resume("T-DONE", forged, human).status()).toMatchObject({
      kind: "BLOCKED",
      reason: expect.stringContaining("DEPLOYED without a recorded completion decision"),
    });

    const dangling = new MemoryTaskStore();
    dangling.createTask(row);
    expect(verifyTaskCompletion(dangling, row)).toEqual({ done: false, reason: `completion evidence ${row.completionEvidenceId} does not exist` });
  });

  it("a hand-edited evidence row on disk makes the task fail loudly instead of advancing", async () => {
    const file = tmpDbPath();
    try {
      const store1 = new SqliteTaskStore(file);
      const orch1 = new Orchestrator("T-TAMPER", bugfix(), { ...human, store: store1 });
      await orch1.step(() => ({ outcome: PASS, deterministicVerification: PASSING_VERIFICATION }));
      const completion = store1.evidenceForTask("T-TAMPER").find((r) => r.kind === "stage-completion")!;
      store1.close();

      const raw = new Database(file);
      const row = raw.prepare("SELECT record FROM evidence WHERE evidence_id = ?").get(completion.evidenceId) as { record: string };
      const edited = JSON.parse(row.record) as EvidenceRecord;
      edited.refs = [];
      raw.prepare("UPDATE evidence SET record = ? WHERE evidence_id = ?").run(JSON.stringify(edited), completion.evidenceId);
      raw.close();

      const store2 = new SqliteTaskStore(file);
      const orch2 = Orchestrator.resume("T-TAMPER", store2, human);
      await expect(
        orch2.step(() => ({ outcome: PASS, artifactType: ArtifactType.QA_REPORT, artifact: passingQaReport("T-TAMPER") })),
      ).rejects.toThrow(/digest does not match/);
      expect(store2.loadTask("T-TAMPER")!.machine.current).toBe(TaskState.QA);
      store2.close();
    } finally {
      cleanup(file);
    }
  });
});
