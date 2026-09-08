import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import type { PlanTaskRow } from "../docs/planGraph.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import { inspectRepositoryPreflight } from "../git/preflight.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { fixtureTask, writePacketPlan } from "../runtime/packetFixture.testSupport.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { AgentStage } from "../types.js";
import { planHash, readJournal, type RunManifest } from "./journal.js";
import { buildWavePreview, executeWave, renderWavePreview, type ResolvedWaveRoute } from "./waveRunner.js";

const roots: string[] = [];
const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  const root = temp("sta-wave-target-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "STA Test");
  git(root, "config", "user.email", "sta@example.test");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "ok", typecheck: "ok", test: "ok", build: "ok" } }));
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  git(root, "add", "package.json", "base.txt");
  git(root, "commit", "-m", "base");
  return root;
}

function row(id: string): PlanTaskRow {
  return {
    id,
    phase: 1,
    designRefs: ["DES-001"],
    dependsOn: [],
    status: "pending",
    owner: AgentStage.BACKEND_ENGINEER,
    wave: null,
    tier: "T2",
    description: `Implement ${id}`,
    fromCheckbox: false,
  };
}

const verification: DeterministicVerification = {
  required: ["typecheck"],
  ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "passed" }],
  failures: [],
  skipped: [],
  missingRequired: [],
  status: "passed",
  enforcement: "enforce",
  passed: true,
};

function route(): ResolvedWaveRoute {
  return {
    runtimeId: "claude-code",
    tier: "T2",
    model: "opus",
    capabilities: new Set([RuntimeCapability.PRE_TOOL_GUARD]),
  };
}

function register(registry: TaskRegistry, targetRoot: string, task: PlanTaskRow): void {
  const docsRoot = temp("sta-wave-docs-");
  writePacketPlan(docsRoot, [...task.dependsOn.map(id => fixtureTask({ id })), fixtureTask({ id: task.id, dependsOn: task.dependsOn })]);
  registry.create({
    taskId: task.id,
    classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
    dependsOn: task.dependsOn,
    projectRoot: frameworkRoot,
    docsRoot,
    moduleName: "packet-fixture",
    taskText: task.description,
    targetWorkRoots: [
      { stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: targetRoot },
      { stage: AgentStage.QA_ENGINEER, targetId: "target", path: targetRoot },
    ],
    changeAwareVerification: false,
  });
}

