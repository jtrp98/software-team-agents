/**
 * T-V8-016 — the one transition vocabulary shared by planning, DEV and QA.
 *
 * Before this file there were two: `TaskStore`'s `TaskState` machine (ordinary
 * tasks) and `run/stateMachine.ts`'s `RunState` (wave runs). They describe the
 * same operation at different granularities, which is why resume had to be
 * written twice. The ledger keeps three *levels* instead of two *machines* —
 * a run, the tasks inside it, and the attempts inside a task — and every
 * durable boundary in `runLedger.ts` moves through exactly one of them.
 *
 * `TaskState` is not replaced here. It stays the per-task pipeline machine the
 * `Orchestrator` drives (CREATED -> REQUIREMENT -> ... -> DEPLOYED); the ledger
 * task status is the coarser execution fact a run needs to resume — which is
 * why `adapters.ts` can project one onto the other without either becoming a
 * second copy of the same field.
 */

export const LEDGER_RUN_STATUSES = [
  "CREATED",
  "REGISTERED",
  "RUNNING",
  "HALTED",
  "AWAITING_HUMAN",
  "COMPLETED",
  "REFUSED",
  "CANCELLED",
  "STALE",
] as const;
export type LedgerRunStatus = (typeof LEDGER_RUN_STATUSES)[number];

export const LEDGER_TASK_STATUSES = [
  "PLANNED",
  "READY",
  "RUNNING",
  "VERIFYING",
  "CHECKPOINTED",
  "FAILED",
  "BLOCKED",
  "DONE",
] as const;
export type LedgerTaskStatus = (typeof LEDGER_TASK_STATUSES)[number];

export const LEDGER_ATTEMPT_STATUSES = [
  "FROZEN",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNAVAILABLE",
  "ABANDONED",
  "SUPERSEDED",
] as const;
export type LedgerAttemptStatus = (typeof LEDGER_ATTEMPT_STATUSES)[number];

/**
 * A transition that is neither legal nor a replay of the state already held.
 *
 * Named separately from a plain Error because the acceptance rule is precise:
 * a repeated transition must be *idempotent* or fail with an *actionable*
 * conflict. Everything a caller needs to decide which of those it hit — the
 * level, the identity, both states, and what is legal from here — is on the
 * instance, not only in the message.
 */
export class LedgerTransitionError extends Error {
  constructor(
    public readonly level: "run" | "task" | "attempt",
    public readonly id: string,
    public readonly from: string,
    public readonly to: string,
    public readonly allowed: readonly string[],
  ) {
    super(
      `${level} ${id} cannot move ${from} -> ${to}; legal next states are ${allowed.join(", ") || "none (terminal)"}` +
        " — reconcile the durable record before retrying rather than forcing the write",
    );
    this.name = "LedgerTransitionError";
  }
}

export interface TransitionResult<S extends string> {
  readonly status: S;
  /** True when the record already held `status`, so the write is a replay and not a change. */
  readonly idempotent: boolean;
}

const RUN_TRANSITIONS: Readonly<Record<LedgerRunStatus, readonly LedgerRunStatus[]>> = {
  CREATED: ["REGISTERED", "REFUSED", "CANCELLED"],
  REGISTERED: ["RUNNING", "HALTED", "AWAITING_HUMAN", "REFUSED", "CANCELLED", "STALE"],
  RUNNING: ["HALTED", "AWAITING_HUMAN", "COMPLETED", "CANCELLED", "STALE"],
  HALTED: ["RUNNING", "AWAITING_HUMAN", "CANCELLED", "STALE"],
  AWAITING_HUMAN: ["RUNNING", "HALTED", "CANCELLED", "STALE"],
  COMPLETED: [],
  REFUSED: [],
  CANCELLED: [],
  STALE: [],
};

const TASK_TRANSITIONS: Readonly<Record<LedgerTaskStatus, readonly LedgerTaskStatus[]>> = {
  PLANNED: ["READY", "BLOCKED"],
  READY: ["RUNNING", "BLOCKED", "PLANNED"],
  RUNNING: ["VERIFYING", "FAILED", "BLOCKED"],
  VERIFYING: ["CHECKPOINTED", "FAILED", "BLOCKED"],
  // A checkpoint is not a verdict: QA may still send the task back for a
  // bounded repair round, which re-enters at READY with a repair packet.
  CHECKPOINTED: ["READY", "DONE", "FAILED", "BLOCKED"],
  FAILED: ["READY", "BLOCKED"],
  BLOCKED: ["READY", "PLANNED"],
  DONE: [],
};

const ATTEMPT_TRANSITIONS: Readonly<Record<LedgerAttemptStatus, readonly LedgerAttemptStatus[]>> = {
  FROZEN: ["RUNNING", "ABANDONED", "SUPERSEDED", "UNAVAILABLE"],
  RUNNING: ["SUCCEEDED", "FAILED", "UNAVAILABLE", "ABANDONED"],
  SUCCEEDED: [],
  FAILED: [],
  UNAVAILABLE: [],
  ABANDONED: [],
  SUPERSEDED: [],
};

function apply<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  level: "run" | "task" | "attempt",
  id: string,
  from: S,
  to: S,
): TransitionResult<S> {
  if (from === to) return { status: to, idempotent: true };
  if (table[from].includes(to)) return { status: to, idempotent: false };
  throw new LedgerTransitionError(level, id, from, to, table[from]);
}

export function applyRunStatus(id: string, from: LedgerRunStatus, to: LedgerRunStatus): TransitionResult<LedgerRunStatus> {
  return apply(RUN_TRANSITIONS, "run", id, from, to);
}

export function applyTaskStatus(id: string, from: LedgerTaskStatus, to: LedgerTaskStatus): TransitionResult<LedgerTaskStatus> {
  return apply(TASK_TRANSITIONS, "task", id, from, to);
}

export function applyAttemptStatus(
  id: string,
  from: LedgerAttemptStatus,
  to: LedgerAttemptStatus,
): TransitionResult<LedgerAttemptStatus> {
  return apply(ATTEMPT_TRANSITIONS, "attempt", id, from, to);
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<LedgerRunStatus> = new Set<LedgerRunStatus>([
  "COMPLETED", "REFUSED", "CANCELLED", "STALE",
]);

/** Statuses that mean this task's work is durably on the run branch. */
export const SETTLED_TASK_STATUSES: ReadonlySet<LedgerTaskStatus> = new Set<LedgerTaskStatus>([
  "CHECKPOINTED", "DONE",
]);

/** The published transition table, for evidence and for the audit export's self-description. */
export function transitionVocabulary(): {
  run: Record<string, readonly string[]>;
  task: Record<string, readonly string[]>;
  attempt: Record<string, readonly string[]>;
} {
  return { run: { ...RUN_TRANSITIONS }, task: { ...TASK_TRANSITIONS }, attempt: { ...ATTEMPT_TRANSITIONS } };
}
