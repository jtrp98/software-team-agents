import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkspaceRunLock, releaseWorkspaceRunLock } from "../concurrency/workspaceRunLock.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { LEDGER_SCHEMA_VERSION, type LedgerAttempt, type LedgerRun, type LedgerTask } from "../ledger/runLedger.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { createRunId } from "../run/journal.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import { GitCommandLayer } from "./commandLayer.js";
import { GuardedRunError, GuardedRunSession } from "./guardedRun.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const roots: string[] = [];
const ledgers: SqliteRunLedger[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vguarded-run-"));
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

const verification: DeterministicVerification = {
  required: ["typecheck"],
  ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "ok" }],
  failures: [], skipped: [], missingRequired: [], status: "passed", enforcement: "enforce", passed: true,
};

function seed(options: { tasks?: Array<{ id: string; owner?: AgentStage; dependsOn?: string[] }> } = {}) {
  const target = repository();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "vguarded-state-"));
  roots.push(state);
  const store = new SqliteTaskStore(path.join(state, "state.db"));
  const ledger = new SqliteRunLedger(store, { projectRoot: state });
  ledgers.push(ledger);
  const runId = createRunId();
  const baseSha = git(target, "rev-parse", "HEAD");
  const rows = options.tasks ?? [{ id: "BE-1" }];
  const run: LedgerRun = {
    ledger_version: LEDGER_SCHEMA_VERSION, run_id: runId, status: "REGISTERED", boundary: "done",
    module: "orders", target_id: "target", target_root: target, knowledge_root: state,
    base_branch: "main", base_sha: baseSha, run_branch: `sta/run/orders/${runId}`,
    requirement_hash: HASH_A, design_hash: HASH_B, plan_hash: HASH_C, config_hash: HASH_A,
    sta_version: "2.0.0", task_order: rows.map((row) => row.id), max_tasks: rows.length,
    created_at: 1_000, updated_at: 1_000, halt_reason: null,
  };
  const tasks: LedgerTask[] = rows.map((row, index) => ({
    run_id: runId, task_id: row.id, status: "READY", owner: row.owner ?? AgentStage.BACKEND_ENGINEER,
    phase: 1, depends_on: row.dependsOn ?? [], produces: [], consumes: [], task_hash: HASH_A,
    position: index, updated_at: 1_000,
  }));
  ledger.transaction(() => { ledger.createRun(run); ledger.registerTasks(tasks); });
  return { target, state, store, ledger, run, tasks };
}

