import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEDGER_SCHEMA_VERSION, type LedgerAttempt, type LedgerRun, type LedgerTask } from "../ledger/runLedger.js";
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
} from "./boundedRunController.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const roots: string[] = [];
const ledgers: SqliteRunLedger[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-controller-target-"));
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

function seed(options: {
  boundary?: LedgerRun["boundary"];
  tasks?: Array<{ id: string; owner?: AgentStage; dependsOn?: string[]; phase?: number }>;
} = {}) {
  const target = repository();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "v8-controller-state-"));
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
    phase: row.phase ?? 1, depends_on: row.dependsOn ?? [], produces: [], consumes: [], task_hash: HASH_A,
    position: index, updated_at: 1_000,
  }));
  ledger.transaction(() => { ledger.createRun(run); ledger.registerTasks(tasks); });
  return { target, state, ledger, run, tasks };
}

function packetHash(attempt: number): string {
  return attempt.toString(16).padStart(64, "0");
}

function freeze(f: ReturnType<typeof seed>, task: LedgerTask, number: number): LedgerAttempt {
  const record: LedgerAttempt = {
    attempt_id: `${f.run.run_id}:${task.task_id}:${task.owner}:${number}`, run_id: f.run.run_id, task_id: task.task_id,
    stage: task.owner, attempt: number, status: "FROZEN",
    requested: { runtime: "claude-code", model: "opus", effort: "high" },
    observed: { runtime: "claude-code", model: "opus", effort: "high" },
    model_explicit: true, route_basis: "task-tier:T2", tier: "T2", adapter_version: "fixture@1",
    config_hash: HASH_A, plan_hash: HASH_C, base_revision: f.run.base_sha,
    capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
    guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [f.target] },
    packet_hash: packetHash(number), packet_path: `.workflow/packets/${task.task_id}/${number}.json`,
    started_at: 2_000 + number, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
  };
  f.ledger.freezeAttempt(record);
  return record;
}

const passed: DeterministicVerification = {
  required: ["typecheck"], ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "ok" }],
  failures: [], skipped: [], missingRequired: [], status: "passed", enforcement: "enforce", passed: true,
};

const skipped: DeterministicVerification = {
  required: ["typecheck"], ran: [], failures: [], skipped: ["typecheck"], missingRequired: ["typecheck"],
  status: "skipped", enforcement: "enforce", passed: false,
};

