import { AgentStage } from "../types.js";
import type { AgentExecutor, Orchestrator, OrchestratorStatus } from "../orchestrator/orchestrator.js";
import type { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { describeStatus, type TaskStatusView } from "../orchestrator/taskStatus.js";
import type { TaskStore } from "../store/taskStore.js";
import { APPROVAL_PROMPT } from "../cli/verbs/approve.js";
import type { RunPolicy } from "./runPolicy.js";

/**
 * The one task-run service (V13 TASK-007): every entry point that runs
 * registered tasks — `sta run` for one task, a bounded run for many — drives
 * them here, through `Orchestrator.step()` and nothing else. There is one
 * transition implementation (the orchestrator's), one completion rule
 * (`transitionGuard.ts`, read back through the registry's `waitingOn`), and
 * one status projection per task (`describeStatus` over the persisted row,
 * with the same stage-entry guard the engine asks).
 *
 * The `RunPolicy` decides only *where to stop* and *how much repair to
 * tolerate*; it never touches a stage, an evidence requirement, a transition
 * or completion. A human gate always parks a task: this service never answers
 * one, never asks on stdin and never names an actor.
 */

export interface RunTasksIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** Composes the executor for one task, once, the first time that task has a stage to run. */
export type TaskExecutorFactory = (orchestrator: Orchestrator) => AgentExecutor | Promise<AgentExecutor>;

export interface RunTasksInput {
  registry: TaskRegistry;
  /** Read for the persisted pause/cancel override and the retry counts the budget is measured against. */
  store: TaskStore;
  /** The tasks this invocation drives. Order breaks ties only; dependencies decide what may run. */
  taskIds: readonly string[];
  executorFor: TaskExecutorFactory;
  policy: RunPolicy;
  io: RunTasksIo;
  /**
   * Called with a task's id each time its persisted state may have moved
   * (after every status poll and every step) - where a caller keeps a
   * projection of engine state, such as a bounded run's ledger. It must only
   * read engine state; it decides nothing.
   */
  onStep?: (taskId: string) => void;
}

/**
 * Why the run stopped:
 * - `DONE` every task is DEPLOYED (and its completion verifies);
 * - `BOUNDARY` the policy's `qa` boundary was reached;
 * - `WAITING` a task is parked on a pending human request;
 * - `STUCK` a task waits on a gate no request answers;
 * - `BLOCKED` a task is blocked (including a refused stage entry);
 * - `BUDGET` a task spent the policy's repair budget — a person decides;
 * - `STALLED` a stage ran without moving its task;
 * - `HELD` a person paused or cancelled a task;
 * - `NOT_READY` tasks remain whose dependencies never completed.
 */
export type RunExitKind = "DONE" | "BOUNDARY" | "WAITING" | "STUCK" | "BLOCKED" | "BUDGET" | "STALLED" | "HELD" | "NOT_READY";

/** Process exit code per stop — the codes `sta run` has always returned. */
export const RUN_EXIT_CODES: Readonly<Record<RunExitKind, number>> = {
  DONE: 0,
  BOUNDARY: 0,
  WAITING: 4,
  STUCK: 2,
  BLOCKED: 1,
  BUDGET: 4,
  STALLED: 1,
  HELD: 1,
  NOT_READY: 1,
};

export interface TaskRunResult {
  taskId: string;
  /** The one projection of this task, derived from its persisted state. */
  status: TaskStatusView;
}

export interface RunTasksResult {
  exit: RunExitKind;
  exitCode: number;
  /** The task and reason of the stop, or null for DONE. */
  stoppedAt: { taskId: string; reason: string } | null;
  tasks: TaskRunResult[];
}

/** How one task's drive ended. */
export interface TaskStop {
  kind: Exclude<RunExitKind, "NOT_READY">;
  reason: string;
}

/** The structural slice of an `Orchestrator` one task's drive needs — so the loop is testable on its own. */
export type DrivableTask = Pick<Orchestrator, "taskId" | "status" | "step" | "stageDecision" | "events"> & {
  runLog: Pick<Orchestrator["runLog"], "summary">;
};

export interface DriveTaskOptions {
  policy: RunPolicy;
  io: RunTasksIo;
  refresh: () => void;
  executor: () => Promise<AgentExecutor>;
  /** The persisted human override and failure rounds, read fresh before every step. */
  persisted: () => { paused: boolean; cancelled: boolean; cancelReason: string | null; failureRounds: number };
}

function waitingStop(taskId: string, status: Extract<OrchestratorStatus, { kind: "WAITING_FOR_HUMAN" }>, io: RunTasksIo): TaskStop {
  const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
  io.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
  if (status.approvalType) io.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);
  if (!status.requestId) {
    io.log(`[orchestrator] task ${taskId} stuck waiting: ${status.from} -> ${status.to} has no pending approval request to answer.`);
    return { kind: "STUCK", reason: status.reason };
  }
  io.log(
    `[orchestrator] parking task ${taskId} on pending request ${status.requestId}. ` +
      `A person resolves it through a trusted channel: ` +
      `node orchestrator/dist/cli.js approve ${taskId} --request ${status.requestId} --yes|--no, then --resume.`,
  );
  return { kind: "WAITING", reason: status.reason };
}