function attempt(f: ReturnType<typeof seed>, taskId = "BE-1", overrides: Partial<LedgerAttempt> = {}): LedgerAttempt {
  const task = f.tasks.find((item) => item.task_id === taskId)!;
  const record: LedgerAttempt = {
    attempt_id: `${f.run.run_id}:${taskId}:${task.owner}:1`, run_id: f.run.run_id, task_id: taskId,
    stage: task.owner, attempt: 1, status: "FROZEN",
    requested: { runtime: "claude-code", model: "opus", effort: "high" },
    observed: { runtime: "claude-code", model: "opus", effort: "high" },
    model_explicit: true, route_basis: "task-tier:T2", tier: "T2", adapter_version: "test@1",
    config_hash: HASH_A, plan_hash: HASH_C, base_revision: f.run.base_sha,
    capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
    guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [f.target] },
    packet_hash: HASH_B, packet_path: `.workflow/packets/${taskId}/1.json`,
    started_at: 2_000, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
  f.ledger.freezeAttempt(record);
  return record;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("T-V8-019 — guarded one-writer RunLedger checkpoint boundary", () => {
  it("never opens Git mutation for an analysis/proposal attempt", async () => {
    const f = seed({ tasks: [{ id: "SA-1", owner: AgentStage.SYSTEM_ANALYST }] });
    const a = attempt(f, "SA-1", { guard_evidence: { target_write: false, pre_tool_guard: false, writable_roots: [] } });
    const calls: string[][] = [];
    const gitLayer = new GitCommandLayer({
      cwd: f.target,
      processRunner: async (args) => { calls.push([...args]); throw new Error("must not invoke Git"); },
    });
    await expect(GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a, git: gitLayer }))
      .rejects.toMatchObject({ kind: "UNGUARDED_ATTEMPT" });
    expect(calls).toEqual([]);
    expect(git(f.target, "branch", "--show-current")).toBe("main");
  });

  it("creates one run branch, enforces one writer, stages exact task paths and records packet identity", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2" }] });
    const a = attempt(f);
    const session = await GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a });
    try {
      session.beginTask(a);
      const second = attempt(f, "BE-2");
      expect(() => session.beginTask(second)).toThrow(/one-writer invariant/);
      fs.writeFileSync(path.join(f.target, "src", "owned.txt"), "owned\n");
      const result = await session.checkpoint({
        attempt: a, adapter: { status: "OK", exitCode: 0 }, runVerification: async () => verification,
        taskDescription: "implement owned path", allowedPathGlobs: ["src/**"], secretScanner: () => ({ ok: true, problems: [] }),
      });
      expect(f.ledger.readTask(f.run.run_id, "BE-1")?.status).toBe("CHECKPOINTED");
      expect(f.ledger.readAttempt(a.attempt_id)?.status).toBe("SUCCEEDED");
      expect(f.ledger.checkpointsForRun(f.run.run_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ task_id: "BE-1", attempt_id: a.attempt_id, packet_hash: HASH_B, sha: result.sha }),
      ]));
      const body = git(f.target, "log", "-1", "--format=%B");
      expect(body).toContain(`STA-Packet-Hash: ${HASH_B}`);
      expect(git(f.target, "show", "--pretty=format:", "--name-only", "HEAD")).toBe("src/owned.txt");
    } finally { session.close(); }
  });

  it.each([
    { name: "outside task contract", path: "outside.txt", kind: "TASK_CONTRACT_VIOLATION" },
    { name: "dependency manifest", path: "package.json", kind: "UNEXPECTED_DEPENDENCY_CHANGE" },
    { name: "Python dependency manifest variant", path: "requirements-dev.txt", kind: "UNEXPECTED_DEPENDENCY_CHANGE" },
    { name: ".NET project dependency manifest", path: "Orders.csproj", kind: "UNEXPECTED_DEPENDENCY_CHANGE" },
  ])("halts and preserves $name before staging", async ({ path: changed, kind }) => {
    const f = seed();
    const a = attempt(f);
    const session = await GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a });
    session.beginTask(a);
    fs.writeFileSync(path.join(f.target, changed), "preserved\n");
    await expect(session.checkpoint({
      attempt: a, adapter: { status: "OK", exitCode: 0 }, runVerification: async () => verification,
      taskDescription: "unsafe change", allowedPathGlobs: kind === "UNEXPECTED_DEPENDENCY_CHANGE" ? ["**"] : ["src/**"],
      secretScanner: () => ({ ok: true, problems: [] }),
    })).rejects.toMatchObject({ kind });
    expect(git(f.target, "diff", "--cached", "--name-only")).toBe("");
    expect(fs.existsSync(path.join(f.target, changed))).toBe(true);
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("HALTED");
    session.close();
  });

  it("refuses a stale active run and a held workspace lock before branch creation", async () => {
    const f = seed();
    const a = attempt(f);
    const otherId = createRunId();
    f.ledger.createRun({ ...f.run, run_id: otherId, run_branch: `sta/run/orders/${otherId}`, task_order: ["OTHER"] });
    await expect(GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a }))
      .rejects.toMatchObject({ kind: "STALE_ACTIVE_RUN" });
    expect(git(f.target, "branch", "--show-current")).toBe("main");

    f.ledger.setRunStatus(otherId, "CANCELLED", { reason: "fixture resolved" });
    acquireWorkspaceRunLock(f.state, f.target, otherId);
    try {
      await expect(GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a }))
        .rejects.toThrow(/already held/);
      expect(git(f.target, "branch", "--show-current")).toBe("main");
    } finally { releaseWorkspaceRunLock(f.state, f.target, otherId); }
  });

  it("adopts only the exact same run branch after an isolation crash", async () => {
    const f = seed();
    const a = attempt(f);
    const layer = new GitCommandLayer({ cwd: f.target });
    await layer.createBranch(f.run.run_branch, f.run.base_sha);
    const session = await GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a, git: layer });
    expect(git(f.target, "branch", "--show-current")).toBe(f.run.run_branch);
    expect(git(f.target, "branch", "--list", f.run.run_branch).split(/\r?\n/)).toHaveLength(1);
    session.close();
  });

  it("re-attributes an exact clean HEAD checkpoint after a lost ledger append", async () => {
    const f = seed();
    const a = attempt(f);
    const layer = new GitCommandLayer({ cwd: f.target });
    const first = await GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: a, git: layer });
    first.beginTask(a);
    fs.writeFileSync(path.join(f.target, "src", "crash.txt"), "durable\n");
    const recordCheckpoint = f.ledger.recordCheckpoint.bind(f.ledger);
    f.ledger.recordCheckpoint = () => { throw new Error("injected lost ledger append"); };
    await expect(first.checkpoint({
      attempt: a, adapter: { status: "OK", exitCode: 0 }, runVerification: async () => verification,
      taskDescription: "crash boundary", allowedPathGlobs: ["src/**"], secretScanner: () => ({ ok: true, problems: [] }),
    })).rejects.toMatchObject({ kind: "CHECKPOINT_RECONCILIATION_REQUIRED" });
    f.ledger.recordCheckpoint = recordCheckpoint;
    const committedSha = git(f.target, "rev-parse", "HEAD");
    expect(f.ledger.readTask(f.run.run_id, a.task_id)?.status).toBe("VERIFYING");
    expect(f.ledger.readAttempt(a.attempt_id)?.status).toBe("RUNNING");
    first.close();

    const interrupted = f.ledger.readAttempt(a.attempt_id)!;
    const resumed = await GuardedRunSession.open({ ledger: f.ledger, runId: f.run.run_id, runtimeStateRoot: f.state, firstAttempt: interrupted, git: layer });
    await expect(resumed.reconcileHeadCheckpoint(interrupted)).resolves.toBe(committedSha);
    expect(f.ledger.readTask(f.run.run_id, a.task_id)?.status).toBe("CHECKPOINTED");
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    resumed.close();
  }, 30_000);
});
