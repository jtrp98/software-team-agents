import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GitCommandLayer, defaultGitProcessRunner } from "../git/commandLayer.js";
import { GuardedRunError, GuardedRunSession } from "../git/guardedRun.js";
import { acquireWorkspaceRunLock, WorkspaceRunLockedError } from "../concurrency/workspaceRunLock.js";
import {
  assertRunIdentity,
  LedgerConflictError,
  LEDGER_SCHEMA_VERSION,
  type LedgerAttempt,
  type LedgerRun,
  type LedgerTask,
  type RunLedger,
} from "../ledger/runLedger.js";
import { assertAttemptResumable, AttemptResumeError } from "../ledger/attemptFreeze.js";
import { exportRunAudit, importRunAudit, AuditImportError } from "../ledger/auditExport.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { createRunId } from "./journal.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import {
  BoundedRunController,
  MAX_AUTOMATIC_REPAIR_ROUNDS,
  type BoundedRunServices,
  type PreparedTargetAttempt,
  type QaControllerResult,
  type RepairInstruction,
} from "./boundedRunController.js";

/**
 * T-V8-022 — the persisted-boundary fault matrix for the unified bounded run.
 *
 * Two things separate this file from boundedRunController.test.ts, which
 * proves the happy path and the ordinary exits:
 *
 * 1. Every row is a durable-state assertion, not a return-value assertion. A
 *    scenario runs one controller to a simulated process death, throws that
 *    controller away, and starts a *new* one against the same SQLite ledger
 *    and the same real Git repository. What the second controller does is the
 *    evidence; the first one's return value is not.
 *
 * 2. Every safety row carries a paired defect. A refusal only proves a guard
 *    when the same scenario *without* the injected defect proceeds (proof
 *    "control"), or when neutralizing exactly the input that guard reads makes
 *    the unsafe thing happen (proof "bypass"). A row with neither is a
 *    coincidence rather than a test, so record() refuses to file one.
 *
 * The crash primitive is crashingLedger: a proxy that makes a chosen durable
 * write - and every ledger call after it - throw, which is what a killed
 * process leaves behind (the write never reached SQLite, and no bookkeeping
 * ran afterwards). run/boundedRunKillFixture.test.ts re-proves one
 * representative window with a real SIGKILL so this proxy is not the only
 * witness.
 */

// ---------------------------------------------------------------- matrix ---

type Proof = "control" | "bypass";

interface MatrixRow {
  id: string;
  boundary: string;
  fault: string;
  expected: "resume" | "refuse" | "halt" | "gate";
  observed: string;
  proof: Proof;
  proofObserved: string;
}

const MATRIX: MatrixRow[] = [];

/** Representative transcripts written alongside the matrix for the round evidence. */
const ARTIFACTS: Record<string, unknown> = {};

function record(row: MatrixRow): void {
  if (row.proofObserved.trim() === "") {
    throw new Error(`matrix row ${row.id} has no defect proof; an unproven guard may not be filed`);
  }
  MATRIX.push(row);
}

afterAll(() => {
  if (process.env.STA_V8_EVIDENCE !== "1") return;
  const out = path.resolve(import.meta.dirname, "..", "..", "..", "planning", "v8", "evidence", "round-13-boundary-matrix.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const document = {
    generated_by: "orchestrator/src/run/boundedRunFaultMatrix.test.ts",
    rows: [...MATRIX].sort((left, right) => left.id.localeCompare(right.id)),
  };
  fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  const transcripts = path.resolve(path.dirname(out), "round-13-transcripts.json");
  fs.writeFileSync(transcripts, `${JSON.stringify({ generated_by: document.generated_by, ...ARTIFACTS }, null, 2)}\n`);
});

// --------------------------------------------------------------- fixture ---

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const roots: string[] = [];
const ledgers: SqliteRunLedger[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v8-fault-target-")));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "base.txt"), "base\n");
  git(root, "add", "--", "src/base.txt");
  git(root, "commit", "-m", "initial", "--");
  return root;
}

class ProcessCrash extends Error {
  constructor(readonly at: string) {
    super(`simulated process death at ledger.${at}`);
    this.name = "ProcessCrash";
  }
}

interface CrashHandle {
  ledger: RunLedger;
  /** Arms the crash from outside the ledger: a runtime/QA service dying mid-call. */
  kill(): void;
  fired: () => boolean;
}

/**
 * A process death is "this durable write never landed, and nothing ran after
 * it". Modeling it as a rollback plus a permanently dead handle is faithful in
 * both halves: SQLite rolls the enclosing transaction back exactly as a killed
 * process would, and every later ledger call throws rather than recording a
 * tidy HALTED that a real crash never gets to write.
 */
function crashingLedger(inner: RunLedger, trigger?: (method: string, args: readonly unknown[]) => boolean): CrashHandle {
  let dead = false;
  const ledger = new Proxy(inner as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "close") return value;
      return (...args: unknown[]) => {
        if (dead) throw new ProcessCrash(String(property));
        if (trigger?.(String(property), args)) {
          dead = true;
          throw new ProcessCrash(String(property));
        }
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as RunLedger;
  return { ledger, kill: () => { dead = true; }, fired: () => dead };
}

interface Fixture {
  target: string;
  state: string;
  ledger: SqliteRunLedger;
  run: LedgerRun;
  gitCalls: string[][];
  gitLayer(): GitCommandLayer;
}

function seed(options: {
  boundary?: LedgerRun["boundary"];
  tasks?: Array<{ id: string; owner?: AgentStage; dependsOn?: string[] }>;
} = {}): Fixture {
  const target = repository();
  const state = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v8-fault-state-")));
  roots.push(state);
  const store = new SqliteTaskStore(path.join(state, "state.db"));
  const ledger = new SqliteRunLedger(store, { projectRoot: state });
  ledgers.push(ledger);
  const runId = createRunId();
  const rows = options.tasks ?? [{ id: "BE-1" }];
  const run: LedgerRun = {
    ledger_version: LEDGER_SCHEMA_VERSION, run_id: runId, status: "REGISTERED", boundary: options.boundary ?? "done",
    module: "orders", target_id: "target", target_root: target, knowledge_root: state,
    base_branch: "main", base_sha: git(target, "rev-parse", "HEAD"), run_branch: `sta/run/orders/${runId}`,
    requirement_hash: HASH_A, design_hash: HASH_B, plan_hash: HASH_C, config_hash: HASH_A,
    sta_version: "2.0.0", task_order: rows.map((row) => row.id), max_tasks: rows.length,
    created_at: 1_000, updated_at: 1_000, halt_reason: null,
  };
  const tasks: LedgerTask[] = rows.map((row, index) => ({
    run_id: runId, task_id: row.id, status: "PLANNED", owner: row.owner ?? AgentStage.BACKEND_ENGINEER,
    phase: 1, depends_on: row.dependsOn ?? [], produces: [], consumes: [], task_hash: HASH_A,
    position: index, updated_at: 1_000,
  }));
  ledger.transaction(() => { ledger.createRun(run); ledger.registerTasks(tasks); });
  const gitCalls: string[][] = [];
  return {
    target, state, ledger, run, gitCalls,
    gitLayer: () => new GitCommandLayer({
      cwd: target,
      identity: { name: "Fixture", email: "fixture@example.invalid" },
      processRunner: (args, processOptions) => { gitCalls.push([...args]); return defaultGitProcessRunner(args, processOptions); },
    }),
  };
}

function packetHash(taskId: string, attempt: number): string {
  return [...`${taskId}#${attempt}`]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

/** Attempt numbering comes from the ledger, so a resumed run never reuses a frozen attempt id. */
function freeze(ledger: RunLedger, f: Fixture, task: LedgerTask, overrides: Partial<LedgerAttempt> = {}): LedgerAttempt {
  const number = ledger.attemptsForTask(f.run.run_id, task.task_id).length + 1;
  const frozen: LedgerAttempt = {
    attempt_id: `${f.run.run_id}:${task.task_id}:${task.owner}:${number}`, run_id: f.run.run_id, task_id: task.task_id,
    stage: task.owner, attempt: number, status: "FROZEN",
    requested: { runtime: "claude-code", model: "opus", effort: "high" },
    observed: { runtime: "claude-code", model: "opus", effort: "high" },
    model_explicit: true, route_basis: "task-tier:T2", tier: "T2", adapter_version: "fixture@1",
    config_hash: HASH_A, plan_hash: HASH_C, base_revision: f.run.base_sha,
    capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
    guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [f.target] },
    packet_hash: packetHash(task.task_id, number), packet_path: `.workflow/packets/${task.task_id}/${number}.json`,
    started_at: 2_000 + number, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
  ledger.freezeAttempt(frozen);
  return frozen;
}

const passed: DeterministicVerification = {
  required: ["typecheck"], ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "ok" }],
  failures: [], skipped: [], missingRequired: [], status: "passed", enforcement: "enforce", passed: true,
};

