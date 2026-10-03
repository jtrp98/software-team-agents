import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isFallbackClass } from "../runtime/runtimeFailureClass.js";
import type { CoreRouteOverlay } from "../runtime/coreRouteOverlay.js";
import { corePaths, runLogPath, runOverlayPath } from "./corePaths.js";
import { admitCommanderDecision, runCommander, type CommanderInvoker, type CommanderPhase } from "./commander.js";
import type { BoundedRunProjection, ChangedFile } from "./engineProjection.js";
import { t } from "./i18n.js";
import type { IntentResult } from "./intent.js";
import { assertInsideMachineRoots, type MachineConfig } from "./machineConfig.js";
import type { SegmentLauncher } from "./processes.js";
import type { RuntimeConnectStatus } from "./runtimeConnect.js";
import { knownUnavailable } from "./runtimeConnect.js";
import type { RuntimeHealthStore } from "./runtimeHealth.js";
import { overlayOrderFor, selectRuntime, type RouteDecision, type RouteInputs } from "./runtimeRouter.js";
import type { TargetGroup } from "./targetGroups.js";
import {
  ACTIVE_STATUSES,
  newRunId,
  type TargetRun,
  type FallbackEntry,
  type Handoff,
  type HumanGate,
  type RuntimeHistoryEntry,
  type WorkRun,
  type WorkRunStatus,
  type WorkRunStore,
  type WorkerRole,
} from "./workRunStore.js";

/**
 * STA Core's work-run controller — deterministic, non-LLM, and the one
 * implementation behind both `sta work` and the STA Platform backend.
 *
 * A work run is driven as a sequence of bounded-run SEGMENTS. Each segment is
 * the existing `sta bounded-run` (start, or `--resume` of the same frozen run)
 * launched as a detached child with a `--core-run` overlay: the per-role
 * runtime order, the shared runtime health, and the pinned Knowledge root.
 * Between segments the Core decides — from deterministic facts (exit code,
 * engine projection, runtime health) — whether the run is ready for review,
 * waiting for a person, paused because every runtime is unavailable, or should
 * simply continue. The Commander role is consulted at start and after each
 * segment, as advice the Core may refuse.
 *
 * `tick()` is the whole control loop: idempotent, safe to call from a timer,
 * and safe after a restart, because everything it needs is in `core.db` and in
 * files the segments write (log + exit record).
 */

export interface TaskControl {
  /** Sets the engine's own pause flag on every unfinished task of a bounded run (graceful: the running stage finishes first). */
  pause(knowledgePath: string, boundedRunId: string): string[];
  unpause(knowledgePath: string, boundedRunId: string): string[];
}

export interface WorkRunServiceDeps {
  store: WorkRunStore;
  health: RuntimeHealthStore;
  machine: () => MachineConfig;
  launcher: SegmentLauncher;
  commander: CommanderInvoker;
  /** Latest Runtime Connect detection (cached), or null when none has run yet. */
  runtimeStatus: () => readonly RuntimeConnectStatus[] | null;
  project: (knowledgePath: string, boundedRunId: string) => BoundedRunProjection | null;
  changedFiles: (projection: BoundedRunProjection) => Promise<ChangedFile[]>;
  tasks: TaskControl;
  resolveKnowledge: (name: string) => { name: string; path: string };
  listModules: (knowledgePath: string) => string[];
  listTargets: (knowledgePath: string) => string[];
  /** The module's in-scope tasks grouped by Target, in dependency order (`core/targetGroups.ts`). */
  targetGroups: (knowledgePath: string, module: string, scope: WorkRun["scope"]) => TargetGroup[];
  /** A Target's local checkout path in this Knowledge root, for a group that spans several Targets. */
  targetPath: (knowledgePath: string, targetId: string) => string | null;
  healthDbPath: string;
  home?: string;
  clock?: () => number;
  /** Test seam only; production uses the declared security record. */
  eligibility?: RouteInputs["eligibility"];
}

export interface CreateRunRequest {
  /** The Knowledge root the user selected. Binding. */
  knowledge: string;
  module: string;
  commandText: string;
  intent: IntentResult["intent"];
  intentSource: WorkRun["intentSource"];
  overrides: string[];
  autonomy?: "edit" | "full";
}

export class WorkRunError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const WORKER_ROLES: readonly WorkerRole[] = ["engineer", "reviewer", "qa"];

/** Maps an engine role name (as runtime events record it) to the Core route role. */
export function routeRoleOf(role: string | null): WorkerRole | "commander" | null {
  if (!role) return null;
  if (role === "commander") return "commander";
  if (role === "qa-engineer" || role === "qa") return "qa";
  if (role === "reviewer" || role === "security") return "reviewer";
  if (/engineer$/.test(role)) return "engineer";
  return null;
}

const UNAVAILABLE_SIGNAL = /is unavailable: |routing\.order is exhausted|no runtime route resolved|STA Core runtime health/;

export class WorkRunService {
  private readonly clock: () => number;
  private readonly busy = new Set<string>();
  private readonly lastSnapshotAt = new Map<string, number>();

