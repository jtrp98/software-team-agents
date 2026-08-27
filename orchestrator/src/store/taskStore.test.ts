import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { MemoryTaskStore } from "./memoryStore.js";
import { DatabaseUnavailableError, SchemaVersionMismatchError, SqliteTaskStore } from "./sqliteStore.js";
import {
  PersistedStateCorruptError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  newPersistedTask,
  type PersistedTask,
  type TaskStore,
} from "./taskStore.js";
import type { RunRecord } from "../observability/runLog.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import type { AgentExecutor, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";

// Deliberately a two-stage pipeline (backend-engineer -> qa-engineer) with no human gate at all
// (no system-analyst/schema-confirmation, no deploy approval) — these tests are about
// resume/idempotency mechanics, not about driving through the five always-human stops, which
// are covered elsewhere (gatePolicy.test.ts et al). Same classification sampleTask() already uses.
const trivial = () => classifyTask({ isClearBugFix: true, touchesBackend: true });

function passingQaReport(): QaReportArtifact {
  return {
    taskId: "T-1",
    status: "PASS",
    mode: "FULL",
    requirements: {},
    tests: { passed: 1, failed: 0 },
    evidence: ["ok"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

/** Every stage PASSes immediately (qa-engineer additionally reports a passing QA_REPORT artifact, since the QA->READY_TO_DEPLOY gate checks that, not just outcome.result) — enough to drive a task from CREATED to DEPLOYED without a human gate in the way. */
function makeExecutor(overrides: Partial<Record<AgentStage, () => AgentExecutorResult>> = {}): AgentExecutor {
  return (req) => {
    const override = overrides[req.stage];
    if (override) return override();
    if (req.stage === AgentStage.QA_ENGINEER) {
      return {
        outcome: { tokens: 10, cost: 0.001, result: "PASS" },
        artifactType: ArtifactType.QA_REPORT,
        artifact: passingQaReport(),
      };
    }
    return { outcome: { tokens: 10, cost: 0.001, result: "PASS" } };
  };
}

function sampleTask(taskId = "T-1"): PersistedTask {
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  return newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, classification.requiresHumanApproval),
    now: 1_000,
  });
}

function sampleRun(taskId = "T-1"): RunRecord {
  return {
    task_id: taskId,
    agent: AgentStage.BACKEND_ENGINEER,
    start_time: 10,
    end_time: 60,
    duration: 50,
    model: "sonnet",
    promptVersion: 1,
    tokens: 1234,
    cost: 0.5,
    result: "PASS",
    retry_count: 0,
    failure_reason: null,
    input_tokens: 1000,
    output_tokens: 234,
    cache_read_tokens: null,
    context_chars: 4000,
    qa_mode: null,
    deterministic_gate: null,
    runtime: "claude-code",
    session_kind: "orchestrated",
    static_chars: 500,
    handoff_chars: 300,
    doc_chars: 2500,
    doc_chars_before: 4000,
    knowledge_chars: 200,
    code_intel_chars: 400,
    tool_output_chars: 100,
    context_budget_chars: null,
    context_budget_source: null,
    context_overflow_chars: null,
    context_budget_warning: null,
    context_base_chars: null,
    context_task_chars: null,
    context_safety_chars: null,
    context_docs_chars: null,
    context_knowledge_chars: null,
    context_code_chars: null,
    context_tool_output_chars: null,
    context_reserve_chars: null,
  };
}

/**
 * One suite, both implementations. The in-memory store exists so the rest of
 * the suite never touches disk — which is only safe if it behaves identically
 * to the store a real run uses. Anything asserted here is asserted about both.
 */
const implementations: [string, () => TaskStore][] = [
  ["MemoryTaskStore", () => new MemoryTaskStore()],
  ["SqliteTaskStore(:memory:)", () => new SqliteTaskStore(":memory:")],
];

