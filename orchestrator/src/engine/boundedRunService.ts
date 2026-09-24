import type { LedgerRun, LedgerTask, RunLedger } from "../ledger/runLedger.js";
import type { LedgerRunStatus, LedgerTaskStatus } from "../ledger/vocabulary.js";
import { applyRunStatus, LedgerTransitionError } from "../ledger/vocabulary.js";
import { ledgerTaskStatusFromPersisted } from "../ledger/adapters.js";
import { createRoleLaneStageGuard, type StageEntryGuard } from "../orchestrator/stageGuards.js";
import type { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { describeStatus, type TaskStatusView } from "../orchestrator/taskStatus.js";
import { verifyTaskCompletion } from "../orchestrator/transitionGuard.js";
import type { TaskStore } from "../store/taskStore.js";
import type { LedgerAttemptBoundary } from "../run/ledgerAttemptExecutor.js";
import type { RunPolicy } from "./runPolicy.js";
import { runTasks, type RunTasksIo, type RunTasksResult, type TaskExecutorFactory } from "./taskRunService.js";

/**
 * A bounded run is the one task engine over a frozen plan scope (V13
 * TASK-007): `runTasks` drives every task of the run's `task_order` through
 * the `Orchestrator`, with the same stages, evidence and completion as
 * `sta run`. What the bounded run adds is a `RunPolicy` (where to stop, how
 * much repair to spend), the Target-mutation boundary on engineer stages
 * (`run/ledgerAttemptExecutor.ts`), and the RunLedger - which is now an audit
 * *projection* of engine state plus attempt freezing, never a decider:
 *
 * - a ledger task status is written only as `ledgerTaskStatusFromPersisted`
 *   of the engine's persisted row, after every settled step;
 * - the run is COMPLETED only when every task's completion re-verifies
 *   against the evidence store (DEPLOYED + task-completion evidence);
 * - a gate, a refused stage entry, a human hold or a spent repair budget is
 *   AWAITING_HUMAN; a stalled stage or a runtime halt is HALTED.
 */

export type BoundedRunExitKind = "COMPLETED" | "BOUNDARY" | "GATE" | "HALTED" | "REFUSED";

/** `sta bounded-run` process exit codes. */
export const BOUNDED_RUN_EXIT_CODES: Readonly<Record<BoundedRunExitKind, number>> = {
  COMPLETED: 0,
  BOUNDARY: 0,
  GATE: 4,
  HALTED: 1,
  REFUSED: 2,
};

export interface AwaitingHumanTask {
  taskId: string;
  reason: string;
}

export interface BoundedRunOutcome {
  kind: BoundedRunExitKind;
  exitCode: number;
  runId: string;
  /** The run status this invocation projected (unchanged for REFUSED). */
  runStatus: LedgerRunStatus | null;
  reason: string;
  /** Null when the run never reached the engine (refused, or halted in reconciliation). */
  engine: RunTasksResult | null;
  /** Every task of the run the engine leaves waiting on a person, with the engine's own reason. */
  awaitingHuman: readonly AwaitingHumanTask[];
}

/** The stage-entry guard a bounded run's engine is built with: the frozen run's Knowledge root and module. */
export function boundedRunStageGuard(run: Pick<LedgerRun, "knowledge_root" | "module">): StageEntryGuard {
  return createRoleLaneStageGuard({ projectRoot: run.knowledge_root, moduleName: run.module });
}

export interface EngineTaskView {
  task: LedgerTask;
  /** The engine's own projection of the task (`describeStatus`), or a refusal when the engine has no such task. */
  view: TaskStatusView | null;
  /** What the ledger task status must read, projected from the engine. */
  status: LedgerTaskStatus;
  reason: string;
}

/** Reads - never writes - the engine's view of every task of a bounded run. */
export function engineViewOfRun(ledger: RunLedger, store: TaskStore, run: LedgerRun, guard: StageEntryGuard = boundedRunStageGuard(run)): EngineTaskView[] {
  const all = store.listTasks();
  return ledger.readTasks(run.run_id).map((task) => {
    const row = all.find((candidate) => candidate.taskId === task.task_id);
    if (!row) {
      return { task, view: null, status: "BLOCKED" as const, reason: `task ${task.task_id} is not registered in the task engine` };
    }
    const view = describeStatus(row, all, { stageEntryGuard: guard });
    const completion = verifyTaskCompletion(store, row);
    const status = ledgerTaskStatusFromPersisted(row, { allTasks: all, stageEntryGuard: guard, completionVerified: completion.done });
    const reason = view.kind === "DEPLOYED" && !completion.done
      ? `DEPLOYED but its completion does not verify: ${completion.reason}`
      : view.reason ?? `${view.kind} at ${view.state}`;
    return { task, view, status, reason };
  });
}

/** Writes the ledger task projection for one task (or every task) of the run from engine state. */
export function projectRunTasks(ledger: RunLedger, store: TaskStore, run: LedgerRun, guard: StageEntryGuard, only?: string): EngineTaskView[] {
  const views = engineViewOfRun(ledger, store, run, guard);
  for (const item of views) {
    if (only !== undefined && item.task.task_id !== only) continue;
    ledger.projectTaskStatus(run.run_id, item.task.task_id, item.status, { reason: item.reason });
  }
  return views;
}

/**
 * The run-status write of a projection. COMPLETED is terminal and legal only
 * from RUNNING, so a run finishing from a stop (every task completed while it
 * was HALTED/AWAITING_HUMAN, e.g. after a person answered the last gate)
 * passes through RUNNING in this same invocation - which is what it did.
 */
function writeRunStatus(ledger: RunLedger, runId: string, to: LedgerRunStatus, reason: string): LedgerRunStatus {
  const current = ledger.readRun(runId)!;
  if (current.status === to) return to;
  try {
    applyRunStatus(runId, current.status, to);
  } catch (error) {
    if (!(error instanceof LedgerTransitionError) || to !== "COMPLETED") throw error;
    ledger.setRunStatus(runId, "RUNNING", { reason: "every task's completion re-verified in this invocation", actor: "engine-projection" });
  }
  return ledger.setRunStatus(runId, to, { reason, actor: "engine-projection" }).status;
}

export interface DriveBoundedRunInput {
  ledger: RunLedger;
  runId: string;
  /** Built with `boundedRunStageGuard(run)`. */
  registry: TaskRegistry;
  store: TaskStore;
  /** The Target-mutation boundary engineer stages run through. */
  boundary: LedgerAttemptBoundary;
  /** Each task's ordinary production executor - the composition `sta run` uses. */
  executorFor: TaskExecutorFactory;
  policy: RunPolicy;
  io: RunTasksIo;
}

export async function driveBoundedRun(input: DriveBoundedRunInput): Promise<BoundedRunOutcome> {
  const { ledger, store, registry, runId } = input;
  const run = ledger.readRun(runId);
  const refused = (reason: string): BoundedRunOutcome => ({
    kind: "REFUSED", exitCode: BOUNDED_RUN_EXIT_CODES.REFUSED, runId, runStatus: run?.status ?? null, reason, engine: null, awaitingHuman: [],
  });
  if (!run) return refused(`run ${runId} does not exist`);
  if (run.status === "COMPLETED") {
    return { kind: "COMPLETED", exitCode: 0, runId, runStatus: "COMPLETED", reason: "run is already COMPLETED", engine: null, awaitingHuman: [] };
  }
  if (["REFUSED", "CANCELLED", "STALE"].includes(run.status)) return refused(`run is already ${run.status}`);
  const guard = registry.stageEntryGuard;

  const halt = (reason: string, engine: RunTasksResult | null): BoundedRunOutcome => {
    const views = projectRunTasks(ledger, store, run, guard);
    const runStatus = writeRunStatus(ledger, runId, "HALTED", reason);
    return { kind: "HALTED", exitCode: BOUNDED_RUN_EXIT_CODES.HALTED, runId, runStatus, reason, engine, awaitingHuman: awaiting(views) };
  };

  let engine: RunTasksResult;
  try {
    const reconciled = await input.boundary.reconcileInterrupted();
    if (reconciled.kind === "reattributed") {
      input.io.log(`[bounded-run] re-attributed interrupted attempt ${reconciled.attemptId} to its checkpoint ${reconciled.sha} (no second commit).`);
    } else if (reconciled.kind === "abandoned") {
      input.io.log(`[bounded-run] abandoned interrupted attempt ${reconciled.attemptId}: it left no work on the run branch.`);
    }
    engine = await runTasks({
      registry,
      store,
      taskIds: run.task_order,
      executorFor: async (orchestrator) => input.boundary.decorate(await input.executorFor(orchestrator)),
      policy: input.policy,
      io: input.io,
      onStep: (taskId) => { projectRunTasks(ledger, store, run, guard, taskId); },
    });
  } catch (error) {
    input.boundary.close();
    return halt(error instanceof Error ? error.message : String(error), null);
  }
  input.boundary.close();

  const views = projectRunTasks(ledger, store, run, guard);
  const everyTaskComplete = views.length > 0 && views.every((item) => item.status === "DONE");
  if (everyTaskComplete) {
    const reason = `every task's completion re-verified (${views.map((item) => item.task.task_id).join(", ")})`;
    const runStatus = writeRunStatus(ledger, runId, "COMPLETED", reason);
    return { kind: "COMPLETED", exitCode: 0, runId, runStatus, reason, engine, awaitingHuman: [] };
  }

  const stop = engine.stoppedAt;
  const reason = stop ? `${stop.taskId}: ${stop.reason}` : "tasks remain whose completion does not verify";
  switch (engine.exit) {
    case "WAITING":
    case "STUCK":
    case "BLOCKED":
    case "BUDGET":
    case "HELD": {
      const runStatus = writeRunStatus(ledger, runId, "AWAITING_HUMAN", reason);
      return { kind: "GATE", exitCode: BOUNDED_RUN_EXIT_CODES.GATE, runId, runStatus, reason, engine, awaitingHuman: awaiting(views) };
    }
    case "BOUNDARY": {
      // A gate a task reached before the boundary outranks it: the run waits on a person.
      const gated = awaiting(views);
      if (gated.length > 0) {
        const runStatus = writeRunStatus(ledger, runId, "AWAITING_HUMAN", gated.map((item) => `${item.taskId}: ${item.reason}`).join("; "));
        return { kind: "GATE", exitCode: BOUNDED_RUN_EXIT_CODES.GATE, runId, runStatus, reason: gated[0]!.reason, engine, awaitingHuman: gated };
      }
      const runStatus = writeRunStatus(ledger, runId, "HALTED", `${input.policy.until} boundary reached — ${reason}`);
      return { kind: "BOUNDARY", exitCode: BOUNDED_RUN_EXIT_CODES.BOUNDARY, runId, runStatus, reason: `${input.policy.until} boundary reached — ${reason}`, engine, awaitingHuman: awaiting(views) };
    }
    case "STALLED":
    case "NOT_READY":
    case "DONE":
      return halt(reason, engine);
  }
}

function awaiting(views: readonly EngineTaskView[]): AwaitingHumanTask[] {
  return views.filter((item) => item.status === "BLOCKED").map((item) => ({ taskId: item.task.task_id, reason: item.reason }));
}
