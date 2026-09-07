import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import type { PlanTaskRow } from "../docs/planGraph.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import { checkpointMessages } from "../git/checkpoint.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import {
  appendJournalRecord,
  planHash,
  readJournal,
  runArtifactPaths,
  type RunManifest,
  writeRunManifest,
} from "./journal.js";
import { findActiveWaveRun, reconcileWaveRunForResume, WaveRunRecoveryError } from "./recovery.js";
import { buildWavePreview, executeWave, type ResolvedWaveRoute } from "./waveRunner.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";

const roots: string[] = [];
const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const verification: DeterministicVerification = {
  required: ["typecheck"],
  ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "pass" }],
  failures: [], skipped: [], missingRequired: [], status: "passed", enforcement: "enforce", passed: true,
};

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function repository(): string {
  const root = temp("sta-recovery-target-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "STA Test");
  git(root, "config", "user.email", "sta@example.test");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
    lint: "ok", typecheck: "ok", test: "ok", build: "ok",
  } }));
  git(root, "add", "base.txt", "package.json");
  git(root, "commit", "-m", "base");
  return root;
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for child marker ${file}`);
}

function row(id = "BE-1"): PlanTaskRow {
  return {
    id, phase: 1, designRefs: ["DES-001"], dependsOn: [], status: "pending",
    owner: AgentStage.BACKEND_ENGINEER, wave: null, tier: "T2", description: `Implement ${id}`, fromCheckbox: false,
  };
}

function manifest(stateRoot: string, target: string, tasks: PlanTaskRow[], runId = "01J00000000000000000000029"): RunManifest {
  const base = git(target, "rev-parse", "HEAD");
  return {
    run_id: runId,
    created_at: "2026-09-07T00:00:00.000Z",
    target_root: target,
    target_id: "target",
    knowledge_root: stateRoot,
    module: "orders",
    wave: 1,
    plan_hash: planHash(tasks),
    task_order: tasks.map((task) => task.id),
    base_branch: "main",
    base_sha: base,
    run_branch: `sta/run/orders/${runId}`,
    runtime_id: "claude-code",
    tier: "T2",
    model: "opus",
    max_tasks: tasks.length,
    sta_version: "1.1.0",
  };
}

function register(store: MemoryTaskStore, target: string, task: PlanTaskRow) {
  const registry = new TaskRegistry({ store });
  const orchestrator = registry.create({
    taskId: task.id,
    classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
    projectRoot: frameworkRoot,
    targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: target }],
  });
  orchestrator.status();
  return orchestrator;
}

function begin(stateRoot: string, run: RunManifest, taskId: string): void {
  writeRunManifest(stateRoot, run);
  for (const record of [
    { ts: "1", kind: "RUN_STARTED" },
    { ts: "2", kind: "RUN_ISOLATED" },
    { ts: "3", kind: "TASK_READY", task_id: taskId },
    { ts: "4", kind: "TASK_STARTED", task_id: taskId },
  ] as const) appendJournalRecord(stateRoot, run.run_id, record);
}

describe("wave crash recovery", () => {
  it("T-V7-031 kills a real runner process, refuses dirty work, then resumes without rerunning the checkpointed owner", async () => {
    const stateRoot = temp("sta-kill-state-");
    const target = repository();
    const marker = path.join(stateRoot, "second-owner-started.marker");
    const orchestratorRoot = path.resolve(frameworkRoot, "orchestrator");
    const vitest = path.join(orchestratorRoot, "node_modules", "vitest", "vitest.mjs");
    const child = spawn(process.execPath, [vitest, "run", "src/run/killWaveFixture.test.ts"], {
      cwd: orchestratorRoot,
      env: {
        ...process.env,
        STA_KILL_FIXTURE: "1",
        STA_KILL_STATE_ROOT: stateRoot,
        STA_KILL_TARGET_ROOT: target,
        STA_KILL_FRAMEWORK_ROOT: frameworkRoot,
        STA_KILL_MARKER: marker,
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

    const stateDb = path.join(stateRoot, ".workflow", "state.db");
    const store = new SqliteTaskStore(stateDb);
    try {
      const tasks = [row("BE-1"), row("BE-2")];
      const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
      expect(active.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "TASK_CHECKPOINTED", task_id: "BE-1" }),
        expect.objectContaining({ kind: "TASK_STARTED", task_id: "BE-2" }),
      ]));
      const partial = path.join(target, "partial-BE-2.txt");
      await expect(reconcileWaveRunForResume({
        projectRoot: stateRoot,
        active,
        planTasks: tasks,
        staVersion: "1.1.0",
        store,
        git: new GitCommandLayer({ cwd: target }),
      })).rejects.toMatchObject({ kind: "DIRTY" });
      expect(fs.readFileSync(partial, "utf8")).toBe("interrupted work\n");

      // Simulate the exact human reconciliation the refusal requested, then restart.
      fs.rmSync(partial);
      const recovered = await reconcileWaveRunForResume({
        projectRoot: stateRoot,
        active: findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target }),
        planTasks: tasks,
        staVersion: "1.1.0",
        store,
        git: new GitCommandLayer({ cwd: target }),
      });
      const route: ResolvedWaveRoute = {
        runtimeId: "claude-code",
        tier: "T2",
        model: "opus",
        capabilities: new Set([RuntimeCapability.PRE_TOOL_GUARD]),
      };
      const preview = buildWavePreview({
        planTasks: tasks,
        wave: 1,
        maxTasks: 2,
        store,
        route,
        repositoryState: "clean-ordinary",
        checkpointedTaskIds: recovered.checkpointedTaskIds,
      });
      const calls: string[] = [];
      const code = await executeWave({
        projectRoot: stateRoot,
        manifest: recovered.manifest,
        planTasks: tasks,
        preview,
        checkpointedTaskIds: recovered.checkpointedTaskIds,
        initialState: recovered.state,
        registry: new TaskRegistry({ store }),
        store,
        route,
        git: new GitCommandLayer({ cwd: target }),
        log: () => undefined,
        secretScanner: () => ({ ok: true, problems: [] }),
        compose: async (task) => ({
          executor: async () => {
            calls.push(task.id);
            fs.writeFileSync(path.join(target, `${task.id}-resumed.txt`), "done\n");
            return { outcome: { result: "PASS", tokens: 1, cost: 0 } };
          },
          verificationFor: () => verification,
        }),
      });
      expect(code).toBe(0);
      expect(calls).toEqual(["BE-2"]);
      expect(readJournal(stateRoot, recovered.manifest.run_id).records.filter((record) =>
        record.kind === "TASK_STARTED" && record.task_id === "BE-1",
      )).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 30_000);

  it("re-attributes a real trailer-matching commit when the checkpoint journal append was lost, and repairs a truncated tail", async () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    const orchestrator = register(store, target, tasks[0]!);
    const snapshot = orchestrator.snapshot();
    store.appendEvent({ taskId: "BE-1", at: 1, type: "WAVE_ATTEMPT_STARTED", payload: { run_id: run.run_id, snapshot } });
    begin(stateRoot, run, "BE-1");
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    await orchestrator.step(() => ({ outcome: { result: "PASS", tokens: 1, cost: 0 } }));
    appendJournalRecord(stateRoot, run.run_id, { ts: "5", kind: "TASK_AGENT_DONE", task_id: "BE-1" });
    appendJournalRecord(stateRoot, run.run_id, { ts: "6", kind: "GATE_RESULT", task_id: "BE-1", result: "passed" });
    fs.writeFileSync(path.join(target, "work.txt"), "done\n");
    git(target, "add", "work.txt");
    const messages = checkpointMessages({ taskId: "BE-1", taskDescription: "Implement BE-1", runId: run.run_id, module: run.module, planHash: run.plan_hash, verification });
    git(target, "commit", "-m", messages[0], "-m", messages[1]);
    fs.appendFileSync(runArtifactPaths(stateRoot, run.run_id).journal, '{"ts":"broken"', "utf8");

    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    expect(active.truncatedFinalLine).toBe(true);
    const recovered = await reconcileWaveRunForResume({
      projectRoot: stateRoot, active, planTasks: tasks, staVersion: "1.1.0", store,
      git: new GitCommandLayer({ cwd: target }),
    });
    expect(recovered.checkpointedTaskIds).toEqual(new Set(["BE-1"]));
    expect(recovered.messages.join("\n")).toContain("re-attributed checkpoint");
    expect(readJournal(stateRoot, run.run_id).truncatedFinalLine).toBe(false);
    expect(readJournal(stateRoot, run.run_id).records.at(-1)).toMatchObject({ kind: "TASK_CHECKPOINTED", task_id: "BE-1" });
  });

  it("restores only the pre-stage task snapshot after a clean interruption", async () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    const orchestrator = register(store, target, tasks[0]!);
    const snapshot = orchestrator.snapshot();
    store.appendEvent({ taskId: "BE-1", at: 1, type: "WAVE_ATTEMPT_STARTED", payload: { run_id: run.run_id, snapshot } });
    begin(stateRoot, run, "BE-1");
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    await orchestrator.step(() => ({ outcome: { result: "PASS", tokens: 1, cost: 0 } }));
    expect(store.loadTask("BE-1")!.pipelineCursor).toBe(1);

    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    const recovered = await reconcileWaveRunForResume({
      projectRoot: stateRoot, active, planTasks: tasks, staVersion: "1.1.0", store,
      git: new GitCommandLayer({ cwd: target }),
    });
    expect(store.loadTask("BE-1")!.pipelineCursor).toBe(snapshot.pipelineCursor);
    expect(recovered.state).toBe("TASK_READY");
    expect(recovered.messages.join("\n")).toContain("only STA-owned task state");
  });

  it("resumes without a prompt when Ctrl+C lands between a checkpoint and the next task", async () => {
    const stateRoot = temp("sta-recovery-between-tasks-");
    const target = repository();
    const tasks = [row("BE-1"), row("BE-2")];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    register(store, target, tasks[0]!);
    register(store, target, tasks[1]!);
    writeRunManifest(stateRoot, run);
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    fs.writeFileSync(path.join(target, "BE-1.txt"), "checkpointed\n");
    git(target, "add", "BE-1.txt");
    const messages = checkpointMessages({
      taskId: "BE-1",
      taskDescription: "Implement BE-1",
      runId: run.run_id,
      module: run.module,
      planHash: run.plan_hash,
      verification,
    });
    git(target, "commit", "-m", messages[0], "-m", messages[1]);
    const sha = git(target, "rev-parse", "HEAD");
    for (const record of [
      { ts: "1", kind: "RUN_STARTED" },
      { ts: "2", kind: "RUN_ISOLATED" },
      { ts: "3", kind: "TASK_READY", task_id: "BE-1" },
      { ts: "4", kind: "TASK_STARTED", task_id: "BE-1" },
      { ts: "5", kind: "TASK_AGENT_DONE", task_id: "BE-1" },
      { ts: "6", kind: "GATE_RESULT", task_id: "BE-1", result: "passed" },
      { ts: "7", kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha },
      { ts: "8", kind: "TASK_READY", task_id: "BE-2" },
    ] as const) appendJournalRecord(stateRoot, run.run_id, record);

    const recovered = await reconcileWaveRunForResume({
      projectRoot: stateRoot,
      active: findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target }),
      planTasks: tasks,
      staVersion: "1.1.0",
      store,
      git: new GitCommandLayer({ cwd: target }),
    });
    expect(recovered.state).toBe("TASK_READY");
    expect(recovered.checkpointedTaskIds).toEqual(new Set(["BE-1"]));
    expect(recovered.messages).toEqual([]);

    const route: ResolvedWaveRoute = {
      runtimeId: "claude-code",
      tier: "T2",
      model: "opus",
      capabilities: new Set([RuntimeCapability.PRE_TOOL_GUARD]),
    };
    const preview = buildWavePreview({
      planTasks: tasks,
      wave: 1,
      maxTasks: 2,
      store,
      route,
      repositoryState: "clean-ordinary",
      checkpointedTaskIds: recovered.checkpointedTaskIds,
    });
    const calls: string[] = [];
    const code = await executeWave({
      projectRoot: stateRoot,
      manifest: recovered.manifest,
      planTasks: tasks,
      preview,
      checkpointedTaskIds: recovered.checkpointedTaskIds,
      initialState: recovered.state,
      registry: new TaskRegistry({ store }),
      store,
      route,
      git: new GitCommandLayer({ cwd: target }),
      log: () => undefined,
      secretScanner: () => ({ ok: true, problems: [] }),
      compose: async (task) => ({
        executor: async () => {
          calls.push(task.id);
          fs.writeFileSync(path.join(target, `${task.id}.txt`), "done\n");
          return { outcome: { result: "PASS", tokens: 1, cost: 0 } };
        },
        verificationFor: () => verification,
      }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["BE-2"]);
  });

  it("refuses a dirty in-flight tree and leaves the user's file untouched", async () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    const orchestrator = register(store, target, tasks[0]!);
    store.appendEvent({ taskId: "BE-1", at: 1, type: "WAVE_ATTEMPT_STARTED", payload: { run_id: run.run_id, snapshot: orchestrator.snapshot() } });
    begin(stateRoot, run, "BE-1");
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    const partial = path.join(target, "partial.txt");
    fs.writeFileSync(partial, "user work\n");
    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });

    await expect(reconcileWaveRunForResume({
      projectRoot: stateRoot, active, planTasks: tasks, staVersion: "1.1.0", store,
      git: new GitCommandLayer({ cwd: target }),
    })).rejects.toMatchObject({ kind: "DIRTY" });
    expect(fs.readFileSync(partial, "utf8")).toBe("user work\n");
  });

  it("refuses a checkpoint SHA that Git cannot verify as an ancestor", async () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    register(store, target, tasks[0]!);
    begin(stateRoot, run, "BE-1");
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    appendJournalRecord(stateRoot, run.run_id, { ts: "5", kind: "TASK_AGENT_DONE", task_id: "BE-1" });
    appendJournalRecord(stateRoot, run.run_id, { ts: "6", kind: "GATE_RESULT", task_id: "BE-1", result: "passed" });
    appendJournalRecord(stateRoot, run.run_id, { ts: "7", kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha: "f".repeat(40) });
    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    await expect(reconcileWaveRunForResume({
      projectRoot: stateRoot, active, planTasks: tasks, staVersion: "1.1.0", store,
      git: new GitCommandLayer({ cwd: target }),
    })).rejects.toMatchObject({ kind: "STALE" });
  });

  it("refuses a real commit that exists only on a side branch, not on run_branch", async () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    const run = manifest(stateRoot, target, tasks);
    const store = new MemoryTaskStore();
    register(store, target, tasks[0]!);
    begin(stateRoot, run, "BE-1");
    git(target, "switch", "-c", "side", run.base_sha);
    fs.writeFileSync(path.join(target, "side.txt"), "side\n");
    git(target, "add", "side.txt");
    git(target, "commit", "-m", "side only");
    const sideSha = git(target, "rev-parse", "HEAD");
    git(target, "switch", "-c", run.run_branch, run.base_sha);
    appendJournalRecord(stateRoot, run.run_id, { ts: "5", kind: "TASK_AGENT_DONE", task_id: "BE-1" });
    appendJournalRecord(stateRoot, run.run_id, { ts: "6", kind: "GATE_RESULT", task_id: "BE-1", result: "passed" });
    appendJournalRecord(stateRoot, run.run_id, { ts: "7", kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha: sideSha });
    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    await expect(reconcileWaveRunForResume({
      projectRoot: stateRoot, active, planTasks: tasks, staVersion: "1.1.0", store,
      git: new GitCommandLayer({ cwd: target }),
    })).rejects.toMatchObject({ kind: "STALE", message: expect.stringContaining("not exist as a commit ancestor") });
  });

  it.each([
    { name: "plan_hash", tasks: [row("BE-CHANGED")], version: "1.1.0", expected: "plan_hash drifted" },
    { name: "sta_version", tasks: [row("BE-1")], version: "2.0.0", expected: "sta_version drifted" },
  ])("marks $name drift STALE before trusting resumable state", async ({ tasks: currentTasks, version, expected }) => {
    const stateRoot = temp("sta-recovery-drift-");
    const target = repository();
    const originalTasks = [row("BE-1")];
    const run = manifest(stateRoot, target, originalTasks);
    const store = new MemoryTaskStore();
    register(store, target, originalTasks[0]!);
    begin(stateRoot, run, "BE-1");
    const active = findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    await expect(reconcileWaveRunForResume({
      projectRoot: stateRoot,
      active,
      planTasks: currentTasks,
      staVersion: version,
      store,
      git: new GitCommandLayer({ cwd: target }),
    })).rejects.toMatchObject({ kind: "STALE", message: expect.stringContaining(expected) });
  });

  it("lists and refuses two unfinished candidate runs", () => {
    const stateRoot = temp("sta-recovery-state-");
    const target = repository();
    const tasks = [row()];
    for (const id of ["01J00000000000000000000031", "01J00000000000000000000032"]) {
      const run = manifest(stateRoot, target, tasks, id);
      writeRunManifest(stateRoot, run);
      appendJournalRecord(stateRoot, id, { ts: "1", kind: "RUN_STARTED" });
    }
    expect(() => findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target })).toThrow(WaveRunRecoveryError);
    try {
      findActiveWaveRun(stateRoot, { module: "orders", wave: 1, targetRoot: target });
    } catch (error) {
      expect(error).toMatchObject({ kind: "AMBIGUOUS" });
      expect((error as Error).message).toContain("01J00000000000000000000031");
      expect((error as Error).message).toContain("01J00000000000000000000032");
    }
  });
});
