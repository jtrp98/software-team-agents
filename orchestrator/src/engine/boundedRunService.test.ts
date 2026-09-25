import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import type { AgentExecutor } from "../orchestrator/orchestrator.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD, LANE_FIXTURE_MODULE, writeSignedOffHandoffs } from "../orchestrator/stageGuards.testSupport.js";
import { decideTaskCompletion, verifyTaskCompletion } from "../orchestrator/transitionGuard.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import type { TaskStore } from "../store/taskStore.js";
import type { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { renderBoundedRunTasksAwaitingHuman } from "../cli/verbs/status.js";
import {
  PLAN_TASK,
  attemptRows,
  driveFixture,
  fakeAgents,
  fixtureFreeze,
  ledgerStatuses,
  quietIo,
  seedEngineRun,
  stagesCompleted,
  type EngineFixture,
} from "../run/boundedRunEngine.testSupport.js";
import { boundedRunStageGuard, engineViewOfRun } from "./boundedRunService.js";
import { SINGLE_TASK_POLICY } from "./runPolicy.js";
import { runTasks } from "./taskRunService.js";

/**
 * V13 TASK-007 — `sta bounded-run` is the one task engine: the same stages,
 * evidence and completion `sta run` produces, with a RunPolicy for where to
 * stop and the ledger as a projection of engine state.
 */

const roots: string[] = [];
const ledgers: SqliteRunLedger[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function seed(options: Parameters<typeof seedEngineRun>[2] = {}): EngineFixture {
  const f = seedEngineRun(git, roots, options);
  ledgers.push(f.ledger);
  return f;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Evidence as kinds per stage — ids differ by store, the shape must not. */
function evidenceShape(store: TaskStore, taskId: string): string[] {
  return store.evidenceForTask(taskId).map((r) => `${r.stage}#${r.attempt}:${r.kind}:${r.subject}`);
}

function completionShape(store: TaskStore, taskId: string) {
  const row = store.loadTask(taskId)!;
  const decided = decideTaskCompletion({ pipeline: row.machine.pipeline, approvals: row.approvals, records: store.evidenceForTask(taskId) });
  const verified = verifyTaskCompletion(store, row);
  const kindsOf = (ids: readonly string[]) => ids.map((id) => {
    const record = store.evidenceForTask(taskId).find((r) => r.evidenceId === id)!;
    return `${record.stage}:${record.kind}`;
  }).sort();
  return {
    decided: decided.done ? { done: true, refs: kindsOf(decided.evidenceIds) } : decided,
    verified: verified.done ? { done: true, refs: kindsOf(verified.evidenceIds) } : verified,
    state: row.machine.current,
  };
}

describe("V13 TASK-007 — `sta run` and `sta bounded-run` are one engine", () => {
  it("(a) an equivalent plan task yields the same STAGE_COMPLETED sequence, evidence kinds and verified completion on both paths", async () => {
    // `sta run`'s path: one task through runTasks under SINGLE_TASK_POLICY.
    const single = new MemoryTaskStore();
    const singleRegistry = new TaskRegistry({ store: single, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: testHumanVerifier() });
    singleRegistry.create({ taskId: "BE-1", classification: classifyTask(PLAN_TASK), classificationInput: PLAN_TASK });
    let packets = 0;
    const plain: AgentExecutor = (req) => withRequiredEvidence(req, {
      outcome: { tokens: 10, cost: 0.001, result: "PASS" },
      packetPath: `.workflow/packets/${req.taskId}/${req.stage}-${++packets}.json`,
    });
    const singleResult = await runTasks({
      registry: singleRegistry, store: single, taskIds: ["BE-1"], executorFor: () => plain, policy: SINGLE_TASK_POLICY, io: quietIo,
    });
    expect(singleResult.exit).toBe("DONE");

    // The bounded path: the same task through driveBoundedRun, the attempt
    // boundary, a real Git checkpoint and the ledger projection.
    const f = seed();
    const bounded = await driveFixture(f);
    expect(bounded).toMatchObject({ kind: "COMPLETED", exitCode: 0, runStatus: "COMPLETED" });

    expect(stagesCompleted(f, "BE-1")).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);
    expect(stagesCompleted(f, "BE-1")).toEqual(
      single.eventsForTask("BE-1").filter((e) => e.type === "STAGE_COMPLETED").map((e) => e.payload.stage),
    );
    // The decorator adds a checkpoint, never an evidence record or requirement.
    expect(evidenceShape(f.store, "BE-1")).toEqual(evidenceShape(single, "BE-1"));
    const completion = completionShape(f.store, "BE-1");
    expect(completion).toEqual(completionShape(single, "BE-1"));
    expect(completion).toMatchObject({ state: TaskState.DEPLOYED, decided: { done: true }, verified: { done: true } });

    // The ledger is a projection of that engine state, plus the frozen attempt and its checkpoint.
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "DONE" });
    expect(attemptRows(f, "BE-1")).toEqual(["1:SUCCEEDED"]);
    expect(f.ledger.checkpointsForRun(f.run.run_id)).toHaveLength(1);
    const projections = f.ledger.eventsForRun(f.run.run_id).filter((e) => e.kind === "TASK_STATUS");
    expect(projections.every((e) => e.actor === "engine-projection")).toBe(true);
  }, 30_000);

  it("(a) COMPLETED ⇔ every task verifies complete: a forged ledger DONE or a DEPLOYED row without completion evidence is not Done", async () => {
    const f = seed({ tasks: [{ id: "BE-1" }, { id: "BE-2" }] });
    // Forge the ledger: both tasks "DONE" before anything ran.
    f.ledger.projectTaskStatus(f.run.run_id, "BE-1", "DONE", { reason: "forged" });
    f.ledger.projectTaskStatus(f.run.run_id, "BE-2", "DONE", { reason: "forged" });
    // Forge the engine row too: BE-2 at DEPLOYED with no task-completion evidence.
    const row = f.store.loadTask("BE-2")!;
    f.store.saveTask({ ...row, machine: { ...row.machine, current: TaskState.DEPLOYED } });
    // `sta status` reads the engine, so it already says so.
    expect(renderBoundedRunTasksAwaitingHuman(f.ledger, f.store).join("\n")).toContain("0/2 task(s) verified done by the engine");

    const agents = fakeAgents(f);
    const result = await driveFixture(f, { agents });
    expect(result.kind).not.toBe("COMPLETED");
    expect(result.kind).toBe("GATE");
    expect(f.ledger.readRun(f.run.run_id)?.status).toBe("AWAITING_HUMAN");
    // BE-1 genuinely ran and completed; BE-2's bare DEPLOYED row is reported, not trusted.
    expect(agents.launches).toEqual(["BE-1:1"]);
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "DONE", "BE-2": "BLOCKED" });
    expect(result.awaitingHuman).toEqual([{ taskId: "BE-2", reason: expect.stringMatching(/completion/) }]);
    const status = renderBoundedRunTasksAwaitingHuman(f.ledger, f.store).join("\n");
    expect(status).toContain("1/2 task(s) verified done by the engine, 1 awaiting a human decision");
    expect(status).toContain("BE-2:");
  }, 30_000);

  it("(d) the role-lane guard with empty Knowledge blocks a bounded engineer task before any freeze or dispatch", async () => {
    const knowledge = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "v13-bounded-knowledge-")));
    roots.push(knowledge);
    fs.mkdirSync(path.join(knowledge, "knowledge"), { recursive: true });
    const guard = boundedRunStageGuard({ knowledge_root: knowledge, module: LANE_FIXTURE_MODULE });
    const f = seed({ guard, knowledgeRoot: knowledge, module: LANE_FIXTURE_MODULE });
    const freeze = vi.fn(fixtureFreeze(f.ledger, f));
    const agents = fakeAgents(f);

    const refused = await driveFixture(f, { agents, freeze });
    expect(refused.kind).toBe("GATE");
    expect(refused.awaitingHuman).toEqual([{ taskId: "BE-1", reason: expect.stringMatching(/holds no items/) }]);
    expect(freeze).not.toHaveBeenCalled();
    expect(agents.calls).toEqual([]);
    expect(f.ledger.attemptsForTask(f.run.run_id, "BE-1")).toEqual([]);
    expect(git(f.target, "branch", "--list", f.run.run_branch)).toBe("");
    expect(ledgerStatuses(f)).toEqual({ "BE-1": "BLOCKED" });
    expect(engineViewOfRun(f.ledger, f.store, f.run)[0]!.reason).toMatch(/trusted human decision channel/);
    // The machine was never forced to BLOCKED: a person's handoff clears it.
    expect(f.store.loadTask("BE-1")!.machine.current).toBe(TaskState.IMPLEMENTATION);

    writeSignedOffHandoffs(knowledge);
    const resumed = await driveFixture(f, { agents, freeze });
    expect(resumed.kind, JSON.stringify({ reason: resumed.reason, runs: f.store.runsForTask("BE-1").map((r) => r.failure_reason) })).toBe("COMPLETED");
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(agents.launches).toEqual(["BE-1:1"]);
  }, 30_000);
});
