import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { MemoryTaskStore } from "./memoryStore.js";
import { SchemaVersionMismatchError, SqliteTaskStore } from "./sqliteStore.js";
import {
  PersistedStateCorruptError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  newPersistedTask,
  type PersistedTask,
  type TaskStore,
} from "./taskStore.js";
import type { RunRecord } from "../observability/runLog.js";

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
    tokens: 1234,
    cost: 0.5,
    result: "PASS",
    retry_count: 0,
    failure_reason: null,
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

  it("keeps events per task as an audit trail", () => {
    const store = makeStore();
    store.appendEvent({ taskId: "T-1", at: 1, type: "AGENT_ASSIGNED", payload: { stage: "backend-engineer" } });
    store.appendEvent({ taskId: "T-2", at: 2, type: "TASK_BLOCKED", payload: { reason: "nope" } });
    expect(store.eventsForTask("T-1")).toEqual([
      { taskId: "T-1", at: 1, type: "AGENT_ASSIGNED", payload: { stage: "backend-engineer" } },
    ]);
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
});
