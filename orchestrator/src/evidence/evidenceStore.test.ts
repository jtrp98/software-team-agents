import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "../store/sqliteDatabase.js";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { newPersistedTask, type TaskStore } from "../store/taskStore.js";
import {
  EvidenceConflictError,
  EvidenceCorruptError,
  MissingEvidenceReferenceError,
  buildEvidence,
  evidenceIdFor,
  type EvidenceRecord,
} from "./evidenceStore.js";
import { PASSING_VERIFICATION } from "./stageEvidence.testSupport.js";

function roleRun(taskId: string, attempt: number, result: "PASS" | "FAIL" = "PASS"): EvidenceRecord {
  return buildEvidence({
    taskId,
    stage: AgentStage.BACKEND_ENGINEER,
    attempt,
    role: "backend-engineer",
    subject: "run",
    payload: {
      kind: "role-run",
      result,
      failureReason: result === "FAIL" ? "boom" : null,
      runtime: "claude-code",
      model: null,
      packetPath: null,
      deployPhase: null,
      startedAt: 1,
      endedAt: 2,
      contractDigest: "a".repeat(64),
    },
    refs: [],
    recordedAt: 3,
  });
}

function verification(taskId: string, attempt: number, refs: string[]): EvidenceRecord {
  return buildEvidence({
    taskId,
    stage: AgentStage.BACKEND_ENGINEER,
    attempt,
    role: "orchestrator",
    subject: "post-dev-verification",
    payload: { kind: "deterministic-verification", verification: PASSING_VERIFICATION },
    refs,
    recordedAt: 4,
  });
}

function seed(store: TaskStore, taskId = "T-EV"): void {
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  store.createTask(
    newPersistedTask({
      taskId,
      classification,
      machine: initTaskMachine(classification.pipeline, classification.requiresHumanApproval),
      now: 1,
    }),
  );
}

const implementations: [string, () => TaskStore][] = [
  ["MemoryTaskStore", () => new MemoryTaskStore()],
  ["SqliteTaskStore(:memory:)", () => new SqliteTaskStore(":memory:")],
];

describe.each(implementations)("evidence store — %s (V13 TASK-002)", (_name, makeStore) => {
  it("derives a stable id from task/stage/attempt/kind/subject and a digest from content", () => {
    const record = roleRun("T-EV", 1);
    expect(record.evidenceId).toBe(
      evidenceIdFor({ taskId: "T-EV", stage: AgentStage.BACKEND_ENGINEER, attempt: 1, kind: "role-run", subject: "run" }),
    );
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(roleRun("T-EV", 1).digest).toBe(record.digest);
  });

  it("appends and queries records by task in recording order", () => {
    const store = makeStore();
    seed(store);
    const run = store.appendEvidence(roleRun("T-EV", 1));
    const sweep = store.appendEvidence(verification("T-EV", 1, [run.evidenceId]));
    expect(store.evidenceForTask("T-EV").map((r) => r.evidenceId)).toEqual([run.evidenceId, sweep.evidenceId]);
    expect(store.loadEvidence(sweep.evidenceId)).toEqual(sweep);
    expect(store.evidenceForTask("other")).toEqual([]);
    store.close();
  });

  it("is idempotent for a duplicate attempt record and refuses a conflicting rewrite", () => {
    const store = makeStore();
    seed(store);
    const first = store.appendEvidence(roleRun("T-EV", 1, "PASS"));
    expect(store.appendEvidence(roleRun("T-EV", 1, "PASS"))).toEqual(first);
    expect(store.evidenceForTask("T-EV")).toHaveLength(1);
    // Same identity (task/stage/attempt/kind/subject), different content: never rewritten.
    expect(() => store.appendEvidence(roleRun("T-EV", 1, "FAIL"))).toThrow(EvidenceConflictError);
    expect(store.evidenceForTask("T-EV")).toEqual([first]);
    store.close();
  });

  it("refuses a record whose reference does not exist for the same task", () => {
    const store = makeStore();
    seed(store);
    seed(store, "T-OTHER");
    const foreign = store.appendEvidence(roleRun("T-OTHER", 1));
    expect(() => store.appendEvidence(verification("T-EV", 1, [`evd_${"f".repeat(32)}`]))).toThrow(MissingEvidenceReferenceError);
    // A record of another task is not a valid reference either.
    expect(() => store.appendEvidence(verification("T-EV", 1, [foreign.evidenceId]))).toThrow(MissingEvidenceReferenceError);
    expect(store.evidenceForTask("T-EV")).toEqual([]);
    store.close();
  });

  it("refuses a hand-built record whose digest does not match its content", () => {
    const store = makeStore();
    seed(store);
    const record = roleRun("T-EV", 1);
    expect(() => store.appendEvidence({ ...record, digest: "0".repeat(64) })).toThrow(EvidenceCorruptError);
    expect(() => store.appendEvidence({ ...record, evidenceId: `evd_${"1".repeat(32)}` })).toThrow(EvidenceCorruptError);
    store.close();
  });

  it("rolls evidence back with the rest of a failed transaction", () => {
    const store = makeStore();
    seed(store);
    expect(() =>
      store.transaction(() => {
        store.appendEvidence(roleRun("T-EV", 1));
        throw new Error("state change refused");
      }),
    ).toThrow("state change refused");
    expect(store.evidenceForTask("T-EV")).toEqual([]);
    store.close();
  });
});

