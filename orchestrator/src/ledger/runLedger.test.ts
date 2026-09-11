import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { newPersistedTask } from "../store/taskStore.js";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { createRunId, type RunManifest } from "../run/journal.js";
import { appendLegacyWaveRecord, writeLegacyWaveRun } from "../run/legacyWaveRecord.testSupport.js";
import { SqliteRunLedger } from "./sqliteRunLedger.js";
import {
  LEDGER_SCHEMA_VERSION,
  LedgerAmbiguityError,
  LedgerConflictError,
  LedgerNotFoundError,
  assertRunIdentity,
  attemptId,
  type LedgerAttempt,
  type LedgerRun,
  type LedgerTask,
} from "./runLedger.js";
import {
  LedgerTransitionError,
  applyAttemptStatus,
  applyRunStatus,
  applyTaskStatus,
  transitionVocabulary,
} from "./vocabulary.js";
import { LEDGER_ADAPTER_VERSION, LedgerAdapterError, ledgerTaskStatusFromPersisted, projectWaveRun, resolveExecutionAuthority } from "./adapters.js";
import { assertAuditRoundTrip, exportRunAudit, importRunAudit } from "./auditExport.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

let root: string;
let store: SqliteTaskStore;
let ledger: SqliteRunLedger;
let runId: string;

function makeRun(overrides: Partial<LedgerRun> = {}): LedgerRun {
  return {
    ledger_version: LEDGER_SCHEMA_VERSION,
    run_id: runId,
    status: "CREATED",
    boundary: "qa",
    module: "orders",
    target_id: "orders-target",
    target_root: path.join(root, "target"),
    knowledge_root: path.join(root, "knowledge"),
    base_branch: "main",
    base_sha: "abc1234",
    run_branch: `sta/run/${runId}`,
    requirement_hash: HASH_A,
    design_hash: HASH_B,
    plan_hash: HASH_C,
    config_hash: HASH_A,
    sta_version: "2.0.0",
    task_order: ["BE-004", "FE-010"],
    max_tasks: 2,
    created_at: 1_000,
    updated_at: 1_000,
    halt_reason: null,
    ...overrides,
  };
}

function makeTasks(): LedgerTask[] {
  return [
    {
      run_id: runId, task_id: "BE-004", status: "PLANNED", owner: AgentStage.BACKEND_ENGINEER, phase: 1,
      depends_on: [], produces: ["Contract:OrderSummary.v2"], consumes: [], task_hash: HASH_A, position: 0, updated_at: 1_000,
    },
    {
      run_id: runId, task_id: "FE-010", status: "PLANNED", owner: AgentStage.FRONTEND_ENGINEER, phase: 1,
      depends_on: ["BE-004"], produces: [], consumes: ["Contract:OrderSummary.v2"], task_hash: HASH_B, position: 1, updated_at: 1_000,
    },
  ];
}

function makeAttempt(overrides: Partial<LedgerAttempt> = {}): LedgerAttempt {
  return {
    attempt_id: attemptId(runId, "BE-004", AgentStage.BACKEND_ENGINEER, 1),
    run_id: runId, task_id: "BE-004", stage: AgentStage.BACKEND_ENGINEER, attempt: 1, status: "FROZEN",
    requested: { runtime: "claude-code", model: "claude-opus-5", effort: "high" },
    observed: { runtime: "claude-code", model: "claude-opus-5", effort: "high" },
    model_explicit: true,
    route_basis: "level-2;task-tier:T2/task-tier:T2",
    tier: "T2",
    adapter_version: "claude-code@1",
    config_hash: HASH_A, plan_hash: HASH_C, base_revision: "abc1234",
    capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
    guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [path.join(root, "target")] },
    packet_hash: HASH_B, packet_path: ".workflow/packets/BE-004/backend-engineer-1.json",
    started_at: 2_000, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ledger-"));
  store = new SqliteTaskStore(path.join(root, "state.db"));
  ledger = new SqliteRunLedger(store, { projectRoot: root });
  runId = createRunId();
});

