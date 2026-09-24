import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandLayer } from "../git/commandLayer.js";
import { GuardedRunError, GuardedRunSession } from "../git/guardedRun.js";
import { acquireWorkspaceRunLock, WorkspaceRunLockedError } from "../concurrency/workspaceRunLock.js";
import { assertRunIdentity, LedgerConflictError, type LedgerAttempt, type RunLedger } from "../ledger/runLedger.js";
import { assertAttemptResumable, AttemptResumeError } from "../ledger/attemptFreeze.js";
import { exportRunAudit, importRunAudit, AuditImportError } from "../ledger/auditExport.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage, TaskState } from "../types.js";
import type { AgentExecutor } from "../orchestrator/orchestrator.js";
import { createRunId } from "./journal.js";
import { MAX_AUTOMATIC_REPAIR_ROUNDS, boundedRunPolicy } from "../engine/runPolicy.js";
import {
  HASH_B,
  HASH_C,
  SCHEMA_PLAN_TASK,
  attemptRows,
  driveFixture,
  fakeAgents,
  fixtureFreeze,
  freezeFixtureAttempt,
  ledgerStatuses,
  packetHash,
  seedEngineRun,
  stagesCompleted,
  type EngineFixture,
  type SeedTask,
} from "./boundedRunEngine.testSupport.js";

/**
 * T-V8-022, retargeted by V13 TASK-007 — the persisted-boundary fault matrix
 * for a bounded run that is the one task engine plus the ledger-attempt
 * boundary (`run/ledgerAttemptExecutor.ts`).
 *
 * Every row is a durable-state assertion: a scenario drives the engine to a
 * simulated process death, throws that process away, and drives it again
 * against the same SQLite state and the same real Git repository. What the
 * second drive does is the evidence.
 *
 * The crash primitive is `crashingLedger`: a proxy that makes a chosen
 * durable ledger write - and every ledger call after it - throw, which is
 * what a killed process leaves behind. `dieAfterExecutor` extends the death
 * to "the executor returned but the engine never recorded it".
 * `boundedRunKillFixture.test.ts` re-proves one window with a real SIGKILL.
 *
 * What changed with the one engine: stages, evidence and completion are the
 * engine's (owner engineer -> reviewer -> QA [-> security], per task); the
 * ledger task status is only a projection of engine state; a refused
 * checkpoint is a failed role-run that leaves the stage incomplete; and the
 * process-local repair rehydration of the retired controller is gone -
 * retries and failure routes are persisted by the engine itself (durable
 * handoff/idempotent replay is TASK-008's).
 */