  constructor(private readonly deps: WorkRunServiceDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  private get language() {
    return this.deps.machine().language;
  }

  // ───────────────────────────── creation ─────────────────────────────

  create(request: CreateRunRequest): WorkRun {
    if (request.intent.action !== "work") throw new WorkRunError(`intent action "${request.intent.action}" is not a work request`);
    if (request.intent.knowledge_root !== request.knowledge) {
      throw new WorkRunError(`Knowledge mismatch: selected "${request.knowledge}", intent "${request.intent.knowledge_root}"`);
    }
    if (request.intent.allow_push || request.intent.allow_merge || request.intent.allow_deploy) {
      throw new WorkRunError("push/merge/deploy are human-only and cannot be part of a work run");
    }
    let knowledge: { name: string; path: string };
    try {
      knowledge = this.deps.resolveKnowledge(request.knowledge);
    } catch (error) {
      throw new WorkRunError(error instanceof Error ? error.message : String(error));
    }
    const machine = this.deps.machine();
    try {
      assertInsideMachineRoots(machine, knowledge.path, "Knowledge root");
    } catch (error) {
      throw new WorkRunError(error instanceof Error ? error.message : String(error), 403);
    }
    if (!this.deps.listModules(knowledge.path).includes(request.module)) {
      throw new WorkRunError(`module "${request.module}" does not exist in Knowledge "${knowledge.name}"`);
    }
    const open = this.deps.store.latestOpen(knowledge.name, request.module);
    if (open && open.status !== "READY_FOR_REVIEW") {
      throw new WorkRunError(`module ${request.module} already has an open work run ${open.runId} (${open.status}) — pause/resume/stop it instead`, 409);
    }
    const now = this.clock();
    const intent = request.intent;
    const run: WorkRun = {
      runId: newRunId(now),
      knowledge: { name: knowledge.name, path: knowledge.path },
      module: request.module,
      targets: this.deps.listTargets(knowledge.path),
      commandText: request.commandText,
      intent,
      intentSource: request.intentSource,
      intentOverrides: request.overrides,
      boundary: intent.completion_target === "next_gate" ? "next-gate" : "done",
      scope: intent.scope === "phase" && intent.phase !== undefined
        ? { kind: "phase", phase: intent.phase }
        : intent.scope === "tasks" && intent.tasks?.length
          ? { kind: "tasks", taskIds: intent.tasks }
          : { kind: "all" },
      autonomy: request.autonomy ?? machine.runtime.default_autonomy,
      status: "QUEUED",
      statusReason: null,
      boundedRunId: null,
      segments: [],
      commander: { current: null, notes: [] },
      workers: { engineer: null, reviewer: null, qa: null },
      runtimeHistory: [],
      fallbacks: [],
      handoffs: [],
      humanGates: [],
      snapshot: null,
      pauseRequested: false,
      stopRequested: false,
      autoResumeAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      push: false,
      merge: false,
      deploy: false,
    };
    this.deps.store.create(run);
    this.deps.store.appendEvent(run.runId, "created", `work run created for ${knowledge.name}/${request.module}`, { intent, source: request.intentSource });
    return run;
  }

  // ───────────────────────────── controls ─────────────────────────────

  pause(runId: string): WorkRun {
    const run = this.require(runId);
    if (run.status === "QUEUED" || run.status === "PAUSED_RUNTIME_EXHAUSTED" || run.status === "WAITING_FOR_HUMAN") {
      return this.setStatus(runId, "PAUSED", "paused by a person", { pauseRequested: false, autoResumeAt: null });
    }
    if (run.status !== "RUNNING") throw new WorkRunError(`cannot pause a run in status ${run.status}`, 409);
    for (const id of boundedRunIds(run)) this.deps.tasks.pause(run.knowledge.path, id);
    this.deps.store.appendEvent(runId, "pause", "pause requested — the current stage finishes first");
    return this.deps.store.update(runId, (r) => { r.pauseRequested = true; r.status = "PAUSING"; r.statusReason = "pause requested"; });
  }

  resume(runId: string, options: { by?: string; note?: string } = {}): WorkRun {
    const run = this.require(runId);
    if (!(["PAUSED", "PAUSED_RUNTIME_EXHAUSTED", "WAITING_FOR_HUMAN", "STOPPED"] as WorkRunStatus[]).includes(run.status)) {
      throw new WorkRunError(`cannot resume a run in status ${run.status}`, 409);
    }
    for (const id of boundedRunIds(run)) this.deps.tasks.unpause(run.knowledge.path, id);
    const now = this.clock();
    const by = options.by ? ` by ${options.by}` : "";
    const note = options.note ? `: ${options.note}` : "";
    this.deps.store.appendEvent(runId, "resume", `resume requested${by}${note}`, { by: options.by ?? null, note: options.note ?? null });
    return this.deps.store.update(runId, (r) => {
      // A Target group that stopped for a person runs again (its own frozen bounded run resumes).
      for (const group of r.targetRuns ?? []) if (group.state === "waiting" || group.state === "halted") { group.state = "running"; group.reason = null; }
      r.pauseRequested = false;
      r.stopRequested = false;
      r.autoResumeAt = null;
      for (const gate of r.humanGates) if (gate.resolvedAt === null && gate.kind !== "review") gate.resolvedAt = now;
      r.status = "QUEUED";
      r.statusReason = options.note ? `resumed: ${options.note}` : "resumed";
    });
  }

  /** Graceful stop: the engine pauses every task, the running stage finishes, nothing is cancelled or deleted. `force` kills the segment process. */
  stop(runId: string, options: { force?: boolean } = {}): WorkRun {
    const run = this.require(runId);
    if (run.status === "STOPPED") return run;
    for (const id of boundedRunIds(run)) this.deps.tasks.pause(run.knowledge.path, id);
    const segment = run.segments.at(-1);
    const running = segment && segment.endedAt === null && segment.pid !== null && this.deps.launcher.isAlive(segment.pid);
    if (running && options.force) {
      this.deps.launcher.kill(segment!.pid!);
      this.deps.store.appendEvent(runId, "stop", "force stop: the segment process was terminated; a partial diff may need a person");
    }
    if (running && !options.force) {
      this.deps.store.appendEvent(runId, "stop", "stop requested — the current stage finishes first");
      return this.deps.store.update(runId, (r) => { r.stopRequested = true; r.status = "STOPPING"; r.statusReason = "stop requested"; });
    }
    return this.setStatus(runId, "STOPPED", options.force ? "force-stopped by a person" : "stopped by a person", { stopRequested: false, autoResumeAt: null });
  }

  /** A person's approval — either review approval when READY_FOR_REVIEW, or human-gate approval when WAITING_FOR_HUMAN. */
  approve(runId: string, by: string, note?: string): WorkRun {
    const run = this.require(runId);
    if (run.status === "READY_FOR_REVIEW") {
      const now = this.clock();
      this.deps.store.appendEvent(runId, "approve", `approved by ${by}`, { by, note: note ?? null });
      return this.deps.store.update(runId, (r) => {
        for (const gate of r.humanGates) if (gate.kind === "review" && gate.resolvedAt === null) gate.resolvedAt = now;
        r.status = "APPROVED";
        r.statusReason = `approved by ${by}${note ? `: ${note}` : ""} — push/merge/deploy remain a person's own action`;
        r.completedAt = now;
      });
    }
    if (run.status === "WAITING_FOR_HUMAN") {
      const now = this.clock();
      this.deps.store.appendEvent(runId, "gate_approved", `gate approved by ${by}${note ? `: ${note}` : ""}`, { by, note: note ?? null });
      return this.resume(runId, { by, note });
    }
    throw new WorkRunError(`cannot approve a run in status ${run.status}`, 409);
  }

  /** A person sends the work back; it waits until they amend the plan/requirements and resume. */
  sendBack(runId: string, by: string, note: string): WorkRun {
    const run = this.require(runId);
    if (run.status !== "READY_FOR_REVIEW") throw new WorkRunError(`only a run that is ready for review can be sent back (status ${run.status})`, 409);
    this.deps.store.appendEvent(runId, "send_back", `sent back by ${by}`, { by, note });
    return this.deps.store.update(runId, (r) => {
      r.humanGates.push(this.gate("review", `sent back by ${by}: ${note}`));
      r.status = "WAITING_FOR_HUMAN";
      r.statusReason = `sent back: ${note}`;
    });
  }

  // ───────────────────────────── control loop ─────────────────────────────

  /** One pass over every run that may need the Core. Never throws; a failing run is recorded and the loop moves on. */
  async tick(): Promise<void> {
    const runs = this.deps.store.list().filter((run) => ACTIVE_STATUSES.has(run.status) || run.status === "PAUSED_RUNTIME_EXHAUSTED");
    await Promise.all(runs.map((run) => this.step(run.runId)));
  }

  async step(runId: string): Promise<void> {
    if (this.busy.has(runId)) return;
    this.busy.add(runId);
    try {
      await this.stepUnguarded(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.appendEvent(runId, "error", `STA Core error: ${message}`);
      try {
        this.setStatus(runId, "WAITING_FOR_HUMAN", `STA Core error: ${message}`);
      } catch { /* the run vanished */ }
    } finally {
      this.busy.delete(runId);
    }
  }

  private async stepUnguarded(runId: string): Promise<void> {
    const run = this.require(runId);
    const segment = run.segments.at(-1);
    const segmentOpen = segment !== undefined && segment.endedAt === null;

    if (segmentOpen) {
      await this.watchSegment(run);
      return;
    }
    if (run.status === "STOPPING") { this.setStatus(runId, "STOPPED", "stopped by a person"); return; }
    if (run.status === "PAUSING") { this.setStatus(runId, "PAUSED", "paused by a person"); return; }
    if (run.status === "PAUSED_RUNTIME_EXHAUSTED") {
      const machine = this.deps.machine();
      if (!machine.work.auto_resume_after_cooldown || run.autoResumeAt === null || run.autoResumeAt > this.clock()) return;
      this.deps.store.appendEvent(runId, "auto_resume", "a runtime cooldown lapsed — re-checking the pool");
      this.deps.store.update(runId, (r) => { r.status = "QUEUED"; r.statusReason = "auto-resume after cooldown"; r.autoResumeAt = null; });
    }
    const current = this.require(runId);
    if (current.status === "QUEUED" || current.status === "RUNNING") await this.launchNext(current);
  }

  private async launchNext(run: WorkRun): Promise<void> {
    const machine = this.deps.machine();
    if (run.segments.length >= machine.work.max_segments) {
      this.openGate(run.runId, "segment_budget", t(this.language, "gate.segment_budget", { max: machine.work.max_segments }));
      return;
    }
    // Knowledge pin: the registration must still name the same canonical path.
    let resolved: { name: string; path: string };
    try {
      resolved = this.deps.resolveKnowledge(run.knowledge.name);
    } catch {
      this.openGate(run.runId, "knowledge_changed", t(this.language, "gate.knowledge_changed", { name: run.knowledge.name }));
      return;
    }
    if (canonical(resolved.path) !== canonical(run.knowledge.path)) {
      this.openGate(run.runId, "knowledge_changed", t(this.language, "gate.knowledge_changed", { name: run.knowledge.name }));
      return;
    }
    assertInsideMachineRoots(machine, run.knowledge.path, "Knowledge root");

    const unavailable = knownUnavailable(this.deps.runtimeStatus() ?? []);

    // Commander, start phase: once per run.
    if (machine.commander.enabled && !run.commander.notes.some((note) => note.phase === "start")) {
      const proceed = await this.consultCommander(run.runId, "start", null, unavailable);
      if (!proceed) return;
    }

    // Worker pool pre-dispatch check: never launch into a pool that cannot serve.
    const decisions = WORKER_ROLES.map((role) => selectRuntime(role, { config: machine, health: this.deps.health.snapshot(overlayOrderFor(machine, role)), extraUnavailable: unavailable, eligibility: this.deps.eligibility }));
    const blocked = decisions.find((decision) => decision.exhausted);
    if (blocked) {
      this.recordRoute(run.runId, blocked);
      if (blocked.recoverable) this.pauseExhausted(run.runId, blocked.role, blocked.recoverAt);
      else this.openGate(run.runId, "security_runtime", t(this.language, "gate.security_no_runtime", { role: blocked.role }));
      return;
    }

    run = this.ensureTargetRuns(run);
    const group = run.targetRuns!.find((item) => item.state === "running") ?? run.targetRuns!.find((item) => item.state === "pending");
    if (!group) {
      await this.finalize(run.runId, null, unavailable);
      return;
    }
    const kind: "start" | "resume" = group.boundedRunId ? "resume" : "start";
    const index = run.segments.length + 1;
    const overlay: CoreRouteOverlay = {
      schema_version: 1,
      run_id: run.runId,
      knowledge: { ...run.knowledge },
      module: run.module,
      role_orders: { engineer: overlayOrderFor(machine, "engineer"), reviewer: overlayOrderFor(machine, "reviewer"), qa: overlayOrderFor(machine, "qa") },
      unavailable,
      segment: index,
      health_db: this.deps.healthDbPath,
      health_policy: machine.health,
    };
    const overlayFile = runOverlayPath(run.runId, this.deps.home);
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.writeFileSync(overlayFile, JSON.stringify(overlay, null, 2), "utf8");
    const gitIdentityRoot = group.targetIds.length > 1 ? this.deps.targetPath(run.knowledge.path, group.targetIds[0]!) : null;
    const args = kind === "start"
      ? ["bounded-run", "--module", run.module,
        ...(group.taskIds.length > 0 ? ["--task", group.taskIds.join(",")] : scopeArgs(run.scope)),
        ...group.targetIds.flatMap((targetId) => ["--target-id", targetId]),
        ...(gitIdentityRoot ? ["--target-root", gitIdentityRoot] : []),
        "--until", run.boundary, "--autonomy", run.autonomy,
        "--root", run.knowledge.name, "--project-root", run.knowledge.path, "--core-run", overlayFile]
      : ["bounded-run", "--resume", group.boundedRunId!, "--module", run.module, "--autonomy", run.autonomy,
        "--root", run.knowledge.name, "--project-root", run.knowledge.path, "--core-run", overlayFile];
    const logPath = runLogPath(run.runId, index, this.deps.home);
    const { pid } = this.deps.launcher.launch({ args, cwd: run.knowledge.path, logPath });
    const now = this.clock();
    this.deps.store.appendEvent(run.runId, "segment_start", `segment ${index} (${kind}) started, pid ${pid}`, { args });
    this.deps.store.update(run.runId, (r) => {
      const current = r.targetRuns!.find((item) => item.key === group.key)!;
      current.state = "running";
      r.boundedRunId = current.boundedRunId;
      r.status = "RUNNING";
      r.statusReason = `segment ${index} (${kind})${group.targetIds.length ? ` · Target ${group.targetIds.join(" + ")}` : ""}`;
      r.segments.push({ index, kind, startedAt: now, endedAt: null, pid, exitCode: null, outcome: null, logPath });
      for (const decision of decisions) {
        if (decision.selected) {
          r.workers[decision.role as WorkerRole] = decision.selected;
          r.runtimeHistory.push({ at: now, role: decision.role, runtimeId: decision.selected, event: "selected", detail: decision.attempts.filter((a) => a.outcome === "skipped").map((a) => `${a.runtimeId}: ${a.reason}`).join(" | ") || null });
        }
      }
    });
  }

  private async watchSegment(run: WorkRun): Promise<void> {
    const segment = run.segments.at(-1)!;
    const log = readTail(segment.logPath);
    const boundedRunId = run.boundedRunId ?? parseBoundedRunId(log);
    if (boundedRunId && !run.boundedRunId) {
      this.deps.store.update(run.runId, (r) => {
        r.boundedRunId = boundedRunId;
        const current = r.targetRuns?.find((item) => item.state === "running");
        if (current && !current.boundedRunId) current.boundedRunId = boundedRunId;
      });
      // A pause/stop asked before the run id was known applies now.
      if (run.pauseRequested || run.stopRequested) this.deps.tasks.pause(run.knowledge.path, boundedRunId);
    }
    const exitFile = path.join(path.dirname(runOverlayPath(run.runId, this.deps.home)), `segment-${segment.index}.exit.json`);
    let exitCode: number | null = null;
    if (fs.existsSync(exitFile)) {
      try {
        const record = JSON.parse(fs.readFileSync(exitFile, "utf8")) as { segment: number; exitCode: number };
        if (record.segment === segment.index) exitCode = record.exitCode;
      } catch { /* a half-written record is read again next tick */ }
    }
    const alive = segment.pid !== null && this.deps.launcher.isAlive(segment.pid);
    if (exitCode === null && alive) {
      // Live stage from the segment's own log every tick; the engine
      // projection (WAL state.db — the store is built for concurrent readers
      // like `sta status`) at most every 15 s.
      const live = parseLiveProgress(log);
      if (live.stage && live.stage !== (run.snapshot as { currentStage?: string } | null)?.currentStage) {
        this.deps.store.update(run.runId, (r) => {
          r.snapshot = { ...(r.snapshot ?? {}), currentStage: live.stage, ...(live.task ? { currentTask: live.task } : {}), live: true };
        });
      }
      await this.refreshSnapshot(run.runId, false);
      return;
    }
    if (exitCode === null && !alive) {
      // Exit records are written in a finally; none means the process was killed.
      await this.finishSegment(run.runId, null, log);
      return;
    }
    await this.finishSegment(run.runId, exitCode, log);
  }

  private async finishSegment(runId: string, exitCode: number | null, log: string): Promise<void> {
    const now = this.clock();
    const outcome = parseOutcome(log);
    let run = this.deps.store.update(runId, (r) => {
      const segment = r.segments.at(-1)!;
      segment.endedAt = now;
      segment.exitCode = exitCode;
      segment.outcome = outcome;
      if (!r.boundedRunId) r.boundedRunId = parseBoundedRunId(log);
      const current = r.targetRuns?.find((item) => item.state === "running");
      if (current && !current.boundedRunId) current.boundedRunId = r.boundedRunId;
    });
    this.deps.store.appendEvent(runId, "segment_end", `segment ${run.segments.at(-1)!.index} ended: exit ${exitCode ?? "none (interrupted)"}${outcome ? ` — ${outcome}` : ""}`);
    this.syncRuntimeHistory(runId);
    const projection = await this.refreshSnapshot(runId, true);
    run = this.require(runId);

    if (run.stopRequested || run.status === "STOPPING") { this.setStatus(runId, "STOPPED", "stopped by a person", { stopRequested: false }); return; }
    if (run.pauseRequested || run.status === "PAUSING") { this.setStatus(runId, "PAUSED", "paused by a person", { pauseRequested: false }); return; }

    const machine = this.deps.machine();
    const unavailable = knownUnavailable(this.deps.runtimeStatus() ?? []);
    if (exitCode !== 0 && UNAVAILABLE_SIGNAL.test(log.slice(-20_000))) {
      const decisions = WORKER_ROLES.map((role) => selectRuntime(role, { config: machine, health: this.deps.health.snapshot(overlayOrderFor(machine, role)), extraUnavailable: unavailable, eligibility: this.deps.eligibility }));
      const blocked = decisions.find((decision) => decision.exhausted);
      if (blocked) {
        this.recordRoute(runId, blocked);
        if (blocked.recoverable) this.pauseExhausted(runId, blocked.role, blocked.recoverAt);
        else this.openGate(runId, "security_runtime", t(this.language, "gate.security_no_runtime", { role: blocked.role }));
        return;
      }
      // Another runtime is usable again: continue on it (the resume re-routes).
      this.deps.store.appendEvent(runId, "continue", "the stage ran out of runtimes but the pool has recovered — resuming on the next usable runtime");
      this.setStatus(runId, "QUEUED", "continuing after a runtime switch");
      return;
    }

    if (exitCode === null) {
      const interrupted = run.segments.slice(-2).filter((s) => s.exitCode === null).length;
      if (interrupted >= 2) { this.openGate(runId, "interrupted", t(this.language, "gate.interrupted")); return; }
      this.deps.store.appendEvent(runId, "interrupted", "the segment process ended without an exit record — resuming once");
      this.setStatus(runId, "QUEUED", "resuming an interrupted segment");
      return;
    }

    const awaiting = awaitingLines(log);
    const label = (group: TargetRun | undefined) => group && group.targetIds.length ? `Target ${group.targetIds.join(" + ")}: ` : "";
    if (exitCode === 0 || exitCode === 4) {
      // This Target group is settled for now: done, or parked at a gate a
      // person answers. Independent groups carry on; the run ends — ready for
      // review or waiting for a person — once no group is left to drive.
      const reason = exitCode === 0 ? (outcome ?? "completed") : (awaiting || outcome || "see run log");
      let settled: TargetRun | undefined;
      const updated = this.deps.store.update(runId, (r) => {
        settled = r.targetRuns?.find((item) => item.state === "running");
        if (settled) { settled.state = exitCode === 0 ? "done" : "waiting"; settled.reason = reason; }
        if (exitCode === 4) r.humanGates.push(this.gate("engine_waiting", `${label(settled)}${t(this.language, "gate.engine_waiting", { reason })}`));
      });
      const next = updated.targetRuns?.find((item) => item.state === "pending");
      if (next) {
        this.deps.store.appendEvent(runId, "target_next", `${label(settled)}${exitCode === 0 ? "done" : "waiting for a person"} — continuing with Target ${next.targetIds.join(" + ") || "(none)"}`);
        this.setStatus(runId, "QUEUED", `${label(settled)}${exitCode === 0 ? "done" : "waiting for a person"}; next: Target ${next.targetIds.join(" + ") || "(none)"}`);
        return;
      }
      await this.finalize(runId, projection, unavailable);
      return;
    }
    this.deps.store.update(runId, (r) => {
      const current = r.targetRuns?.find((item) => item.state === "running");
      if (current) { current.state = "halted"; current.reason = outcome || lastLines(log); }
    });
    const group = this.require(runId).targetRuns?.find((item) => item.state === "halted");
    if (exitCode === 1) { this.openGate(runId, "engine_halted", `${label(group)}${t(this.language, "gate.engine_halted", { reason: outcome || lastLines(log) })}`); return; }
    if (exitCode === 2 || exitCode === 64) { this.openGate(runId, "engine_refused", `${label(group)}${t(this.language, "gate.engine_refused", { reason: lastLines(log) })}`); return; }
    this.setStatus(runId, "FAILED", `segment exited ${exitCode}: ${lastLines(log)}`);
  }

  /** Every Target group is settled: ask the Commander once, then stop for a person. */
  private async finalize(runId: string, projection: BoundedRunProjection | null, unavailable: Record<string, string>): Promise<void> {
    const run = this.require(runId);
    const groups = run.targetRuns ?? [];
    const waiting = groups.filter((group) => group.state === "waiting");
    if (this.deps.machine().commander.enabled) {
      await this.consultCommander(runId, "assess", projection, unavailable, { boundaryReached: waiting.length === 0, engineWaiting: waiting.length > 0 });
    }
    if (waiting.length > 0) {
      const reason = waiting.map((group) => `Target ${group.targetIds.join(" + ") || "(none)"}: ${group.reason ?? "waiting"}`).join(" · ");
      this.deps.store.appendEvent(runId, "human_gate", reason, { kind: "engine_waiting" });
      this.deps.store.update(runId, (r) => { r.status = "WAITING_FOR_HUMAN"; r.statusReason = t(this.language, "gate.engine_waiting", { reason }); });
      return;
    }
    this.deps.store.update(runId, (r) => {
      r.humanGates.push(this.gate("review", "work reached the QA boundary — a person reviews before anything else happens"));
      r.status = "READY_FOR_REVIEW";
      r.statusReason = groups.length > 1 ? `every Target done (${groups.map((group) => group.targetIds.join(" + ") || "(none)").join(", ")})` : (groups[0]?.reason ?? "completed");
      r.completedAt = this.clock();
    });
  }

  /** Splits the run into Target groups on first launch; a run that started before the split keeps its one bounded run. */
  private ensureTargetRuns(run: WorkRun): WorkRun {
    if (run.targetRuns && run.targetRuns.length > 0) return run;
    let groups: TargetGroup[] = [];
    if (!run.boundedRunId) {
      try {
        groups = this.deps.targetGroups(run.knowledge.path, run.module, run.scope);
      } catch {
        groups = [];
      }
    }
    const targetRuns: TargetRun[] = groups.length > 0
      ? groups.map((group) => ({ key: group.key, targetIds: group.targetIds, taskIds: group.taskIds, boundedRunId: null, state: "pending", reason: null }))
      : [{ key: "", targetIds: [], taskIds: [], boundedRunId: run.boundedRunId, state: run.boundedRunId ? "running" : "pending", reason: null }];
    if (groups.length > 1) {
      this.deps.store.appendEvent(run.runId, "target_split", `split into ${groups.length} bounded runs by Target: ${groups.map((group) => `${group.targetIds.join(" + ") || "(none)"} [${group.taskIds.join(",")}]`).join(" → ")}`);
    }
    return this.deps.store.update(run.runId, (r) => { r.targetRuns = targetRuns; });
  }

  /** Commander turn with failover. Returns false when the run must not proceed now. */
  private async consultCommander(
    runId: string,
    phase: CommanderPhase,
    projection: BoundedRunProjection | null,
    unavailable: Record<string, string>,
    facts: { boundaryReached: boolean; engineWaiting: boolean } = { boundaryReached: false, engineWaiting: false },
  ): Promise<boolean> {
    const run = this.require(runId);
    const machine = this.deps.machine();
    const outcome = await runCommander({ run, phase, projection, config: machine, health: this.deps.health, invoker: this.deps.commander, extraUnavailable: unavailable, eligibility: this.deps.eligibility });
    const now = this.clock();
    const handoffs = outcome.fallbacks.map((fallback) => this.buildHandoff(run, projection, "commander", fallback.from, fallback.to, { class: fallback.failureClass, reason: fallback.reason }, phase === "start" ? "assess whether to start the run" : "assess the last segment"));
    this.deps.store.update(runId, (r) => {
      for (const fallback of outcome.fallbacks) {
        r.fallbacks.push({ at: now, role: "commander", from: fallback.from, to: fallback.to, failureClass: fallback.failureClass, reason: fallback.reason });
      }
      r.handoffs.push(...handoffs);
      for (const attempt of outcome.attempts) {
        r.runtimeHistory.push({
          at: now,
          role: "commander",
          runtimeId: attempt.runtimeId,
          event: attempt.outcome === "selected" ? "success" : attempt.outcome === "failed" ? "failure" : "skipped",
          failureClass: "failureClass" in attempt ? attempt.failureClass : null,
          detail: attempt.reason,
        });
      }
      if (outcome.runtimeId) r.commander.current = outcome.runtimeId;
    });
    if (outcome.exhausted) {
      if (outcome.recoverable) this.pauseExhausted(runId, "commander", outcome.recoverAt);
      else this.openGate(runId, "security_runtime", t(this.language, "gate.security_no_runtime", { role: "commander" }));
      return false;
    }
    const decision = outcome.decision;
    const admitted = decision ? admitCommanderDecision(decision, { phase, ...facts }) : { accepted: false, note: outcome.error ?? "no decision" };
    this.deps.store.update(runId, (r) => {
      r.commander.notes.push({
        at: now,
        runtimeId: outcome.runtimeId,
        phase,
        decision: decision?.decision ?? "none",
        summary: decision?.summary ?? outcome.error ?? "",
        accepted: admitted.accepted,
        ...(admitted.note ? { policyNote: admitted.note } : {}),
      });
    });
    if (decision?.decision === "hold_for_human" && admitted.accepted && phase === "start") {
      this.openGate(runId, "engine_waiting", `Commander (${outcome.runtimeId}) asked for a person before starting: ${decision.summary}`);
      return false;
    }
    return true;
  }

  // ───────────────────────────── projection / history ─────────────────────────────

  async refreshSnapshot(runId: string, force: boolean): Promise<BoundedRunProjection | null> {
    const run = this.require(runId);
    const ids = boundedRunIds(run);
    if (ids.length === 0) return null;
    const last = this.lastSnapshotAt.get(runId) ?? 0;
    if (!force && this.clock() - last < 15_000) return null;
    this.lastSnapshotAt.set(runId, this.clock());
    const projections: BoundedRunProjection[] = [];
    for (const id of ids) {
      try {
        const projection = this.deps.project(run.knowledge.path, id);
        if (projection) projections.push(projection);
      } catch {
        return null; // the engine holds the database right now; next tick reads it
      }
    }
    if (projections.length === 0) return null;
    const current = projections.find((projection) => projection.runId === run.boundedRunId) ?? projections.at(-1)!;
    const prefix = projections.length > 1;
    const changed: ChangedFile[] = [];
    for (const projection of projections) {
      try {
        for (const file of await this.deps.changedFiles(projection)) changed.push(prefix ? { ...file, path: `${projection.targetId}: ${file.path}` } : file);
      } catch { /* no branch yet */ }
    }
    const verification = projections.reduce((sum, projection) => ({
      reviewPassed: sum.reviewPassed + projection.verification.reviewPassed,
      qaPassed: sum.qaPassed + projection.verification.qaPassed,
      securityPassed: sum.securityPassed + projection.verification.securityPassed,
      checkpointed: sum.checkpointed + projection.verification.checkpointed,
      done: sum.done + projection.verification.done,
      total: sum.total + projection.verification.total,
    }), { reviewPassed: 0, qaPassed: 0, securityPassed: 0, checkpointed: 0, done: 0, total: 0 });
    this.deps.store.update(runId, (r) => {
      r.snapshot = {
        ...current,
        tasks: projections.flatMap((projection) => projection.tasks),
        verification,
        targets: projections.map((projection) => ({
          boundedRunId: projection.runId, status: projection.status, targetId: projection.targetId, targetRoot: projection.targetRoot,
          baseBranch: projection.baseBranch, baseSha: projection.baseSha, runBranch: projection.runBranch,
        })),
        changedFiles: changed,
        at: this.clock(),
      } as unknown as Record<string, unknown>;
    });
    return current;
  }

  /** Folds the children's health events for this run into runtime history, workers and fallbacks. */
  syncRuntimeHistory(runId: string): void {
    const run = this.require(runId);
    const events = this.deps.health.eventsForRun(runId).filter((event) => event.role !== "commander");
    const seen = new Set(run.runtimeHistory.map((entry) => `${entry.at}|${entry.runtimeId}|${entry.event}|${entry.role}`));
    const additions: RuntimeHistoryEntry[] = [];
    const fallbacks: FallbackEntry[] = [];
    const lastFailureByRole = new Map<string, { runtimeId: string; failureClass: string; reason: string; at: number }>();
    for (const event of events) {
      const role = routeRoleOf(event.role) ?? event.role ?? "worker";
      const kind = event.kind === "success" ? "success" : event.kind === "failure" ? "failure" : null;
      if (!kind) continue;
      const key = `${event.at}|${event.runtimeId}|${kind}|${role}`;
      const pending = lastFailureByRole.get(role);
      if (pending && pending.runtimeId !== event.runtimeId) {
        fallbacks.push({ at: event.at, role, from: pending.runtimeId, to: event.runtimeId, failureClass: pending.failureClass, reason: pending.reason });
        lastFailureByRole.delete(role);
      }
      if (kind === "failure" && event.failureClass && isFallbackClass(event.failureClass as never)) {
        lastFailureByRole.set(role, { runtimeId: event.runtimeId, failureClass: event.failureClass, reason: event.detail ?? "", at: event.at });
      }
      if (seen.has(key)) continue;
      additions.push({ at: event.at, role, runtimeId: event.runtimeId, event: kind, failureClass: event.failureClass, detail: event.detail });
    }
    if (additions.length === 0) return;
    const projection = run.boundedRunId ? safeProject(this.deps.project, run.knowledge.path, run.boundedRunId) : null;
    this.deps.store.update(runId, (r) => {
      r.runtimeHistory.push(...additions);
      const known = new Set(r.fallbacks.map((f) => `${f.at}|${f.role}|${f.from}|${f.to}`));
      for (const fallback of fallbacks) {
        const key = `${fallback.at}|${fallback.role}|${fallback.from}|${fallback.to}`;
        if (known.has(key)) continue;
        r.fallbacks.push(fallback);
        r.handoffs.push(this.buildHandoff(r, projection, fallback.role, fallback.from, fallback.to, { class: fallback.failureClass, reason: fallback.reason }, "continue the stage on the next runtime from the frozen execution packet"));
      }
      for (const addition of additions) {
        if (addition.event === "success" && (WORKER_ROLES as readonly string[]).includes(addition.role)) r.workers[addition.role as WorkerRole] = addition.runtimeId;
      }
    });
  }

  /** The structured handoff recorded at every runtime switch. Knowledge root is always present. */
  buildHandoff(
    run: Pick<WorkRun, "knowledge" | "module" | "snapshot">,
    projection: BoundedRunProjection | null,
    role: string,
    from: string | null,
    to: string | null,
    failure: { class: string; reason: string } | null,
    nextAction: string,
  ): Handoff {
    const snapshot = (projection ?? (run.snapshot as unknown as BoundedRunProjection | null)) ?? null;
    const changed = ((run.snapshot as { changedFiles?: ChangedFile[] } | null)?.changedFiles ?? []).map((file) => file.path);
    return {
      at: this.clock(),
      knowledge_root: run.knowledge.name,
      knowledge_path: run.knowledge.path,
      module: run.module,
      target: snapshot?.targetId ?? null,
      task: snapshot?.currentTask ?? null,
      stage: snapshot?.currentStage ?? null,
      role,
      previous_runtime: from,
      next_runtime: to,
      failure,
      completed: (snapshot?.tasks ?? []).filter((task) => task.status === "DONE" || task.status === "CHECKPOINTED").map((task) => `${task.taskId} (${task.status})`),
      files_changed: changed.slice(0, 200),
      verification: Object.fromEntries((snapshot?.tasks ?? []).map((task) => [task.taskId, task.status])),
      next_action: nextAction,
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private recordRoute(runId: string, decision: RouteDecision): void {
    const now = this.clock();
    this.deps.store.update(runId, (r) => {
      for (const attempt of decision.attempts) {
        r.runtimeHistory.push({ at: now, role: decision.role, runtimeId: attempt.runtimeId, event: attempt.outcome === "selected" ? "selected" : "skipped", detail: attempt.reason });
      }
    });
  }

  private pauseExhausted(runId: string, role: string, recoverAt: number | null): void {
    const when = recoverAt ? new Date(recoverAt).toISOString() : "when a person reconnects one";
    const reason = t(this.language, "gate.runtime_exhausted", { role, when });
    this.deps.store.appendEvent(runId, "runtime_exhausted", reason);
    this.deps.store.update(runId, (r) => {
      r.humanGates.push(this.gate("runtime_exhausted", reason));
      r.status = "PAUSED_RUNTIME_EXHAUSTED";
      r.statusReason = reason;
      r.autoResumeAt = recoverAt;
    });
  }

  private openGate(runId: string, kind: HumanGate["kind"], reason: string): void {
    this.deps.store.appendEvent(runId, "human_gate", reason, { kind });
    this.deps.store.update(runId, (r) => {
      r.humanGates.push(this.gate(kind, reason));
      r.status = "WAITING_FOR_HUMAN";
      r.statusReason = reason;
    });
  }

  private gate(kind: HumanGate["kind"], reason: string): HumanGate {
    return { id: `g-${randomBytes(4).toString("hex")}`, at: this.clock(), kind, reason, resolvedAt: null };
  }

  private setStatus(runId: string, status: WorkRunStatus, reason: string, patch: Partial<Pick<WorkRun, "pauseRequested" | "stopRequested" | "autoResumeAt">> = {}): WorkRun {
    this.deps.store.appendEvent(runId, "status", `${status}: ${reason}`);
    return this.deps.store.update(runId, (r) => {
      r.status = status;
      r.statusReason = reason;
      Object.assign(r, patch);
      if (status === "STOPPED" || status === "FAILED") r.completedAt = this.clock();
    });
  }

  private require(runId: string): WorkRun {
    const run = this.deps.store.get(runId);
    if (!run) throw new WorkRunError(`no such work run: ${runId}`, 404);
    return run;
  }
}

function canonical(p: string): string {
  let real = path.resolve(p);
  try { real = fs.realpathSync.native(real); } catch { /* compared as written */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function safeProject(project: WorkRunServiceDeps["project"], knowledgePath: string, boundedRunId: string): BoundedRunProjection | null {
  try { return project(knowledgePath, boundedRunId); } catch { return null; }
}

/** Every bounded run this work run drives (one per Target group), current first. */
export function boundedRunIds(run: Pick<WorkRun, "boundedRunId" | "targetRuns">): string[] {
  const ids = [run.boundedRunId, ...(run.targetRuns ?? []).map((group) => group.boundedRunId)].filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

export function scopeArgs(scope: WorkRun["scope"]): string[] {
  if (scope.kind === "phase") return ["--phase", String(scope.phase)];
  if (scope.kind === "tasks") return ["--task", scope.taskIds.join(",")];
  return ["--all"];
}

function readTail(file: string, bytes = 200_000): string {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(bytes, stat.size);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The stage/task the running segment last announced (`[orchestrator] running <stage>...`). */
export function parseLiveProgress(log: string): { stage: string | null; task: string | null } {
  const stages = [...log.matchAll(/^\[orchestrator\] running ([a-z-]+)\.\.\./gm)];
  const tasks = [...log.matchAll(/^\[orchestrator\] task (\S+) /gm)];
  return { stage: stages.at(-1)?.[1] ?? null, task: tasks.at(-1)?.[1] ?? null };
}

export function parseBoundedRunId(log: string): string | null {
  return /\[bounded-run\] froze run (\S+?):/.exec(log)?.[1] ?? /\[bounded-run\] resuming run (\S+?):/.exec(log)?.[1] ?? null;
}

export function parseOutcome(log: string): string | null {
  const lines = log.split(/\r?\n/).filter((line) => /^\[bounded-run\] (COMPLETED|GATE|HALTED|BOUNDARY|REFUSED|DONE|WAITING)\b/.test(line));
  return lines.at(-1)?.replace(/^\[bounded-run\] /, "") ?? null;
}

function awaitingLines(log: string): string {
  return log.split(/\r?\n/).filter((line) => /^\[bounded-run\]\s{2,}\S+: /.test(line) || /awaiting|waiting for|approve/i.test(line)).slice(-6).map((line) => line.replace(/^\[bounded-run\]\s*/, "")).join(" · ");
}

function lastLines(log: string, count = 4): string {
  return log.trim().split(/\r?\n/).slice(-count).join(" · ").slice(0, 1500);
}

export { corePaths };
