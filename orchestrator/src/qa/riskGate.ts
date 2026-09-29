import { TaskLevel } from "../types.js";
import type { QaRiskSignals } from "./mode.js";

/** How much model judgment a QA round receives. Independent from QaMode's verification surface. */
export type QaEffort = "lightweight" | "full";

export interface QaEffortDecision {
  effort: QaEffort;
  reasons: string[];
}

const SIGNAL_REASONS: ReadonlyArray<{ key: keyof QaRiskSignals; reason: string }> = [
  { key: "touchesSchema", reason: "schema/architecture change" },
  { key: "changesSharedContract", reason: "shared contract change" },
  { key: "securitySensitive", reason: "sensitive gate" },
  { key: "migrationOrCutover", reason: "migration/cutover change" },
  { key: "crossTargetImpact", reason: "cross-target impact" },
  { key: "releaseGateRequiresFull", reason: "release gate requires FULL QA" },
];

/**
 * Deterministic risk-to-effort policy. It deliberately shares QaMode's boolean
 * signals without importing or changing QaMode's state machine.
 */
export function selectQaEffort(
  level: TaskLevel | undefined,
  signals: QaRiskSignals = {},
): QaEffortDecision {
  const vetoReasons = SIGNAL_REASONS.filter(({ key }) => signals[key]).map(({ reason }) => reason);
  if (vetoReasons.length > 0) {
    return { effort: "full", reasons: vetoReasons };
  }

  if (level === TaskLevel.LARGE_CRITICAL) {
    return { effort: "full", reasons: ["high/critical task level"] };
  }
  if (level === TaskLevel.UNKNOWN || level === undefined) {
    return { effort: "full", reasons: ["unknown task level; fail closed"] };
  }
  if (level === TaskLevel.MEDIUM) {
    return { effort: "lightweight", reasons: ["medium task level"] };
  }

  // V13 TASK-019 — every QA-requiring task dispatches the QA role; synthetic PASS
  // and skip are removed. Low-risk tasks receive lightweight model QA.
  return { effort: "lightweight", reasons: ["low-risk task"] };
}

