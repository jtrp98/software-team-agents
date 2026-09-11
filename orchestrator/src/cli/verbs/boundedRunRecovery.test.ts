import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../../runtime/mockAdapter.js";
import { RuntimeCapability } from "../../runtime/runtimeCapabilities.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";
import { boundedRunProject } from "./boundedRunFixture.testSupport.js";

/**
 * T-V8-022 — end-to-end recovery through the real `sta bounded-run` CLI.
 *
 * boundedRunFaultMatrix.test.ts proves each persisted boundary against the
 * controller with fake services. This file proves the same claims one layer
 * up, where nothing is faked below the runtime adapter: real CLI dispatch,
 * real plan compilation and registration, the production
 * BoundedRunServices (packet compile, attempt freeze, deterministic hook,
 * production QA composition), the real guarded Git session, and a real
 * disposable Target repository. Two invocations of the binary stand in for
 * the crash: the first one ends at a durable stop, the process exits, and a
 * later `--resume` picks the run up from SQLite alone.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const roots: string[] = [];

/** Console transcripts captured for the round evidence (opt-in, never during a plain `npm test`). */
const TRANSCRIPTS: Record<string, string[]> = {};

afterAll(() => {
  if (process.env.STA_V8_EVIDENCE !== "1") return;
  const out = path.resolve(import.meta.dirname, "..", "..", "..", "..", "planning", "v8", "evidence", "round-13-cli-transcripts.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const document = { generated_by: "orchestrator/src/cli/verbs/boundedRunRecovery.test.ts", ...TRANSCRIPTS };
  fs.writeFileSync(out, JSON.stringify(document, null, 2) + "\n");
});

const KNOWLEDGE_ROOT_ORIGINAL = process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
const INSTALLATION_CONFIG_ORIGINAL = process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
beforeEach(() => {
  delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-boundedrun-recovery-no-installation.yaml");
});
afterEach(() => {
  if (KNOWLEDGE_ROOT_ORIGINAL === undefined) delete process.env.AGENTCLAUDE_KNOWLEDGE_ROOT;
  else process.env.AGENTCLAUDE_KNOWLEDGE_ROOT = KNOWLEDGE_ROOT_ORIGINAL;
  if (INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.AGENTCLAUDE_INSTALLATION_CONFIG;
  else process.env.AGENTCLAUDE_INSTALLATION_CONFIG = INSTALLATION_CONFIG_ORIGINAL;
  for (const root of roots.splice(0)) {
    // A disposable Target left on its run branch can still be held briefly by
    // Windows after the last git child exits; the fixture is temp-only, so an
    // undeletable directory is noise rather than a test result.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch { /* temp directory; the OS reclaims it */ }
  }
});

async function cli(argv: string[], root: string, registry?: RuntimeRegistry): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: string) => out.push(String(line));
  console.error = (line: string) => out.push(String(line));
  try {
    const code = await runCli(argv, root, registry ? { createRuntimeRegistry: () => registry } : {});
    return { code, out };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function inspect<T>(root: string, read: (ledger: SqliteRunLedger) => T): T {
  const store = new SqliteTaskStore(defaultStateDbPath(root));
  const ledger = new SqliteRunLedger(store, { projectRoot: root });
  try {
    return read(ledger);
  } finally {
    ledger.close();
  }
}

/** An adapter whose DEV stage fails once, then behaves like the completing one. */
function flakyAdapter(targetRoot: string, failFirstDev: boolean): MockRuntimeAdapter {
  let devCalls = 0;
  let self: MockRuntimeAdapter;
  const guardedResult = (overrides: Parameters<typeof okResult>[0] = {}) => okResult({
    guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] },
    ...overrides,
  });
  const adapter = new MockRuntimeAdapter({
    id: "claude-code",
    models: ["sonnet"],
    respond: (req) => {
      if (req.role === "qa-engineer") {
        self.workspace.files.set(
          "_docs/module/orders/review.md",
          "# review.md — orders\n\n## Round 1 — verify\n\n**Status:** ✅ Verified (FULL)\n\n" +
            "## Per-Task Results\n\n" +
            "- BE-004: ✅ Verified — the empty-order response stays stable.\n" +
            "- AC-007.2: ✅ Verified — zero-total response confirmed by inspection.\n" +
            "- DES-011: ✅ Verified — serializer boundary preserved.\n",
        );
        return guardedResult();
      }
      devCalls += 1;
      if (failFirstDev && devCalls === 1) {
        return guardedResult({ status: "UNAVAILABLE", exitCode: 1, text: "provider unavailable: upstream 503 during the attempt" });
      }
      fs.writeFileSync(path.join(targetRoot, "README.md"), "# orders\n\nReviewed the empty-order summary path.\n");
      return guardedResult();
    },
    files: {
      ".mock/guards.json": JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-path-permissions.js" }] }],
          Stop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }] }],
        },
      }),
    },
  });
  self = adapter;
  return adapter;
}