const roots: string[] = [];
const ledgers: SqliteRunLedger[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function seed(options: { boundary?: "next-gate" | "qa" | "done"; tasks?: SeedTask[] } = {}): EngineFixture {
  const f = seedEngineRun(git, roots, options);
  ledgers.push(f.ledger);
  return f;
}

class ProcessCrash extends Error {
  constructor(readonly at: string) {
    super(`simulated process death at ${at}`);
    this.name = "ProcessCrash";
  }
}

interface CrashHandle {
  ledger: RunLedger;
  kill(): void;
  fired: () => boolean;
}

function crashingLedger(inner: RunLedger, trigger?: (method: string, args: readonly unknown[]) => boolean): CrashHandle {
  let dead = false;
  const ledger = new Proxy(inner as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "close") return value;
      return (...args: unknown[]) => {
        if (dead) throw new ProcessCrash(`ledger.${String(property)}`);
        if (trigger?.(String(property), args)) {
          dead = true;
          throw new ProcessCrash(`ledger.${String(property)}`);
        }
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as RunLedger;
  return { ledger, kill: () => { dead = true; }, fired: () => dead };
}

/** Once the handle has fired, the process is dead: nothing after the executor returns - the engine's record included - happens. */
function dieAfterExecutor(handle: CrashHandle): (decorated: AgentExecutor) => AgentExecutor {
  return (decorated) => async (req) => {
    const result = await decorated(req);
    if (handle.fired()) throw new ProcessCrash(`after ${req.stage} returned`);
    return result;
  };
}

async function crash(f: EngineFixture, handle: CrashHandle, options: Parameters<typeof driveFixture>[1] = {}): Promise<void> {
  await expect(driveFixture(f, {
    ledger: handle.ledger,
    freeze: fixtureFreeze(handle.ledger, f),
    wrap: dieAfterExecutor(handle),
    ...options,
  })).rejects.toBeInstanceOf(ProcessCrash);
  expect(handle.fired()).toBe(true);
}

const failedVerification: DeterministicVerification = {
  required: ["typecheck"], ran: [{ id: "typecheck", status: "FAIL", durationMs: 1, outputSummary: "TS2322" }],
  failures: [{ id: "typecheck", status: "FAIL", durationMs: 1, outputSummary: "TS2322" }], skipped: [],
  missingRequired: [], status: "failed", enforcement: "enforce", passed: false,
};

const PLAN_STAGES = [AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER];

function porcelain(root: string): string {
  return git(root, "status", "--porcelain");
}

function branchExists(root: string, branch: string): boolean {
  return git(root, "branch", "--list", branch) !== "";
}

function attemptReason(f: EngineFixture, taskId: string, index = -1): string {
  return f.ledger.attemptsForTask(f.run.run_id, taskId).at(index)?.outcome_reason ?? "";
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ------------------------------------------- persisted crash boundaries ---

describe("T-V8-022 — persisted crash boundaries resume or refuse deterministically", () => {
  it("B01 · an id that was never durably registered is refused, not invented", async () => {
    const f = seed();
    const result = await driveFixture({ ...f, run: { ...f.run, run_id: createRunId() } });
    expect(result.kind).toBe("REFUSED");
    expect(result.reason).toContain("does not exist");
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    // Control: the registered id completes.
    expect((await driveFixture(f)).kind).toBe("COMPLETED");
  }, 30_000);

  it("B02 · after plan freeze, before branch creation — resume creates the branch and loses nothing", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method) => method === "freezeAttempt"));
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("REGISTERED");
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-1")).toEqual([]);

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("COMPLETED");
    expect(agents.launches).toEqual(["BE-1:1"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
  }, 30_000);

  it("B03 · after branch creation, before the RUNNING write — resume adopts the exact branch without a second switch", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "RUNNING"));
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("REGISTERED");
    expect(branchExists(f.target, f.run.run_branch)).toBe(true);
    expect(git(f.target, "rev-parse", "HEAD")).toBe(f.run.base_sha);
    expect(f.gitCalls.filter((call) => call[0] === "switch")).toHaveLength(1);

    f.gitCalls.length = 0;
    expect((await driveFixture(f)).kind).toBe("COMPLETED");
    expect(f.gitCalls.filter((call) => call[0] === "switch")).toEqual([]);
  }, 30_000);

  it("B03b · the adopted branch must be clean — a dirty adopted branch refuses and keeps the bytes", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "RUNNING"));
    const stray = path.join(f.target, "src", "human-was-here.txt");
    fs.writeFileSync(stray, "unsaved human work\n");
    const before = fs.readFileSync(stray, "utf8");

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    // The refusal is a failed engineer role-run: the stage stays incomplete and the run halts.
    expect(result.kind).toBe("HALTED");
    expect(attemptRows(f, "BE-1")).toEqual(["1:FROZEN", "2:FROZEN"]);
    expect(f.store.runsForTask("BE-1").at(-1)?.failure_reason ?? "").toContain("new run branch is dirty after interrupted isolation");
    expect(agents.launches).toEqual([]);
    expect(fs.readFileSync(stray, "utf8")).toBe(before);
    expect(porcelain(f.target)).toContain("human-was-here.txt");
  }, 30_000);

  it("B04 · after attempt freeze, before attempt start — the frozen attempt is never edited and a new one is frozen", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method) => method === "updateAttempt"));
    expect(attemptRows(f, "BE-1")).toEqual(["1:FROZEN"]);
    const frozenBefore = JSON.stringify(f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`));

    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    expect(agents.launches).toEqual(["BE-1:2"]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:FROZEN", "2:SUCCEEDED"]);
    expect(JSON.stringify(f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`))).toBe(frozenBefore);
  }, 30_000);

  it("B05 · after attempt start, before the agent returns — an interrupted in-flight attempt refuses and preserves the partial diff", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    const partial = path.join(f.target, "src", "partial.txt");
    await crash(f, handle, {
      agents: fakeAgents(f, {
        onEngineer: () => {
          fs.writeFileSync(partial, "half-written agent work\n");
          handle.kill();
          throw new ProcessCrash("agent");
        },
      }),
    });
    // Reconciliation keys on the attempt left RUNNING, not on a task status.
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    const before = fs.readFileSync(partial, "utf8");

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("resumes only on clean branch");
    expect(agents.calls).toEqual([]);
    expect(fs.readFileSync(partial, "utf8")).toBe(before);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
  }, 30_000);

  it("B06 · after the agent returns, before the checkpoint — a dirty verifying window refuses and discards nothing", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    await crash(f, handle, {
      secretScanner: () => {
        handle.kill();
        throw new ProcessCrash("secretScan");
      },
    });
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    const agentWork = path.join(f.target, "src", "BE-1.txt");
    const before = fs.readFileSync(agentWork, "utf8");

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("resumes only on clean branch");
    expect(agents.calls).toEqual([]);
    expect(fs.readFileSync(agentWork, "utf8")).toBe(before);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
  }, 30_000);

  it("B07 · after the commit, before the checkpoint transaction — resume re-attributes the exact HEAD and never commits the work twice", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method) => method === "recordCheckpoint"));
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    const orphan = git(f.target, "rev-parse", "HEAD");
    expect(orphan).not.toBe(f.run.base_sha);
    expect(porcelain(f.target)).toBe("");
    // The engine never recorded the stage: the process died first.
    expect(stagesCompleted(f, "BE-1")).toEqual([]);

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("COMPLETED");
    const checkpoints = f.ledger.checkpointsForRun(f.run.run_id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      task_id: "BE-1", sha: orphan,
      attempt_id: `${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`,
      packet_hash: packetHash("BE-1", 1),
    });
    // The engine needs its own evidence of the stage, so the engineer reruns
    // (TASK-008 owns replaying a recorded result instead); the idempotent
    // rerun changes nothing and succeeds on the reconciled checkpoint.
    expect(agents.launches).toEqual(["BE-1:2"]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED", "2:SUCCEEDED"]);
    expect(attemptReason(f, "BE-1")).toContain("no second commit");
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("2");
    expect(stagesCompleted(f, "BE-1")).toEqual(PLAN_STAGES);
  }, 30_000);

  it("B07b · a HEAD whose trailers do not match the interrupted attempt is refused, not adopted", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method) => method === "recordCheckpoint"));
    const interrupted = f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`)!;
    const session = await GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: interrupted,
    });
    try {
      await expect(session.reconcileHeadCheckpoint({ ...interrupted, packet_hash: HASH_B }))
        .rejects.toThrow(/does not carry exact STA-Packet-Hash/);
      await expect(session.reconcileHeadCheckpoint(interrupted)).resolves.toBe(git(f.target, "rev-parse", "HEAD"));
    } finally {
      session.close();
    }
  }, 30_000);

  it("B07c · after the checkpoint, before the engine records the stage — resume adds no second commit", async () => {
    const f = seed();
    // The process dies right after the decorated executor returned PASS: the
    // checkpoint is durable in Git and the ledger, the engine record is not.
    const handle = crashingLedger(f.ledger);
    const wrap = (decorated: AgentExecutor): AgentExecutor => async (req) => {
      const result = await decorated(req);
      if (req.stage === AgentStage.BACKEND_ENGINEER) {
        handle.kill();
        throw new ProcessCrash("before the engine recorded backend-engineer");
      }
      return result;
    };
    await expect(driveFixture(f, { ledger: handle.ledger, freeze: fixtureFreeze(handle.ledger, f), wrap })).rejects.toBeInstanceOf(ProcessCrash);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    expect(stagesCompleted(f, "BE-1")).toEqual([]);
    const checkpoint = f.ledger.checkpointsForRun(f.run.run_id)[0]!.sha;

    const result = await driveFixture(f);
    expect(result.kind).toBe("COMPLETED");
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("2");
    expect(git(f.target, "rev-parse", "HEAD")).toBe(checkpoint);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED", "2:SUCCEEDED"]);
    expect(stagesCompleted(f, "BE-1")).toEqual(PLAN_STAGES);
  }, 30_000);

  it("B08 · after a checkpointed task, before the next task — the done task never reruns", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    await crash(f, crashingLedger(f.ledger, (method, args) => method === "freezeAttempt" && (args[0] as LedgerAttempt).task_id === "BE-2"));
    expect(f.store.loadTask("BE-1")!.machine.current).toBe(TaskState.DEPLOYED);
    const firstCheckpoint = f.ledger.checkpointsForRun(f.run.run_id);
    expect(firstCheckpoint).toHaveLength(1);

    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    expect(agents.launches).toEqual(["BE-2:1"]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)[0]).toEqual(firstCheckpoint[0]);
  }, 30_000);

  it("B08-defect · the ledger task status decides nothing: forging it changes no dispatch", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    await crash(f, crashingLedger(f.ledger, (method, args) => method === "freezeAttempt" && (args[0] as LedgerAttempt).task_id === "BE-2"));
    // Forge the ledger both ways: the done task "not started", the pending task "DONE".
    f.ledger.projectTaskStatus(f.run.run_id, "BE-1", "PLANNED", { reason: "injected defect" });
    f.ledger.projectTaskStatus(f.run.run_id, "BE-2", "DONE", { reason: "injected defect" });
    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    // The engine, not the forged projection, chose the work: BE-2 ran, BE-1 did not.
    expect(agents.launches).toEqual(["BE-2:1"]);
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "DONE", "BE-2": "DONE" });
  }, 30_000);

  it("B09 · after QA starts, before its verdict — QA re-runs and DEV does not", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    await crash(f, handle, {
      agents: fakeAgents(f, {
        onStage: (req) => {
          if (req.stage !== AgentStage.QA_ENGINEER) return;
          handle.kill();
          throw new ProcessCrash("qa");
        },
      }),
    });
    expect(stagesCompleted(f, "BE-1")).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER]);

    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    expect(agents.calls).toEqual([`BE-1:${AgentStage.QA_ENGINEER}`]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
  }, 30_000);

  it("B10 · after a QA failure, before the repair attempt starts — the persisted failure round survives the crash", async () => {
    const f = seed();
    let frozenOnce = false;
    const handle = crashingLedger(f.ledger, (method) => {
      if (method !== "freezeAttempt") return false;
      if (!frozenOnce) { frozenOnce = true; return false; }
      return true;
    });
    await crash(f, handle, {
      agents: fakeAgents(f, { qa: () => ({ outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: "AC-1 failed" } }) }),
    });
    // The engine persisted the failed round and routed the task back to the engineer.
    const row = f.store.loadTask("BE-1")!;
    expect(row.retries.qa).toBe(1);
    expect(row.machine.current).toBe(TaskState.IMPLEMENTATION);

    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    expect(agents.launches).toEqual(["BE-1:2"]);
    expect(f.store.loadTask("BE-1")!.retries.qa).toBe(1);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(2);
  }, 30_000);

  it("B11 · after the last task completes, before the run status write — resume closes the run with no new work", async () => {
    const f = seed();
    await crash(f, crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "COMPLETED"));
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("RUNNING");
    expect(f.store.loadTask("BE-1")!.machine.current).toBe(TaskState.DEPLOYED);

    const agents = fakeAgents(f);
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
    expect(agents.calls).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("COMPLETED");
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "DONE" });
  }, 30_000);

  it("B12 · a terminal run is never re-executed", async () => {
    const f = seed();
    expect((await driveFixture(f)).kind).toBe("COMPLETED");
    const agents = fakeAgents(f);
    const replay = await driveFixture(f, { agents });
    expect(replay).toMatchObject({ kind: "COMPLETED", reason: "run is already COMPLETED" });
    expect(agents.calls).toEqual([]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
  }, 30_000);
});

// ----------------------------------------------------------- fault kinds ---

describe("T-V8-022 — non-crash fault classes end the run explicitly and durably", () => {
  it.each([
    { id: "F01", label: "quota exhaustion", failure: undefined, reason: "usage limit reached", attempt: "FAILED", kind: "HALTED", resumes: true },
    {
      id: "F02", label: "provider/network unavailability", reason: "provider unavailable", attempt: "UNAVAILABLE", kind: "GATE", resumes: false,
      failure: { category: "infrastructure" as const, owner: AgentStage.HUMAN, severity: "high" as const, retryable: false, reason: "provider unavailable", affected: [], requiresHuman: true },
    },
    { id: "F03", label: "runtime timeout", failure: undefined, reason: "runtime timed out after 900s", attempt: "FAILED", kind: "HALTED", resumes: true },
  ])("$id · $label settles the attempt with no checkpoint and stops the run durably", async ({ failure, reason, attempt, kind, resumes }) => {
    const f = seed();
    let fail = true;
    const agents = fakeAgents(f, {
      engineerResult: () => (fail ? { outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: reason }, ...(failure ? { failure } : {}) } : undefined),
    });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe(kind);
    expect(attemptRows(f, "BE-1")).toEqual([`1:${attempt}`]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe(kind === "GATE" ? "AWAITING_HUMAN" : "HALTED");
    expect(porcelain(f.target)).toBe("");

    fail = false;
    const again = await driveFixture(f, { agents });
    if (resumes) {
      // A task defect leaves the stage incomplete: the next explicit invocation reruns it.
      expect(again.kind).toBe("COMPLETED");
      expect(agents.launches).toEqual(["BE-1:1", "BE-1:2"]);
    } else {
      // Infrastructure is the engine's human stop; recovering from it is a person's (and TASK-008's) call.
      expect(again.kind).toBe("GATE");
      expect(agents.launches).toEqual(["BE-1:1"]);
    }
  }, 30_000);

  it("F04 · an operator interruption abandons the attempt without failing the task's future", async () => {
    const f = seed();
    let interrupt = true;
    const agents = fakeAgents(f, { onEngineer: () => { if (interrupt) throw new Error("SIGINT from the operator"); } });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("SIGINT from the operator");
    expect(attemptRows(f, "BE-1")).toEqual(["1:ABANDONED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    interrupt = false;
    expect((await driveFixture(f, { agents })).kind).toBe("COMPLETED");
  }, 30_000);

  it("F05 · a deterministic failure refuses the checkpoint, leaves the work in the tree and the stage incomplete", async () => {
    const f = seed();
    const result = await driveFixture(f, { agents: fakeAgents(f, { verification: () => failedVerification }) });
    expect(result.kind).toBe("HALTED");
    expect(attemptReason(f, "BE-1")).toContain("Deterministic verification failed");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
    expect(porcelain(f.target)).toContain("BE-1.txt");
    // A failed role-run, recorded by the engine; the stage did not complete and the task did not move.
    expect(f.store.runsForTask("BE-1").map((run) => run.result)).toEqual(["FAIL"]);
    expect(stagesCompleted(f, "BE-1")).toEqual([]);
    expect(f.store.loadTask("BE-1")!.machine.current).toBe(TaskState.IMPLEMENTATION);
  }, 30_000);

  it("F06 · no test suite is treated as unverified, never as a pass", async () => {
    const f = seed();
    const skipped: DeterministicVerification = {
      required: ["typecheck"], ran: [], failures: [], skipped: ["typecheck"], missingRequired: ["typecheck"],
      status: "skipped", enforcement: "enforce", passed: false,
    };
    const result = await driveFixture(f, { agents: fakeAgents(f, { verification: () => skipped }) });
    expect(result.kind).toBe("HALTED");
    expect(attemptReason(f, "BE-1")).toContain("Deterministic verification was skipped");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
  }, 30_000);

  it("F07 · a pre-existing dirty Target refuses before any branch exists or any agent runs", async () => {
    const f = seed();
    const human = path.join(f.target, "src", "base.txt");
    fs.writeFileSync(human, "base\nhuman edit in progress\n");
    const before = fs.readFileSync(human, "utf8");
    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(f.store.runsForTask("BE-1").at(-1)?.failure_reason ?? "").toContain("Resolve this repository state");
    expect(agents.calls).toEqual([]);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(fs.readFileSync(human, "utf8")).toBe(before);
    expect(git(f.target, "branch", "--show-current")).toBe("main");
  }, 30_000);

  it("F08 · stale run identity refuses rather than executing a frozen scope against edited inputs", () => {
    const f = seed();
    const run = f.ledger.readRun(f.run.run_id)!;
    expect(() => assertRunIdentity(run, { planHash: HASH_C, baseSha: run.base_sha })).not.toThrow();
    for (const [label, drift] of [
      ["plan", { planHash: HASH_B }],
      ["requirement", { requirementHash: HASH_C }],
      ["design", { designHash: HASH_C }],
      ["base revision", { baseSha: "0".repeat(40) }],
      ["config", { configHash: HASH_B }],
    ] as const) {
      expect(() => assertRunIdentity(run, drift), label).toThrow(LedgerConflictError);
    }
  });

  it("F09 · a frozen attempt refuses to resume against a changed world", () => {
    const f = seed();
    const attempt = freezeFixtureAttempt(f.ledger, f, "BE-1");
    expect(() => assertAttemptResumable(attempt, { packetHash: attempt.packet_hash, baseRevision: attempt.base_revision })).not.toThrow();
    for (const [label, drift] of [
      ["packet", { packetHash: HASH_B }],
      ["config", { configHash: HASH_B }],
      ["plan", { planHash: HASH_B }],
      ["base revision", { baseRevision: "0".repeat(40) }],
      ["runtime", { runtimeId: "codex" }],
      ["adapter version", { adapterVersion: "fixture@2" }],
    ] as const) {
      expect(() => assertAttemptResumable(attempt, drift), label).toThrow(AttemptResumeError);
    }
  });

  it("F10 · a malformed or tampered audit export is refused and never becomes the authority", async () => {
    const f = seed();
    expect((await driveFixture(f)).kind).toBe("COMPLETED");
    const exported = exportRunAudit(f.ledger, f.run.run_id);
    expect(() => importRunAudit(exported)).not.toThrow();
    const truncated = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    delete truncated.tasks;
    expect(() => importRunAudit(truncated)).toThrow(AuditImportError);
    expect(() => importRunAudit(JSON.parse('{"not":"an export"}'))).toThrow(AuditImportError);
    const inconsistent = JSON.parse(JSON.stringify(exported)) as typeof exported;
    inconsistent.run.task_order = ["BE-1", "GHOST-9"];
    expect(() => importRunAudit(inconsistent)).toThrow(AuditImportError);
    const edited = JSON.parse(JSON.stringify(exported)) as typeof exported;
    edited.run.status = "REGISTERED";
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("COMPLETED");
  }, 30_000);

  it("F11 · a tampered frozen attempt cannot open a Target mutation boundary", async () => {
    const f = seed();
    const frozen = freezeFixtureAttempt(f.ledger, f, "BE-1");
    await expect(GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: { ...frozen, packet_hash: HASH_B },
    })).rejects.toThrow(/byte-identical frozen ledger record/);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    const honest = await GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: frozen,
    });
    honest.close();
    expect(branchExists(f.target, f.run.run_branch)).toBe(true);
  }, 30_000);

  it("F12 · the ledger refuses to overwrite a frozen attempt with different inputs", () => {
    const f = seed();
    const frozen = freezeFixtureAttempt(f.ledger, f, "BE-1");
    expect(() => f.ledger.freezeAttempt(frozen)).not.toThrow();
    expect(() => f.ledger.freezeAttempt({ ...frozen, observed: { runtime: "codex", model: "gpt-5", effort: "low" } }))
      .toThrow(/already frozen with different inputs/);
    expect(f.ledger.readAttempt(frozen.attempt_id)?.observed.runtime).toBe("claude-code");
  });
});

// ----------------------------------------------------------- human gates ---

describe("T-V8-022 — every human gate stops at the exact recorded gate", () => {
  it("G01 · a schema plan task stops for its approval before Done and a replay never answers it", async () => {
    const f = seed({ boundary: "next-gate", tasks: [{ id: "BE-1", classification: SCHEMA_PLAN_TASK }] });
    const result = await driveFixture(f);
    expect(result.kind).toBe("GATE");
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "BLOCKED" });
    const row = f.store.loadTask("BE-1")!;
    expect(row.machine.current).toBe(TaskState.READY_TO_DEPLOY);
    expect(row.approvals.every((approval) => approval.status === "pending")).toBe(true);
    expect(stagesCompleted(f, "BE-1")).toEqual([...PLAN_STAGES, AgentStage.SECURITY]);

    const agents = fakeAgents(f);
    const replay = await driveFixture(f, { agents });
    expect(replay.kind).toBe("GATE");
    expect(agents.calls).toEqual([]);
    expect(f.store.loadTask("BE-1")!.approvals.every((approval) => approval.status === "pending")).toBe(true);
  }, 30_000);

  it("G02 · the automatic repair budget stops the run for a person and leaves the task as the engine recorded it", async () => {
    const f = seed();
    const agents = fakeAgents(f, { qa: () => ({ outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: "AC-1 still failing" } }) });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("GATE");
    expect(result.reason).toContain(`automatic repair budget (${MAX_AUTOMATIC_REPAIR_ROUNDS})`);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    expect(f.store.loadTask("BE-1")!.retries.qa).toBe(MAX_AUTOMATIC_REPAIR_ROUNDS + 1);
    expect(agents.launches).toHaveLength(MAX_AUTOMATIC_REPAIR_ROUNDS + 1);

    const before = { ...f.store.loadTask("BE-1")!, updatedAt: 0 };
    const evidenceBefore = f.store.evidenceForTask("BE-1").length;
    const again = fakeAgents(f);
    expect((await driveFixture(f, { agents: again })).kind).toBe("GATE");
    expect(again.calls).toEqual([]);
    expect({ ...f.store.loadTask("BE-1")!, updatedAt: 0 }).toEqual(before);
    expect(f.store.evidenceForTask("BE-1")).toHaveLength(evidenceBefore);
  }, 60_000);

  it("G03 · a finding that requires a human is never repaired automatically", async () => {
    const f = seed();
    const agents = fakeAgents(f, {
      qa: (req) => ({
        outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: "Critical security finding: auth bypass" },
        failure: {
          category: "implementation", owner: AgentStage.BACKEND_ENGINEER, severity: "critical", retryable: false,
          reason: "Critical security finding: auth bypass", affected: [req.taskId], requiresHuman: true,
        },
      }),
    });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("GATE");
    expect(agents.launches).toEqual(["BE-1:1"]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
  }, 30_000);

  it("G04 · a task a person holds gates the run instead of being skipped", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2" }] });
    f.registry.pause("BE-2");
    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("GATE");
    expect(result.reason).toContain("BE-2");
    expect(agents.launches).toEqual(["BE-1:1"]);
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "DONE", "BE-2": "BLOCKED" });
    expect(result.awaitingHuman.map((item) => item.taskId)).toEqual(["BE-2"]);
  }, 30_000);

  it("G05 · a failure owned by a stage the task's workflow does not have escalates rather than improvising", async () => {
    const f = seed();
    const agents = fakeAgents(f, {
      qa: (req) => ({
        outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: "contract evidence is incomplete" },
        failure: {
          category: "contract", owner: AgentStage.SYSTEM_ANALYST, severity: "high", retryable: true,
          reason: "contract evidence is incomplete", affected: [req.taskId], requiresHuman: false,
        },
      }),
    });
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("GATE");
    expect(agents.launches).toEqual(["BE-1:1"]);
    expect(agents.calls.some((call) => call.endsWith(AgentStage.SYSTEM_ANALYST))).toBe(false);
  }, 30_000);

  it("G06 · --until boundaries only move the stop, and a gate still outranks them", async () => {
    const twoTasks = [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }];
    const qaStop = seed({ boundary: "qa", tasks: twoTasks });
    const stopped = await driveFixture(qaStop);
    expect(stopped.kind).toBe("BOUNDARY");
    expect(stopped.exitCode).toBe(0);
    expect(qaStop.ledger.readRun(qaStop.run.run_id)?.status).toBe("HALTED");
    expect(stagesCompleted(qaStop, "BE-1")).toEqual(PLAN_STAGES);
    expect(stagesCompleted(qaStop, "BE-2")).toEqual([]);
    expect(ledgerStatuses(qaStop)).toEqual({ "BE-1": "DONE", "BE-2": "PLANNED" });

    // The same boundary may not report a pending human gate as a mere stop.
    const gated = seed({ boundary: "qa" });
    const agents = fakeAgents(gated, {
      qa: (req) => ({
        outcome: { tokens: 1, cost: 0, result: "FAIL", failure_reason: "Critical finding" },
        failure: {
          category: "implementation", owner: AgentStage.BACKEND_ENGINEER, severity: "critical", retryable: false,
          reason: "Critical finding", affected: [req.taskId], requiresHuman: true,
        },
      }),
    });
    const result = await driveFixture(gated, { agents });
    expect(result.kind).toBe("GATE");
    expect(gated.ledger.readRun(gated.run.run_id)?.status).toBe("AWAITING_HUMAN");

    // Control: the same stages and evidence under `done`, only a later stop.
    const done = seed({ boundary: "done", tasks: twoTasks });
    expect((await driveFixture(done, { policy: boundedRunPolicy("done") })).kind).toBe("COMPLETED");
    expect(stagesCompleted(done, "BE-1")).toEqual(stagesCompleted(qaStop, "BE-1"));
    // Resuming the qa-stopped run under `done` finishes it with the same stages.
    expect((await driveFixture(qaStop, { policy: boundedRunPolicy("done") })).kind).toBe("COMPLETED");
    expect(stagesCompleted(qaStop, "BE-2")).toEqual(stagesCompleted(done, "BE-2"));
  }, 60_000);
});

// -------------------------------------------------- Git boundary refusals ---

describe("T-V8-022 — the guarded Git boundary refuses every unguarded mutation", () => {
  async function openWith(f: EngineFixture, overrides: Partial<LedgerAttempt>): Promise<GuardedRunSession> {
    const attempt = freezeFixtureAttempt(f.ledger, f, f.run.task_order[0]!, AgentStage.BACKEND_ENGINEER, overrides);
    return GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: attempt,
    });
  }

  it.each([
    {
      id: "V01", label: "an analysis/proposal stage",
      overrides: { stage: AgentStage.SYSTEM_ANALYST, guard_evidence: { target_write: false, pre_tool_guard: false, writable_roots: [] } } as Partial<LedgerAttempt>,
      expect_: /analysis\/proposal-only and may not open a Git mutation boundary/,
    },
    {
      id: "V02", label: "an attempt frozen without a verified pre-tool guard",
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: false, writable_roots: ["ROOT"] } } as Partial<LedgerAttempt>,
      expect_: /no verified pre-tool guard/,
    },
    {
      id: "V03", label: "an attempt that resolved two writable roots",
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: ["ROOT", "ROOT"] } } as Partial<LedgerAttempt>,
      expect_: /resolved 2 writable roots/,
    },
    {
      id: "V04", label: "an attempt whose writable root is not the frozen Target",
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [os.tmpdir()] } } as Partial<LedgerAttempt>,
      expect_: /writable root does not equal frozen Target root/,
    },
    {
      id: "V05", label: "an attempt frozen against a different plan",
      overrides: { plan_hash: HASH_B } as Partial<LedgerAttempt>,
      expect_: /plan hash differs from the frozen run/,
    },
    {
      id: "V06", label: "an attempt frozen against a base revision the run never recorded",
      overrides: { base_revision: "0".repeat(40) } as Partial<LedgerAttempt>,
      expect_: /neither the frozen run base nor a checkpoint this run recorded/,
    },
  ])("$id · $label may not open the Target mutation boundary", async ({ overrides, expect_ }) => {
    const f = seed();
    const resolved = JSON.parse(JSON.stringify(overrides).replace(/"ROOT"/g, JSON.stringify(f.target))) as Partial<LedgerAttempt>;
    const refusal = await openWith(f, resolved).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(GuardedRunError);
    expect((refusal as GuardedRunError).kind).toBe("UNGUARDED_ATTEMPT");
    expect((refusal as GuardedRunError).message).toMatch(expect_);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    // Control: the same fixture with only the offending field corrected opens.
    const clean = seed();
    const session = await openWith(clean, {});
    session.close();
    expect(branchExists(clean.target, clean.run.run_branch)).toBe(true);
  }, 30_000);

  it("V07 · a second unfinished run on the same Target is refused", async () => {
    const f = seed();
    const otherId = createRunId();
    f.ledger.transaction(() => {
      f.ledger.createRun({ ...f.run, run_id: otherId, run_branch: `sta/run/orders/${otherId}`, task_order: ["BE-9"] });
      f.ledger.registerTasks([{
        run_id: otherId, task_id: "BE-9", status: "PLANNED", owner: AgentStage.BACKEND_ENGINEER, phase: 1,
        depends_on: [], produces: [], consumes: [], task_hash: HASH_B, position: 0, updated_at: 1_000,
      }]);
    });
    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(f.store.runsForTask("BE-1").at(-1)?.failure_reason ?? "").toContain(`already has unfinished run(s) ${otherId}`);
    expect(agents.calls).toEqual([]);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);

    // Bypass: hide the competing run from the guard and the same run completes.
    const blind = new Proxy(f.ledger as object, {
      get(target, property, receiver) {
        if (property !== "listRuns") return Reflect.get(target, property, receiver);
        return () => f.ledger.listRuns().filter((candidate) => candidate.run_id !== otherId);
      },
    }) as unknown as RunLedger;
    expect((await driveFixture(f, { ledger: blind, freeze: fixtureFreeze(blind, f) })).kind).toBe("COMPLETED");
  }, 40_000);

  it("V08 · a workspace lock held by another run blocks the mutation boundary", async () => {
    const f = seed();
    acquireWorkspaceRunLock(f.state, f.target, createRunId());
    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(agents.calls).toEqual([]);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(() => acquireWorkspaceRunLock(f.state, f.target, createRunId())).toThrow(WorkspaceRunLockedError);
  }, 30_000);

  it("V09 · a write outside the task's own contract refuses the checkpoint and stages nothing", async () => {
    const f = seed();
    const result = await driveFixture(f, {
      freeze: fixtureFreeze(f.ledger, f, { allowedPathGlobs: ["src/allowed/**"] }),
      agents: fakeAgents(f, {
        writeFile: () => {
          fs.mkdirSync(path.join(f.target, "src", "allowed"), { recursive: true });
          fs.writeFileSync(path.join(f.target, "src", "allowed", "ok.txt"), "in contract\n");
          fs.writeFileSync(path.join(f.target, "src", "sneaky.txt"), "outside the contract\n");
        },
      }),
    });
    expect(result.kind).toBe("HALTED");
    expect(attemptReason(f, "BE-1")).toContain("Changed path(s) are outside the immutable task/stage write contract: src/sneaky.txt");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "diff", "--cached", "--name-only")).toBe("");
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
    expect(stagesCompleted(f, "BE-1")).toEqual([]);
  }, 30_000);

  it("V10 · a dependency manifest change refuses the checkpoint", async () => {
    const f = seed();
    const result = await driveFixture(f, {
      freeze: fixtureFreeze(f.ledger, f, { allowedPathGlobs: ["**"] }),
      agents: fakeAgents(f, {
        writeFile: () => {
          fs.writeFileSync(path.join(f.target, "src", "BE-1.txt"), "work\n");
          fs.writeFileSync(path.join(f.target, "package.json"), JSON.stringify({ name: "target", dependencies: { evil: "1.0.0" } }));
        },
      }),
    });
    expect(result.kind).toBe("HALTED");
    expect(attemptReason(f, "BE-1")).toContain("Dependency manifest/lockfile change requires human review");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "diff", "--cached", "--name-only")).toBe("");
  }, 30_000);

  it("V11 · secret-shaped content refuses the checkpoint", async () => {
    const f = seed();
    const result = await driveFixture(f, { secretScanner: () => ({ ok: false, problems: ["src/BE-1.txt:1 looks like an API key"] }) });
    expect(result.kind).toBe("HALTED");
    expect(attemptReason(f, "BE-1")).toContain("Secret-shaped content refused the checkpoint");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
  }, 30_000);

  it("V12 · a complete successful run issues no integration, rollback or remote Git command", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    expect((await driveFixture(f)).kind).toBe("COMPLETED");
    const verbs = [...new Set(f.gitCalls.map((call) => call.find((token) => !token.startsWith("-")) ?? call[0]!))].sort();
    expect(verbs).toEqual(["add", "branch", "commit", "diff", "ls-files", "rev-parse", "status", "switch", "symbolic-ref"]);
    const forbidden = /^(push|pull|fetch|remote|merge|rebase|cherry-pick|revert|reset|clean|stash|tag|checkout|worktree|submodule|gc|filter-branch|update-ref)$/;
    expect(f.gitCalls.filter((call) => call.some((token) => forbidden.test(token)))).toEqual([]);
    expect(f.gitCalls.filter((call) => call.includes("-d") || call.includes("-D") || call.includes("--force"))).toEqual([]);
    expect(git(f.target, "branch", "--show-current")).toBe(f.run.run_branch);
    expect(git(f.target, "rev-parse", "main")).toBe(f.run.base_sha);
    // Two tasks, two checkpoints: the second attempt started from the first checkpoint.
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("3");
  }, 40_000);
});

// ------------------------------------------------- real process-kill row ---

describe("T-V8-022 — a real SIGKILL leaves the same durable state the crash model predicts", () => {
  async function waitForFile(file: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${file}`);
  }

  it("B-KILL · kills the engine mid-attempt, then refuses to rerun the done task or drop the partial diff", async () => {
    const target = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v13-fault-kill-target-")));
    roots.push(target);
    git(target, "init", "-b", "main");
    git(target, "config", "user.name", "Fixture");
    git(target, "config", "user.email", "fixture@example.invalid");
    fs.mkdirSync(path.join(target, "src"));
    fs.writeFileSync(path.join(target, "src", "base.txt"), "base\n");
    git(target, "add", "--", "src/base.txt");
    git(target, "commit", "-m", "initial", "--");
    const state = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v13-fault-kill-state-")));
    roots.push(state);
    const marker = path.join(state, "second-owner-started.marker");
    const runId = createRunId();
    const orchestratorRoot = path.resolve(import.meta.dirname, "..", "..");
    const vitest = path.join(orchestratorRoot, "node_modules", "vitest", "vitest.mjs");

    const child = spawn(process.execPath, [vitest, "run", "src/run/boundedRunKillFixture.test.ts"], {
      cwd: orchestratorRoot,
      env: {
        ...process.env,
        STA_BOUNDED_KILL_FIXTURE: "1",
        STA_BOUNDED_KILL_STATE_ROOT: state,
        STA_BOUNDED_KILL_TARGET_ROOT: target,
        STA_BOUNDED_KILL_MARKER: marker,
        STA_BOUNDED_KILL_RUN_ID: runId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await waitForFile(marker);
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nchild output:\n${output}`);
    }
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    const store = new SqliteTaskStore(path.join(state, "state.db"));
    const ledger = new SqliteRunLedger(store, { projectRoot: state });
    ledgers.push(ledger);
    expect(ledger.readRun(runId)!.status).toBe("RUNNING");
    expect(store.loadTask("BE-1")!.machine.current).toBe(TaskState.DEPLOYED);
    const checkpoints = ledger.checkpointsForRun(runId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ task_id: "BE-1", packet_hash: packetHash("BE-1", 1) });
    expect(ledger.attemptsForTask(runId, "BE-1").map((item) => item.status)).toEqual(["SUCCEEDED"]);
    expect(ledger.attemptsForTask(runId, "BE-2").map((item) => item.status)).toEqual(["RUNNING"]);
    const partial = path.join(target, "src", "partial-BE-2.txt");
    const partialBytes = fs.readFileSync(partial, "utf8");
    expect(git(target, "log", "-1", "--format=%H")).toBe(checkpoints[0]!.sha);

    // The killed process's lock is stale (its pid is gone), so it does not wedge
    // the Target - but the interrupted attempt and its partial diff still do.
    const f = seedEngineRun(git, roots, { target, stateRoot: state, runId, tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }], reuse: true });
    ledgers.push(f.ledger);
    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("resumes only on clean branch");
    expect(agents.calls).toEqual([]);
    expect(fs.readFileSync(partial, "utf8")).toBe(partialBytes);
    expect(ledger.checkpointsForRun(runId)).toHaveLength(1);
    expect(ledger.attemptsForTask(runId, "BE-1").map((item) => item.status)).toEqual(["SUCCEEDED"]);
    expect(output).not.toContain("never reached");
  }, 180_000);
});