function services(
  f: ReturnType<typeof seed>,
  options: {
    qa?: (round: number) => QaControllerResult;
    verification?: DeterministicVerification;
    execution?: BoundedRunServices["executeAttempt"];
    prepare?: BoundedRunServices["prepareTask"];
    analysisRepair?: BoundedRunServices["runAnalysisRepair"];
  } = {},
): BoundedRunServices & { launches: string[] } {
  const attempts = new Map<string, number>();
  const launches: string[] = [];
  return {
    launches,
    prepareTask: options.prepare ?? (async (task) => {
      const number = (attempts.get(task.task_id) ?? 0) + 1;
      attempts.set(task.task_id, number);
      return {
        kind: "attempt", attempt: freeze(f, task, number), taskDescription: `execute ${task.task_id}`,
        allowedPathGlobs: ["src/**"], secretScanner: () => ({ ok: true, problems: [] }),
      };
    }),
    executeAttempt: options.execution ?? (async (prepared: PreparedTargetAttempt) => {
      launches.push(`${prepared.attempt.task_id}:${prepared.attempt.attempt}`);
      fs.writeFileSync(path.join(f.target, "src", `${prepared.attempt.task_id}.txt`), `attempt ${prepared.attempt.attempt}\n`);
      return { kind: "completed", adapter: { status: "OK", exitCode: 0 }, verification: options.verification ?? passed };
    }),
    runQa: async ({ round }) => options.qa?.(round) ?? { kind: "pass", evidence: "all task/AC verdicts passed" },
    ...(options.analysisRepair ? { runAnalysisRepair: options.analysisRepair } : {}),
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("T-V8-020 — one sequential bounded controller", () => {
  it("walks a multi-task fixed DAG one at a time through DEV, verification, checkpoints and coherent QA", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2", dependsOn: ["BE-1"] }] });
    const svc = services(f);
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 2, qaRounds: 1 });
    expect(svc.launches).toEqual(["BE-1:1", "BE-2:1"]);
    expect(f.ledger.readTasks(f.run.run_id).map((task) => task.status)).toEqual(["DONE", "DONE"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id).map((item) => item.task_id)).toEqual(["BE-1", "BE-2"]);
    const events = f.ledger.eventsForRun(f.run.run_id);
    const firstDone = events.findIndex((event) => event.kind === "TASK_CHECKPOINTED" && event.task_id === "BE-1");
    const secondStart = events.findIndex((event) => event.kind === "ATTEMPT_STATUS" && event.task_id === "BE-2" && event.to === "RUNNING");
    expect(firstDone).toBeLessThan(secondStart);
    expect(git(f.target, "rev-list", "--count", f.run.run_branch)).toBe("3");
  });

  it("halts at a schema human gate before packet compilation or branch creation", async () => {
    const f = seed({ boundary: "next-gate" });
    const prepare = vi.fn(async () => ({ kind: "gate" as const, reason: "schema confirmation required" }));
    const svc = services(f, { prepare });
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result).toMatchObject({ kind: "GATE", launchedAttempts: 0 });
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    expect(git(f.target, "branch", "--show-current")).toBe("main");
    expect(git(f.target, "branch", "--list", f.run.run_branch)).toBe("");
  });

  it("routes a QA failure into a targeted DEV repair and rechecks QA", async () => {
    const f = seed();
    const repair = {
      taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "AC-1 failed", findingIds: ["F-1"],
      invalidates: [] as string[], requiresHuman: false,
    };
    const svc = services(f, { qa: (round) => round === 1 ? { kind: "repair", evidence: "F-1", repair } : { kind: "pass", evidence: "F-1 closed" } });
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result).toMatchObject({ kind: "COMPLETED", launchedAttempts: 2, qaRounds: 2 });
    expect(svc.launches).toEqual(["BE-1:1", "BE-1:2"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(2);
    expect(f.ledger.eventsForRun(f.run.run_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "QA_REPAIR_SCHEDULED", task_id: "BE-1", payload: expect.objectContaining({ findings: ["F-1"] }) }),
    ]));
  });

  it("runs proposal-only contract repair without a Git attempt, then recompiles affected DEV work", async () => {
    const f = seed();
    const analysisRepair = vi.fn(async () => ({ kind: "completed" as const }));
    const repair = {
      taskId: "BE-1", owner: AgentStage.SYSTEM_ANALYST, reason: "contract evidence is incomplete", findingIds: ["F-CONTRACT"],
      invalidates: [] as string[], requiresHuman: false,
    };
    const svc = services(f, { qa: (round) => round === 1 ? { kind: "repair", evidence: "F-CONTRACT", repair } : { kind: "pass", evidence: "contract repaired" }, analysisRepair });
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result.kind).toBe("COMPLETED");
    expect(analysisRepair).toHaveBeenCalledOnce();
    expect(svc.launches).toEqual(["BE-1:1", "BE-1:2"]);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-1")).toHaveLength(2);
  }, 30_000);

  it("enforces the selected qa boundary and the global two-round ordinary repair ceiling", async () => {
    const repair = { taskId: "BE-1", owner: AgentStage.BACKEND_ENGINEER, reason: "still failing", findingIds: ["F-1"], invalidates: [] as string[], requiresHuman: false };
    const qaBoundary = seed({ boundary: "qa" });
    const firstServices = services(qaBoundary, { qa: () => ({ kind: "repair", evidence: "F-1", repair }) });
    const stopped = await new BoundedRunController({ ledger: qaBoundary.ledger, runId: qaBoundary.run.run_id, runtimeStateRoot: qaBoundary.state, services: firstServices }).run();
    expect(stopped).toMatchObject({ kind: "HALTED", launchedAttempts: 1, qaRounds: 1 });
    expect(firstServices.launches).toEqual(["BE-1:1"]);

    const exhaustedFixture = seed({ boundary: "done" });
    const exhaustedServices = services(exhaustedFixture, { qa: () => ({ kind: "repair", evidence: "F-1", repair }) });
    const exhausted = await new BoundedRunController({ ledger: exhaustedFixture.ledger, runId: exhaustedFixture.run.run_id, runtimeStateRoot: exhaustedFixture.state, services: exhaustedServices }).run();
    expect(exhausted).toMatchObject({ kind: "GATE", launchedAttempts: MAX_AUTOMATIC_REPAIR_ROUNDS + 1, qaRounds: MAX_AUTOMATIC_REPAIR_ROUNDS + 1 });
    expect(exhaustedFixture.ledger.readRun(exhaustedFixture.run.run_id)?.status).toBe("AWAITING_HUMAN");
  }, 30_000);

  it.each([
    { name: "runtime unavailable", execution: async () => ({ kind: "halt" as const, category: "unavailable" as const, reason: "provider unavailable" }), expected: "HALTED" },
    { name: "interruption", execution: async () => ({ kind: "interrupted" as const, reason: "SIGINT" }), expected: "INTERRUPTED" },
  ])("persists an explicit $name exit without QA or a checkpoint", async ({ execution, expected }) => {
    const f = seed();
    const svc = services(f, { execution });
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result).toMatchObject({ kind: expected, launchedAttempts: 1, qaRounds: 0 });
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("HALTED");
  });

  it("halts a no-test-suite flow as unverified instead of skipping the deterministic gate", async () => {
    const f = seed();
    const svc = services(f, { verification: skipped });
    const result = await new BoundedRunController({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, services: svc }).run();
    expect(result).toMatchObject({ kind: "HALTED", launchedAttempts: 1, qaRounds: 0 });
    expect(result.reason).toContain("Deterministic verification was skipped");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual([]);
  });
});
