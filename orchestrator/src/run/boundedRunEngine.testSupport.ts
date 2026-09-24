/**
 * Test-only harness for a bounded run driven through the one task engine
 * (V13 TASK-007): a real SQLite task store + RunLedger, real `TaskRegistry`
 * plan tasks, the real `LedgerAttemptBoundary` and `GuardedRunSession`
 * against a real disposable Git repository — with only the route/packet
 * freeze and the agent itself replaced by deterministic fakes.
 *
 * Shared by the fault matrix, the real-SIGKILL child fixture and the bounded
 * run service tests so every one of them exercises one harness.
 *
 * It takes the calling suite's Git runner: a non-`.test.ts` module that
 * shelled out to Git would be production source to `checkGitOwnership`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { classifyTask, type ClassificationInput } from "../classification/taskClassifier.js";
import { GitCommandLayer, defaultGitProcessRunner } from "../git/commandLayer.js";
import type { SecretScanner } from "../git/checkpoint.js";
import { LEDGER_SCHEMA_VERSION, type LedgerAttempt, type LedgerRun, type LedgerTask, type RunLedger } from "../ledger/runLedger.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import type { StageEntryGuard } from "../orchestrator/stageGuards.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { withRequiredEvidence, PASSING_VERIFICATION } from "../evidence/stageEvidence.testSupport.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { createRunId } from "./journal.js";
import { LedgerAttemptBoundary, type FreezeOutcome, type FreezeRequest } from "./ledgerAttemptExecutor.js";
import { driveBoundedRun, type BoundedRunOutcome } from "../engine/boundedRunService.js";
import { boundedRunPolicy, type RunPolicy } from "../engine/runPolicy.js";

export type FixtureGit = (root: string, ...args: string[]) => string;

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);

/** The classification a backend-owned canonical plan task gets. */
export const PLAN_TASK: ClassificationInput = { isPlanTask: true, touchesBackend: true };
/** A plan task whose authored risk is a schema change: security pass + human approval before Done. */
export const SCHEMA_PLAN_TASK: ClassificationInput = { isPlanTask: true, touchesBackend: true, touchesSchema: true };

export interface EngineFixture {
  target: string;
  state: string;
  store: SqliteTaskStore;
  ledger: SqliteRunLedger;
  registry: TaskRegistry;
  run: LedgerRun;
  gitCalls: string[][];
  gitLayer(): GitCommandLayer;
  git: FixtureGit;
}

export function fixtureRepository(git: FixtureGit, roots: string[]): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v13-bounded-target-")));
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

export interface SeedTask {
  id: string;
  dependsOn?: string[];
  classification?: ClassificationInput;
}

/**
 * One frozen bounded run: ledger run + tasks, and the same tasks registered
 * in the engine as plan tasks (owner engineer -> reviewer -> QA [-> security]).
 */
export function seedEngineRun(
  git: FixtureGit,
  roots: string[],
  options: {
    boundary?: LedgerRun["boundary"];
    tasks?: SeedTask[];
    guard?: StageEntryGuard;
    knowledgeRoot?: string;
    target?: string;
    stateRoot?: string;
    runId?: string;
    module?: string;
    /** Attach to the run and tasks already persisted under `stateRoot` (a resumed process) instead of creating them. */
    reuse?: boolean;
  } = {},
): EngineFixture {
  const target = options.target ?? fixtureRepository(git, roots);
  const state = options.stateRoot ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v13-bounded-state-")));
  if (!options.stateRoot) roots.push(state);
  const store = new SqliteTaskStore(path.join(state, "state.db"));
  const ledger = new SqliteRunLedger(store, { projectRoot: state });
  const registry = new TaskRegistry({
    store,
    stageEntryGuard: options.guard ?? ALLOW_EVERY_STAGE_TEST_GUARD,
    humanDecisionVerifier: testHumanVerifier(),
  });
  const runId = options.runId ?? createRunId();
  const rows = options.tasks ?? [{ id: "BE-1" }];
  const run: LedgerRun = options.reuse ? ledger.readRun(runId)! : {
    ledger_version: LEDGER_SCHEMA_VERSION, run_id: runId, status: "REGISTERED", boundary: options.boundary ?? "done",
    module: options.module ?? "orders", target_id: "target", target_root: target, knowledge_root: options.knowledgeRoot ?? state,
    base_branch: "main", base_sha: git(target, "rev-parse", "HEAD"), run_branch: `sta/run/${options.module ?? "orders"}/${runId}`,
    requirement_hash: HASH_A, design_hash: HASH_B, plan_hash: HASH_C, config_hash: HASH_A,
    sta_version: "2.0.0", task_order: rows.map((row) => row.id), max_tasks: rows.length,
    created_at: 1_000, updated_at: 1_000, halt_reason: null,
  };
  const tasks: LedgerTask[] = rows.map((row, index) => ({
    run_id: runId, task_id: row.id, status: "PLANNED", owner: AgentStage.BACKEND_ENGINEER,
    phase: 1, depends_on: row.dependsOn ?? [], produces: [], consumes: [], task_hash: HASH_A,
    position: index, updated_at: 1_000,
  }));
  if (!options.reuse) {
    ledger.transaction(() => { ledger.createRun(run); ledger.registerTasks(tasks); });
    for (const row of rows) {
      const input = row.classification ?? PLAN_TASK;
      registry.create({ taskId: row.id, classification: classifyTask(input), classificationInput: input, dependsOn: row.dependsOn ?? [] });
    }
  }
  const gitCalls: string[][] = [];
  return {
    target, state, store, ledger, registry, run: ledger.readRun(runId)!, gitCalls, git,
    gitLayer: () => new GitCommandLayer({
      cwd: target,
      identity: { name: "Fixture", email: "fixture@example.invalid" },
      processRunner: (args, processOptions) => { gitCalls.push([...args]); return defaultGitProcessRunner(args, processOptions); },
    }),
  };
}

