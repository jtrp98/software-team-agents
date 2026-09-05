/**
 * QA Mode Selection (TARGETED vs FULL), and the decision rules the
 * conditional final gate enforces.
 *
 * The selection is deterministic on purpose: same scope + same signals must
 * always produce the same mode, so a task cannot get a lighter verification
 * round by being described differently. Risk signals are booleans supplied by
 * the caller (classification, release policy) — never inferred from prose
 * here, mirroring `classification/taskClassifier.ts`'s stance.
 *
 * Fail-closed: anything ambiguous — an unbounded scope, a missing signal set —
 * lands on FULL. TARGETED is an earned optimization, not a default.
 */

import { z } from "zod";
import type { QaScope } from "./scope.js";

export type QaMode = "FULL" | "TARGETED";

export const QaModeDecisionSchema = z.object({
  taskId: z.string().min(1),
  mode: z.enum(["FULL", "TARGETED"]),
  reasons: z.array(z.string()),
  source: z.enum(["policy", "escalation"]),
  decidedAt: z.number(),
});

export interface QaRiskSignals {
  /** Data model / architecture shape changed. */
  touchesSchema?: boolean;
  /** A shared contract (API shape, design.md contract rule) changed. */
  changesSharedContract?: boolean;
  /** Auth, personal data, payments, untrusted input. */
  securitySensitive?: boolean;
  /** Migration or cutover step. */
  migrationOrCutover?: boolean;
  /** More than one Target is affected. */
  crossTargetImpact?: boolean;
  /** Release policy demands FULL for this point in the pipeline. */
  releaseGateRequiresFull?: boolean;
}

export interface QaModeDecision {
  taskId: string;
  mode: QaMode;
  reasons: string[];
  /** `policy` = decided before the round from scope+risk; `escalation` = widened mid-flight. */
  source: "policy" | "escalation";
  decidedAt: number;
}

export interface SelectQaModeOptions {
  now?: () => number;
}

const SIGNAL_REASONS: ReadonlyArray<{ key: keyof QaRiskSignals; reason: string }> = [
  { key: "touchesSchema", reason: "schema/architecture change" },
  { key: "changesSharedContract", reason: "shared contract change" },
  { key: "securitySensitive", reason: "security-sensitive change" },
  { key: "migrationOrCutover", reason: "migration/cutover change" },
  { key: "crossTargetImpact", reason: "cross-target impact" },
  { key: "releaseGateRequiresFull", reason: "release gate requires FULL QA" },
];

export function selectQaMode(
  taskId: string,
  scope: QaScope,
  signals?: QaRiskSignals,
  opts?: SelectQaModeOptions,
): QaModeDecision {
  const reasons: string[] = [];
  for (const { key, reason } of SIGNAL_REASONS) {
    if (signals?.[key]) reasons.push(reason);
  }
  if (!scope.bounded && scope.unboundedReason) reasons.push(`unbounded scope: ${scope.unboundedReason}`);

  if (reasons.length > 0) {
    return { taskId, mode: "FULL", reasons, source: "policy", decidedAt: (opts?.now ?? Date.now)() };
  }

  return {
    taskId,
    mode: "TARGETED",
    reasons: [
      "bounded change-aware scope",
      "no high-risk boundary signal",
      `scope covers ${scope.changedFiles.length} changed + ${scope.impactedFiles.length} impacted file(s)`,
    ],
    source: "policy",
    decidedAt: (opts?.now ?? Date.now)(),
  };
}

/** TARGETED found cross-boundary impact (or a person asked): widen to FULL, keeping the audit trail of why. */
export function escalateMode(decision: QaModeDecision, reason: string, now: () => number = Date.now): QaModeDecision {
  if (decision.mode === "FULL") return decision;
  return {
    ...decision,
    mode: "FULL",
    source: "escalation",
    reasons: [...decision.reasons, `escalated to FULL: ${reason}`],
    decidedAt: now(),
  };
}

export interface DowngradePolicy {
  /**
   * Deliberately never true in shipped policy: a FULL decision exists because
   * something named a high-risk fact, and nothing that happens later un-names
   * it. The parameter exists so a future policy can opt in explicitly instead
   * of someone loosening this file.
   */
  allowDowngrade: boolean;
}

export class QaModeDowngradeError extends Error {
  constructor(reason: string) {
    super(`refusing to downgrade QA mode FULL -> TARGETED: ${reason}`);
    this.name = "QaModeDowngradeError";
  }
}

export function downgradeMode(
  decision: QaModeDecision,
  policy: DowngradePolicy,
  reason: string,
  now: () => number = Date.now,
): QaModeDecision {
  if (!policy.allowDowngrade) {
    throw new QaModeDowngradeError("no policy supports downgrading a FULL decision");
  }
  if (decision.source === "escalation") {
    throw new QaModeDowngradeError("an escalated decision cannot be undone by policy");
  }
  return {
    ...decision,
    mode: "TARGETED",
    reasons: [...decision.reasons, `downgraded to TARGETED by policy: ${reason}`],
    decidedAt: now(),
  };
}

/**
 * Whether a PASSing qa-report may close the round it was written for.
 *
 * A decision of FULL is only satisfied by a report that says FULL — a
 * TARGETED report against a FULL decision does not pass. No decision on
 * record keeps the pre-optimization behaviour (PASS alone closes), which
 * keeps this gate backward-compatible with older runs.
 */
export function canCloseWith(decision: QaModeDecision | undefined, reportMode: QaMode): { allowed: boolean; reason?: string } {
  if (!decision) return { allowed: true };
  if (decision.mode === "FULL" && reportMode !== "FULL") {
    return {
      allowed: false,
      reason:
        "this task's QA decision is FULL (" +
        decision.reasons.join("; ") +
        ") but the qa-report says TARGETED — re-run qa-engineer in FULL mode before the round can close",
    };
  }
  return { allowed: true };
}
