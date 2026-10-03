import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type SqliteDatabase from "../store/sqliteDatabase.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import type { CommanderInvocation, CommanderInvoker } from "./commander.js";
import { openCoreDb } from "./coreDb.js";
import { runOverlayPath } from "./corePaths.js";
import type { BoundedRunProjection } from "./engineProjection.js";
import type { IntentResult } from "./intent.js";
import { parseMachineConfig, type MachineConfig } from "./machineConfig.js";
import type { SegmentLauncher, SegmentLaunchSpec } from "./processes.js";
import { RuntimeHealthStore } from "./runtimeHealth.js";
import { WorkRunError, WorkRunService, type TaskControl } from "./workRunService.js";
import { WorkRunStore, type WorkRun } from "./workRunStore.js";
import { groupTasksByTarget, type TargetGroup } from "./targetGroups.js";
import type { PlanTask } from "../docs/planTask.js";

type CommanderReply = Pick<RuntimeAgentResult, "status" | "text" | "failureClass" | "retryAt" | "diagnostics">;

class FakeLauncher implements SegmentLauncher {
  launches: Array<SegmentLaunchSpec & { pid: number }> = [];
  alive = new Set<number>();
  killed: number[] = [];
  private next = 1000;
  launch(spec: SegmentLaunchSpec) {
    const pid = this.next++;
    this.launches.push({ ...spec, pid });
    this.alive.add(pid);
    return { pid };
  }
  isAlive(pid: number) { return this.alive.has(pid); }
  kill(pid: number) { this.killed.push(pid); this.alive.delete(pid); }
  /** Plays the bounded-run child: log lines, then the exit record its `finally` writes. */
  finish(home: string, runId: string, exitCode: number | null, log: string) {
    const last = this.launches.at(-1)!;
    fs.appendFileSync(last.logPath, log, "utf8");
    const segment = Number(/segment-(\d+)\.log$/.exec(last.logPath)![1]);
    if (exitCode !== null) fs.writeFileSync(path.join(path.dirname(runOverlayPath(runId, home)), `segment-${segment}.exit.json`), JSON.stringify({ segment, exitCode, at: Date.now() }));
    this.alive.delete(last.pid);
  }
}

class FakeCommander implements CommanderInvoker {
  calls: CommanderInvocation[] = [];
  replies = new Map<string, CommanderReply>();
  async invoke(request: CommanderInvocation): Promise<CommanderReply> {
    this.calls.push(request);
    const decision = request.prompt.includes("Phase: START") ? "proceed" : "ready_for_review";
    return this.replies.get(request.runtimeId) ?? { status: "OK", text: JSON.stringify({ decision, summary: "สรุป", risks: [] }), diagnostics: [] };
  }
}

const QUOTA: CommanderReply = { status: "UNAVAILABLE", failureClass: "QUOTA_EXHAUSTED", text: "", diagnostics: ["usage limit reached"] };
const allCertified = () => ({ eligible: true });

interface Harness {
  service: WorkRunService;
  store: WorkRunStore;
  health: RuntimeHealthStore;
  launcher: FakeLauncher;
  commander: FakeCommander;
  tasks: { paused: string[]; unpaused: string[] };
  knowledge: Map<string, string>;
  modules: Map<string, string[]>;
  projections: Map<string, BoundedRunProjection>;
  groups: { value: TargetGroup[] };
  home: string;
  db: SqliteDatabase;
  now: { value: number };
  config: { value: MachineConfig };
  rebuild(): WorkRunService;
}

function projection(over: Partial<BoundedRunProjection> = {}): BoundedRunProjection {
  return {
    runId: "run-1", status: "RUNNING", boundary: "done", module: "timetableai", knowledgeRoot: "", targetId: "timetable-api", targetRoot: "/t",
    baseBranch: "main", baseSha: "a".repeat(40), runBranch: "sta/run-1", checkpoints: 1, currentTask: "T-2", currentStage: "backend-engineer",
    tasks: [
      { taskId: "T-1", phase: 1, owner: "backend-engineer", status: "DONE", state: "DEPLOYED", stage: null, reason: "done", attempts: [], findings: 0, retries: null },
      { taskId: "T-2", phase: 1, owner: "backend-engineer", status: "RUNNING", state: "IMPLEMENTATION", stage: "backend-engineer", reason: "running", attempts: [], findings: 0, retries: null },
    ],
    verification: { reviewPassed: 1, qaPassed: 1, securityPassed: 0, checkpointed: 0, done: 1, total: 2 },
    ...over,
  };
}