/**
 * Steps one task until it deploys or stops. Returns `DONE` for a deployed
 * task; every other kind is a stop the caller's policy acts on.
 */
export async function driveTask(orchestrator: DrivableTask, options: DriveTaskOptions): Promise<TaskStop> {
  const { io, policy } = options;
  const taskId = orchestrator.taskId;
  let qaVerdicts = 0;
  const unsubscribe = [
    orchestrator.events.on("QA_PASSED", () => { qaVerdicts += 1; }),
    orchestrator.events.on("QA_FAILED", () => { qaVerdicts += 1; }),
  ];
  try {
    for (;;) {
      const persisted = options.persisted();
      if (persisted.cancelled) {
        io.log(`[orchestrator] task ${taskId} is cancelled (${persisted.cancelReason ?? "no reason recorded"}) — nothing to run.`);
        return { kind: "HELD", reason: `cancelled: ${persisted.cancelReason ?? "no reason recorded"}` };
      }
      if (persisted.paused) {
        io.log(`[orchestrator] task ${taskId} is paused — use \`resume\`/\`retry\` (or --resume) to continue it.`);
        return { kind: "HELD", reason: "paused" };
      }
      if (policy.maxRepairRounds !== null && persisted.failureRounds > policy.maxRepairRounds) {
        const reason =
          `automatic repair budget (${policy.maxRepairRounds}) spent after ${persisted.failureRounds} failed verification round(s) — ` +
          "a person decides how this task continues; its state is left exactly as the engine recorded it";
        io.log(`[orchestrator] task ${taskId} stopped: ${reason}.`);
        return { kind: "BUDGET", reason };
      }

      const status = orchestrator.status();
      options.refresh();
      if (status.kind === "DEPLOYED") {
        io.log(`[orchestrator] task ${taskId} DEPLOYED.`);
        io.log(orchestrator.runLog.summary(taskId));
        return { kind: "DONE", reason: "deployed" };
      }
      if (status.kind === "BLOCKED") {
        io.log(`[orchestrator] task ${taskId} BLOCKED: ${status.reason}`);
        return { kind: "BLOCKED", reason: status.reason };
      }
      if (status.kind === "WAITING_FOR_HUMAN") return waitingStop(taskId, status, io);

      io.log(`[orchestrator] running ${status.stage}...`);
      const verdictsBefore = qaVerdicts;
      const nextStatus = await orchestrator.step(await options.executor());
      options.refresh();
      if (nextStatus.kind === "RUNNING" && nextStatus.stage === status.stage) {
        io.log(`[orchestrator] ${status.stage} did not advance the task — stopping to avoid a spin loop.`);
        // Why, from STA's own completion decision rather than the agent's report (V13 TASK-003).
        const decision = orchestrator.stageDecision;
        if (decision && !decision.decision.complete) {
          io.log(`[orchestrator]   attempt ${decision.attempt} is incomplete: ${decision.decision.missing.join("; ")}`);
        }
        return { kind: "STALLED", reason: `${status.stage} did not advance the task` };
      }
      if (policy.until === "qa" && status.stage === AgentStage.QA_ENGINEER && qaVerdicts > verdictsBefore) {
        io.log(`[orchestrator] task ${taskId} reached the qa boundary — stopping here as the run policy asks.`);
        return { kind: "BOUNDARY", reason: "qa verdict recorded" };
      }
    }
  } finally {
    for (const off of unsubscribe) off();
  }
}