describe.each(implementations)("%s", (_name, makeStore) => {
  it("round-trips a task unchanged", () => {
    const store = makeStore();
    const task = sampleTask();
    store.createTask(task);
    expect(store.loadTask("T-1")).toEqual(task);
    store.close();
  });

  it("returns null for a task it has never seen", () => {
    const store = makeStore();
    expect(store.loadTask("nope")).toBeNull();
    store.close();
  });

  it("refuses to create the same task twice instead of overwriting it", () => {
    const store = makeStore();
    store.createTask(sampleTask());
    expect(() => store.createTask(sampleTask())).toThrow(TaskAlreadyExistsError);
    store.close();
  });

  it("refuses to save a task that was never created", () => {
    const store = makeStore();
    expect(() => store.saveTask(sampleTask())).toThrow(TaskNotFoundError);
    store.close();
  });

  it("saves state changes and keeps human approvals across a reload", () => {
    const store = makeStore();
    const task = sampleTask();
    store.createTask(task);
    store.saveTask({
      ...task,
      updatedAt: 2_000,
      pipelineCursor: 2,
      retries: { qa: 1, security: 0 },
      gateContext: { designApproved: true, humanApproved: true },
      blockedReason: "waiting on a person",
    });
    const loaded = store.loadTask("T-1")!;
    expect(loaded.pipelineCursor).toBe(2);
    expect(loaded.retries.qa).toBe(1);
    expect(loaded.gateContext).toEqual({ designApproved: true, humanApproved: true });
    expect(loaded.blockedReason).toBe("waiting on a person");
    store.close();
  });

  it("hands back copies, never a live reference into the store", () => {
    const store = makeStore();
    store.createTask(sampleTask());
    const first = store.loadTask("T-1")!;
    first.pipelineCursor = 99;
    first.machine.current = TaskState.DEPLOYED;
    expect(store.loadTask("T-1")!.pipelineCursor).toBe(0);
    expect(store.loadTask("T-1")!.machine.current).toBe(TaskState.CREATED);
    store.close();
  });

  it("lists tasks oldest first", () => {
    const store = makeStore();
    store.createTask({ ...sampleTask("T-2"), createdAt: 5_000 });
    store.createTask({ ...sampleTask("T-1"), createdAt: 1_000 });
    expect(store.listTasks().map((t) => t.taskId)).toEqual(["T-1", "T-2"]);
    store.close();
  });

  it("keeps runs per task, in the order they were appended", () => {
    const store = makeStore();
    store.appendRun(sampleRun("T-1"));
    store.appendRun({ ...sampleRun("T-1"), agent: AgentStage.QA_ENGINEER, result: "FAIL", failure_reason: "typecheck" });
    store.appendRun(sampleRun("T-2"));

    const runs = store.runsForTask("T-1");
    expect(runs.map((r) => r.agent)).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER]);
    expect(runs[1].failure_reason).toBe("typecheck");
    expect(store.runsForTask("T-2")).toHaveLength(1);
    store.close();
  });

  it("round-trips the T26/T28 fields (model, token breakdown, cache reads, context size), nulls included", () => {
    const store = makeStore();
    store.appendRun(sampleRun("T-1"));
    store.appendRun({ ...sampleRun("T-1"), agent: AgentStage.QA_ENGINEER, model: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, context_chars: null });

    const runs = store.runsForTask("T-1");
    expect(runs[0]).toMatchObject({ model: "sonnet", input_tokens: 1000, output_tokens: 234, cache_read_tokens: null, context_chars: 4000 });
    expect(runs[1]).toMatchObject({ model: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, context_chars: null });
    store.close();
  });

  it("round-trips T-V3TOK-001 runtime and prompt composition fields, including truthful nulls", () => {
    const store = makeStore();
    store.appendRun(sampleRun("T-1"));
    store.appendRun({ ...sampleRun("T-1"), runtime: "codex", session_kind: "interactive", static_chars: 9, handoff_chars: null, doc_chars: null, knowledge_chars: null, code_intel_chars: null, tool_output_chars: null });
    expect(store.runsForTask("T-1")).toMatchObject([
      { runtime: "claude-code", session_kind: "orchestrated", static_chars: 500, doc_chars: 2500 },
      { runtime: "codex", session_kind: "interactive", static_chars: 9, handoff_chars: null, doc_chars: null },
    ]);
    store.close();
  });

  it("records whether optimized QA used the deterministic gate or its explicit escape hatch", () => {
    const store = makeStore();
    store.appendRun({ ...sampleRun("T-1"), agent: AgentStage.QA_ENGINEER, deterministic_gate: "enabled" });
    store.appendRun({ ...sampleRun("T-1"), agent: AgentStage.QA_ENGINEER, deterministic_gate: "disabled" });

    expect(store.runsForTask("T-1").map((run) => run.deterministic_gate)).toEqual(["enabled", "disabled"]);
    store.close();
  });

  it("keeps events per task as an audit trail", () => {
    const store = makeStore();
    store.appendEvent({ taskId: "T-1", at: 1, type: "AGENT_ASSIGNED", payload: { stage: "backend-engineer" } });
    store.appendEvent({ taskId: "T-2", at: 2, type: "TASK_BLOCKED", payload: { reason: "nope" } });
    // T37's audit fields are optional on the way in and always present on the way
    // out — explicitly null, so "not recorded" is a value rather than an absence.
    expect(store.eventsForTask("T-1")).toEqual([
      {
        taskId: "T-1",
        at: 1,
        type: "AGENT_ASSIGNED",
        payload: { stage: "backend-engineer" },
        actor: null,
        reason: null,
        input: null,
        output: null,
        decision: null,
      },
    ]);
    store.close();
  });

  it("round-trips the audit fields an emitter did record (T37)", () => {
    const store = makeStore();
    store.appendEvent({
      taskId: "T-1",
      at: 3,
      type: "QA_FAILED",
      payload: { round: 1 },
      actor: "qa-engineer",
      reason: "API response mismatch",
      input: "design, plan",
      output: "FAIL (round 1)",
      decision: "retry:backend-engineer",
    });
    expect(store.eventsForTask("T-1")[0]).toMatchObject({
      actor: "qa-engineer",
      reason: "API response mismatch",
      input: "design, plan",
      output: "FAIL (round 1)",
      decision: "retry:backend-engineer",
    });
    store.close();
  });

  it("rejects stored state that no longer matches the schema rather than resuming from it", () => {
    const store = makeStore();
    const task = sampleTask();
    store.createTask(task);
    store.saveTask({ ...task, machine: { ...task.machine, current: "NOT_A_STATE" as TaskState } });
    expect(() => store.loadTask("T-1")).toThrow(PersistedStateCorruptError);
    store.close();
  });
});

