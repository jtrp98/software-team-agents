import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCommandLayer } from "../git/commandLayer.js";
import { LEDGER_SCHEMA_VERSION, type LedgerAttempt, type LedgerRun, type LedgerTask } from "../ledger/runLedger.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import { BoundedRunController, type BoundedRunServices, type PreparedTargetAttempt } from "./boundedRunController.js";

/**
 * T-V8-022 — the child half of the real process-kill boundary test.
 *
 * boundedRunFaultMatrix.test.ts models a crash with a ledger proxy, which is
 * fast and precise but is still a model. This file is the same controller,
 * the same SQLite ledger and the same Git repository in a process the parent
 * actually SIGKILLs mid-attempt, so the durable state the parent then reads
 * was produced by an operating-system kill rather than by a thrown error.
 *
 * Skipped unless the parent (boundedRunFaultMatrix.test.ts) spawns it.
 */

const enabled = process.env.STA_BOUNDED_KILL_FIXTURE === "1";

const VERIFICATION: DeterministicVerification = {
  required: ["typecheck"], ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "ok" }],
  failures: [], skipped: [], missingRequired: [], status: "passed", enforcement: "enforce", passed: true,
};

const HASH_A = "a".repeat(64);
const HASH_C = "c".repeat(64);

/** The exact packet hash the parent expects to see on a frozen attempt. */
function packetHash(taskId: string, attempt: number): string {
  return [...`${taskId}#${attempt}`]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

describe.skipIf(!enabled)("real process-kill bounded-run fixture", () => {
  it("checkpoints the first task, then hangs inside the second owner until the parent kills it", async () => {
    const stateRoot = process.env.STA_BOUNDED_KILL_STATE_ROOT!;
    const targetRoot = process.env.STA_BOUNDED_KILL_TARGET_ROOT!;
    const marker = process.env.STA_BOUNDED_KILL_MARKER!;
    const runId = process.env.STA_BOUNDED_KILL_RUN_ID!;

    const store = new SqliteTaskStore(path.join(stateRoot, "state.db"));
    const ledger = new SqliteRunLedger(store, { projectRoot: stateRoot });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim();
    const run: LedgerRun = {
      ledger_version: LEDGER_SCHEMA_VERSION, run_id: runId, status: "REGISTERED", boundary: "done",
      module: "orders", target_id: "target", target_root: targetRoot, knowledge_root: stateRoot,
      base_branch: "main", base_sha: baseSha, run_branch: `sta/run/orders/${runId}`,
      requirement_hash: HASH_A, design_hash: HASH_A, plan_hash: HASH_C,
      config_hash: HASH_A, sta_version: "2.0.0", task_order: ["BE-1", "BE-2"], max_tasks: 2,
      created_at: 1_000, updated_at: 1_000, halt_reason: null,
    };
    const tasks: LedgerTask[] = ["BE-1", "BE-2"].map((taskId, index) => ({
      run_id: runId, task_id: taskId, status: "PLANNED", owner: AgentStage.BACKEND_ENGINEER, phase: 1,
      depends_on: index === 0 ? [] : ["BE-1"], produces: [], consumes: [], task_hash: HASH_A,
      position: index, updated_at: 1_000,
    }));
    ledger.transaction(() => { ledger.createRun(run); ledger.registerTasks(tasks); });

    const services: BoundedRunServices = {
      prepareTask: async (task) => {
        const number = ledger.attemptsForTask(runId, task.task_id).length + 1;
        const attempt: LedgerAttempt = {
          attempt_id: `${runId}:${task.task_id}:${task.owner}:${number}`, run_id: runId, task_id: task.task_id,
          stage: task.owner, attempt: number, status: "FROZEN",
          requested: { runtime: "claude-code", model: "opus", effort: "high" },
          observed: { runtime: "claude-code", model: "opus", effort: "high" },
          model_explicit: true, route_basis: "task-tier:T2", tier: "T2", adapter_version: "fixture@1",
          config_hash: HASH_A, plan_hash: HASH_C, base_revision: baseSha,
          capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
          guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [targetRoot] },
          packet_hash: packetHash(task.task_id, number),
          packet_path: `.workflow/packets/${task.task_id}/${number}.json`,
          started_at: 2_000 + number, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
        };
        ledger.freezeAttempt(attempt);
        return {
          kind: "attempt", attempt, taskDescription: `execute ${task.task_id}`,
          allowedPathGlobs: ["src/**"], secretScanner: () => ({ ok: true, problems: [] }),
        };
      },
      executeAttempt: async (prepared: PreparedTargetAttempt) => {
        if (prepared.attempt.task_id === "BE-1") {
          fs.writeFileSync(path.join(targetRoot, "src", "BE-1.txt"), "checkpoint me\n");
          return { kind: "completed", adapter: { status: "OK", exitCode: 0 }, verification: VERIFICATION };
        }
        fs.writeFileSync(path.join(targetRoot, "src", "partial-BE-2.txt"), "interrupted work\n");
        fs.writeFileSync(marker, "ready\n");
        return await new Promise<never>(() => undefined);
      },
      runQa: async () => ({ kind: "pass", evidence: "unreachable" }),
    };

    const result = await new BoundedRunController({
      ledger, runId, runtimeStateRoot: stateRoot, services,
      git: new GitCommandLayer({ cwd: targetRoot, identity: { name: "Fixture", email: "fixture@example.invalid" } }),
    }).run();
    expect(result.kind).toBe("never reached — the parent kills this process first");
  }, 60_000);
});