/**
 * Drives `taskIds` through the engine in dependency order until the policy's
 * boundary. A task becomes runnable only when every dependency's completion
 * verifies (`TaskRegistry.waitingOn`); under `done`, a task that parks or
 * stops leaves its independent siblings running, under `next-gate`/`qa` the
 * first stop ends the run.
 */
export async function runTasks(input: RunTasksInput): Promise<RunTasksResult> {
  const { registry, store, policy, io } = input;
  const settled = new Set<string>();
  const executors = new Map<string, Promise<AgentExecutor>>();
  let firstStop: { kind: RunExitKind; taskId: string; reason: string } | null = null;

  const finish = (stop: { kind: RunExitKind; taskId: string; reason: string } | null): RunTasksResult => {
    const all = store.listTasks();
    const tasks = input.taskIds.map((taskId) => {
      const row = all.find((task) => task.taskId === taskId);
      if (!row) throw new Error(`task ${taskId} vanished from the store during the run`);
      return { taskId, status: describeStatus(row, all, { stageEntryGuard: registry.stageEntryGuard }) };
    });
    const exit = stop?.kind ?? "DONE";
    return { exit, exitCode: RUN_EXIT_CODES[exit], stoppedAt: stop ? { taskId: stop.taskId, reason: stop.reason } : null, tasks };
  };

  for (;;) {
    const next = input.taskIds.find((taskId) => !settled.has(taskId) && registry.waitingOn(taskId).length === 0);
    if (next === undefined) {
      const remaining = input.taskIds.filter((taskId) => !settled.has(taskId));
      if (firstStop) return finish(firstStop);
      if (remaining.length === 0) return finish(null);
      const waiting = remaining.map((taskId) => `${taskId} waits on ${registry.waitingOn(taskId).join(", ")}`).join("; ");
      io.log(`[orchestrator] nothing left to run: ${waiting}.`);
      return finish({ kind: "NOT_READY", taskId: remaining[0]!, reason: waiting });
    }

    const orchestrator = registry.open(next);
    const stop = await driveTask(orchestrator, {
      policy,
      io,
      refresh: () => {
        registry.refreshStateView();
        input.onStep?.(next);
      },
      executor: () => {
        let executor = executors.get(next);
        if (!executor) {
          executor = Promise.resolve(input.executorFor(orchestrator));
          executors.set(next, executor);
        }
        return executor;
      },
      persisted: () => {
        const row = store.loadTask(next);
        if (!row) throw new Error(`task ${next} vanished from the store during the run`);
        return {
          paused: row.paused,
          cancelled: row.cancelled,
          cancelReason: row.cancelReason,
          failureRounds: row.retries.review + row.retries.qa + row.retries.security,
        };
      },
    });
    settled.add(next);
    if (stop.kind === "DONE") continue;

    const reached = { kind: stop.kind, taskId: next, reason: stop.reason };
    // Only a task parking or stopping on its own lets `done` carry on with its
    // independent siblings; a budget, stall, human override or the qa
    // boundary always ends the run.
    const continues = policy.until === "done" && (stop.kind === "WAITING" || stop.kind === "STUCK" || stop.kind === "BLOCKED");
    if (!continues) return finish(reached);
    firstStop ??= reached;
  }
}