describe("T-V8-022 — sta bounded-run end-to-end recovery", () => {
  it("E01 · a provider failure halts durably, and --resume finishes the same frozen run without re-registering it", async () => {
    const { root, targetRoot } = boundedRunProject(roots, git);
    const halted = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, true)]),
    );
    expect(halted.code).not.toBe(0);
    expect(halted.out.some((line) => line.includes("HALTED"))).toBe(true);
    expect(halted.out.some((line) => line.includes("sta bounded-run --resume"))).toBe(true);

    const afterHalt = inspect(root, (ledger) => {
      const run = ledger.listRuns()[0]!;
      return {
        runId: run.run_id,
        status: run.status,
        haltReason: run.halt_reason,
        tasks: ledger.readTasks(run.run_id).map((task) => `${task.task_id}:${task.status}`),
        attempts: ledger.attemptsForTask(run.run_id, "BE-004").map((attempt) => `${attempt.attempt}:${attempt.status}`),
        checkpoints: ledger.checkpointsForRun(run.run_id).length,
      };
    });
    expect(afterHalt.status).toBe("HALTED");
    expect(afterHalt.haltReason).toContain("provider unavailable");
    expect(afterHalt.tasks).toEqual(["BE-004:FAILED"]);
    expect(afterHalt.attempts).toEqual(["1:UNAVAILABLE"]);
    expect(afterHalt.checkpoints).toBe(0);
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("1");

    const resumed = await cli(
      ["bounded-run", "--resume", afterHalt.runId, "--module", "orders", "--project-root", root],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, false)]),
    );
    expect(resumed.out.join("\n")).toContain(`resuming run ${afterHalt.runId}`);
    expect(resumed.code, resumed.out.join("\n")).toBe(0);
    expect(resumed.out.some((line) => line.includes("COMPLETED"))).toBe(true);

    const afterResume = inspect(root, (ledger) => {
      const runs = ledger.listRuns();
      const run = runs[0]!;
      return {
        runCount: runs.length,
        runId: run.run_id,
        status: run.status,
        planHash: run.plan_hash,
        tasks: ledger.readTasks(run.run_id).map((task) => `${task.task_id}:${task.status}`),
        attempts: ledger.attemptsForTask(run.run_id, "BE-004").map((attempt) => `${attempt.attempt}:${attempt.status}`),
        checkpoints: ledger.checkpointsForRun(run.run_id).map((item) => item.task_id),
        qaRounds: ledger.eventsForRun(run.run_id).filter((event) => event.kind === "QA_ROUND_STARTED").length,
        linkage: ledger.checkpointsForRun(run.run_id).map((checkpoint) => {
          const attempt = ledger.readAttempt(checkpoint.attempt_id!)!;
          return {
            sameTask: attempt.task_id === checkpoint.task_id,
            samePacket: attempt.packet_hash === checkpoint.packet_hash,
            sameRun: attempt.run_id === checkpoint.run_id,
            succeeded: attempt.status === "SUCCEEDED",
          };
        }),
      };
    });
    // Resume continues the *same* frozen run: one run row, same id, the
    // failed attempt kept as history and a second attempt appended.
    expect(afterResume.runCount).toBe(1);
    expect(afterResume.runId).toBe(afterHalt.runId);
    expect(afterResume.status).toBe("COMPLETED");
    expect(afterResume.tasks).toEqual(["BE-004:DONE"]);
    // Attempt numbers are unique and strictly increasing, but not dense: the
    // production services compile the packet twice per attempt (once in
    // prepareTask for the hash, once inside runtimeExecutor), so
    // `nextExecutionPacketAttempt` ticks twice and the second ledger attempt
    // is numbered 3. That double-compile is the gap Round 12 recorded and
    // deliberately left to a later task; what matters for resume is that the
    // history is append-only and the checkpoint still names its exact attempt.
    expect(afterResume.attempts[0]).toBe("1:UNAVAILABLE");
    expect(afterResume.attempts).toHaveLength(2);
    expect(afterResume.attempts[1]).toMatch(/^[23]:SUCCEEDED$/);
    expect(afterResume.checkpoints).toEqual(["BE-004"]);
    expect(afterResume.linkage).toEqual([{ sameTask: true, samePacket: true, sameRun: true, succeeded: true }]);
    // The eligible flow reached QA PASS with no manual agent launch: the only
    // commands issued were the two `sta bounded-run` invocations above.
    expect(afterResume.qaRounds).toBe(1);
    TRANSCRIPTS.e01_halt_then_resume = [...halted.out, "--- second invocation ---", ...resumed.out];
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(targetRoot, "branch", "--show-current")).toContain(`sta/run/orders/${afterHalt.runId}`);
    // No automatic integration: main is untouched and the run branch is left
    // for a person to merge.
    expect(git(targetRoot, "rev-list", "--count", "main")).toBe("1");
  }, 120_000);

  it("E02 · a run whose plan.md changed under it refuses to resume instead of executing a frozen scope", async () => {
    const { root, targetRoot } = boundedRunProject(roots, git);
    const first = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, true)]),
    );
    expect(first.code).not.toBe(0);
    const runId = inspect(root, (ledger) => ledger.listRuns()[0]!.run_id);

    const planPath = path.join(root, "_docs", "module", "orders", "plan.md");
    const original = fs.readFileSync(planPath, "utf8");
    fs.writeFileSync(planPath, original.replace("Objective: Return the existing order summary for an empty order.", "Objective: Rewrite the order summary contract from scratch."));

    const refused = await cli(["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root], root, new RuntimeRegistry([flakyAdapter(targetRoot, false)]));
    expect(refused.code).toBe(1);
    expect(refused.out.join("\n")).toMatch(/plan_hash drifted|recompile explicitly/);
    expect(inspect(root, (ledger) => ledger.checkpointsForRun(runId).length)).toBe(0);
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("1");

    // Control: restoring the exact plan bytes lets the identical resume run.
    fs.writeFileSync(planPath, original);
    const resumed = await cli(["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root], root, new RuntimeRegistry([flakyAdapter(targetRoot, false)]));
    expect(resumed.code, resumed.out.join("\n")).toBe(0);
    expect(inspect(root, (ledger) => ledger.readRun(runId)?.status)).toBe("COMPLETED");
    TRANSCRIPTS.e02_stale_plan_refusal = [...refused.out, "--- plan restored ---", ...resumed.out];
  }, 120_000);

  it("E04 · --resume takes the Target from the frozen run and refuses a flag that repoints it", async () => {
    const { root, targetRoot } = boundedRunProject(roots, git);
    const halted = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, true)]),
    );
    expect(halted.code).not.toBe(0);
    const runId = inspect(root, (ledger) => ledger.listRuns()[0]!.run_id);

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "v8-boundedrun-elsewhere-"));
    roots.push(elsewhere);
    const repointed = await cli(
      ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--target-root", elsewhere],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, false)]),
    );
    expect(repointed.code).toBe(1);
    expect(repointed.out.join("\n")).toContain("--target-root");
    expect(repointed.out.join("\n")).toContain("recompile explicitly rather than repointing a frozen run");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(inspect(root, (ledger) => ledger.readRun(runId)?.status)).toBe("HALTED");

    // Control: the same resume with no --target-root at all uses the frozen
    // Target and completes, which is the only reason the refusal above is
    // a refusal rather than a missing feature.
    const resumed = await cli(
      ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, false)]),
    );
    expect(resumed.code, resumed.out.join("\n")).toBe(0);
    expect(inspect(root, (ledger) => ledger.readRun(runId)?.status)).toBe("COMPLETED");
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("2");
    TRANSCRIPTS.e04_repointed_resume_refusal = [...repointed.out, "--- resumed with the frozen Target ---", ...resumed.out];
  }, 120_000);

  it("E03 · uncommitted operator work in the Target refuses the whole command before anything is registered", async () => {
    const { root, targetRoot } = boundedRunProject(roots, git);
    const humanFile = path.join(targetRoot, "src", "orders.ts");
    fs.writeFileSync(humanFile, `${fs.readFileSync(humanFile, "utf8")}// human edit in progress\n`);
    const before = fs.readFileSync(humanFile, "utf8");

    const refused = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, false)]),
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join("\n")).toContain("Resolve this repository state");
    expect(fs.readFileSync(humanFile, "utf8")).toBe(before);
    expect(git(targetRoot, "branch", "--list")).not.toContain("sta/run");
    expect(git(targetRoot, "branch", "--show-current")).toBe("main");
    // Nothing was registered: the refusal precedes compileAndRegisterPlan.
    expect(fs.existsSync(defaultStateDbPath(root)) ? inspect(root, (ledger) => ledger.listRuns().length) : 0).toBe(0);
    TRANSCRIPTS.e03_dirty_target_refusal = refused.out;
  }, 60_000);
});