describe("bounded sequential wave runner", () => {
  it("prints and executes exactly one owner stage per task, checkpoints sequentially, and leaves QA for manual resume", async () => {
    const target = repository();
    const stateRoot = temp("sta-wave-state-");
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const tasks = [row("BE-1"), row("BE-2")];
    for (const task of tasks) register(registry, target, task);
    const selectedRoute = route();
    const preview = buildWavePreview({
      planTasks: tasks,
      wave: 1,
      maxTasks: 2,
      store,
      route: selectedRoute,
      repositoryState: "clean-ordinary",
    });
    expect(preview.allEligible).toBe(true);
    const runId = "01J00000000000000000000028";
    const commandLayer = new GitCommandLayer({ cwd: target });
    const preflight = await inspectRepositoryPreflight(commandLayer, "orders", runId);
    const manifest: RunManifest = {
      run_id: runId,
      created_at: "2026-09-07T00:00:00.000Z",
      target_root: target,
      target_id: "target",
      knowledge_root: stateRoot,
      module: "orders",
      wave: 1,
      plan_hash: planHash(tasks),
      task_order: tasks.map((task) => task.id),
      base_branch: preflight.baseBranch,
      base_sha: preflight.baseSha,
      run_branch: preflight.runBranch,
      runtime_id: selectedRoute.runtimeId,
      tier: selectedRoute.tier,
      model: selectedRoute.model,
      max_tasks: 2,
      sta_version: "1.1.0",
    };
    const calls: string[] = [];
    const logs: string[] = [];
    const code = await executeWave({
      projectRoot: stateRoot,
      manifest,
      planTasks: tasks,
      preview,
      preflight,
      registry,
      store,
      route: selectedRoute,
      git: commandLayer,
      log: (line) => logs.push(line),
      secretScanner: () => ({ ok: true, problems: [] }),
      compose: async (task) => ({
        executor: async (request) => {
          calls.push(`${request.taskId}:${request.stage}`);
          fs.writeFileSync(path.join(target, `${task.id}.txt`), `${task.id}\n`);
          return { outcome: { result: "PASS", tokens: 1, cost: 0 } };
        },
        verificationFor: () => verification,
      }),
    });

    expect(code).toBe(0);
    expect(calls).toEqual(["BE-1:backend-engineer", "BE-2:backend-engineer"]);
    expect(store.loadTask("BE-1")?.classification.pipeline[store.loadTask("BE-1")!.pipelineCursor]).toBe(AgentStage.QA_ENGINEER);
    expect(store.loadTask("BE-2")?.classification.pipeline[store.loadTask("BE-2")!.pipelineCursor]).toBe(AgentStage.QA_ENGINEER);
    expect(readJournal(stateRoot, runId).records.map((record) => record.kind)).toEqual([
      "RUN_STARTED", "RUN_ISOLATED",
      "TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE", "GATE_RESULT", "TASK_CHECKPOINTED",
      "TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE", "GATE_RESULT", "TASK_CHECKPOINTED",
      "RUN_COMPLETED", "HUMAN_REVIEW_REQUIRED",
    ]);
    expect(git(target, "log", "--format=%s", "--reverse", preflight.runBranch)).toContain("sta(BE-1)");
    expect(logs.join("\n")).toContain("not VERIFIED, SECURITY_APPROVED, or MERGE_READY");
    expect(logs.join("\n")).not.toMatch(/\b(?:tasks?|BE-\w+)\s+(?:done|complete|passed)\b/i);
    expect(renderWavePreview({ wave: 1, preview, route: selectedRoute, baseBranch: preflight.baseBranch, baseSha: preflight.baseSha })).toEqual([
      "[orchestrator] bounded wave 1: 2 task(s)",
      "[orchestrator] route runtime=claude-code tier=T2 model=opus",
      `[orchestrator] base branch=${preflight.baseBranch} sha=${preflight.baseSha}`,
      "[orchestrator] 1. BE-1 owner=backend-engineer ELIGIBLE",
      "[orchestrator] 2. BE-2 owner=backend-engineer ELIGIBLE",
    ]);
  }, 15_000);

  it("T-V7-031 reports real base-branch divergence and never merges automatically", async () => {
    const target = repository();
    const stateRoot = temp("sta-wave-divergence-state-");
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const task = row("BE-DIVERGENCE");
    register(registry, target, task);
    const selectedRoute = route();
    const preview = buildWavePreview({
      planTasks: [task], wave: 1, maxTasks: 1, store, route: selectedRoute, repositoryState: "clean-ordinary",
    });
    const runId = "01J00000000000000000000061";
    const commandLayer = new GitCommandLayer({ cwd: target });
    const preflight = await inspectRepositoryPreflight(commandLayer, "orders", runId);

    fs.writeFileSync(path.join(target, "base-advanced.txt"), "advanced while run was pending\n");
    git(target, "add", "base-advanced.txt");
    git(target, "commit", "-m", "advance base outside bounded run");
    const advancedBaseSha = git(target, "rev-parse", "main");

    const manifest: RunManifest = {
      run_id: runId,
      created_at: "2026-09-07T00:00:00.000Z",
      target_root: target,
      target_id: "target",
      knowledge_root: stateRoot,
      module: "orders",
      wave: 1,
      plan_hash: planHash([task]),
      task_order: [task.id],
      base_branch: preflight.baseBranch,
      base_sha: preflight.baseSha,
      run_branch: preflight.runBranch,
      runtime_id: selectedRoute.runtimeId,
      tier: selectedRoute.tier,
      model: selectedRoute.model,
      max_tasks: 1,
      sta_version: "1.1.0",
    };
    const logs: string[] = [];
    const code = await executeWave({
      projectRoot: stateRoot,
      manifest,
      planTasks: [task],
      preview,
      preflight,
      registry,
      store,
      route: selectedRoute,
      git: commandLayer,
      log: (line) => logs.push(line),
      secretScanner: () => ({ ok: true, problems: [] }),
      compose: async () => ({
        executor: async () => {
          fs.writeFileSync(path.join(target, "run-change.txt"), "bounded run change\n");
          return { outcome: { result: "PASS", tokens: 1, cost: 0 } };
        },
        verificationFor: () => verification,
      }),
    });

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("base branch advanced by 1 commit");
    expect(logs.join("\n")).toContain("git merge --ff-only");
    expect(git(target, "rev-parse", "main")).toBe(advancedBaseSha);
    expect(git(target, "branch", "--show-current")).toBe(preflight.runBranch);
  }, 15_000);

  it("fails closed when registration classification carries a human gate", () => {
    const target = repository();
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const task = row("BE-1");
    registry.create({
      taskId: task.id,
      classification: classifyTask({ touchesSchema: true, touchesBackend: true }),
      projectRoot: frameworkRoot,
      targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: target }],
    });
    const preview = buildWavePreview({
      planTasks: [task], wave: 1, maxTasks: 1, store, route: route(), repositoryState: "clean-ordinary",
    });
    expect(preview.allEligible).toBe(false);
    expect(preview.tasks[0]!.decision.failures.some((failure) => failure.clause === "D")).toBe(true);
  });

  it("T-V7-031 refuses an otherwise eligible wave spanning two writable Targets", () => {
    const firstTarget = repository();
    const secondTarget = repository();
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const tasks = [row("BE-1"), row("BE-2")];
    register(registry, firstTarget, tasks[0]);
    const secondDocs = temp("sta-wave-docs-");
    writePacketPlan(secondDocs, [fixtureTask({ id: tasks[1].id })]);
    registry.create({
      taskId: tasks[1].id,
      classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
      projectRoot: frameworkRoot,
      docsRoot: secondDocs,
      moduleName: "packet-fixture",
      taskText: tasks[1].description,
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "second", path: secondTarget },
        { stage: AgentStage.QA_ENGINEER, targetId: "second", path: secondTarget },
      ],
      changeAwareVerification: false,
    });
    const preview = buildWavePreview({
      planTasks: tasks, wave: 1, maxTasks: 2, store, route: route(), repositoryState: "clean-ordinary",
    });
    expect(preview.allEligible).toBe(false);
    expect(preview.tasks[0].decision.eligible).toBe(true);
    expect(preview.tasks[1].decision.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ clause: "H" }),
    ]));
  });

  it.each([
    { name: "runtime ERROR", runId: "01J00000000000000000000040", reason: "runtime exited non-zero", failure: undefined, expectedClass: "runtime", outcome: "FAIL" as const },
    { name: "TIMEOUT", runId: "01J00000000000000000000041", reason: "runtime TIMEOUT", failure: undefined, expectedClass: "runtime", outcome: "FAIL" as const },
    {
      name: "UNAVAILABLE",
      runId: "01J00000000000000000000042",
      reason: "runtime unavailable",
      failure: {
        category: "infrastructure" as const,
        owner: AgentStage.BACKEND_ENGINEER,
        severity: "high" as const,
        retryable: false,
        reason: "runtime unavailable",
        affected: ["BE-1"],
        requiresHuman: true,
      },
      expectedClass: "unavailable",
      outcome: "FAIL" as const,
    },
    { name: "quota", runId: "01J00000000000000000000043", reason: "provider quota exhausted", failure: undefined, expectedClass: "quota", outcome: "FAIL" as const },
    {
      name: "deterministic FAIL", runId: "01J00000000000000000000044", reason: "gate failed", failure: undefined,
      expectedClass: "deterministic-gate", outcome: "PASS" as const, writePath: "gate-failed.txt",
      caseVerification: { ...verification, status: "failed" as const, passed: false, failures: verification.ran },
    },
    {
      name: "deterministic skipped", runId: "01J00000000000000000000045", reason: "gate skipped", failure: undefined,
      expectedClass: "deterministic-gate", outcome: "PASS" as const, writePath: "gate-skipped.txt",
      caseVerification: { ...verification, status: "skipped" as const, passed: false, ran: [], skipped: ["typecheck" as const] },
    },
    {
      name: "denied changed path", runId: "01J00000000000000000000046", reason: "denied path", failure: undefined,
      expectedClass: "DENIED_PATH", outcome: "PASS" as const, writePath: ".workflow/forbidden.txt", caseVerification: verification,
    },
    {
      name: "NO_CHANGES", runId: "01J00000000000000000000047", reason: "no changes", failure: undefined,
      expectedClass: "NO_CHANGES", outcome: "PASS" as const, caseVerification: verification,
    },
  ])("T-V7-031 halts and preserves on $name without retrying or checkpointing", async ({
    runId, reason, failure, expectedClass, outcome, writePath, caseVerification,
  }) => {
    const target = repository();
    const stateRoot = temp("sta-wave-failure-");
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const task = row("BE-1");
    register(registry, target, task);
    const selectedRoute = route();
    const preview = buildWavePreview({
      planTasks: [task], wave: 1, maxTasks: 1, store, route: selectedRoute, repositoryState: "clean-ordinary",
    });
    const commandLayer = new GitCommandLayer({ cwd: target });
    const preflight = await inspectRepositoryPreflight(commandLayer, "orders", runId);
    const manifest: RunManifest = {
      run_id: runId,
      created_at: "2026-09-07T00:00:00.000Z",
      target_root: target,
      target_id: "target",
      knowledge_root: stateRoot,
      module: "orders",
      wave: 1,
      plan_hash: planHash([task]),
      task_order: [task.id],
      base_branch: preflight.baseBranch,
      base_sha: preflight.baseSha,
      run_branch: preflight.runBranch,
      runtime_id: selectedRoute.runtimeId,
      tier: selectedRoute.tier,
      model: selectedRoute.model,
      max_tasks: 1,
      sta_version: "1.1.0",
    };
    let calls = 0;
    const logs: string[] = [];
    const code = await executeWave({
      projectRoot: stateRoot,
      manifest,
      planTasks: [task],
      preview,
      preflight,
      registry,
      store,
      route: selectedRoute,
      git: commandLayer,
      log: (line) => logs.push(line),
      compose: async () => ({
        executor: async () => {
          calls += 1;
          if (writePath) {
            const destination = path.join(target, writePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, "preserve me\n");
          }
          return { outcome: { result: outcome, tokens: 0, cost: 0, failure_reason: reason }, ...(failure ? { failure } : {}) };
        },
        verificationFor: () => caseVerification,
      }),
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(git(target, "rev-list", "--count", preflight.runBranch)).toBe("1");
    expect(readJournal(stateRoot, runId).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "TASK_FAILED", task_id: "BE-1", class: expectedClass }),
      expect.objectContaining({ kind: "RUN_HALTED" }),
    ]));
    if (expectedClass === "quota") {
      expect(logs.join("\n")).toContain("Runtime reading");
      expect(logs.join("\n")).toContain("accounting reading");
      expect(logs.join("\n")).toContain("No retry or alternate runtime");
    }
  });
});