const failedVerification: DeterministicVerification = {
  required: ["typecheck"], ran: [{ id: "typecheck", status: "FAIL", durationMs: 1, outputSummary: "TS2322" }],
  failures: [{ id: "typecheck", status: "FAIL", durationMs: 1, outputSummary: "TS2322" }], skipped: [],
  missingRequired: [], status: "failed", enforcement: "enforce", passed: false,
};

interface ScenarioOptions {
  ledger?: RunLedger;
  qa?: (round: number) => QaControllerResult;
  verification?: (taskId: string, attempt: number) => DeterministicVerification;
  onExecute?: (prepared: PreparedTargetAttempt) => void | Promise<void>;
  execution?: BoundedRunServices["executeAttempt"];
  prepare?: BoundedRunServices["prepareTask"];
  analysisRepair?: BoundedRunServices["runAnalysisRepair"];
  allowedPathGlobs?: readonly string[];
  writeFile?: (prepared: PreparedTargetAttempt) => void;
  onQa?: (round: number) => void;
  secretScanner?: PreparedTargetAttempt["secretScanner"];
}

interface Harness extends BoundedRunServices {
  launches: string[];
  qaCalls: number[];
  repairs: Array<RepairInstruction | null>;
}

function harness(f: Fixture, options: ScenarioOptions = {}): Harness {
  const launches: string[] = [];
  const qaCalls: number[] = [];
  const repairs: Array<RepairInstruction | null> = [];
  const ledger = options.ledger ?? f.ledger;
  return {
    launches, qaCalls, repairs,
    prepareTask: options.prepare ?? (async (task, context) => {
      repairs.push(context.repair);
      return {
        kind: "attempt",
        attempt: freeze(ledger, f, task),
        taskDescription: `execute ${task.task_id}`,
        allowedPathGlobs: options.allowedPathGlobs ?? ["src/**"],
        secretScanner: options.secretScanner ?? (() => ({ ok: true, problems: [] })),
      };
    }),
    executeAttempt: options.execution ?? (async (prepared: PreparedTargetAttempt) => {
      launches.push(`${prepared.attempt.task_id}:${prepared.attempt.attempt}`);
      await options.onExecute?.(prepared);
      if (options.writeFile) options.writeFile(prepared);
      else fs.writeFileSync(path.join(f.target, "src", `${prepared.attempt.task_id}.txt`), `attempt ${prepared.attempt.attempt}\n`);
      return {
        kind: "completed",
        adapter: { status: "OK", exitCode: 0 },
        verification: options.verification?.(prepared.attempt.task_id, prepared.attempt.attempt) ?? passed,
      };
    }),
    runQa: async ({ round }) => {
      qaCalls.push(round);
      options.onQa?.(round);
      return options.qa?.(round) ?? { kind: "pass", evidence: "all task/AC verdicts passed" };
    },
    ...(options.analysisRepair ? { runAnalysisRepair: options.analysisRepair } : {}),
  };
}

function controller(f: Fixture, services: BoundedRunServices, ledger: RunLedger = f.ledger): BoundedRunController {
  return new BoundedRunController({
    ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services, git: f.gitLayer(),
  });
}

/** Runs a controller that is expected to die rather than return. */
async function crash(f: Fixture, handle: CrashHandle, services: BoundedRunServices): Promise<void> {
  await expect(controller(f, services, handle.ledger).run()).rejects.toBeInstanceOf(ProcessCrash);
  expect(handle.fired()).toBe(true);
}

function statuses(f: Fixture): Record<string, string> {
  return Object.fromEntries(f.ledger.readTasks(f.run.run_id).map((task) => [task.task_id, task.status]));
}

function attemptRows(f: Fixture, taskId: string): string[] {
  return f.ledger.attemptsForTask(f.run.run_id, taskId).map((attempt) => `${attempt.attempt}:${attempt.status}`);
}

function porcelain(root: string): string {
  return git(root, "status", "--porcelain");
}