describe("SqliteTaskStore — the durability the in-memory store cannot prove", () => {
  function tmpDbPath(): string {
    return path.join(os.tmpdir(), `orchestrator-t01-${Date.now()}-${Math.random().toString(36).slice(2)}`, "state.db");
  }

  it("survives the process that wrote it: a reopened file still has the task, its runs and its events", () => {
    const file = tmpDbPath();
    try {
      const first = new SqliteTaskStore(file);
      const task = sampleTask();
      first.createTask(task);
      first.saveTask({ ...task, pipelineCursor: 3, gateContext: { designApproved: true } });
      first.appendRun(sampleRun());
      first.appendEvent({ taskId: "T-1", at: 7, type: "AGENT_ASSIGNED", payload: { stage: "qa-engineer" } });
      first.close();

      const second = new SqliteTaskStore(file);
      const loaded = second.loadTask("T-1")!;
      expect(loaded.pipelineCursor).toBe(3);
      expect(loaded.gateContext.designApproved).toBe(true);
      expect(second.runsForTask("T-1")).toHaveLength(1);
      expect(second.eventsForTask("T-1")).toHaveLength(1);
      second.close();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("creates the directory it was pointed at rather than failing on a missing .workflow/", () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      store.close();
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("refuses a database written by a different schema version instead of misreading it", () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      store.close();
      const db = new Database(file);
      db.pragma("user_version = 99");
      db.close();
      expect(() => new SqliteTaskStore(file)).toThrow(SchemaVersionMismatchError);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("T47: a database it cannot open fails as DatabaseUnavailableError, not a raw fs/sqlite stack trace", () => {
    const blockingFile = tmpDbPath();
    fs.mkdirSync(path.dirname(blockingFile), { recursive: true });
    fs.writeFileSync(blockingFile, "not a directory", "utf8"); // a plain file sits where a directory needs to go
    try {
      // Asking for a db *inside* a path component that is actually a file — mkdirSync can never
      // create it, the same shape a permissions problem or a vanished mount point would produce.
      const unreachable = path.join(blockingFile, "state.db");
      expect(() => new SqliteTaskStore(unreachable)).toThrow(DatabaseUnavailableError);
    } finally {
      fs.rmSync(path.dirname(blockingFile), { recursive: true, force: true });
    }
  });

  it("T47: the message names the file and says nothing was lost — actionable, not a stack trace", () => {
    const blockingFile = tmpDbPath();
    fs.mkdirSync(path.dirname(blockingFile), { recursive: true });
    fs.writeFileSync(blockingFile, "not a directory", "utf8");
    try {
      const unreachable = path.join(blockingFile, "state.db");
      try {
        new SqliteTaskStore(unreachable);
        expect.unreachable("constructor should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DatabaseUnavailableError);
        const err = e as DatabaseUnavailableError;
        expect(err.filePath).toBe(unreachable);
        expect(err.message).toContain(unreachable);
        expect(err.message).toMatch(/nothing was written/);
      }
    } finally {
      fs.rmSync(path.dirname(blockingFile), { recursive: true, force: true });
    }
  });

  it("T47: a schema version mismatch is NOT relabelled as DatabaseUnavailableError — it's a distinct, deliberate refusal", () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      store.close();
      const db = new Database(file);
      db.pragma("user_version = 99");
      db.close();
      try {
        new SqliteTaskStore(file);
        expect.unreachable("constructor should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaVersionMismatchError);
        expect(e).not.toBeInstanceOf(DatabaseUnavailableError);
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("T57: a v3 file (predating runs.prompt_version) migrates in place — old runs read back with promptVersion: null, new runs get a real one", () => {
    const file = tmpDbPath();
    try {
      // Build a v3-shaped file by hand: same DDL as before T57, minus the new column.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE tasks (task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL, duration INTEGER NOT NULL, model TEXT, tokens INTEGER NOT NULL, cost REAL NOT NULL,
          result TEXT NOT NULL, retry_count INTEGER NOT NULL, failure_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
          cache_read_tokens INTEGER, context_chars INTEGER
        );
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT, reason TEXT, input TEXT, output TEXT, decision TEXT);
      `);
      db.exec(
        "INSERT INTO runs (task_id, agent, start_time, end_time, duration, model, tokens, cost, result, retry_count) VALUES ('T-OLD', 'backend-engineer', 1, 2, 1, 'sonnet', 100, 0.1, 'PASS', 0)",
      );
      db.pragma("user_version = 3");
      db.close();

      const store = new SqliteTaskStore(file);
      try {
        const runs = store.runsForTask("T-OLD");
        expect(runs).toHaveLength(1);
        expect(runs[0].promptVersion).toBeNull(); // pre-T57 row — not recorded, not guessed

        store.appendRun({ ...sampleRun("T-NEW"), promptVersion: 2 });
        expect(store.runsForTask("T-NEW")[0].promptVersion).toBe(2);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("T-V3TOK-001: a v6 database migrates in place without changing legacy run facts", () => {
    const file = tmpDbPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new Database(file);
      db.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, duration INTEGER NOT NULL, model TEXT, tokens INTEGER NOT NULL, cost REAL NOT NULL, result TEXT NOT NULL, retry_count INTEGER NOT NULL, failure_reason TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, context_chars INTEGER, prompt_version INTEGER, qa_mode TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT, reason TEXT, input TEXT, output TEXT, decision TEXT);`);
      db.exec("INSERT INTO runs (task_id, agent, start_time, end_time, duration, tokens, cost, result, retry_count) VALUES ('T-V6', 'backend-engineer', 1, 2, 1, 123, 0, 'PASS', 0)");
      db.pragma("user_version = 6");
      db.close();
      const store = new SqliteTaskStore(file);
      try {
        expect(store.runsForTask("T-V6")[0]).toMatchObject({ tokens: 123, runtime: null, session_kind: null, static_chars: null, doc_chars: null });
      } finally { store.close(); }
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });

  it("Phase 2: a v4 task row reads with null Target bindings without rewriting historical JSON", () => {
    const file = tmpDbPath();
    try {
      const initial = new SqliteTaskStore(file);
      initial.createTask(sampleTask("T-V4"));
      initial.close();
      const db = new Database(file);
      const row = db.prepare("SELECT state FROM tasks WHERE task_id = 'T-V4'").get() as { state: string };
      const legacy = JSON.parse(row.state) as Record<string, unknown>;
      delete legacy.targetBindings;
      db.prepare("UPDATE tasks SET state = ? WHERE task_id = 'T-V4'").run(JSON.stringify(legacy));
      db.pragma("user_version = 4");
      db.close();

      const migrated = new SqliteTaskStore(file);
      try {
        expect(migrated.loadTask("T-V4")!.targetBindings).toEqual({ frontend_target: null, backend_target: null });
      } finally { migrated.close(); }
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });

  /**
   * T33 (Resume after session death) — the store round-trip test above proves the DATA survives;
   * this proves a task can actually be picked back up and driven to completion by a brand-new
   * `Orchestrator`/`TaskRegistry` pair built on a reopened file, simulating the process that was
   * running it having been killed and a fresh one started in its place.
   */
  it("a task interrupted mid-pipeline is fully drivable to DEPLOYED by a fresh process reopening the same file", async () => {
    const file = tmpDbPath();
    try {
      const executor = makeExecutor({});

      const firstStore = new SqliteTaskStore(file);
      const firstRegistry = new TaskRegistry({ store: firstStore });
      const orch1 = firstRegistry.create({ taskId: "T-1", classification: trivial() });
      await orch1.step(executor); // one stage in, then the process "dies"
      expect(orch1.status().kind).toBe("RUNNING");
      firstStore.close();

      // A brand-new store instance and a brand-new TaskRegistry — nothing here is the same
      // in-memory object as above; only the file on disk connects them.
      const secondStore = new SqliteTaskStore(file);
      const secondRegistry = new TaskRegistry({ store: secondStore });
      const orch2 = secondRegistry.open("T-1");

      let status = orch2.status();
      let steps = 0;
      while (status.kind !== "DEPLOYED" && steps++ < 20) {
        if (status.kind === "WAITING_FOR_HUMAN") {
          // The bugfix pipeline has no schema gate, but deploy approval is always human —
          // one of the five stops that hold regardless of classification.
          orch2.provideHumanApproval("humanApproved", true);
          status = orch2.status();
          continue;
        }
        status = await orch2.step(executor);
      }
      expect(status.kind).toBe("DEPLOYED");
      secondStore.close();
    } finally {
      // better-sqlite3's WAL sidecar files can hold a Windows file handle open for a moment
      // after close() returns, under heavier write activity like this test's — the test's own
      // assertions above already ran; a leaked temp dir here is harmless, unlike a failed
      // assertion would be.
      try {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      } catch {
        /* see comment above */
      }
    }
  });

  /**
   * T34 (Idempotency) — the concrete guarantee TASKS.md asks for ("รันซ้ำต้องไม่สร้าง...ซ้ำ") is
   * that re-issuing the same task_id never produces a second, competing pipeline for the same
   * work. `TaskAlreadyExistsError` (already exercised on the in-memory store above) is the same
   * guard here, backed by SQLite's own `task_id TEXT PRIMARY KEY` — this proves it holds across a
   * process restart too, not just within one running process's memory.
   */
  it("re-creating the same task_id after a restart still throws, rather than silently starting a second pipeline for it", () => {
    const file = tmpDbPath();
    try {
      const first = new SqliteTaskStore(file);
      const firstRegistry = new TaskRegistry({ store: first });
      firstRegistry.create({ taskId: "T-1", classification: trivial() });
      first.close();

      const second = new SqliteTaskStore(file);
      const secondRegistry = new TaskRegistry({ store: second });
      expect(() => secondRegistry.create({ taskId: "T-1", classification: trivial() })).toThrow(
        TaskAlreadyExistsError,
      );
      second.close();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
