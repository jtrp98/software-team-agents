import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../../runtime/mockAdapter.js";
import { RuntimeCapability } from "../../runtime/runtimeCapabilities.js";
import type { RuntimeAgentResult } from "../../runtime/runtimeAdapter.js";
import { SqliteRunLedger } from "../../ledger/sqliteRunLedger.js";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";
import { boundedRunProject, playPlanTaskStage, PLAN_TASK_GUARD_FILES } from "./boundedRunFixture.testSupport.js";
import { writeSignedOffHandoffs } from "../../orchestrator/stageGuards.testSupport.js";
import { declareInstallationConfigOverrideChannelForTest } from "../../threeRepo/installation.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * T-V8-022 — end-to-end recovery through the real `sta bounded-run` CLI.
 *
 * boundedRunFaultMatrix.test.ts proves each persisted boundary against the
 * engine with fake agents. This file proves the same claims one layer up,
 * where nothing is faked below the runtime adapter: real CLI dispatch, real
 * plan compilation and registration, the one task engine with the production
 * executor composition `sta run` uses (packet compile, deterministic hook,
 * reviewer and QA stages), the ledger-attempt boundary (attempt freeze, the
 * real guarded Git session and checkpoint), and a real disposable Target. Two invocations of the binary stand in for
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

const KNOWLEDGE_ROOT_ORIGINAL = process.env.STA_KNOWLEDGE_ROOT;
const INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
beforeEach(() => {
  delete process.env.STA_KNOWLEDGE_ROOT;
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-boundedrun-recovery-no-installation.yaml");
});
afterEach(() => {
  if (KNOWLEDGE_ROOT_ORIGINAL === undefined) delete process.env.STA_KNOWLEDGE_ROOT;
  else process.env.STA_KNOWLEDGE_ROOT = KNOWLEDGE_ROOT_ORIGINAL;
  if (INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = INSTALLATION_CONFIG_ORIGINAL;
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

/** A mock runtime playing every plan-task stage (see `playPlanTaskStage`). */
function planTaskAdapter(
  targetRoot: string,
  options: { module?: string; engineer?: (call: number) => Partial<RuntimeAgentResult> | undefined } = {},
): MockRuntimeAdapter {
  let engineerCalls = 0;
  let self: MockRuntimeAdapter;
  const adapter = new MockRuntimeAdapter({
    id: "claude-code",
    models: ["sonnet"],
    respond: (req) => {
      if (req.role !== "reviewer" && req.role !== "qa-engineer") engineerCalls += 1;
      const over = playPlanTaskStage(req, self.workspace.files, targetRoot, { ...options, engineerCall: engineerCalls });
      return okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] }, ...over });
    },
    files: PLAN_TASK_GUARD_FILES,
  });
  self = adapter;
  return adapter;
}

/**
 * An adapter whose first engineer call fails as a runtime error (a task
 * defect the engine leaves incomplete and a later invocation reruns), then
 * plays every plan-task stage to completion.
 */
function flakyAdapter(targetRoot: string, failFirstDev: boolean): MockRuntimeAdapter {
  return planTaskAdapter(targetRoot, {
    engineer: (call) => (failFirstDev && call === 1 ? { status: "ERROR", exitCode: 1, text: "runtime error: the agent crashed mid-attempt" } : undefined),
  });
}

/** A project whose BA -> SA -> DEV handoffs a person has signed off and acknowledged. */
function signedProject() {
  const fixture = boundedRunProject(roots, git);
  writeSignedOffHandoffs(fixture.root, "orders");
  return fixture;
}

