import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { ApprovalType } from "../gates/approval.js";
import { classifyTask, type ClassificationInput } from "../classification/taskClassifier.js";
import type { AgentExecutor, AgentExecutorRequest, OrchestratorStatus } from "../orchestrator/orchestrator.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { withRequiredEvidence } from "../evidence/stageEvidence.testSupport.js";
import { decideTaskCompletion, verifyTaskCompletion } from "../orchestrator/transitionGuard.js";
import { createRoleLaneStageGuard, type StageEntryGuard } from "../orchestrator/stageGuards.js";
import {
  ALLOW_EVERY_STAGE_TEST_GUARD,
  LANE_FIXTURE_MODULE,
  writeApprovedKnowledge,
  writeSignedOffHandoffs,
} from "../orchestrator/stageGuards.testSupport.js";
import { SINGLE_TASK_POLICY, boundedRunPolicy, type RunPolicy } from "./runPolicy.js";
import { driveTask, runTasks, type DrivableTask, type RunTasksIo } from "./taskRunService.js";

/** The classification every plan task registered from a canonical plan.md gets for a backend owner. */
const PLAN_TASK: ClassificationInput = { isPlanTask: true, touchesBackend: true };
/** A plan task whose authored risk is a schema change: security pass + human approval before Done. */
const GATED_PLAN_TASK: ClassificationInput = { isPlanTask: true, touchesBackend: true, touchesSchema: true };

const PASS = { tokens: 10, cost: 0.001, result: "PASS" as const };
const FAIL = { tokens: 10, cost: 0.001, result: "FAIL" as const };

/** Deterministic fake runtime: every stage succeeds with exactly the evidence its completion requires. */
function passingExecutor(calls: AgentExecutorRequest[] = []): AgentExecutor {
  return (req) => {
    calls.push(req);
    return withRequiredEvidence(req, { outcome: PASS, packetPath: `.workflow/packets/${req.taskId}/${req.stage}-${calls.length}.json` });
  };
}

function quietIo(): RunTasksIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function registryWith(guard: StageEntryGuard, store: TaskStore = new MemoryTaskStore()): { registry: TaskRegistry; store: TaskStore } {
  return { registry: new TaskRegistry({ store, stageEntryGuard: guard, humanDecisionVerifier: testHumanVerifier() }), store };
}

function register(registry: TaskRegistry, taskId: string, input: ClassificationInput, dependsOn: string[] = []): void {
  registry.create({ taskId, classification: classifyTask(input), classificationInput: input, dependsOn });
}

function stagesCompleted(store: TaskStore, taskId: string): AgentStage[] {
  return store.eventsForTask(taskId).filter((e) => e.type === "STAGE_COMPLETED").map((e) => e.payload.stage as AgentStage);
}

/** Evidence as kinds per stage — ids differ by task, the shape must not. */
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

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-run-service-"));
}