afterEach(() => {
  try { ledger.close(); } catch { /* already closed by a test */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T-V8-016 — one transition vocabulary", () => {
  it("publishes one table for all three levels and refuses an illegal move with the legal set", () => {
    const vocabulary = transitionVocabulary();
    expect(Object.keys(vocabulary)).toEqual(["run", "task", "attempt"]);
    expect(vocabulary.run.COMPLETED).toEqual([]);
    expect(() => applyRunStatus("R", "COMPLETED", "RUNNING")).toThrow(LedgerTransitionError);
    try {
      applyTaskStatus("T", "DONE", "RUNNING");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerTransitionError);
      expect((error as LedgerTransitionError).allowed).toEqual([]);
      expect((error as Error).message).toContain("reconcile the durable record");
    }
  });

  it("treats a replayed transition as idempotent rather than a conflict", () => {
    expect(applyRunStatus("R", "RUNNING", "RUNNING")).toEqual({ status: "RUNNING", idempotent: true });
    expect(applyTaskStatus("T", "CHECKPOINTED", "CHECKPOINTED").idempotent).toBe(true);
    expect(applyAttemptStatus("A", "FROZEN", "RUNNING")).toEqual({ status: "RUNNING", idempotent: false });
  });
});

describe("T-V8-016 — transactions and crash consistency", () => {
  it("rolls ledger and task rows back together when the unit throws", () => {
    expect(() =>
      store.transaction(() => {
        ledger.createRun(makeRun());
        ledger.registerTasks(makeTasks());
        store.createTask(newPersistedTask({
          taskId: "BE-004",
          classification: { level: TaskLevel.SMALL, pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sensitiveGate: false, reasons: [] },
          machine: { pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sequence: [TaskState.CREATED], current: TaskState.CREATED, history: [] },
          now: 1,
        }));
        throw new Error("simulated crash between writes");
      }),
    ).toThrow(/simulated crash/);
    expect(ledger.readRun(runId)).toBeNull();
    expect(ledger.listRuns()).toEqual([]);
    expect(store.loadTask("BE-004")).toBeNull();
  });

  it("survives a process crash: what committed is on disk, what did not is absent", () => {
    const file = path.join(root, "state.db");
    store.transaction(() => {
      ledger.createRun(makeRun());
      ledger.registerTasks(makeTasks());
    });
    try { store.transaction(() => { ledger.setTaskStatus(runId, "BE-004", "READY"); throw new Error("power cut"); }); } catch { /* expected */ }
    store.close(); // the process ends here

    const reopened = new SqliteTaskStore(file);
    const afterCrash = new SqliteRunLedger(reopened, { projectRoot: root });
    try {
      expect(afterCrash.readRun(runId)?.status).toBe("CREATED");
      expect(afterCrash.readTasks(runId).map((t) => t.status)).toEqual(["PLANNED", "PLANNED"]);
    } finally {
      afterCrash.close();
    }
    store = new SqliteTaskStore(file);
    ledger = new SqliteRunLedger(store, { projectRoot: root });
  });

  it("joins a nested transaction rather than opening a second one", () => {
    store.transaction(() => {
      ledger.createRun(makeRun());
      ledger.registerTasks(makeTasks());
      // setTaskStatus opens its own transaction internally.
      ledger.setTaskStatus(runId, "BE-004", "READY");
    });
    expect(ledger.readTask(runId, "BE-004")?.status).toBe("READY");
  });

  it("MemoryTaskStore rolls back identically, so tests written against it mean something", () => {
    const memory = new MemoryTaskStore();
    const task = newPersistedTask({
      taskId: "BE-004",
      classification: { level: TaskLevel.SMALL, pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sensitiveGate: false, reasons: [] },
      machine: { pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sequence: [TaskState.CREATED], current: TaskState.CREATED, history: [] },
      now: 1,
    });
    expect(() => memory.transaction(() => { memory.createTask(task); throw new Error("rollback"); })).toThrow(/rollback/);
    expect(memory.loadTask("BE-004")).toBeNull();
    memory.transaction(() => memory.createTask(task));
    expect(memory.loadTask("BE-004")).not.toBeNull();
  });
});