export function packetHash(taskId: string, attempt: number): string {
  return [...`${taskId}#${attempt}`]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

/** Freezes the next attempt of a task/stage exactly as the production freeze would record it (route and packet are fixtures). */
export function freezeFixtureAttempt(
  ledger: RunLedger,
  f: Pick<EngineFixture, "run" | "target" | "git">,
  taskId: string,
  stage: AgentStage = AgentStage.BACKEND_ENGINEER,
  overrides: Partial<LedgerAttempt> = {},
): LedgerAttempt {
  const number = ledger.attemptsForTask(f.run.run_id, taskId).length + 1;
  const frozen: LedgerAttempt = {
    attempt_id: `${f.run.run_id}:${taskId}:${stage}:${number}`, run_id: f.run.run_id, task_id: taskId,
    stage, attempt: number, status: "FROZEN",
    requested: { runtime: "claude-code", model: "opus", effort: "high" },
    observed: { runtime: "claude-code", model: "opus", effort: "high" },
    model_explicit: true, route_basis: "task-tier:T2", tier: "T2", adapter_version: "fixture@1",
    config_hash: HASH_A, plan_hash: f.run.plan_hash, base_revision: f.git(f.target, "rev-parse", "HEAD"),
    capability_evidence: [{ capability: "pre-tool-guard", verified: true, detail: null }],
    guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: [f.target] },
    packet_hash: packetHash(taskId, number), packet_path: `.workflow/packets/${taskId}/${number}.json`,
    started_at: 2_000 + number, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
  ledger.freezeAttempt(frozen);
  return frozen;
}

export function fixtureFreeze(
  ledger: RunLedger,
  f: Pick<EngineFixture, "run" | "target" | "git">,
  options: { allowedPathGlobs?: readonly string[]; deniedPathGlobs?: readonly string[] } = {},
): (request: FreezeRequest) => Promise<FreezeOutcome> {
  return async (request) => ({
    kind: "frozen",
    attempt: freezeFixtureAttempt(ledger, f, request.task.taskId, request.stage),
    taskDescription: `execute ${request.task.taskId}`,
    allowedPathGlobs: options.allowedPathGlobs ?? ["src/**"],
    deniedPathGlobs: options.deniedPathGlobs ?? [],
  });
}

export interface FakeAgents {
  /** `${taskId}:${attempt}` for every engineer launch. */
  launches: string[];
  /** `${taskId}:${stage}` for every stage dispatched. */
  calls: string[];
  executor: AgentExecutor;
}

const PASS = { tokens: 10, cost: 0.001, result: "PASS" as const };

/**
 * Deterministic fake agents. An engineer writes `src/<task>.txt` with bytes
 * that depend only on how many times the engine has *completed* its stage -
 * so a rerun after a crash writes identical bytes (an idempotent agent),
 * while a repair round writes new ones.
 */
export function fakeAgents(
  f: Pick<EngineFixture, "run" | "target" | "store" | "ledger">,
  options: {
    verification?: (taskId: string, attempt: number) => DeterministicVerification;
    writeFile?: (req: AgentExecutorRequest, attempt: number) => void;
    onEngineer?: (req: AgentExecutorRequest, attempt: number) => void | Promise<void>;
    engineerResult?: (req: AgentExecutorRequest, attempt: number) => AgentExecutorResult | undefined;
    onStage?: (req: AgentExecutorRequest) => void | Promise<void>;
    qa?: (req: AgentExecutorRequest) => AgentExecutorResult | undefined;
  } = {},
): FakeAgents {
  const launches: string[] = [];
  const calls: string[] = [];
  let packets = 0;
  const executor: AgentExecutor = async (req) => {
    calls.push(`${req.taskId}:${req.stage}`);
    await options.onStage?.(req);
    packets += 1;
    const packetPath = `.workflow/packets/${req.taskId}/${req.stage}-${packets}.json`;
    if (req.stage === AgentStage.BACKEND_ENGINEER || req.stage === AgentStage.FRONTEND_ENGINEER) {
      const attempt = f.ledger.attemptsForTask(f.run.run_id, req.taskId).length;
      launches.push(`${req.taskId}:${attempt}`);
      await options.onEngineer?.(req, attempt);
      const scripted = options.engineerResult?.(req, attempt);
      if (scripted) return scripted;
      if (options.writeFile) options.writeFile(req, attempt);
      else {
        const rounds = f.store.eventsForTask(req.taskId).filter((e) => e.type === "STAGE_COMPLETED" && e.payload.stage === req.stage).length;
        fs.writeFileSync(path.join(f.target, "src", `${req.taskId}.txt`), `${req.taskId} work, round ${rounds + 1}\n`);
      }
      return withRequiredEvidence(req, {
        outcome: PASS,
        packetPath,
        deterministicVerification: options.verification?.(req.taskId, attempt) ?? PASSING_VERIFICATION,
      });
    }
    if (req.stage === AgentStage.QA_ENGINEER) {
      const scripted = options.qa?.(req);
      if (scripted) return scripted;
    }
    return withRequiredEvidence(req, { outcome: PASS, packetPath });
  };
  return { launches, calls, executor };
}

export const quietIo = { log: () => undefined, error: () => undefined };

export const cleanSecrets: SecretScanner = () => ({ ok: true, problems: [] });

export interface DriveOptions {
  ledger?: RunLedger;
  agents?: FakeAgents;
  freeze?: (request: FreezeRequest) => Promise<FreezeOutcome>;
  secretScanner?: SecretScanner;
  policy?: RunPolicy;
  /** Wraps the decorated executor (e.g. a process death right after it returns). */
  wrap?: (decorated: AgentExecutor) => AgentExecutor;
  registry?: TaskRegistry;
}

/** Drives the fixture's run through `driveBoundedRun` with the real boundary. */
export async function driveFixture(f: EngineFixture, options: DriveOptions = {}): Promise<BoundedRunOutcome> {
  const ledger = options.ledger ?? f.ledger;
  const boundary = new (class extends LedgerAttemptBoundary {
    override decorate(inner: AgentExecutor): AgentExecutor {
      const decorated = super.decorate(inner);
      return options.wrap ? options.wrap(decorated) : decorated;
    }
  })({
    ledger,
    runId: f.run.run_id,
    store: f.store,
    runtimeStateRoot: f.state,
    contractRoot: f.state,
    registry: new RuntimeRegistry([]),
    runtimeSelection: () => ({ defaultRuntimeId: "claude-code" }),
    guards: () => { throw new Error("the fixture freeze never resolves guards"); },
    dependencyEvidence: () => [],
    adapterVersion: "fixture@1",
    git: f.gitLayer(),
    secretScanner: options.secretScanner ?? cleanSecrets,
    freeze: options.freeze ?? fixtureFreeze(ledger, f),
  });
  const agents = options.agents ?? fakeAgents(f);
  return driveBoundedRun({
    ledger,
    runId: f.run.run_id,
    registry: options.registry ?? f.registry,
    store: f.store,
    boundary,
    executorFor: () => agents.executor,
    policy: options.policy ?? boundedRunPolicy(f.run.boundary),
    io: quietIo,
  });
}

export function ledgerStatuses(f: Pick<EngineFixture, "ledger" | "run">): Record<string, string> {
  return Object.fromEntries(f.ledger.readTasks(f.run.run_id).map((task) => [task.task_id, task.status]));
}

export function attemptRows(f: Pick<EngineFixture, "ledger" | "run">, taskId: string): string[] {
  return f.ledger.attemptsForTask(f.run.run_id, taskId).map((attempt) => `${attempt.attempt}:${attempt.status}`);
}

export function stagesCompleted(f: Pick<EngineFixture, "store">, taskId: string): AgentStage[] {
  return f.store.eventsForTask(taskId).filter((e) => e.type === "STAGE_COMPLETED").map((e) => e.payload.stage as AgentStage);
}