function makeHarness(base: string, eligibility?: () => { eligible: boolean }, homeName = "home"): Harness {
  const home = path.join(base, homeName);
  fs.mkdirSync(home, { recursive: true });
  const db = openCoreDb(path.join(home, "core", "core.db"));
  const now = { value: 1_000_000 };
  const config = { value: parseMachineConfig({ workspace: { allowed_roots: [base] } }) };
  const clock = () => now.value;
  const health = new RuntimeHealthStore(db, config.value.health, clock);
  const store = new WorkRunStore(db, clock);
  const launcher = new FakeLauncher();
  const commander = new FakeCommander();
  const tasks = { paused: [] as string[], unpaused: [] as string[] };
  const taskControl: TaskControl = {
    pause: (_k, id) => { tasks.paused.push(id); return ["T-2"]; },
    unpause: (_k, id) => { tasks.unpaused.push(id); return ["T-2"]; },
  };
  const knowledge = new Map<string, string>();
  const modules = new Map<string, string[]>();
  const projections = new Map<string, BoundedRunProjection>();
  const groups = { value: [] as TargetGroup[] };
  const build = () => new WorkRunService({
    store, health, launcher, commander,
    machine: () => config.value,
    runtimeStatus: () => null,
    project: (knowledgePath, id) => projections.get(`${knowledgePath}|${id}`) ?? null,
    changedFiles: async () => [{ status: "M", path: "src/parser.ts" }, { status: "A", path: "tests/parser.test.ts" }],
    tasks: taskControl,
    resolveKnowledge: (name) => {
      const p = knowledge.get(name);
      if (!p) throw new Error(`unknown Knowledge root "${name}"`);
      return { name, path: p };
    },
    listModules: (p) => modules.get(p) ?? [],
    listTargets: () => ["timetable-api"],
    targetGroups: () => groups.value,
    targetPath: (_k, targetId) => `C:/src/${targetId}`,
    healthDbPath: path.join(home, "core", "core.db"),
    home,
    clock,
    ...(eligibility ? { eligibility } : {}),
  });
  const harness: Harness = { service: build(), store, health, launcher, commander, tasks, knowledge, modules, projections, groups, home, db, now, config, rebuild: () => build() };
  return harness;
}

function intent(knowledge: string, module: string, over: Partial<IntentResult["intent"]> = {}): IntentResult["intent"] {
  return {
    action: "work", knowledge_root: knowledge, module, scope: "ready_tasks", completion_target: "qa_passed", stop_for_human_review: true,
    allow_push: false, allow_merge: false, allow_deploy: false, ...over,
  };
}