describe("T-V8-016 — idempotency and actionable conflicts", () => {
  beforeEach(() => {
    store.transaction(() => { ledger.createRun(makeRun()); ledger.registerTasks(makeTasks()); });
  });

  it("accepts a byte-identical replayed create and refuses a changed one", () => {
    expect(() => ledger.createRun(makeRun())).not.toThrow();
    expect(() => ledger.createRun(makeRun({ boundary: "done" }))).toThrow(LedgerConflictError);
    expect(ledger.readRun(runId)?.boundary).toBe("qa");
  });

  it("never lets a fixed run gain or replace a task", () => {
    expect(() => ledger.registerTasks([makeTasks()[0]!])).toThrow(/already registered/);
  });

  it("replays a status transition without duplicating an event, and refuses an illegal one", () => {
    ledger.setRunStatus(runId, "REGISTERED");
    ledger.setRunStatus(runId, "REGISTERED");
    expect(ledger.eventsForRun(runId).filter((e) => e.kind === "RUN_STATUS")).toHaveLength(1);
    ledger.setRunStatus(runId, "RUNNING");
    ledger.setRunStatus(runId, "COMPLETED", { reason: "every task settled" });
    expect(() => ledger.setRunStatus(runId, "RUNNING")).toThrow(LedgerTransitionError);
  });

  it("refuses a changed attempt freeze and accepts an identical replay", () => {
    ledger.freezeAttempt(makeAttempt());
    expect(() => ledger.freezeAttempt(makeAttempt())).not.toThrow();
    expect(() => ledger.freezeAttempt(makeAttempt({ observed: { runtime: "codex", model: null, effort: null } }))).toThrow(
      /already frozen with different inputs/,
    );
    expect(ledger.readAttempt(makeAttempt().attempt_id)?.observed.runtime).toBe("claude-code");
  });

  it("names what is missing rather than returning an empty answer", () => {
    expect(() => ledger.setTaskStatus(runId, "NOPE-1", "READY")).toThrow(LedgerNotFoundError);
    expect(() => ledger.readiness("01HZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(LedgerNotFoundError);
  });
});

describe("T-V8-016 — readiness, checkpoints and read-through state", () => {
  beforeEach(() => {
    store.transaction(() => { ledger.createRun(makeRun()); ledger.registerTasks(makeTasks()); });
  });

  it("answers readiness from the frozen DAG, not from a plan file", () => {
    expect(ledger.readiness(runId)).toEqual({ ready: ["BE-004"], waiting: [{ task_id: "FE-010", waiting_on: ["BE-004"] }], blocked: [], settled: [] });
    ledger.setTaskStatus(runId, "BE-004", "READY");
    ledger.setTaskStatus(runId, "BE-004", "RUNNING");
    ledger.setTaskStatus(runId, "BE-004", "VERIFYING");
    ledger.setTaskStatus(runId, "BE-004", "CHECKPOINTED");
    expect(ledger.readiness(runId)).toEqual({ ready: ["FE-010"], waiting: [], blocked: [], settled: ["BE-004"] });
  });

  it("treats a blocked upstream as unsatisfiable rather than skippable", () => {
    ledger.setTaskStatus(runId, "BE-004", "BLOCKED", { reason: "human gate" });
    const readiness = ledger.readiness(runId);
    expect(readiness.blocked).toEqual(["BE-004"]);
    expect(readiness.ready).toEqual([]);
    expect(readiness.waiting).toEqual([{ task_id: "FE-010", waiting_on: ["BE-004"] }]);
  });

  it("records a checkpoint once and reads retries/approvals through their own authority", () => {
    ledger.freezeAttempt(makeAttempt());
    const checkpoint = { run_id: runId, task_id: "BE-004", attempt_id: makeAttempt().attempt_id, sha: "def5678", packet_hash: HASH_B, at: 3_000 };
    ledger.recordCheckpoint(checkpoint);
    ledger.recordCheckpoint(checkpoint);
    expect(ledger.checkpointsForRun(runId)).toHaveLength(1);
    expect([...ledger.checkpointedTaskIds(runId)]).toEqual(["BE-004"]);
    // No task row exists in the TaskStore, so read-through says "unknown",
    // never a fabricated zero.
    expect(ledger.retriesFor("BE-004")).toBeNull();
    expect(ledger.approvalsFor("BE-004")).toBeNull();
    expect(ledger.findingsFor("BE-004")).toEqual([]);
  });

  it("refuses to guess between two unfinished runs for one module", () => {
    expect(ledger.activeRun({ module: "orders" })?.run_id).toBe(runId);
    const second = createRunId();
    ledger.createRun(makeRun({ run_id: second, run_branch: `sta/run/${second}` }));
    expect(() => ledger.activeRun({ module: "orders" })).toThrow(LedgerAmbiguityError);
    ledger.setRunStatus(second, "CANCELLED", { reason: "operator abandoned it" });
    expect(ledger.activeRun({ module: "orders" })?.run_id).toBe(runId);
  });
});

describe("T-V8-016 — stale identity refuses before anything runs", () => {
  it("names every drifted field at once", () => {
    const run = makeRun();
    expect(() => assertRunIdentity(run, { planHash: HASH_C, staVersion: "2.0.0" })).not.toThrow();
    try {
      assertRunIdentity(run, { planHash: HASH_A, staVersion: "9.9.9", targetRoot: "/elsewhere" });
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("plan_hash");
      expect(message).toContain("sta_version");
      expect(message).toContain("target_root");
      expect(message).toContain("recompile explicitly");
    }
  });

  it("ignores an expectation the caller could not resolve rather than reading it as drift", () => {
    expect(() => assertRunIdentity(makeRun(), {})).not.toThrow();
  });
});

describe("T-V8-016 — versioned compatibility adapters (dual-read, never dual-write)", () => {
  it("round-trips a persisted task's pipeline state into ledger vocabulary without changing meaning", () => {
    const base = newPersistedTask({
      taskId: "BE-004",
      classification: { level: TaskLevel.SMALL, pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sensitiveGate: false, reasons: [] },
      machine: { pipeline: [AgentStage.BACKEND_ENGINEER], requiresHumanApproval: false, sequence: [TaskState.CREATED], current: TaskState.CREATED, history: [] },
      now: 1,
    });
    const at = (current: TaskState) => ({ ...base, machine: { ...base.machine, current } });
    expect(ledgerTaskStatusFromPersisted(at(TaskState.CREATED))).toBe("PLANNED");
    expect(ledgerTaskStatusFromPersisted(at(TaskState.IMPLEMENTATION))).toBe("RUNNING");
    expect(ledgerTaskStatusFromPersisted(at(TaskState.QA))).toBe("VERIFYING");
    expect(ledgerTaskStatusFromPersisted(at(TaskState.READY_TO_DEPLOY))).toBe("CHECKPOINTED");
    expect(ledgerTaskStatusFromPersisted(at(TaskState.DEPLOYED))).toBe("DONE");
    expect(ledgerTaskStatusFromPersisted(at(TaskState.BLOCKED))).toBe("BLOCKED");
    // A human freeze is invisible to the pipeline machine but decisive for a run.
    expect(ledgerTaskStatusFromPersisted({ ...at(TaskState.IMPLEMENTATION), paused: true })).toBe("BLOCKED");
    expect(ledgerTaskStatusFromPersisted({ ...at(TaskState.IMPLEMENTATION), cancelled: true })).toBe("BLOCKED");
  });

  it("projects a real wave run into ledger vocabulary and leaves its files untouched", () => {
    const waveRunId = createRunId();
    const manifest: RunManifest = {
      run_id: waveRunId, created_at: new Date(5_000).toISOString(), target_root: path.join(root, "target"),
      target_id: "orders-target", knowledge_root: path.join(root, "knowledge"), module: "orders", wave: 1,
      plan_hash: HASH_C, task_order: ["BE-004", "FE-010"], base_branch: "main", base_sha: "abc1234",
      run_branch: `sta/run/${waveRunId}`, runtime_id: "claude-code", tier: "T2", model: "claude-opus-5",
      max_tasks: 2, sta_version: "2.0.0",
    };
    writeLegacyWaveRun(root, manifest);
    for (const record of [
      { ts: new Date(5_001).toISOString(), kind: "RUN_STARTED" as const },
      { ts: new Date(5_002).toISOString(), kind: "RUN_ISOLATED" as const },
      { ts: new Date(5_003).toISOString(), kind: "TASK_READY" as const, task_id: "BE-004" },
      { ts: new Date(5_004).toISOString(), kind: "TASK_STARTED" as const, task_id: "BE-004" },
      { ts: new Date(5_005).toISOString(), kind: "TASK_AGENT_DONE" as const, task_id: "BE-004" },
      { ts: new Date(5_006).toISOString(), kind: "TASK_CHECKPOINTED" as const, task_id: "BE-004", sha: "def5678" },
    ]) appendLegacyWaveRecord(root, waveRunId, record);
    const journalBefore = fs.readFileSync(path.join(root, ".workflow", "wave-runs", waveRunId, "journal.jsonl"), "utf8");

    const owners = new Map([["BE-004", AgentStage.BACKEND_ENGINEER], ["FE-010", AgentStage.FRONTEND_ENGINEER]]);
    const projected = projectWaveRun(root, waveRunId, { taskOwners: owners });
    expect(projected.adapter_version).toBe(LEDGER_ADAPTER_VERSION);
    expect(projected.run.status).toBe("RUNNING");
    expect(projected.run.boundary).toBe("next-gate");
    // Facts a wave manifest never recorded are null, never substituted.
    expect(projected.run.config_hash).toBeNull();
    expect(projected.tasks.map((t) => t.task_hash)).toEqual([null, null]);
    expect(projected.checkpoints).toEqual([
      { run_id: waveRunId, task_id: "BE-004", attempt_id: null, sha: "def5678", packet_hash: null, at: 5_006 },
    ]);
    expect(projected.tasks.map((t) => [t.task_id, t.status])).toEqual([["BE-004", "CHECKPOINTED"], ["FE-010", "PLANNED"]]);
    expect(projected.events).toHaveLength(6);
    expect(fs.readFileSync(path.join(root, ".workflow", "wave-runs", waveRunId, "journal.jsonl"), "utf8")).toBe(journalBefore);

    expect(() => projectWaveRun(root, waveRunId)).toThrow(LedgerAdapterError);
    expect(() => projectWaveRun(root, waveRunId)).toThrow(/records no owner for BE-004/);
  });

  it("lets exactly one store claim current truth for a run id", () => {
    const waveRunId = createRunId();
    writeLegacyWaveRun(root, {
      run_id: waveRunId, created_at: new Date(5_000).toISOString(), target_root: path.join(root, "target"),
      target_id: "orders-target", knowledge_root: path.join(root, "knowledge"), module: "orders", wave: 1,
      plan_hash: HASH_C, task_order: ["BE-004"], base_branch: "main", base_sha: "abc1234",
      run_branch: `sta/run/${waveRunId}`, runtime_id: "claude-code", tier: "T2", model: "claude-opus-5",
      max_tasks: 1, sta_version: "2.0.0",
    });
    // The same id present in BOTH stores still resolves to exactly one authority.
    expect(resolveExecutionAuthority({ projectRoot: root, runId: waveRunId, ledgerHasRun: true }).authority).toBe("ledger");
    expect(resolveExecutionAuthority({ projectRoot: root, runId: waveRunId, ledgerHasRun: false }).authority).toBe("legacy-wave-journal");
    expect(() => resolveExecutionAuthority({ projectRoot: root, runId: createRunId(), ledgerHasRun: false })).toThrow(
      /exists in neither the ledger nor/,
    );
  });

  it("refuses a ledger record written by a version this build cannot read", () => {
    store.transaction(() => { ledger.createRun(makeRun()); ledger.registerTasks(makeTasks()); });
    const raw = new Database(path.join(root, "state.db"));
    try {
      raw.prepare("UPDATE ledger_runs SET record = ? WHERE run_id = ?").run(JSON.stringify({ ...makeRun(), ledger_version: 99 }), runId);
    } finally {
      raw.close();
    }
    expect(() => ledger.readRun(runId)).toThrow(/ledger version 99/);
  });
});

describe("T-V8-016 — JSON audit export is an export, not an authority", () => {
  beforeEach(() => {
    store.transaction(() => { ledger.createRun(makeRun()); ledger.registerTasks(makeTasks()); });
    ledger.setRunStatus(runId, "REGISTERED");
    ledger.freezeAttempt(makeAttempt());
    ledger.recordCheckpoint({ run_id: runId, task_id: "BE-004", attempt_id: makeAttempt().attempt_id, sha: "def5678", packet_hash: HASH_B, at: 3_000 });
  });

  it("exports every record with the vocabulary it was produced under, and round-trips", () => {
    const exported = exportRunAudit(ledger, runId);
    expect(exported.export_version).toBe(1);
    expect(exported.ledger_version).toBe(LEDGER_SCHEMA_VERSION);
    expect(exported.vocabulary.run.CREATED).toEqual(["REGISTERED", "REFUSED", "CANCELLED"]);
    expect(exported.tasks.map((t) => t.task_id)).toEqual(["BE-004", "FE-010"]);
    expect(exported.attempts).toHaveLength(1);
    expect(exported.checkpoints).toHaveLength(1);
    expect(exported.events.length).toBeGreaterThan(0);
    expect(() => assertAuditRoundTrip(exported)).not.toThrow();
  });

  it("refuses an export that is internally inconsistent instead of half-recovering it", () => {
    const exported = exportRunAudit(ledger, runId);
    expect(() => importRunAudit({ ...exported, tasks: [exported.tasks[0]] })).toThrow(/frozen task_order/);
    expect(() => importRunAudit({ ...exported, checkpoints: [{ ...exported.checkpoints[0]!, task_id: "GHOST-1" }] })).toThrow(
      /unknown task GHOST-1/,
    );
    expect(() => importRunAudit({ ...exported, export_version: 2 })).toThrow(/does not match the current contract/);
  });

  it("does not become a second authority: the ledger still answers state after an export exists", () => {
    const exported = exportRunAudit(ledger, runId);
    ledger.setRunStatus(runId, "RUNNING");
    expect(exported.run.status).toBe("REGISTERED");
    expect(ledger.readRun(runId)?.status).toBe("RUNNING");
  });
});