describe("runTasks — one engine for `sta run` and a bounded run (V13 TASK-007)", () => {
  it("drives an equivalent plan task to the same stages, evidence and completion whichever policy runs it", async () => {
    // `sta run`-style: one task, SINGLE_TASK_POLICY.
    const single = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
    register(single.registry, "T-SINGLE", PLAN_TASK);
    const singleResult = await runTasks({
      registry: single.registry,
      store: single.store,
      taskIds: ["T-SINGLE"],
      executorFor: () => passingExecutor(),
      policy: SINGLE_TASK_POLICY,
      io: quietIo(),
    });

    // Bounded-style: the same classification inside a multi-task run, behind a dependency,
    // listed out of dependency order so the service — not the caller — decides the order.
    const bounded = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
    register(bounded.registry, "T-DEP", PLAN_TASK);
    register(bounded.registry, "T-MULTI", PLAN_TASK, ["T-DEP"]);
    const order: string[] = [];
    const boundedResult = await runTasks({
      registry: bounded.registry,
      store: bounded.store,
      taskIds: ["T-MULTI", "T-DEP"],
      executorFor: (orchestrator) => {
        order.push(orchestrator.taskId);
        return passingExecutor();
      },
      policy: boundedRunPolicy("done"),
      io: quietIo(),
    });

    expect(singleResult).toMatchObject({ exit: "DONE", exitCode: 0, stoppedAt: null });
    expect(boundedResult).toMatchObject({ exit: "DONE", exitCode: 0, stoppedAt: null });
    expect(order).toEqual(["T-DEP", "T-MULTI"]);

    const expectedStages = [AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER];
    expect(stagesCompleted(single.store, "T-SINGLE")).toEqual(expectedStages);
    expect(stagesCompleted(bounded.store, "T-MULTI")).toEqual(expectedStages);
    expect(evidenceShape(bounded.store, "T-MULTI")).toEqual(evidenceShape(single.store, "T-SINGLE"));

    const singleCompletion = completionShape(single.store, "T-SINGLE");
    expect(singleCompletion.state).toBe(TaskState.DEPLOYED);
    expect(singleCompletion.decided).toMatchObject({ done: true });
    expect(singleCompletion.verified).toMatchObject({ done: true });
    expect(completionShape(bounded.store, "T-MULTI")).toEqual(singleCompletion);

    // One projection per task, from persisted state.
    expect(singleResult.tasks).toEqual([{ taskId: "T-SINGLE", status: { kind: "DEPLOYED", state: TaskState.DEPLOYED } }]);
    expect(boundedResult.tasks.map((t) => [t.taskId, t.status.kind])).toEqual([["T-MULTI", "DEPLOYED"], ["T-DEP", "DEPLOYED"]]);
  });

  it("stops at the repair budget as a limit — the task's state and evidence are exactly what the engine left", async () => {
    const { registry, store } = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
    register(registry, "T-BUDGET", PLAN_TASK);
    const calls: AgentExecutorRequest[] = [];
    const qaAlwaysFails: AgentExecutor = (req) => {
      calls.push(req);
      if (req.stage === AgentStage.QA_ENGINEER) return { outcome: { ...FAIL, failure_reason: "AC not met" } };
      return withRequiredEvidence(req, { outcome: PASS, packetPath: `.workflow/packets/${req.taskId}/${req.stage}-${calls.length}.json` });
    };
    const policy: RunPolicy = boundedRunPolicy("done", 1);

    const stopped = await runTasks({ registry, store, taskIds: ["T-BUDGET"], executorFor: () => qaAlwaysFails, policy, io: quietIo() });
    expect(stopped).toMatchObject({ exit: "BUDGET", exitCode: 4, stoppedAt: { taskId: "T-BUDGET" } });
    const row = store.loadTask("T-BUDGET")!;
    // Two failed QA rounds spent a budget of one; the engine itself would retry (its ceiling is higher).
    expect(row.retries.qa).toBe(2);
    expect(row.machine.current).toBe(TaskState.IMPLEMENTATION);
    expect(stopped.tasks[0]!.status).toMatchObject({ kind: "RUNNING", currentAgent: AgentStage.BACKEND_ENGINEER });

    // Asking again under the same budget dispatches nothing and changes nothing.
    const before = { ...store.loadTask("T-BUDGET")!, updatedAt: 0 };
    const evidenceBefore = evidenceShape(store, "T-BUDGET");
    const callsBefore = calls.length;
    const again = await runTasks({ registry, store, taskIds: ["T-BUDGET"], executorFor: () => qaAlwaysFails, policy, io: quietIo() });
    expect(again.exit).toBe("BUDGET");
    expect(calls.length).toBe(callsBefore);
    expect({ ...store.loadTask("T-BUDGET")!, updatedAt: 0 }).toEqual(before);
    expect(evidenceShape(store, "T-BUDGET")).toEqual(evidenceBefore);

    // The budget was only ever a limit: without it, the same engine continues the same task.
    const unbounded = await runTasks({ registry, store, taskIds: ["T-BUDGET"], executorFor: () => passingExecutor(calls), policy: SINGLE_TASK_POLICY, io: quietIo() });
    expect(unbounded.exit).toBe("DONE");
    expect(stagesCompleted(store, "T-BUDGET").slice(-3)).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);
  });

  it("`until: next-gate` stops at the first gate; `done` carries on with independent tasks and reports that gate", async () => {
    for (const until of ["next-gate", "done"] as const) {
      const { registry, store } = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
      register(registry, "T-GATED", GATED_PLAN_TASK);
      register(registry, "T-FREE", PLAN_TASK);
      const seen: string[] = [];
      const result = await runTasks({
        registry,
        store,
        taskIds: ["T-GATED", "T-FREE"],
        executorFor: (orchestrator) => {
          seen.push(orchestrator.taskId);
          return passingExecutor();
        },
        policy: boundedRunPolicy(until),
        io: quietIo(),
      });

      expect(result, until).toMatchObject({ exit: "WAITING", exitCode: 4, stoppedAt: { taskId: "T-GATED" } });
      const gated = store.loadTask("T-GATED")!;
      expect(gated.machine.current).toBe(TaskState.READY_TO_DEPLOY);
      expect(stagesCompleted(store, "T-GATED")).toEqual([
        AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY,
      ]);
      // The service never answers a gate.
      expect(gated.approvals.every((a) => a.status === "pending")).toBe(true);
      expect(result.tasks[0]!.status.kind).toBe("WAITING_FOR_HUMAN");
      if (until === "next-gate") {
        expect(seen).toEqual(["T-GATED"]);
        expect(store.loadTask("T-FREE")!.machine.current).toBe(TaskState.CREATED);
      } else {
        expect(seen).toEqual(["T-GATED", "T-FREE"]);
        expect(result.tasks[1]!.status.kind).toBe("DEPLOYED");
      }
    }
  });

  it("`until: qa` stops right after the first QA verdict", async () => {
    const { registry, store } = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
    register(registry, "T-QA-1", PLAN_TASK);
    register(registry, "T-QA-2", PLAN_TASK);
    const calls: AgentExecutorRequest[] = [];
    const result = await runTasks({ registry, store, taskIds: ["T-QA-1", "T-QA-2"], executorFor: () => passingExecutor(calls), policy: boundedRunPolicy("qa"), io: quietIo() });
    expect(result).toMatchObject({ exit: "BOUNDARY", exitCode: 0, stoppedAt: { taskId: "T-QA-1" } });
    expect(calls.map((c) => `${c.taskId}:${c.stage}`)).toEqual([
      `T-QA-1:${AgentStage.BACKEND_ENGINEER}`, `T-QA-1:${AgentStage.REVIEWER}`, `T-QA-1:${AgentStage.QA_ENGINEER}`,
    ]);
  });

  it("honours a person's pause and cancel between steps", async () => {
    const { registry, store } = registryWith(ALLOW_EVERY_STAGE_TEST_GUARD);
    register(registry, "T-HOLD", PLAN_TASK);
    // A person pauses the task once backend-engineer's attempt has been committed —
    // STAGE_COMPLETED reaches listeners only after the orchestrator's unit commits.
    const paused = await runTasks({
      registry,
      store,
      taskIds: ["T-HOLD"],
      executorFor: (orchestrator) => {
        orchestrator.events.on("STAGE_COMPLETED", (event) => {
          if (event.stage === AgentStage.BACKEND_ENGINEER) registry.pause("T-HOLD");
        });
        return passingExecutor();
      },
      policy: SINGLE_TASK_POLICY,
      io: quietIo(),
    });
    expect(paused).toMatchObject({ exit: "HELD", exitCode: 1, stoppedAt: { reason: "paused" } });
    expect(stagesCompleted(store, "T-HOLD")).toEqual([AgentStage.BACKEND_ENGINEER]);
    expect(paused.tasks[0]!.status.kind).toBe("PAUSED");

    registry.unpause("T-HOLD");
    registry.cancel("T-HOLD", "duplicate");
    const executor = vi.fn(passingExecutor());
    const cancelled = await runTasks({ registry, store, taskIds: ["T-HOLD"], executorFor: () => executor, policy: SINGLE_TASK_POLICY, io: quietIo() });
    expect(cancelled).toMatchObject({ exit: "HELD", stoppedAt: { reason: "cancelled: duplicate" } });
    expect(executor).not.toHaveBeenCalled();
    expect(cancelled.tasks[0]!.status.kind).toBe("CANCELLED");
  });
});