describe("STA Core work runs", () => {
  let base: string;
  let h: Harness;
  let timetable: string;
  let companyA: string;
  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sta-workrun-")));
    timetable = path.join(base, "timetable-knowledge");
    companyA = path.join(base, "company-a-knowledge");
    fs.mkdirSync(timetable);
    fs.mkdirSync(companyA);
    h = makeHarness(base);
    h.knowledge.set("timetable", timetable);
    h.knowledge.set("company-a", companyA);
    h.modules.set(timetable, ["timetableai", "shared"]);
    h.modules.set(companyA, ["billing", "shared"]);
  });
  afterEach(() => {
    h.db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const create = (knowledge = "timetable", module = "timetableai", over: Partial<IntentResult["intent"]> = {}) =>
    h.service.create({ knowledge, module, commandText: "ทำงานที่พร้อมให้หมดจน QA ผ่าน", intent: intent(knowledge, module, over), intentSource: "offline", overrides: [] });
  const startAndFreeze = async (run: WorkRun, knowledgePath = timetable) => {
    await h.service.tick();
    h.projections.set(`${knowledgePath}|run-1`, projection({ knowledgeRoot: knowledgePath }));
    fs.appendFileSync(h.launcher.launches.at(-1)!.logPath, "[bounded-run] froze run run-1: compiled\n");
    await h.service.tick();
    return h.store.get(run.runId)!;
  };

  it("persists the run with its Knowledge pinned, and refuses a module of another Knowledge", () => {
    const run = create();
    expect(run.knowledge).toEqual({ name: "timetable", path: timetable });
    expect(run.boundary).toBe("done");
    expect(run.push || run.merge || run.deploy).toBe(false);
    expect(new WorkRunStore(h.db).get(run.runId)!.status).toBe("QUEUED");
    expect(() => create("timetable", "billing")).toThrow(/does not exist in Knowledge "timetable"/);
    expect(() => create("timetable", "shared", { allow_deploy: true })).toThrow(WorkRunError);
    expect(() => h.service.create({ knowledge: "timetable", module: "shared", commandText: "", intent: intent("company-a", "shared"), intentSource: "cli", overrides: [] })).toThrow(/Knowledge mismatch/);
  });

  it("launches bounded-run with the pinned root, the overlay and no push/merge/deploy path", async () => {
    const run = create();
    await h.service.tick();
    const launched = h.launcher.launches[0]!;
    expect(launched.args).toEqual(expect.arrayContaining(["bounded-run", "--module", "timetableai", "--all", "--until", "done", "--autonomy", "edit", "--root", "timetable", "--project-root", timetable, "--core-run"]));
    expect(launched.cwd).toBe(timetable);
    const overlay = JSON.parse(fs.readFileSync(runOverlayPath(run.runId, h.home), "utf8"));
    expect(overlay.knowledge).toEqual({ name: "timetable", path: timetable });
    expect(overlay.role_orders.engineer[0]).toBe("codex");
    const stored = h.store.get(run.runId)!;
    expect(stored.status).toBe("RUNNING");
    expect(stored.commander.current).toBe("claude-code");
    // Engineer and QA follow their configured orders; Codex checks writes after the run.
    expect(stored.workers).toEqual({ engineer: "codex", reviewer: "claude-code", qa: "antigravity" });
  });

  it("a completed segment stops for human review — never past it", async () => {
    const run = await startAndFreeze(create());
    h.launcher.finish(h.home, run.runId, 0, "[bounded-run] COMPLETED: every task done (run run-1 status=COMPLETED)\n");
    await h.service.tick();
    const done = h.store.get(run.runId)!;
    expect(done.status).toBe("READY_FOR_REVIEW");
    expect(done.humanGates.some((gate) => gate.kind === "review" && gate.resolvedAt === null)).toBe(true);
    expect(done.commander.notes.map((n) => `${n.phase}:${n.decision}:${n.accepted}`)).toEqual(["start:proceed:true", "assess:ready_for_review:true"]);
    expect((done.snapshot as { changedFiles: unknown[] }).changedFiles).toHaveLength(2);
    // Approval is a person's act and only records it.
    const approved = h.service.approve(run.runId, "golf", "ok");
    expect(approved.status).toBe("APPROVED");
    expect(approved.statusReason).toMatch(/push\/merge\/deploy remain a person's own action/);
    expect(h.launcher.launches).toHaveLength(1);
  });

  it("pause is graceful (engine task pause), resume relaunches the same frozen run", async () => {
    const run = await startAndFreeze(create());
    expect(h.service.pause(run.runId).status).toBe("PAUSING");
    expect(h.tasks.paused).toEqual(["run-1"]);
    h.launcher.finish(h.home, run.runId, 4, "[bounded-run] GATE: task T-2 is paused (run run-1 status=AWAITING_HUMAN)\n");
    await h.service.tick();
    expect(h.store.get(run.runId)!.status).toBe("PAUSED");
    h.service.resume(run.runId);
    expect(h.tasks.unpaused).toEqual(["run-1"]);
    await h.service.tick();
    const resumed = h.launcher.launches.at(-1)!;
    expect(resumed.args.slice(0, 3)).toEqual(["bounded-run", "--resume", "run-1"]);
    expect(resumed.args).toContain("--core-run");
    expect(h.store.get(run.runId)!.segments).toHaveLength(2);
  });

  it("stop waits for the current stage; force stop kills the segment", async () => {
    const run = await startAndFreeze(create());
    expect(h.service.stop(run.runId).status).toBe("STOPPING");
    h.launcher.finish(h.home, run.runId, 4, "[bounded-run] GATE: paused\n");
    await h.service.tick();
    expect(h.store.get(run.runId)!.status).toBe("STOPPED");
    const second = await startAndFreeze(create("timetable", "shared"));
    const forced = h.service.stop(second.runId, { force: true });
    expect(forced.status).toBe("STOPPED");
    expect(h.launcher.killed).toHaveLength(1);
  });

  it("an engine human gate is a WAITING_FOR_HUMAN, not a failure", async () => {
    const run = await startAndFreeze(create());
    h.launcher.finish(h.home, run.runId, 4, "[bounded-run] GATE: schema approval required (run run-1 status=AWAITING_HUMAN)\n[bounded-run]   T-2: waiting for a person's schema approval\n");
    await h.service.tick();
    const waiting = h.store.get(run.runId)!;
    expect(waiting.status).toBe("WAITING_FOR_HUMAN");
    expect(waiting.statusReason).toMatch(/schema approval/);
  });

  it("Commander failover: Claude quota → Codex commander; history, fallback and a Knowledge-bearing handoff are recorded", async () => {
    h.commander.replies.set("claude-code", QUOTA);
    const run = create();
    await h.service.tick();
    const stored = h.store.get(run.runId)!;
    expect(stored.commander.current).toBe("codex");
    expect(stored.fallbacks[0]).toMatchObject({ role: "commander", from: "claude-code", to: "codex", failureClass: "QUOTA_EXHAUSTED" });
    expect(stored.handoffs[0]).toMatchObject({ knowledge_root: "timetable", knowledge_path: timetable, module: "timetableai", role: "commander", previous_runtime: "claude-code", next_runtime: "codex", failure: { class: "QUOTA_EXHAUSTED" } });
    expect(h.health.isUsable("claude-code")).toBe(false);
    // Codex can also engineer, so Claude's cooldown does not pause the worker route.
    expect(stored.status).toBe("RUNNING");
    expect(stored.workers.engineer).toBe("codex");
    expect(h.launcher.launches).toHaveLength(1);
    // Another tick does not repeat the commander turn.
    await h.service.tick();
    expect(h.store.get(run.runId)!.status).toBe("RUNNING");
    expect(h.commander.calls.map((c) => c.runtimeId)).toEqual(["claude-code", "codex"]);
  });

  it("multi-hop commander failover across all four runtimes (were every boundary certified): Claude → Codex → AGY → ZCode", async () => {
    h.db.close();
    h = makeHarness(base, allCertified, "home-certified");
    h.knowledge.set("timetable", timetable);
    h.modules.set(timetable, ["timetableai"]);
    for (const id of ["claude-code", "codex", "antigravity"]) h.commander.replies.set(id, { ...QUOTA, failureClass: id === "antigravity" ? "PROVIDER_UNAVAILABLE" : "QUOTA_EXHAUSTED" });
    const run = create();
    await h.service.tick();
    const stored = h.store.get(run.runId)!;
    expect(stored.commander.current).toBe("zcode");
    expect(stored.fallbacks.map((f) => `${f.from}→${f.to}`)).toEqual(["claude-code→codex", "codex→antigravity", "antigravity→zcode"]);
    expect(stored.handoffs.every((handoff) => handoff.knowledge_root === "timetable")).toBe(true);
    expect(stored.status).toBe("RUNNING");
  });

  it("all commander runtimes unavailable → PAUSED_RUNTIME_EXHAUSTED (not failed), then resumes when a cooldown ends", async () => {
    h.commander.replies.set("claude-code", QUOTA);
    h.commander.replies.set("codex", QUOTA);
    const run = create();
    await h.service.tick();
    let stored = h.store.get(run.runId)!;
    expect(stored.status).toBe("PAUSED_RUNTIME_EXHAUSTED");
    expect(stored.autoResumeAt).not.toBeNull();
    expect(stored.runtimeHistory.some((e) => e.runtimeId === "antigravity" && e.event === "skipped" && /SECURITY/.test(e.detail ?? ""))).toBe(true);
    expect(h.launcher.launches).toHaveLength(0);
    h.commander.replies.clear();
    await h.service.tick();
    expect(h.store.get(run.runId)!.status).toBe("PAUSED_RUNTIME_EXHAUSTED");
    h.now.value = stored.autoResumeAt! + 1;
    await h.service.tick();
    stored = h.store.get(run.runId)!;
    expect(stored.status).toBe("RUNNING");
    expect(h.launcher.launches).toHaveLength(1);
  });

  it("worker runtime exhaustion mid-run pauses the run and auto-resumes the same frozen run later", async () => {
    const run = await startAndFreeze(create());
    for (const id of ["codex", "claude-code"]) h.health.recordFailure({ runtimeId: id, failureClass: "QUOTA_EXHAUSTED", reason: "usage limit", runId: run.runId, role: "backend-engineer" });
    h.launcher.finish(h.home, run.runId, 4, '[bounded-run] GATE: task T-2 BLOCKED: runtime "claude-code" is unavailable: usage limit | routing.order is exhausted\n');
    await h.service.tick();
    const paused = h.store.get(run.runId)!;
    expect(paused.status).toBe("PAUSED_RUNTIME_EXHAUSTED");
    expect(paused.humanGates.at(-1)!.kind).toBe("runtime_exhausted");
    h.now.value = paused.autoResumeAt! + 1;
    await h.service.tick();
    expect(h.launcher.launches.at(-1)!.args.slice(0, 3)).toEqual(["bounded-run", "--resume", "run-1"]);
  });

  it("worker fallback: Codex engineer quota → Claude engineer, commander and Knowledge unchanged", async () => {
    const run = await startAndFreeze(create());
    h.now.value += 1000;
    h.health.recordFailure({ runtimeId: "codex", failureClass: "QUOTA_EXHAUSTED", reason: "You've hit your usage limit", runId: run.runId, role: "backend-engineer" });
    h.now.value += 1000;
    h.health.recordSuccess("claude-code", { runId: run.runId, role: "backend-engineer" });
    h.now.value += 1000;
    h.health.recordSuccess("claude-code", { runId: run.runId, role: "reviewer" });
    h.health.recordSuccess("claude-code", { runId: run.runId, role: "qa-engineer" });
    h.launcher.finish(h.home, run.runId, 0, "[bounded-run] COMPLETED\n");
    await h.service.tick();
    const done = h.store.get(run.runId)!;
    expect(done.fallbacks).toEqual([expect.objectContaining({ role: "engineer", from: "codex", to: "claude-code", failureClass: "QUOTA_EXHAUSTED" })]);
    expect(done.workers.engineer).toBe("claude-code");
    expect(done.commander.current).toBe("claude-code");
    expect(done.knowledge).toEqual({ name: "timetable", path: timetable });
    const handoff = done.handoffs.find((x) => x.role === "engineer")!;
    expect(handoff).toMatchObject({ knowledge_root: "timetable", module: "timetableai", target: "timetable-api", task: "T-2", previous_runtime: "codex", next_runtime: "claude-code" });
    expect(handoff.completed).toEqual(["T-1 (DONE)"]);
    expect(handoff.files_changed).toEqual(["src/parser.ts", "tests/parser.test.ts"]);
    expect(done.status).toBe("READY_FOR_REVIEW");
  });

  it("service restart: a new Core instance reconciles a segment that finished while it was down", async () => {
    const run = await startAndFreeze(create());
    h.launcher.finish(h.home, run.runId, 0, "[bounded-run] COMPLETED\n");
    const restarted = h.rebuild();
    await restarted.tick();
    expect(h.store.get(run.runId)!.status).toBe("READY_FOR_REVIEW");
  });

  it("service restart: a segment that died without an exit record resumes once, then asks a person", async () => {
    const run = await startAndFreeze(create());
    h.launcher.finish(h.home, run.runId, null, "");
    const restarted = h.rebuild();
    await restarted.tick();
    expect(h.store.get(run.runId)!.status).toBe("QUEUED");
    await restarted.tick();
    expect(h.launcher.launches.at(-1)!.args).toContain("--resume");
    h.launcher.finish(h.home, run.runId, null, "");
    await restarted.tick();
    const stuck = h.store.get(run.runId)!;
    expect(stuck.status).toBe("WAITING_FOR_HUMAN");
    expect(stuck.humanGates.at(-1)!.kind).toBe("interrupted");
  });

  it("Knowledge isolation: a changed registration stops the run instead of repointing it, and no code path can repoint it", async () => {
    const run = await startAndFreeze(create());
    h.launcher.finish(h.home, run.runId, 4, "[bounded-run] GATE: x\n");
    await h.service.tick();
    h.service.resume(run.runId);
    h.knowledge.set("timetable", companyA);
    await h.service.tick();
    const stopped = h.store.get(run.runId)!;
    expect(stopped.status).toBe("WAITING_FOR_HUMAN");
    expect(stopped.humanGates.at(-1)!.kind).toBe("knowledge_changed");
    expect(() => h.store.update(run.runId, (r) => { r.knowledge = { name: "company-a", path: companyA }; })).toThrow(/cannot change during a run/);
  });

  it("no cross-Knowledge leakage: two runs of a same-named module see only their own root", async () => {
    const a = create("timetable", "shared");
    const b = create("company-a", "shared");
    await h.service.tick();
    const promptA = h.commander.calls.find((c) => c.runId === a.runId)!;
    const promptB = h.commander.calls.find((c) => c.runId === b.runId)!;
    expect(promptA.cwd).toBe(timetable);
    expect(promptA.prompt).toContain("Knowledge root: timetable");
    expect(promptA.prompt).not.toContain("company-a");
    expect(promptB.prompt).not.toContain("timetable");
    const overlayA = JSON.parse(fs.readFileSync(runOverlayPath(a.runId, h.home), "utf8"));
    const overlayB = JSON.parse(fs.readFileSync(runOverlayPath(b.runId, h.home), "utf8"));
    expect(overlayA.knowledge.path).toBe(timetable);
    expect(overlayB.knowledge.path).toBe(companyA);
    expect(h.launcher.launches.find((l) => l.args.includes(a.runId) || l.logPath.includes(a.runId))!.cwd).toBe(timetable);
  });

  it("the machine root is enforced at run creation", () => {
    h.config.value = parseMachineConfig({ workspace: { allowed_roots: [path.join(base, "elsewhere")] } });
    fs.mkdirSync(path.join(base, "elsewhere"));
    expect(() => create()).toThrow(/outside the machine root/);
  });

  it("one open run per module; a fresh run after review is allowed", async () => {
    const run = await startAndFreeze(create());
    expect(() => create()).toThrow(/already has an open work run/);
    h.launcher.finish(h.home, run.runId, 0, "[bounded-run] COMPLETED\n");
    await h.service.tick();
    expect(() => create()).not.toThrow();
  });
});

describe("segment log parsing", () => {
  it("reads the bounded-run id, final verdict and live stage from the child's own log lines", async () => {
    const { parseBoundedRunId, parseOutcome, parseLiveProgress } = await import("./workRunService.js");
    const log = [
      "[bounded-run] froze run 20261003-abc: compiled 3 tasks",
      "[orchestrator] running backend-engineer...",
      "[orchestrator] task T-1 DEPLOYED.",
      "[orchestrator] running reviewer...",
      "[bounded-run] GATE: schema approval (run 20261003-abc status=AWAITING_HUMAN)",
    ].join("\n");
    expect(parseBoundedRunId(log)).toBe("20261003-abc");
    expect(parseBoundedRunId("[bounded-run] resuming run r-9: status=HALTED")).toBe("r-9");
    expect(parseOutcome(log)).toMatch(/^GATE: schema approval/);
    expect(parseLiveProgress(log)).toEqual({ stage: "reviewer", task: "T-1" });
  });
});

describe("one bounded run per Target", () => {
  const plan = (rows: Array<[string, string[], string[]]>, extra: Partial<PlanTask> = {}) =>
    rows.map(([id, targets, dependsOn], index) => ({ id, targets, dependsOn, phase: 1, ...extra, order: index }) as unknown as PlanTask);

  it("groups tasks by Target and orders a group after the groups it depends on", () => {
    const groups = groupTasksByTarget(plan([
      ["FE-1", ["web"], ["BE-1"]],
      ["BE-1", ["api"], []],
      ["BE-2", ["api"], []],
      ["FE-2", ["web"], []],
    ]), { kind: "all" });
    expect(groups.map((group) => [group.key, group.taskIds])).toEqual([["api", ["BE-1", "BE-2"]], ["web", ["FE-1", "FE-2"]]]);
  });

  it("respects the run scope and keeps a multi-Target task in its own group", () => {
    const groups = groupTasksByTarget(plan([
      ["BE-1", ["api"], []],
      ["X-1", ["web", "api"], []],
      ["BE-9", ["api"], []],
    ]), { kind: "tasks", taskIds: ["BE-1", "X-1"] });
    expect(groups.map((group) => group.key)).toEqual(["api", "api+web"]);
  });
});

describe("STA Core work runs across two Targets", () => {
  let base: string;
  let h: Harness;
  let knowledgePath: string;
  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sta-targets-")));
    knowledgePath = path.join(base, "schoolbright-knowledge");
    fs.mkdirSync(knowledgePath);
    h = makeHarness(base);
    h.knowledge.set("schoolbright", knowledgePath);
    h.modules.set(knowledgePath, ["timetableai"]);
    h.config.value = parseMachineConfig({ workspace: { allowed_roots: [base] }, commander: { enabled: false } });
    h.groups.value = [
      { key: "sb-api", targetIds: ["sb-api"], taskIds: ["BE-008", "BE-009"] },
      { key: "sb-web", targetIds: ["sb-web"], taskIds: ["FE-019", "FE-020"] },
    ];
  });
  afterEach(() => {
    h.db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const create = () => h.service.create({ knowledge: "schoolbright", module: "timetableai", commandText: "ทำงาน", intent: intent("schoolbright", "timetableai"), intentSource: "cli", overrides: [] });
  const finishWith = async (runId: string, boundedRunId: string, exitCode: number, verdict: string) => {
    fs.appendFileSync(h.launcher.launches.at(-1)!.logPath, `[bounded-run] froze run ${boundedRunId}: x
[bounded-run] ${verdict}
`);
    h.launcher.finish(h.home, runId, exitCode, "");
    await h.service.tick();
  };

  it("never asks for --target-root: it runs one bounded run per Target, backend first, then stops for review", async () => {
    const run = create();
    await h.service.tick();
    expect(h.launcher.launches[0]!.args).toEqual(expect.arrayContaining(["--task", "BE-008,BE-009", "--target-id", "sb-api"]));
    expect(h.launcher.launches[0]!.args).not.toContain("--target-root");
    expect(h.launcher.launches[0]!.args).not.toContain("--all");
    await finishWith(run.runId, "run-api", 0, "COMPLETED: done");
    expect(h.store.get(run.runId)!.status).toBe("QUEUED");
    await h.service.tick();
    expect(h.launcher.launches[1]!.args).toEqual(expect.arrayContaining(["--task", "FE-019,FE-020", "--target-id", "sb-web"]));
    await finishWith(run.runId, "run-web", 0, "COMPLETED: done");
    const done = h.store.get(run.runId)!;
    expect(done.status).toBe("READY_FOR_REVIEW");
    expect(done.targetRuns!.map((group) => [group.key, group.boundedRunId, group.state])).toEqual([["sb-api", "run-api", "done"], ["sb-web", "run-web", "done"]]);
  });

  it("a Target parked at a human gate does not hold the other Target back; resume picks the parked one up", async () => {
    const run = create();
    await h.service.tick();
    await finishWith(run.runId, "run-api", 4, "GATE: breaking-contract approval");
    await h.service.tick();
    await finishWith(run.runId, "run-web", 0, "COMPLETED: done");
    let stored = h.store.get(run.runId)!;
    expect(stored.status).toBe("WAITING_FOR_HUMAN");
    expect(stored.statusReason).toMatch(/sb-api/);
    h.service.resume(run.runId);
    expect(h.tasks.unpaused).toEqual(expect.arrayContaining(["run-api", "run-web"]));
    await h.service.tick();
    expect(h.launcher.launches.at(-1)!.args.slice(0, 3)).toEqual(["bounded-run", "--resume", "run-api"]);
    await finishWith(run.runId, "run-api", 0, "COMPLETED: done");
    stored = h.store.get(run.runId)!;
    expect(stored.status).toBe("READY_FOR_REVIEW");
  });

  it("a multi-Target group names its git-identity root itself", async () => {
    h.groups.value = [{ key: "sb-api+sb-web", targetIds: ["sb-api", "sb-web"], taskIds: ["X-1"] }];
    create();
    await h.service.tick();
    expect(h.launcher.launches[0]!.args).toEqual(expect.arrayContaining(["--target-id", "sb-api", "--target-id", "sb-web", "--target-root", "C:/src/sb-api"]));
  });

  it("pause reaches every Target's bounded run", async () => {
    const run = create();
    await h.service.tick();
    await finishWith(run.runId, "run-api", 0, "COMPLETED: done");
    await h.service.tick();
    fs.appendFileSync(h.launcher.launches.at(-1)!.logPath, "[bounded-run] froze run run-web: x\n");
    await h.service.tick();
    h.service.pause(run.runId);
    expect(h.tasks.paused).toEqual(expect.arrayContaining(["run-api", "run-web"]));
  });
});
