import type { RunBoundary } from "../ledger/runLedger.js";

/**
 * How far one invocation drives its tasks through the one task engine
 * (V13 TASK-007), and how many automatic repair rounds it may spend doing so.
 *
 * A policy is a *limit*, never a semantic: it decides only where
 * `taskRunService.runTasks` stops stepping and how much failure it tolerates
 * before handing the task to a person. It cannot add, drop or reorder a
 * stage, change what evidence a stage needs, relax a transition rule, or
 * decide that a task is complete — those belong to the `Orchestrator` and its
 * transition guard alone, identically for every policy.
 */
export interface RunPolicy {
  /**
   * Where to stop:
   * - `next-gate`: at the first task that parks (WAITING_FOR_HUMAN) or stops (BLOCKED);
   * - `qa`: right after the first QA verdict a task records in this run;
   * - `done`: once every task is DEPLOYED or can go no further on its own.
   */
  until: RunBoundary;
  /**
   * The automatic repair budget: once a task's recorded failure rounds
   * (`retries.review + retries.qa + retries.security`) exceed it, the run
   * stops for a person and leaves the task exactly as the engine left it.
   * Null = no budget beyond the engine's own retry ceiling.
   */
  maxRepairRounds: number | null;
}

/** The ordinary automatic repair limit of a bounded (multi-task) run. */
export const MAX_AUTOMATIC_REPAIR_ROUNDS = 2;

/**
 * `sta run`: one task, stepped until it deploys or parks/stops for a person;
 * no budget beyond the engine's own retry ceiling.
 */
export const SINGLE_TASK_POLICY: RunPolicy = Object.freeze({ until: "next-gate", maxRepairRounds: null });

/** A bounded run: the operator's boundary, with the ordinary automatic repair limit. */
export function boundedRunPolicy(until: RunBoundary, maxRepairRounds: number = MAX_AUTOMATIC_REPAIR_ROUNDS): RunPolicy {
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0) {
    throw new Error(`a bounded run's repair budget must be a non-negative integer (got ${maxRepairRounds})`);
  }
  return { until, maxRepairRounds };
}