describe("the role-lane stage-entry guard fires on every entry point (V13 TASK-007)", () => {
  type Knowledge = "missing" | "empty" | "invalid";
  function prepare(kind: Knowledge): string {
    const root = tmpRoot();
    if (kind === "empty") fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    if (kind === "invalid") {
      writeApprovedKnowledge(root);
      const broken = path.join(root, "knowledge", LANE_FIXTURE_MODULE, "requirement", "REQ-999.yaml");
      fs.mkdirSync(path.dirname(broken), { recursive: true });
      fs.writeFileSync(broken, "id: [unterminated\n");
    }
    return root;
  }
  const reasonFor: Record<Knowledge, RegExp> = {
    missing: /no knowledge\/ directory/,
    empty: /holds no items/,
    invalid: /is invalid/,
  };
  const policies: Array<[string, RunPolicy]> = [
    ["SINGLE_TASK_POLICY", SINGLE_TASK_POLICY],
    ["bounded next-gate", boundedRunPolicy("next-gate")],
    ["bounded done", boundedRunPolicy("done")],
  ];

  for (const knowledge of ["missing", "empty", "invalid"] as const) {
    for (const [name, policy] of policies) {
      it(`${knowledge} Knowledge ⇒ the engineer stage is never dispatched under ${name}, and a valid signoff + ack lets it run`, async () => {
        const root = prepare(knowledge);
        const { registry, store } = registryWith(createRoleLaneStageGuard({ projectRoot: root, moduleName: LANE_FIXTURE_MODULE }));
        register(registry, "T-LANE", PLAN_TASK);
        const executor = vi.fn(passingExecutor());

        const refused = await runTasks({ registry, store, taskIds: ["T-LANE"], executorFor: () => executor, policy, io: quietIo() });
        expect(refused).toMatchObject({ exit: "BLOCKED", exitCode: 1, stoppedAt: { taskId: "T-LANE" } });
        expect(refused.stoppedAt!.reason).toMatch(reasonFor[knowledge]);
        expect(refused.stoppedAt!.reason).toMatch(/sta roles (signoff|ack)|sta --check-knowledge/);
        expect(executor).not.toHaveBeenCalled();
        // One projection: BLOCKED with the guard's reason — yet the machine was never forced to BLOCKED
        // and no role-run was recorded, so nothing failed; it is waiting on a person.
        expect(refused.tasks[0]!.status).toMatchObject({ kind: "BLOCKED", currentAgent: AgentStage.BACKEND_ENGINEER });
        expect(refused.tasks[0]!.status.reason).toMatch(reasonFor[knowledge]);
        const row = store.loadTask("T-LANE")!;
        expect(row.machine.current).toBe(TaskState.IMPLEMENTATION);
        expect(row.blockedReason).toBeNull();
        expect(store.evidenceForTask("T-LANE").filter((r) => r.kind === "role-run")).toEqual([]);
        expect(store.runsForTask("T-LANE")).toEqual([]);

        // A person records the handoffs (fixture of `sta roles signoff`/`ack`); the same task now runs.
        if (knowledge === "invalid") fs.rmSync(path.join(root, "knowledge"), { recursive: true, force: true });
        writeSignedOffHandoffs(root);
        const resumed = await runTasks({ registry, store, taskIds: ["T-LANE"], executorFor: () => executor, policy, io: quietIo() });
        expect(resumed.exit).toBe("DONE");
        expect(executor.mock.calls[0]![0].stage).toBe(AgentStage.BACKEND_ENGINEER);
      });
    }
  }

  it("the same refusal is what `Orchestrator.status()` settles on, re-evaluated on every poll", () => {
    const root = prepare("empty");
    const { registry } = registryWith(createRoleLaneStageGuard({ projectRoot: root, moduleName: LANE_FIXTURE_MODULE }));
    register(registry, "T-POLL", { isPlanTask: true, touchesFrontend: true });
    const orchestrator = registry.open("T-POLL");
    const first = orchestrator.status();
    expect(first).toMatchObject({ kind: "BLOCKED" });
    expect(orchestrator.machine.current).toBe(TaskState.IMPLEMENTATION);
    writeSignedOffHandoffs(root);
    // Signed-off lanes, but frontend at MEDIUM also needs the signed UX artifact — still refused, a different reason.
    const second = orchestrator.status();
    expect(second.kind).toBe("BLOCKED");
    if (second.kind === "BLOCKED") expect(second.reason).toMatch(/UX artifact/);
  });
});

