import { TaskState } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { describeStatus } from "../orchestrator/taskStatus.js";
import type { StageEntryGuard } from "../orchestrator/stageGuards.js";
import type { LedgerTaskStatus } from "./vocabulary.js";

/**
 * T-V8-016 compatibility adapters — **read only**, and versioned.
 *
 * Bump `LEDGER_ADAPTER_VERSION` whenever a mapping below changes meaning, so a
 * projection carried into evidence can be told apart from a later one.
 */
export const LEDGER_ADAPTER_VERSION = 2;

/** What the engine's projection of one task needs beyond the row itself. */
export interface EngineProjectionContext {
  /** Every task in the store, for dependency readiness (`describeStatus`). */
  allTasks: readonly PersistedTask[];
  /** The stage-entry guard the engine that drives this task is built with. */
  stageEntryGuard: StageEntryGuard;
  /** `verifyTaskCompletion(store, task).done` - DEPLOYED is Done only when its completion evidence re-verifies. */
  completionVerified: boolean;
}

/**
 * The engine's persisted state projected onto the coarse ledger task status
 * (V13 TASK-007, adapter version 2). This is the *only* way a bounded run's
 * ledger task status is written: the ledger is an audit projection of the
 * engine, never a second decider.
 *
 * The input is the engine's own status projection (`describeStatus`, with the
 * same stage-entry guard the engine asks) plus the re-verified completion, so
 * the ledger can never call a task DONE the engine would not:
 *
 * - DEPLOYED with re-verified completion evidence -> DONE; DEPLOYED without it -> BLOCKED;
 * - anything a person must act on (a refused stage entry, a pending approval,
 *   a blocked machine, a pause or cancel) -> BLOCKED;
 * - waiting on a dependency, or not yet started -> PLANNED;
 * - an independent verifier holding the task (reviewer/QA/security) -> VERIFYING;
 * - every verification passed, before the approval/deploy edge -> CHECKPOINTED;
 * - otherwise (an engineer holding it) -> RUNNING.
 */
export function ledgerTaskStatusFromPersisted(task: PersistedTask, context: EngineProjectionContext): LedgerTaskStatus {
  const view = describeStatus(task, context.allTasks, { stageEntryGuard: context.stageEntryGuard });
  switch (view.kind) {
    case "DEPLOYED":
      return context.completionVerified ? "DONE" : "BLOCKED";
    case "BLOCKED":
    case "WAITING_FOR_HUMAN":
    case "PAUSED":
    case "CANCELLED":
      return "BLOCKED";
    case "WAITING_FOR_DEPENDENCY":
      return "PLANNED";
    case "RUNNING":
      break;
  }
  switch (task.machine.current) {
    case TaskState.CREATED:
      return "PLANNED";
    case TaskState.REVIEW:
    case TaskState.REVIEW_FAILED:
    case TaskState.QA:
    case TaskState.QA_FAILED:
    case TaskState.SECURITY:
    case TaskState.SECURITY_FAILED:
      return "VERIFYING";
    case TaskState.READY_TO_DEPLOY:
    case TaskState.APPROVED:
      return "CHECKPOINTED";
    default:
      return "RUNNING";
  }
}