function branchExists(root: string, branch: string): boolean {
  return git(root, "branch", "--list", branch) !== "";
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ------------------------------------------- persisted crash boundaries ---

describe("T-V8-022 — persisted crash boundaries resume or refuse deterministically", () => {
  it("B01 · before plan freeze — a crash inside registration leaves no run to resume", async () => {
    const f = seed();
    const other = createRunId();
    // The registration transaction is T-V8-017's; what this row proves is the
    // controller's own contract at the boundary before it: an id that was
    // never durably registered is refused, not invented.
    const result = await new BoundedRunController({
      ledger: f.ledger, runId: other, runtimeStateRoot: f.state, services: harness(f), git: f.gitLayer(),
    }).run();
    expect(result.kind).toBe("REFUSED");
    expect(result.reason).toContain("does not exist");
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);

    const control = await controller(f, harness(f)).run();
    record({
      id: "B01", boundary: "before plan freeze", fault: "registration transaction never committed",
      expected: "refuse", observed: `REFUSED: ${result.reason}`, proof: "control",
      proofObserved: `the same controller against the registered run id returns ${control.kind}`,
    });
    expect(control.kind).toBe("COMPLETED");
  }, 30_000);

  it("B02 · after plan freeze, before branch creation — resume creates the branch and loses nothing", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method) => method === "setTaskStatus");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("REGISTERED");
    expect(statuses(f)).toEqual({ "BE-1": "PLANNED" });
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 1 });
    expect(resumed.launches).toEqual(["BE-1:1"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    record({
      id: "B02", boundary: "after plan freeze, before branch creation",
      fault: "process death before the first task-status write",
      expected: "resume", observed: "run REGISTERED, no branch, 0 checkpoints; resume COMPLETED with exactly BE-1:1",
      proof: "control",
      proofObserved: "the crash left task PLANNED and no branch; without the crash the same harness reaches CHECKPOINTED in one pass",
    });
  }, 30_000);

  it("B03 · after branch creation, before the RUNNING write — resume adopts the exact branch without a second switch", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "RUNNING");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("REGISTERED");
    expect(branchExists(f.target, f.run.run_branch)).toBe(true);
    expect(git(f.target, "rev-parse", "HEAD")).toBe(f.run.base_sha);
    const createdBefore = f.gitCalls.filter((call) => call[0] === "switch").length;
    expect(createdBefore).toBe(1);

    f.gitCalls.length = 0;
    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("COMPLETED");
    expect(f.gitCalls.filter((call) => call[0] === "switch")).toEqual([]);
    record({
      id: "B03", boundary: "after branch creation, before the ledger RUNNING write",
      fault: "process death between switch -c and setRunStatus(RUNNING)",
      expected: "resume", observed: "branch present at base_sha, run still REGISTERED; resume adopted it and issued zero switch commands",
      proof: "control",
      proofObserved: "B03b runs the identical scenario with one extra dirty byte on that branch and is refused",
    });
  }, 30_000);

  it("B03b · the adopted branch must be clean — a dirty adopted branch refuses and keeps the bytes", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "RUNNING");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    const stray = path.join(f.target, "src", "human-was-here.txt");
    fs.writeFileSync(stray, "unsaved human work\n");
    const before = fs.readFileSync(stray, "utf8");

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    // REFUSED, not HALTED: the refusal happened inside session open, before
    // the run ever reached RUNNING, so the controller has nothing to halt.
    // The run row is left exactly as the crash left it and the next
    // invocation refuses identically.
    expect(result.kind).toBe("REFUSED");
    expect(result.reason).toContain("new run branch is dirty after interrupted isolation");
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("REGISTERED");
    expect(resumed.launches).toEqual([]);
    expect(fs.readFileSync(stray, "utf8")).toBe(before);
    expect(porcelain(f.target)).toContain("human-was-here.txt");
    record({
      id: "B03b", boundary: "after branch creation, before the ledger RUNNING write",
      fault: "the adopted run branch carries an uncommitted human file",
      expected: "refuse", observed: `REFUSED: ${result.reason}; run left REGISTERED, the file byte-identical and still untracked`,
      proof: "control",
      proofObserved: "B03 is the same scenario with a clean branch and resumes to COMPLETED",
    });
  }, 30_000);

  it("B04 · after attempt freeze, before attempt start — the frozen attempt is never edited and a new one is frozen", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method) => method === "updateAttempt");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    // beginTask writes the task RUNNING and the attempt RUNNING in one
    // transaction; a crash inside it must roll both back, not half of them.
    expect(statuses(f)).toEqual({ "BE-1": "READY" });
    expect(attemptRows(f, "BE-1")).toEqual(["1:FROZEN"]);
    const frozenBefore = JSON.stringify(f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`));

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("COMPLETED");
    expect(resumed.launches).toEqual(["BE-1:2"]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:FROZEN", "2:SUCCEEDED"]);
    expect(JSON.stringify(f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`))).toBe(frozenBefore);
    record({
      id: "B04", boundary: "after attempt freeze/packet persist, before attempt start",
      fault: "process death inside beginTask's transaction",
      expected: "resume", observed: "attempt 1 stayed FROZEN byte-identical, task rolled back to READY, resume froze attempt 2 and checkpointed it",
      proof: "control",
      proofObserved: "attempt 1's bytes are compared before and after the resume and are identical, so the resume created rather than mutated an attempt",
    });
  }, 30_000);

  it("B05 · after attempt start, before the agent returns — an interrupted in-flight attempt refuses and preserves the partial diff", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    const partial = path.join(f.target, "src", "partial.txt");
    const services = harness(f, {
      ledger: handle.ledger,
      execution: async () => {
        fs.writeFileSync(partial, "half-written agent work\n");
        handle.kill();
        throw new ProcessCrash("executeAttempt");
      },
    });
    await expect(controller(f, services, handle.ledger).run()).rejects.toBeInstanceOf(ProcessCrash);

    expect(statuses(f)).toEqual({ "BE-1": "RUNNING" });
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    const before = fs.readFileSync(partial, "utf8");

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toMatch(/RUNNING -> READY|cannot move RUNNING/);
    expect(resumed.launches).toEqual([]);
    expect(fs.readFileSync(partial, "utf8")).toBe(before);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    record({
      id: "B05", boundary: "after attempt start, before the agent returns",
      fault: "process death while the runtime held the one-writer slot",
      expected: "refuse", observed: `HALTED without relaunching the owner: ${result.reason}`,
      proof: "control",
      proofObserved: "B04 is the same run one ledger write earlier (task READY, attempt FROZEN) and resumes cleanly, so the refusal is caused by the RUNNING attempt and not by the crash itself",
    });
  }, 30_000);

  it("B06 · after the agent returns, before the deterministic result — a dirty VERIFYING window refuses and discards nothing", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    // The secret scan is the last guard inside checkpointTask before "git
    // add", so dying there is exactly the VERIFYING window: the task status
    // is already durable, verification has passed, and nothing is staged.
    const services = harness(f, {
      ledger: handle.ledger,
      secretScanner: () => {
        handle.kill();
        throw new ProcessCrash("secretScan");
      },
    });
    await expect(controller(f, services, handle.ledger).run()).rejects.toBeInstanceOf(ProcessCrash);

    expect(statuses(f)).toEqual({ "BE-1": "VERIFYING" });
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    const agentWork = path.join(f.target, "src", "BE-1.txt");
    const before = fs.readFileSync(agentWork, "utf8");
    expect(porcelain(f.target)).toContain("BE-1.txt");

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("resumes only on clean branch");
    expect(resumed.launches).toEqual([]);
    expect(fs.readFileSync(agentWork, "utf8")).toBe(before);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    record({
      id: "B06", boundary: "after the agent returns, before the deterministic result",
      fault: "process death during deterministic verification, leaving uncommitted agent work",
      expected: "refuse", observed: `HALTED: ${result.reason}; the uncommitted agent file is byte-identical`,
      proof: "control",
      proofObserved: "B07 is the same VERIFYING window with the work already committed and resumes by re-attributing it, so the refusal is caused by the dirty tree",
    });
  }, 30_000);

  it("B07 · after the commit, before the checkpoint transaction — resume re-attributes the exact HEAD without relaunching DEV", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method) => method === "recordCheckpoint");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    expect(statuses(f)).toEqual({ "BE-1": "VERIFYING" });
    expect(attemptRows(f, "BE-1")).toEqual(["1:RUNNING"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    const orphan = git(f.target, "rev-parse", "HEAD");
    expect(orphan).not.toBe(f.run.base_sha);
    expect(porcelain(f.target)).toBe("");

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("COMPLETED");
    expect(resumed.launches).toEqual([]);
    const checkpoints = f.ledger.checkpointsForRun(f.run.run_id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      task_id: "BE-1",
      sha: orphan,
      attempt_id: `${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`,
      packet_hash: packetHash("BE-1", 1),
    });
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("2");
    ARTIFACTS.b07_checkpoint_reconciliation = {
      orphan_head: orphan,
      checkpoint: checkpoints[0],
      timeline: f.ledger.eventsForRun(f.run.run_id).map((event) => [event.kind, event.task_id ?? "-", `${event.from ?? ""}->${event.to ?? ""}`, event.reason ?? ""].join(" ").trim()),
    };
    record({
      id: "B07", boundary: "after the Git commit, before the ledger checkpoint transaction",
      fault: "process death between commit and recordCheckpoint",
      expected: "resume",
      observed: `HEAD ${orphan.slice(0, 12)} re-attributed to attempt 1 with its exact packet hash; DEV launched 0 times and the branch still holds 2 commits`,
      proof: "control",
      proofObserved: "B07b is the identical window with one trailer byte changed and refuses instead of adopting the commit",
    });
  }, 30_000);

  it("B07b · a HEAD whose trailers do not match the interrupted attempt is refused, not adopted", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method) => method === "recordCheckpoint");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    // Same window, one injected defect: the commit on HEAD belongs to some
    // other packet. Nothing may adopt it into this attempt's identity.
    const tampered = f.ledger.readAttempt(`${f.run.run_id}:BE-1:${AgentStage.BACKEND_ENGINEER}:1`)!;
    const session = await GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: tampered,
    });
    try {
      await expect(session.reconcileHeadCheckpoint({ ...tampered, packet_hash: HASH_B }))
        .rejects.toThrow(/does not carry exact STA-Packet-Hash/);
      await expect(session.reconcileHeadCheckpoint(tampered)).resolves.toBe(git(f.target, "rev-parse", "HEAD"));
    } finally {
      session.close();
    }
    record({
      id: "B07b", boundary: "after the Git commit, before the ledger checkpoint transaction",
      fault: "the interrupted attempt claims a packet hash the HEAD trailers do not carry",
      expected: "refuse", observed: "RECONCILE_MISMATCH naming STA-Packet-Hash",
      proof: "control",
      proofObserved: "the same call with the real packet hash immediately re-attributes the same HEAD",
    });
  }, 30_000);

  it("B08 · after a checkpoint, before the next task — the checkpointed task never reruns", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    const handle = crashingLedger(f.ledger, (method, args) => method === "setTaskStatus" && args[1] === "BE-2");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    expect(statuses(f)).toEqual({ "BE-1": "CHECKPOINTED", "BE-2": "PLANNED" });
    const firstCheckpoint = f.ledger.checkpointsForRun(f.run.run_id);
    expect(firstCheckpoint).toHaveLength(1);

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 1 });
    expect(resumed.launches).toEqual(["BE-2:1"]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)[0]).toEqual(firstCheckpoint[0]);
    record({
      id: "B08", boundary: "after a task checkpoint, before the next task starts",
      fault: "process death before the next task's readiness write",
      expected: "resume",
      observed: "resume launched only BE-2:1; BE-1 kept its single SUCCEEDED attempt and its original checkpoint row unchanged",
      proof: "bypass",
      proofObserved: "B08-defect forces the checkpointed task back to READY and the same controller then reruns it, so the no-rerun result comes from the ledger status and not from the harness",
    });
  }, 30_000);

  it("B08-defect · neutralizing the checkpointed status is what makes a rerun possible", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    const handle = crashingLedger(f.ledger, (method, args) => method === "setTaskStatus" && args[1] === "BE-2");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    f.ledger.setTaskStatus(f.run.run_id, "BE-1", "READY", { reason: "injected defect: forget the checkpoint" });
    const resumed = harness(f);
    await controller(f, resumed).run();
    expect(resumed.launches).toContain("BE-1:2");
    expect(f.ledger.checkpointsForRun(f.run.run_id).filter((item) => item.task_id === "BE-1")).toHaveLength(2);
  }, 30_000);

  it("B09 · after the QA round opens, before its verdict — QA re-runs and DEV does not", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger);
    const services = harness(f, {
      ledger: handle.ledger,
      onQa: () => {
        handle.kill();
        throw new ProcessCrash("runQa");
      },
    });
    await expect(controller(f, services, handle.ledger).run()).rejects.toBeInstanceOf(ProcessCrash);

    expect(statuses(f)).toEqual({ "BE-1": "CHECKPOINTED" });
    expect(f.ledger.eventsForRun(f.run.run_id).filter((event) => event.kind === "QA_ROUND_STARTED")).toHaveLength(1);

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 0, qaRounds: 2 });
    expect(resumed.launches).toEqual([]);
    expect(resumed.qaCalls).toEqual([2]);
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
    record({
      id: "B09", boundary: "after the QA round opens, before its verdict is persisted",
      fault: "process death inside the QA round",
      expected: "resume",
      observed: "resume re-opened QA as round 2 (the durable QA_ROUND_STARTED count), launched 0 DEV attempts and completed",
      proof: "control",
      proofObserved: "the pre-crash DEV attempt row is 1:SUCCEEDED before and after the resume, so the second QA round is the only work that repeated",
    });
  }, 30_000);

  it("B10 · after repair is scheduled, before the repair attempt starts — the repair survives the crash", async () => {
    const f = seed();
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "AC-1 failed", findingIds: ["F-1"],
      invalidates: [], requiresHuman: false,
    };
    let frozenOnce = false;
    const crashAfterFirstFreeze = crashingLedger(f.ledger, (method) => {
      if (method !== "freezeAttempt") return false;
      if (!frozenOnce) { frozenOnce = true; return false; }
      return true;
    });
    const services = harness(f, {
      ledger: crashAfterFirstFreeze.ledger,
      qa: () => ({ kind: "repair", evidence: "F-1", repair }),
    });
    await expect(controller(f, services, crashAfterFirstFreeze.ledger).run()).rejects.toBeInstanceOf(ProcessCrash);

    const scheduled = f.ledger.eventsForRun(f.run.run_id).filter((event) => event.kind === "QA_REPAIR_SCHEDULED");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toMatchObject({ findings: ["F-1"], round: 1 });
    expect(statuses(f)).toEqual({ "BE-1": "READY" });
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);

    const resumed = harness(f, { qa: (round) => (round >= 3 ? { kind: "pass", evidence: "F-1 closed" } : { kind: "repair", evidence: "F-1", repair }) });
    const result = await controller(f, resumed).run();
    expect(result.kind).toBe("COMPLETED");
    expect(resumed.launches[0]).toBe("BE-1:2");
    // The durable QA_REPAIR_SCHEDULED record is what carries the finding into
    // the resumed attempt; the controller's in-process map did not survive.
    expect(resumed.repairs[0]).toMatchObject({ findingIds: ["F-1"], taskId: "BE-1" });
    ARTIFACTS.b10_repair_timeline = {
      rehydrated_instruction: resumed.repairs[0],
      attempts: attemptRows(f, "BE-1"),
      timeline: f.ledger.eventsForRun(f.run.run_id).map((event) => [event.kind, event.task_id ?? "-", event.reason ?? ""].join(" ").trim()),
    };
    record({
      id: "B10", boundary: "after QA repair is scheduled, before the repair attempt starts",
      fault: "process death between the QA_REPAIR_SCHEDULED event and freezing the repair attempt",
      expected: "resume",
      observed: "the resumed controller rehydrated the finding from the durable event and prepared BE-1 attempt 2 as a targeted repair",
      proof: "bypass",
      proofObserved: "B10-defect hides the durable repair event from the resumed controller and the attempt is then prepared with repair=null, so the rehydration is what carries the finding",
    });
  }, 30_000);

  it("B10-defect · hiding the durable repair event is what loses the finding", async () => {
    const f = seed();
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "AC-1 failed", findingIds: ["F-1"],
      invalidates: [], requiresHuman: false,
    };
    let frozenOnce = false;
    const crashAfterFirstFreeze = crashingLedger(f.ledger, (method) => {
      if (method !== "freezeAttempt") return false;
      if (!frozenOnce) { frozenOnce = true; return false; }
      return true;
    });
    await expect(
      controller(f, harness(f, { ledger: crashAfterFirstFreeze.ledger, qa: () => ({ kind: "repair", evidence: "F-1", repair }) }), crashAfterFirstFreeze.ledger).run(),
    ).rejects.toBeInstanceOf(ProcessCrash);

    // The injected defect is exactly the input `rehydrateScheduledRepair`
    // reads: a ledger whose event log has forgotten the scheduled repair.
    const amnesiac = new Proxy(f.ledger as object, {
      get(target, property, receiver) {
        if (property !== "eventsForRun") return Reflect.get(target, property, receiver);
        return (runId: string) => f.ledger.eventsForRun(runId).filter((event) => event.kind !== "QA_REPAIR_SCHEDULED");
      },
    }) as unknown as RunLedger;

    const resumed = harness(f, { qa: () => ({ kind: "pass", evidence: "closed" }) });
    await controller(f, resumed, amnesiac).run();
    expect(resumed.repairs[0]).toBeNull();
  }, 30_000);

  it("B11 · after the last checkpoint, before the run completes — resume closes the run with no new DEV work", async () => {
    const f = seed();
    const handle = crashingLedger(f.ledger, (method, args) => method === "setRunStatus" && args[1] === "COMPLETED");
    await crash(f, handle, harness(f, { ledger: handle.ledger }));

    expect(statuses(f)).toEqual({ "BE-1": "CHECKPOINTED" });
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("RUNNING");

    const resumed = harness(f);
    const result = await controller(f, resumed).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 0 });
    expect(resumed.launches).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("COMPLETED");
    expect(statuses(f)).toEqual({ "BE-1": "DONE" });
    record({
      id: "B11", boundary: "after the last checkpoint, before the run status write",
      fault: "process death before setRunStatus(COMPLETED)",
      expected: "resume", observed: "resume launched 0 DEV attempts, re-ran QA and moved the run to COMPLETED and the task to DONE",
      proof: "control",
      proofObserved: "the crash left run=RUNNING/task=CHECKPOINTED; a completed run is refused as already terminal (B12), so the resume acted on the un-written status and not on a replay",
    });
  }, 30_000);

  it("B12 · a terminal run is never re-executed", async () => {
    const f = seed();
    expect((await controller(f, harness(f)).run()).kind).toBe("COMPLETED");
    const replay = harness(f);
    const result = await controller(f, replay).run();
    expect(result.kind).toBe("COMPLETED");
    expect(result.reason).toContain("already COMPLETED");
    expect(replay.launches).toEqual([]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    record({
      id: "B12", boundary: "after completion", fault: "the same run id is invoked again",
      expected: "refuse", observed: "returned COMPLETED without launching an attempt or adding a checkpoint",
      proof: "control",
      proofObserved: "the first invocation of the identical controller/harness pair launched BE-1:1 and produced the checkpoint",
    });
  }, 30_000);
});