describe("driveTask — the per-task loop (migrated from cli/runTaskLoop.test.ts)", () => {
  const executor: AgentExecutor = vi.fn();
  const REQUEST_ID = "apr_0123456789abcdef0123456789abcdef";
  const gate: OrchestratorStatus = {
    kind: "WAITING_FOR_HUMAN",
    from: TaskState.DESIGN,
    to: TaskState.PLAN,
    reason: "schema confirmation required",
    approvalType: ApprovalType.SCHEMA_CONFIRMATION,
    requestId: REQUEST_ID,
  };

  function fixture(statuses: OrchestratorStatus[], stepResult?: OrchestratorStatus) {
    let cursor = 0;
    const summary = vi.fn(() => "run summary");
    const step = vi.fn(async () => stepResult ?? statuses[++cursor]!);
    const orchestrator = {
      taskId: "T-LOOP",
      runLog: { summary },
      status: vi.fn(() => statuses[Math.min(cursor, statuses.length - 1)]!),
      step,
      stageDecision: null,
      events: { on: () => () => undefined },
    } as unknown as DrivableTask;
    const io = quietIo();
    const drive = () => driveTask(orchestrator, {
      policy: SINGLE_TASK_POLICY,
      io,
      refresh: () => undefined,
      executor: async () => executor,
      persisted: () => ({ paused: false, cancelled: false, cancelReason: null, failureRounds: 0 }),
    });
    return { drive, io, step };
  }

  it("ends DONE for DEPLOYED and prints the run summary", async () => {
    const f = fixture([{ kind: "DEPLOYED" }]);
    await expect(f.drive()).resolves.toMatchObject({ kind: "DONE" });
    expect(f.io.lines).toEqual(["[orchestrator] task T-LOOP DEPLOYED.", "run summary"]);
  });

  it("stops BLOCKED with the reason", async () => {
    const f = fixture([{ kind: "BLOCKED", reason: "cannot continue" }]);
    await expect(f.drive()).resolves.toEqual({ kind: "BLOCKED", reason: "cannot continue" });
    expect(f.io.lines).toEqual(["[orchestrator] task T-LOOP BLOCKED: cannot continue"]);
  });

  it("parks on a human gate with its request id and never answers it", async () => {
    const f = fixture([gate, { kind: "DEPLOYED" }]);
    await expect(f.drive()).resolves.toMatchObject({ kind: "WAITING" });
    expect(f.step).not.toHaveBeenCalled();
    expect(f.io.lines.at(-1)).toBe(
      `[orchestrator] parking task T-LOOP on pending request ${REQUEST_ID}. A person resolves it through a trusted channel: ` +
        `node orchestrator/dist/cli.js approve T-LOOP --request ${REQUEST_ID} --yes|--no, then --resume.`,
    );
  });

  it("is STUCK on a gate with no pending request to answer", async () => {
    const f = fixture([{
      kind: "WAITING_FOR_HUMAN",
      from: TaskState.QA,
      to: TaskState.READY_TO_DEPLOY,
      reason: "unknown gate",
      approvalType: null,
      requestId: null,
    }]);
    await expect(f.drive()).resolves.toMatchObject({ kind: "STUCK" });
  });

  it("is STALLED when a running stage does not advance", async () => {
    const running: OrchestratorStatus = { kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER };
    const f = fixture([running], running);
    await expect(f.drive()).resolves.toMatchObject({ kind: "STALLED" });
    expect(f.step).toHaveBeenCalledWith(executor);
    expect(f.io.lines).toEqual([
      "[orchestrator] running backend-engineer...",
      "[orchestrator] backend-engineer did not advance the task — stopping to avoid a spin loop.",
    ]);
  });
});