describe("T-V8-022 — sta bounded-run end-to-end recovery", () => {
  it("E01 · a runtime failure halts durably, and --resume finishes the same frozen run without re-registering it", async () => {
    const { root, targetRoot } = signedProject();
    const halted = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([flakyAdapter(targetRoot, true)]),
    );
    expect(halted.code).toBe(1);
    expect(halted.out.some((line) => line.includes("HALTED"))).toBe(true);
    expect(halted.out.some((line) => line.includes("sta bounded-run --resume"))).toBe(true);

    const afterHalt = inspect(root, (ledger) => {
      const run = ledger.listRuns()[0]!;
      return {
        runId: run.run_id,
        status: run.status,
        tasks: ledger.readTasks(run.run_id).map((task) => `${task.task_id}:${task.status}`),
        attempts: ledger.attemptsForTask(run.run_id, "BE-004").map((attempt) => `${attempt.attempt}:${attempt.status}`),
        checkpoints: ledger.checkpointsForRun(run.run_id).length,
      };
    });
    expect(afterHalt.status).toBe("HALTED");
    // The ledger task status is the engine's projection: the engineer still holds the task.
    expect(afterHalt.tasks).toEqual(["BE-004:RUNNING"]);
    expect(afterHalt.attempts).toEqual(["1:FAILED"]);
    expect(afterHalt.checkpoints).toBe(0);
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("1");

    const resumed = await cli(
      ["bounded-run", "--resume", afterHalt.runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"],
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
        tasks: ledger.readTasks(run.run_id).map((task) => `${task.task_id}:${task.status}`),
        attempts: ledger.attemptsForTask(run.run_id, "BE-004").map((attempt) => `${attempt.attempt}:${attempt.status}`),
        checkpoints: ledger.checkpointsForRun(run.run_id).map((item) => item.task_id),
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
    expect(afterResume.runCount).toBe(1);
    expect(afterResume.runId).toBe(afterHalt.runId);
    expect(afterResume.status).toBe("COMPLETED");
    expect(afterResume.tasks).toEqual(["BE-004:DONE"]);
    // Attempt numbers are unique and increasing but not dense: the boundary's
    // freeze and the runtime executor each compile a packet (the gap Round 12
    // recorded), so the second ledger attempt may be numbered 3.
    expect(afterResume.attempts[0]).toBe("1:FAILED");
    expect(afterResume.attempts).toHaveLength(2);
    expect(afterResume.attempts[1]).toMatch(/^[23]:SUCCEEDED$/);
    expect(afterResume.checkpoints).toEqual(["BE-004"]);
    expect(afterResume.linkage).toEqual([{ sameTask: true, samePacket: true, sameRun: true, succeeded: true }]);
    // The engine ran the whole plan-task workflow, per task: engineer, reviewer, QA.
    const store = new SqliteTaskStore(defaultStateDbPath(root));
    try {
      expect(store.eventsForTask("BE-004").filter((e) => e.type === "STAGE_COMPLETED").map((e) => e.payload.stage))
        .toEqual(["backend-engineer", "reviewer", "qa-engineer"]);
    } finally {
      store.close();
    }
    TRANSCRIPTS.e01_halt_then_resume = [...halted.out, "--- second invocation ---", ...resumed.out];
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(targetRoot, "branch", "--show-current")).toContain(`sta/run/orders/${afterHalt.runId}`);
    // No automatic integration: main is untouched and the run branch is left for a person to merge.
    expect(git(targetRoot, "rev-list", "--count", "main")).toBe("1");
  }, 120_000);

  it("E05 · an unavailable provider is the engine's human stop: the run waits, and a resume dispatches nothing", async () => {
    const { root, targetRoot } = signedProject();
    const unavailable = planTaskAdapter(targetRoot, {
      engineer: () => ({ status: "UNAVAILABLE", exitCode: 1, text: "provider unavailable: upstream 503 during the attempt" }),
    });
    const stopped = await cli(
      ["bounded-run", "--module", "orders", "--all", "--target-root", targetRoot, "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([unavailable]),
    );
    expect(stopped.code, stopped.out.join("\n")).toBe(4);
    const state = inspect(root, (ledger) => {
      const run = ledger.listRuns()[0]!;
      return {
        runId: run.run_id,
        status: run.status,
        tasks: ledger.readTasks(run.run_id).map((task) => `${task.task_id}:${task.status}`),
        attempts: ledger.attemptsForTask(run.run_id, "BE-004").map((attempt) => attempt.status),
      };
    });
    expect(state).toMatchObject({ status: "AWAITING_HUMAN", tasks: ["BE-004:BLOCKED"], attempts: ["UNAVAILABLE"] });
    const healthy = planTaskAdapter(targetRoot);
    const again = await cli(
      ["bounded-run", "--resume", state.runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"],
      root,
      new RuntimeRegistry([healthy]),
    );
    // Recovering from an infrastructure stop is a person's decision (durable recovery is TASK-008's).
    expect(again.code).toBe(4);
    expect(healthy.requests).toEqual([]);
  }, 120_000);

  it("E02 · a run whose plan.md changed under it refuses to resume instead of executing a frozen scope", async () => {
    const { root, targetRoot } = signedProject();
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

    const refused = await cli(["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"], root, new RuntimeRegistry([flakyAdapter(targetRoot, false)]));
    expect(refused.code).toBe(1);
    expect(refused.out.join("\n")).toMatch(/plan_hash drifted|recompile explicitly/);
    expect(inspect(root, (ledger) => ledger.checkpointsForRun(runId).length)).toBe(0);
    expect(git(targetRoot, "rev-list", "--count", "HEAD")).toBe("1");

    // Control: restoring the exact plan bytes lets the identical resume run.
    fs.writeFileSync(planPath, original);
    const resumed = await cli(["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"], root, new RuntimeRegistry([flakyAdapter(targetRoot, false)]));
    expect(resumed.code, resumed.out.join("\n")).toBe(0);
    expect(inspect(root, (ledger) => ledger.readRun(runId)?.status)).toBe("COMPLETED");
    TRANSCRIPTS.e02_stale_plan_refusal = [...refused.out, "--- plan restored ---", ...resumed.out];
  }, 120_000);

  it("E04 · --resume takes the Target from the frozen run and refuses a flag that repoints it", async () => {
    const { root, targetRoot } = signedProject();
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
      ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--target-root", elsewhere, "--autonomy", "edit"],
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
      ["bounded-run", "--resume", runId, "--module", "orders", "--project-root", root, "--autonomy", "edit"],
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