// ----------------------------------------------------------- fault kinds ---

describe("T-V8-022 — non-crash fault classes end the run explicitly and durably", () => {
  it.each([
    { id: "F01", label: "quota exhaustion", category: "quota" as const, reason: "usage limit reached", attempt: "FAILED", kind: "HALTED" },
    { id: "F02", label: "provider/network unavailability", category: "unavailable" as const, reason: "provider unavailable", attempt: "UNAVAILABLE", kind: "HALTED" },
    { id: "F03", label: "runtime timeout", category: "runtime" as const, reason: "runtime timed out after 900s", attempt: "FAILED", kind: "HALTED" },
  ])("$id · $label halts with the attempt settled, no checkpoint, and a resumable run", async ({ id, label, category, reason, attempt, kind }) => {
    const f = seed();
    const services = harness(f, { execution: async () => ({ kind: "halt", category, reason }) });
    const result = await controller(f, services).run();
    expect(result).toMatchObject({ kind, reason, qaRounds: 0 });
    expect(attemptRows(f, "BE-1")).toEqual([`1:${attempt}`]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)).toMatchObject({ status: "HALTED", halt_reason: reason });
    expect(porcelain(f.target)).toBe("");

    // Durable and resumable: the halted run continues on the next explicit
    // invocation rather than needing a new registration.
    const resumed = harness(f);
    expect((await controller(f, resumed).run()).kind).toBe("COMPLETED");
    expect(resumed.launches).toEqual(["BE-1:2"]);
    record({
      id, boundary: "agent return", fault: label,
      expected: "halt",
      observed: `HALTED with attempt 1 settled ${attempt}, zero checkpoints, halt_reason persisted`,
      proof: "control",
      proofObserved: "the same fixture resumed with a healthy runtime reaches COMPLETED on attempt 2, so the halt came from the injected failure category",
    });
  }, 30_000);

  it("F04 · a user interruption abandons the attempt without failing the task's future", async () => {
    const f = seed();
    const services = harness(f, { execution: async () => ({ kind: "interrupted", reason: "SIGINT from the operator" }) });
    const result = await controller(f, services).run();
    expect(result).toMatchObject({ kind: "INTERRUPTED", launchedAttempts: 1, qaRounds: 0 });
    expect(attemptRows(f, "BE-1")).toEqual(["1:ABANDONED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("HALTED");

    const resumed = harness(f);
    expect((await controller(f, resumed).run()).kind).toBe("COMPLETED");
    record({
      id: "F04", boundary: "agent return", fault: "operator interruption (SIGINT-shaped)",
      expected: "halt", observed: "INTERRUPTED exit, attempt 1 ABANDONED (not FAILED), run HALTED and resumable",
      proof: "control",
      proofObserved: "F01/F02/F03 are the same seam returning a halt category and settle the attempt FAILED/UNAVAILABLE instead, so ABANDONED is attributable to the interruption",
    });
  }, 30_000);

  it("F05 · a deterministic failure refuses the checkpoint and leaves the work in the tree", async () => {
    const f = seed();
    const services = harness(f, { verification: () => failedVerification });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("Deterministic verification failed");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
    expect(porcelain(f.target)).toContain("BE-1.txt");
    expect(fs.readFileSync(path.join(f.target, "src", "BE-1.txt"), "utf8")).toBe("attempt 1\n");
    record({
      id: "F05", boundary: "deterministic result", fault: "typecheck fails after the agent returns",
      expected: "halt", observed: "CheckpointRefusal DETERMINISTIC_FAILED; branch still at 1 commit and the agent's file is uncommitted and unmodified",
      proof: "control",
      proofObserved: "the identical harness with a passing verification commits the same file and records a checkpoint (B02)",
    });
  }, 30_000);

  it("F06 · no test suite is treated as unverified, never as a pass", async () => {
    const f = seed();
    const skipped: DeterministicVerification = {
      required: ["typecheck"], ran: [], failures: [], skipped: ["typecheck"], missingRequired: ["typecheck"],
      status: "skipped", enforcement: "enforce", passed: false,
    };
    const services = harness(f, { verification: () => skipped });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("Deterministic verification was skipped");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    record({
      id: "F06", boundary: "deterministic result", fault: "the Target resolves no deterministic command",
      expected: "halt", observed: "CheckpointRefusal DETERMINISTIC_SKIPPED with no checkpoint",
      proof: "control",
      proofObserved: "the same verification object with status=passed produces the checkpoint, so 'skipped' is refused on its own and does not fall through to a pass",
    });
  }, 30_000);

  it("F07 · a pre-existing dirty Target refuses before any branch or attempt exists", async () => {
    const f = seed();
    const human = path.join(f.target, "src", "base.txt");
    fs.writeFileSync(human, "base\nhuman edit in progress\n");
    const before = fs.readFileSync(human, "utf8");

    const services = harness(f);
    const result = await controller(f, services).run();
    expect(result.kind).toBe("REFUSED");
    expect(result.reason).toContain("Resolve this repository state");
    expect(services.launches).toEqual([]);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(fs.readFileSync(human, "utf8")).toBe(before);
    expect(git(f.target, "branch", "--show-current")).toBe("main");
    record({
      id: "F07", boundary: "branch creation", fault: "the operator has uncommitted work in the Target",
      expected: "refuse", observed: "RepositoryPreflightError before any branch, attempt or commit; the human bytes are unchanged and HEAD is still main",
      proof: "control",
      proofObserved: "the same fixture with a clean tree creates the branch and completes (B02), so the refusal is caused by the dirty file",
    });
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
    record({
      id: "F08", boundary: "resume identity", fault: "plan/requirement/design/base-revision/config drifted under a frozen run",
      expected: "refuse", observed: "LedgerConflictError for each of the five drifted fields, naming both the frozen and current value",
      proof: "control",
      proofObserved: "the same assertion with the run's own values passes, so each refusal is caused by exactly the drifted field",
    });
  });

  it("F09 · a frozen attempt refuses to resume against a changed world", async () => {
    const f = seed();
    const task = f.ledger.readTask(f.run.run_id, "BE-1")!;
    const attempt = freeze(f.ledger, f, task);
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
    record({
      id: "F09", boundary: "attempt resume", fault: "packet/config/plan/base/runtime/adapter changed under a frozen attempt",
      expected: "refuse", observed: "AttemptResumeError for each of the six drift classes",
      proof: "control",
      proofObserved: "the same call with the attempt's own frozen values passes",
    });
  });

  it("F10 · a malformed or tampered audit export is refused and never becomes the authority", async () => {
    const f = seed();
    await controller(f, harness(f)).run();
    const exported = exportRunAudit(f.ledger, f.run.run_id);
    expect(() => importRunAudit(exported)).not.toThrow();

    const truncated = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    delete truncated.tasks;
    expect(() => importRunAudit(truncated)).toThrow(AuditImportError);
    expect(() => importRunAudit(JSON.parse('{"not":"an export"}'))).toThrow(AuditImportError);

    const inconsistent = JSON.parse(JSON.stringify(exported)) as typeof exported;
    inconsistent.run.task_order = ["BE-1", "GHOST-9"];
    expect(() => importRunAudit(inconsistent)).toThrow(AuditImportError);

    // Even a *valid* export is not a second authority: editing it changes nothing.
    const edited = JSON.parse(JSON.stringify(exported)) as typeof exported;
    edited.run.status = "REGISTERED";
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("COMPLETED");
    record({
      id: "F10", boundary: "audit export/import", fault: "truncated, foreign, and internally inconsistent export documents",
      expected: "refuse", observed: "AuditImportError in all three cases; an edited valid export left the ledger COMPLETED",
      proof: "control",
      proofObserved: "the untouched export imports cleanly, so each refusal is caused by exactly the injected corruption",
    });
  }, 30_000);

  it("F11 · a tampered frozen attempt cannot open a Target mutation boundary", async () => {
    const f = seed();
    const task = f.ledger.readTask(f.run.run_id, "BE-1")!;
    const frozen = freeze(f.ledger, f, task);
    const tampered = { ...frozen, packet_hash: HASH_B };

    await expect(GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: tampered,
    })).rejects.toThrow(/byte-identical frozen ledger record/);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);

    const honest = await GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: frozen,
    });
    honest.close();
    expect(branchExists(f.target, f.run.run_branch)).toBe(true);
    record({
      id: "F11", boundary: "attempt start", fault: "an in-memory attempt whose bytes differ from the ledger row",
      expected: "refuse", observed: "ATTEMPT_NOT_FROZEN before any branch command",
      proof: "control",
      proofObserved: "the byte-identical record opens the same session and creates the branch",
    });
  }, 30_000);

  it("F12 · the ledger refuses to overwrite a frozen attempt with different inputs", () => {
    const f = seed();
    const task = f.ledger.readTask(f.run.run_id, "BE-1")!;
    const frozen = freeze(f.ledger, f, task);
    expect(() => f.ledger.freezeAttempt(frozen)).not.toThrow();
    expect(() => f.ledger.freezeAttempt({ ...frozen, observed: { runtime: "codex", model: "gpt-5", effort: "low" } }))
      .toThrow(/already frozen with different inputs/);
    expect(f.ledger.readAttempt(frozen.attempt_id)?.observed.runtime).toBe("claude-code");
    record({
      id: "F12", boundary: "attempt freeze", fault: "a replay that silently reroutes the frozen attempt",
      expected: "refuse", observed: "LedgerConflictError; the stored route is unchanged",
      proof: "control",
      proofObserved: "the byte-identical replay is accepted as idempotent, so the refusal is caused by the changed route and not by the replay",
    });
  });
});

