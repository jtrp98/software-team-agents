import type { KnownJournalRecord } from "./journal.js";

export const RUN_STATES = [
  "CREATED",
  "PREFLIGHT",
  "ISOLATED",
  "TASK_READY",
  "TASK_RUNNING",
  "VALIDATING",
  "CHECKPOINTED",
  "WAVE_COMPLETE",
  "HUMAN_REVIEW",
  "REFUSED",
  "HALTED",
  "CANCELLED",
  "STALE",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface RunTransition {
  previous: RunState;
  current: RunState;
  record: KnownJournalRecord;
}

export class IllegalRunTransitionError extends Error {
  constructor(public readonly state: RunState, public readonly recordKind: KnownJournalRecord["kind"]) {
    super(`journal record ${recordKind} cannot be applied while run state is ${state}`);
    this.name = "IllegalRunTransitionError";
  }
}

const terminalStates = new Set<RunState>(["HUMAN_REVIEW", "REFUSED", "CANCELLED", "STALE"]);
const abandonableStates = new Set<RunState>([
  "PREFLIGHT", "ISOLATED", "TASK_READY", "TASK_RUNNING", "VALIDATING", "CHECKPOINTED", "HALTED",
]);

function transition(previous: RunState, current: RunState, record: KnownJournalRecord): RunTransition {
  return { previous, current, record };
}

/** Pure reduction of durable journal history into the canonical run state. */
export function applyRunJournalRecord(state: RunState, record: KnownJournalRecord): RunTransition {
  if (terminalStates.has(state)) throw new IllegalRunTransitionError(state, record.kind);

  if (record.kind === "RUN_STALE" && state === "HALTED") {
    return transition(state, "STALE", record);
  }
  if (record.kind === "RUN_ABANDONED" && abandonableStates.has(state)) {
    return transition(state, "CANCELLED", record);
  }

  switch (state) {
    case "CREATED":
      if (record.kind === "RUN_STARTED") return transition(state, "PREFLIGHT", record);
      break;
    case "PREFLIGHT":
      if (record.kind === "RUN_ISOLATED") return transition(state, "ISOLATED", record);
      if (record.kind === "RUN_REFUSED") return transition(state, "REFUSED", record);
      break;
    case "ISOLATED":
      if (record.kind === "TASK_READY") return transition(state, "TASK_READY", record);
      break;
    case "TASK_READY":
      if (record.kind === "TASK_STARTED") return transition(state, "TASK_RUNNING", record);
      if (record.kind === "RUN_HALTED") return transition(state, "HALTED", record);
      break;
    case "TASK_RUNNING":
      if (record.kind === "TASK_AGENT_DONE") return transition(state, "VALIDATING", record);
      if (record.kind === "TASK_FAILED") return transition(state, "HALTED", record);
      if (record.kind === "RUN_HALTED") return transition(state, "HALTED", record);
      break;
    case "VALIDATING":
      if (record.kind === "GATE_RESULT") return transition(state, state, record);
      if (record.kind === "TASK_FAILED") return transition(state, "HALTED", record);
      if (record.kind === "TASK_CHECKPOINTED") return transition(state, "CHECKPOINTED", record);
      if (record.kind === "RUN_HALTED") return transition(state, "HALTED", record);
      break;
    case "CHECKPOINTED":
      if (record.kind === "TASK_READY") return transition(state, "TASK_READY", record);
      if (record.kind === "RUN_COMPLETED") return transition(state, "WAVE_COMPLETE", record);
      break;
    case "WAVE_COMPLETE":
      if (record.kind === "HUMAN_REVIEW_REQUIRED") return transition(state, "HUMAN_REVIEW", record);
      break;
    case "HALTED":
      if (record.kind === "RUN_HALTED") return transition(state, state, record);
      if (record.kind === "RUN_RESUMED") return transition(state, "TASK_READY", record);
      break;
    case "HUMAN_REVIEW":
    case "REFUSED":
    case "CANCELLED":
    case "STALE":
      break;
  }
  throw new IllegalRunTransitionError(state, record.kind);
}

export function reconstructRunState(records: readonly KnownJournalRecord[]): RunState {
  return records.reduce<RunState>((state, record) => applyRunJournalRecord(state, record).current, "CREATED");
}