describe("evidence store on a real file (V13 TASK-002)", () => {
  function tmpDbPath(): string {
    return path.join(os.tmpdir(), `sta-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`, "state.db");
  }

  it("survives the process that wrote it, and a corrupted row fails loudly instead of being trusted", () => {
    const file = tmpDbPath();
    try {
      const writer = new SqliteTaskStore(file);
      seed(writer);
      const run = writer.appendEvidence(roleRun("T-EV", 1));
      writer.close();

      const reader = new SqliteTaskStore(file);
      expect(reader.evidenceForTask("T-EV")).toEqual([run]);
      reader.close();

      // Someone edits the database file by hand: the payload no longer matches its digest.
      const raw = new Database(file);
      const row = raw.prepare("SELECT record FROM evidence WHERE evidence_id = ?").get(run.evidenceId) as { record: string };
      const tampered = JSON.parse(row.record) as EvidenceRecord;
      (tampered.payload as { result: string }).result = "FAIL";
      raw.prepare("UPDATE evidence SET record = ? WHERE evidence_id = ?").run(JSON.stringify(tampered), run.evidenceId);
      raw.close();

      const after = new SqliteTaskStore(file);
      expect(() => after.evidenceForTask("T-EV")).toThrow(EvidenceCorruptError);
      expect(() => after.loadEvidence(run.evidenceId)).toThrow(/digest does not match/);
      after.close();
    } finally {
      try {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      } catch {
        /* Windows may hold the WAL handle briefly; a leaked temp dir is harmless */
      }
    }
  });

  it("migrates a v19 file by adding the empty evidence table, reading no historical byte", () => {
    const file = tmpDbPath();
    try {
      const store = new SqliteTaskStore(file);
      store.close();
      const raw = new Database(file);
      raw.exec("DROP TABLE evidence");
      raw.pragma("user_version = 19");
      raw.close();

      const migrated = new SqliteTaskStore(file);
      seed(migrated);
      expect(migrated.evidenceForTask("T-EV")).toEqual([]);
      migrated.appendEvidence(roleRun("T-EV", 1));
      expect(migrated.evidenceForTask("T-EV")).toHaveLength(1);
      migrated.close();
      const check = new Database(file);
      expect(check.pragma("user_version", { simple: true })).toBe(21);
      check.close();
    } finally {
      try {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      } catch {
        /* see above */
      }
    }
  });
});