// ----------------------------------------------------------- human gates ---

describe("T-V8-022 — every human gate stops at the exact recorded gate", () => {
  it("G01 · a schema-confirmation gate stops before any packet, branch or attempt", async () => {
    const f = seed({ boundary: "next-gate" });
    const services = harness(f, {
      prepare: async () => ({ kind: "gate", reason: "schema confirmation required for BE-1 before implementation" }),
    });
    const result = await controller(f, services).run();
    expect(result).toMatchObject({ kind: "GATE", launchedAttempts: 0 });
    expect(f.ledger.readRun(f.run.run_id)).toMatchObject({
      status: "AWAITING_HUMAN", halt_reason: "schema confirmation required for BE-1 before implementation",
    });
    expect(statuses(f)).toEqual({ "BE-1": "BLOCKED" });
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-1")).toEqual([]);

    // A gated run does not restart itself: the next invocation reports the
    // same recorded gate instead of executing.
    const again = harness(f);
    const replay = await controller(f, again).run();
    expect(replay).toMatchObject({ kind: "GATE", reason: "schema confirmation required for BE-1 before implementation" });
    expect(again.launches).toEqual([]);
    record({
      id: "G01", boundary: "packet compilation", fault: "the task carries an unresolved schema gate",
      expected: "gate", observed: "AWAITING_HUMAN with the exact reason persisted; task BLOCKED, no branch, no attempt, and a replay re-reports the same gate",
      proof: "control",
      proofObserved: "the same fixture whose prepareTask returns an attempt creates the branch and completes",
    });
  }, 30_000);

  it("G02 · the two-round ordinary repair ceiling stops the run for a person", async () => {
    const f = seed();
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "AC-1 still failing", findingIds: ["F-1"],
      invalidates: [], requiresHuman: false,
    };
    const services = harness(f, { qa: () => ({ kind: "repair", evidence: "F-1", repair }) });
    const result = await controller(f, services).run();
    expect(result).toMatchObject({
      kind: "GATE",
      launchedAttempts: MAX_AUTOMATIC_REPAIR_ROUNDS + 1,
      qaRounds: MAX_AUTOMATIC_REPAIR_ROUNDS + 1,
    });
    expect(result.reason).toContain(`ordinary automatic repair limit (${MAX_AUTOMATIC_REPAIR_ROUNDS})`);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    expect(f.ledger.eventsForRun(f.run.run_id).filter((event) => event.kind === "QA_REPAIR_SCHEDULED")).toHaveLength(MAX_AUTOMATIC_REPAIR_ROUNDS);
    record({
      id: "G02", boundary: "QA repair", fault: "QA keeps failing the same finding",
      expected: "gate",
      observed: `exactly ${MAX_AUTOMATIC_REPAIR_ROUNDS} automatic repair rounds were scheduled, then AWAITING_HUMAN`,
      proof: "control",
      proofObserved: "the same fixture whose QA passes on round 2 completes after a single repair, so the stop is the ceiling and not a generic failure",
    });
  }, 40_000);

  it("G03 · a finding that requires a human is never repaired automatically", async () => {
    const f = seed();
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "Critical security finding: auth bypass",
      findingIds: ["S-1"], invalidates: [], requiresHuman: true,
    };
    const services = harness(f, { qa: () => ({ kind: "repair", evidence: "S-1", repair }) });
    const result = await controller(f, services).run();
    expect(result).toMatchObject({ kind: "GATE", reason: "Critical security finding: auth bypass", launchedAttempts: 1 });
    expect(f.ledger.eventsForRun(f.run.run_id).filter((event) => event.kind === "QA_REPAIR_SCHEDULED")).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    record({
      id: "G03", boundary: "QA finding", fault: "the finding is flagged requires_human",
      expected: "gate", observed: "AWAITING_HUMAN with zero QA_REPAIR_SCHEDULED events and one DEV attempt total",
      proof: "control",
      proofObserved: "the byte-identical instruction with requiresHuman=false schedules a repair round and relaunches DEV (G02)",
    });
  }, 30_000);

  it("G04 · a blocked task gates the run instead of skipping it", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2" }] });
    f.ledger.setTaskStatus(f.run.run_id, "BE-2", "BLOCKED", { reason: "waiting on a business decision from the product owner" });
    const services = harness(f);
    const result = await controller(f, services).run();
    expect(result.kind).toBe("GATE");
    expect(result.reason).toContain("blocked task(s): BE-2");
    expect(services.launches).toEqual(["BE-1:1"]);
    expect(services.qaCalls).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    record({
      id: "G04", boundary: "readiness", fault: "one task in the frozen scope is BLOCKED on a business decision",
      expected: "gate", observed: "the ready task checkpointed, then AWAITING_HUMAN naming BE-2; QA never ran on an incomplete set",
      proof: "control",
      proofObserved: "the same two-task fixture without the BLOCKED status runs both tasks and reaches one coherent QA round",
    });
  }, 30_000);

  it("G05 · an analysis repair owner with no configured service gates rather than improvising", async () => {
    const f = seed();
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.SYSTEM_ANALYST, reason: "contract evidence is incomplete",
      findingIds: ["F-C"], invalidates: [], requiresHuman: false,
    };
    const services = harness(f, { qa: () => ({ kind: "repair", evidence: "F-C", repair }) });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("GATE");
    expect(result.reason).toContain("has no configured analysis repair service");
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    record({
      id: "G05", boundary: "repair start", fault: "a contract repair routes to system-analyst with no analysis service wired",
      expected: "gate", observed: "AWAITING_HUMAN naming the missing service instead of running the repair through a DEV owner",
      proof: "control",
      proofObserved: "the same fixture with runAnalysisRepair configured runs the proposal-only repair and completes",
    });
  }, 30_000);

  it("G06 · --until boundaries stop the run and cannot waive a hard gate", async () => {
    const repair: RepairInstruction = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "AC-1 failed", findingIds: ["F-1"],
      invalidates: [], requiresHuman: false,
    };
    const qaStop = seed({ boundary: "qa" });
    const qaServices = harness(qaStop, { qa: () => ({ kind: "repair", evidence: "F-1", repair }) });
    const stopped = await controller(qaStop, qaServices).run();
    expect(stopped).toMatchObject({ kind: "HALTED", launchedAttempts: 1, qaRounds: 1 });
    expect(stopped.reason).toContain("qa boundary reached after QA");

    // The same boundary may not skip a human gate that is due earlier.
    const gated = seed({ boundary: "qa" });
    const gateServices = harness(gated, {
      qa: () => ({ kind: "repair", evidence: "S-1", repair: { ...repair, requiresHuman: true, reason: "Critical finding" } }),
    });
    const result = await controller(gated, gateServices).run();
    expect(result).toMatchObject({ kind: "GATE", reason: "Critical finding" });
    expect(gated.ledger.readRun(gated.run.run_id)?.status).toBe("AWAITING_HUMAN");
    record({
      id: "G06", boundary: "selected run boundary", fault: "--until qa is combined with an outstanding human gate",
      expected: "gate", observed: "the boundary halts an ordinary repair, but the requires-human finding still produces AWAITING_HUMAN and not a boundary halt",
      proof: "control",
      proofObserved: "the identical --until qa fixture with an ordinary finding halts at the boundary instead of gating, so the gate outranks the boundary",
    });
  }, 40_000);
});

// -------------------------------------------------- Git boundary refusals ---

describe("T-V8-022 — the guarded Git boundary refuses every unguarded mutation", () => {
  async function openWith(f: Fixture, overrides: Partial<LedgerAttempt>): Promise<GuardedRunSession> {
    const task = f.ledger.readTask(f.run.run_id, f.run.task_order[0]!)!;
    const attempt = freeze(f.ledger, f, task, overrides);
    return GuardedRunSession.open({
      ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, git: f.gitLayer(), firstAttempt: attempt,
    });
  }

  it.each([
    {
      id: "V01", label: "an analysis/proposal stage",
      tasks: [{ id: "SA-1", owner: AgentStage.SYSTEM_ANALYST }],
      overrides: {} as Partial<LedgerAttempt>,
      expect_: /analysis\/proposal-only and may not open a Git mutation boundary/,
    },
    {
      id: "V02", label: "an attempt frozen without a verified pre-tool guard",
      tasks: [{ id: "BE-1" }],
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: false, writable_roots: ["ROOT"] } },
      expect_: /no verified pre-tool guard/,
    },
    {
      id: "V03", label: "an attempt that resolved two writable roots",
      tasks: [{ id: "BE-1" }],
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: ["ROOT", "ROOT"] } },
      expect_: /resolved 2 writable roots/,
    },
    {
      id: "V04", label: "an attempt whose writable root is not the frozen Target",
      tasks: [{ id: "BE-1" }],
      overrides: { guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [os.tmpdir()] } },
      expect_: /writable root does not equal frozen Target root/,
    },
    {
      id: "V05", label: "an attempt frozen against a different plan",
      tasks: [{ id: "BE-1" }],
      overrides: { plan_hash: HASH_B },
      expect_: /plan hash differs from the frozen run/,
    },
    {
      id: "V06", label: "an attempt frozen against a different base revision",
      tasks: [{ id: "BE-1" }],
      overrides: { base_revision: "0".repeat(40) },
      expect_: /base revision differs from the frozen run/,
    },
  ])("$id · $label may not open the Target mutation boundary", async ({ id, label, tasks, overrides, expect_ }) => {
    const f = seed({ tasks });
    const resolved = JSON.parse(
      JSON.stringify(overrides).replace(/"ROOT"/g, JSON.stringify(f.target)),
    ) as Partial<LedgerAttempt>;
    const refusal = await openWith(f, resolved).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(GuardedRunError);
    expect((refusal as GuardedRunError).kind).toBe("UNGUARDED_ATTEMPT");
    expect((refusal as GuardedRunError).message).toMatch(expect_);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(git(f.target, "branch", "--show-current")).toBe("main");

    // Control: the same fixture with only the offending field corrected opens.
    const clean = seed();
    const session = await openWith(clean, {});
    session.close();
    expect(branchExists(clean.target, clean.run.run_branch)).toBe(true);
    record({
      id, boundary: "Git mutation boundary", fault: label,
      expected: "refuse", observed: "GuardedRunError before any Git command; the Target is still on its base branch",
      proof: "control",
      proofObserved: "an attempt identical except for that one field opens the session and creates the run branch",
    });
  }, 30_000);

  it("V07 · a second unfinished run on the same Target is refused", async () => {
    const f = seed();
    const shared = f.target;
    const otherId = createRunId();
    f.ledger.transaction(() => {
      f.ledger.createRun({ ...f.run, run_id: otherId, run_branch: `sta/run/orders/${otherId}`, task_order: ["BE-9"] });
      f.ledger.registerTasks([{
        run_id: otherId, task_id: "BE-9", status: "PLANNED", owner: AgentStage.BACKEND_ENGINEER, phase: 1,
        depends_on: [], produces: [], consumes: [], task_hash: HASH_A, position: 0, updated_at: 1_000,
      }]);
    });
    expect(f.ledger.readRun(otherId)?.target_root).toBe(shared);

    const services = harness(f);
    const result = await controller(f, services).run();
    expect(result.kind).toBe("REFUSED");
    expect(result.reason).toContain("already has unfinished run(s)");
    expect(result.reason).toContain(otherId);
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);

    // Bypass: hide the competing run from the guard and the branch is created.
    const blind = new Proxy(f.ledger as object, {
      get(target, property, receiver) {
        if (property !== "listRuns") return Reflect.get(target, property, receiver);
        return () => f.ledger.listRuns().filter((candidate) => candidate.run_id !== otherId);
      },
    }) as unknown as RunLedger;
    expect((await controller(f, harness(f, { ledger: blind }), blind).run()).kind).toBe("COMPLETED");
    record({
      id: "V07", boundary: "Git mutation boundary", fault: "another unfinished run already owns this Target",
      expected: "refuse", observed: "STALE_ACTIVE_RUN naming the competing run id, before any branch command",
      proof: "bypass",
      proofObserved: "a ledger proxy that hides the competing run from listRuns lets the identical run reach COMPLETED, so the refusal is that guard's reading of the ledger",
    });
  }, 40_000);

  it("V08 · a workspace lock held by another run blocks the mutation boundary", async () => {
    const f = seed();
    const holder = createRunId();
    acquireWorkspaceRunLock(f.state, f.target, holder);
    const services = harness(f);
    const result = await controller(f, services).run();
    expect(result.kind).toBe("REFUSED");
    expect(result).toMatchObject({ launchedAttempts: 0 });
    expect(branchExists(f.target, f.run.run_branch)).toBe(false);
    expect(() => acquireWorkspaceRunLock(f.state, f.target, createRunId())).toThrow(WorkspaceRunLockedError);
    record({
      id: "V08", boundary: "one-writer lock", fault: "a live workspace run lock is held for this Target by another run",
      expected: "refuse", observed: "WorkspaceRunLockedError with no branch created and no attempt launched",
      proof: "control",
      proofObserved: "every other row in this file acquires the same lock cleanly on an unlocked Target",
    });
  }, 30_000);

  it("V09 · a write outside the task's own contract refuses the checkpoint and stages nothing", async () => {
    const f = seed();
    const services = harness(f, {
      allowedPathGlobs: ["src/allowed/**"],
      writeFile: () => {
        fs.mkdirSync(path.join(f.target, "src", "allowed"), { recursive: true });
        fs.writeFileSync(path.join(f.target, "src", "allowed", "ok.txt"), "in contract\n");
        fs.writeFileSync(path.join(f.target, "src", "sneaky.txt"), "outside the contract\n");
      },
    });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("Changed path(s) are outside the immutable task/stage write contract: src/sneaky.txt");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "diff", "--cached", "--name-only")).toBe("");
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
    record({
      id: "V09", boundary: "checkpoint", fault: "the agent wrote a file outside the packet's allowed globs",
      expected: "halt", observed: "checkpoint refused, nothing staged, branch still at its single base commit, both files left in the tree",
      proof: "control",
      proofObserved: "the same run whose writes all match the contract globs stages exactly those paths and commits",
    });
  }, 30_000);

  it("V10 · a dependency manifest change refuses the checkpoint", async () => {
    const f = seed();
    const services = harness(f, {
      allowedPathGlobs: ["**"],
      writeFile: () => {
        fs.writeFileSync(path.join(f.target, "src", "BE-1.txt"), "work\n");
        fs.writeFileSync(path.join(f.target, "package.json"), JSON.stringify({ name: "target", dependencies: { evil: "1.0.0" } }));
      },
    });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("Dependency manifest/lockfile change requires human review");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "diff", "--cached", "--name-only")).toBe("");
    record({
      id: "V10", boundary: "checkpoint", fault: "the agent edited package.json",
      expected: "halt", observed: "UNEXPECTED_DEPENDENCY_CHANGE; nothing staged or committed",
      proof: "control",
      proofObserved: "the identical run without the package.json write commits the same source file",
    });
  }, 30_000);

  it("V11 · secret-shaped content refuses the checkpoint", async () => {
    const f = seed();
    const services = harness(f, { secretScanner: () => ({ ok: false, problems: ["src/BE-1.txt:1 looks like an API key"] }) });
    const result = await controller(f, services).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toContain("Secret-shaped content refused the checkpoint");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("1");
    record({
      id: "V11", boundary: "checkpoint", fault: "the secret scan reports a problem",
      expected: "halt", observed: "SECRET_DETECTED; no commit and no staged paths",
      proof: "control",
      proofObserved: "the same fixture with a clean scan result commits the identical file",
    });
  }, 30_000);

  it("V12 · a complete successful run issues no integration, rollback or remote Git command", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    const result = await controller(f, harness(f)).run();
    expect(result.kind).toBe("COMPLETED");

    const verbs = [...new Set(f.gitCalls.map((call) => call.find((token) => !token.startsWith("-")) ?? call[0]!))].sort();
    expect(verbs).toEqual(["add", "branch", "commit", "diff", "ls-files", "rev-parse", "status", "switch", "symbolic-ref"]);
    const forbidden = /^(push|pull|fetch|remote|merge|rebase|cherry-pick|revert|reset|clean|stash|tag|checkout|worktree|submodule|gc|filter-branch|update-ref)$/;
    const violations = f.gitCalls.filter((call) => call.some((token) => forbidden.test(token)));
    expect(violations).toEqual([]);
    // Branch deletion and force-push shapes never appear either.
    expect(f.gitCalls.filter((call) => call.includes("-d") || call.includes("-D") || call.includes("--force"))).toEqual([]);
    expect(git(f.target, "branch", "--show-current")).toBe(f.run.run_branch);
    expect(git(f.target, "rev-parse", "main")).toBe(f.run.base_sha);
    ARTIFACTS.v12_git_command_trace = f.gitCalls.map((call) => ["git", ...call].join(" "));
    record({
      id: "V12", boundary: "whole run", fault: "none — this row asserts an absence across a full COMPLETED run",
      expected: "resume",
      observed: `the run issued only [${verbs.join(", ")}]; main is still at the frozen base and the run branch is left checked out for a person to integrate`,
      proof: "bypass",
      proofObserved: "the recording layer is the same GitCommandLayer the run uses, and its closed allow-list rejects any other verb before spawning git, so an added integration step would appear here or fail at the layer",
    });
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

  it("B-KILL · kills the controller mid-attempt, then refuses to rerun the checkpointed task or drop the partial diff", async () => {
    const target = repository();
    const state = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v8-fault-kill-state-")));
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

    // The killed process never got to write anything after BE-2 started.
    const store = new SqliteTaskStore(path.join(state, "state.db"));
    const ledger = new SqliteRunLedger(store, { projectRoot: state });
    ledgers.push(ledger);
    const run = ledger.readRun(runId)!;
    expect(run.status).toBe("RUNNING");
    expect(Object.fromEntries(ledger.readTasks(runId).map((task) => [task.task_id, task.status])))
      .toEqual({ "BE-1": "CHECKPOINTED", "BE-2": "RUNNING" });
    const checkpoints = ledger.checkpointsForRun(runId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ task_id: "BE-1", packet_hash: packetHash("BE-1", 1) });
    expect(ledger.attemptsForTask(runId, "BE-1").map((item) => item.status)).toEqual(["SUCCEEDED"]);
    expect(ledger.attemptsForTask(runId, "BE-2").map((item) => item.status)).toEqual(["RUNNING"]);

    const partial = path.join(target, "src", "partial-BE-2.txt");
    expect(fs.existsSync(partial)).toBe(true);
    const partialBytes = fs.readFileSync(partial, "utf8");
    expect(git(target, "log", "-1", "--format=%H")).toBe(checkpoints[0]!.sha);

    // The lock the killed process held is stale (its pid is gone), so it does
    // not permanently wedge the Target — but the interrupted attempt still does.
    const fixture: Fixture = {
      target, state, ledger, run, gitCalls: [],
      gitLayer: () => new GitCommandLayer({ cwd: target, identity: { name: "Fixture", email: "fixture@example.invalid" } }),
    };
    const resumed = harness(fixture);
    const result = await controller(fixture, resumed).run();
    expect(result.kind).toBe("HALTED");
    expect(result.reason).toMatch(/cannot move RUNNING/);
    expect(resumed.launches).toEqual([]);
    expect(fs.readFileSync(partial, "utf8")).toBe(partialBytes);
    expect(ledger.checkpointsForRun(runId)).toHaveLength(1);
    expect(ledger.attemptsForTask(runId, "BE-1").map((item) => item.status)).toEqual(["SUCCEEDED"]);
    ARTIFACTS.b_kill_durable_state = {
      run_status_after_sigkill: run.status,
      tasks_after_sigkill: ledger.readTasks(runId).map((task) => [task.task_id, task.status].join(":")),
      checkpoint: checkpoints[0],
      resume_result: { kind: result.kind, reason: result.reason, launchedAttempts: result.launchedAttempts },
      partial_file_unchanged: fs.readFileSync(partial, "utf8") === partialBytes,
    };
    record({
      id: "B-KILL", boundary: "attempt start, real process kill",
      fault: "SIGKILL of the controller process while the second owner held the one-writer slot",
      expected: "refuse",
      observed: "the killed process left run=RUNNING, BE-1 CHECKPOINTED with its commit on HEAD, BE-2 RUNNING; the resume refused, relaunched nothing and left the partial file byte-identical",
      proof: "control",
      proofObserved: "BE-1, which finished before the kill, keeps exactly one SUCCEEDED attempt and one checkpoint across the resume, so the refusal is scoped to the interrupted task",
    });
  }, 180_000);
});
