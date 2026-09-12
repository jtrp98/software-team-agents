import type { QaReportArtifact } from "../artifacts/schemas.js";
import { canCloseWith, type QaMode, type QaModeDecision } from "./mode.js";

/**
 * T-V8-014 — "every verdict maps to task/AC/DES/evidence; bare PASS is
 * rejected", made mechanical.
 *
 * Before this, `parseQaReport` produced `requirements: {}` for every round it
 * ever read, so a passing QA report asserted "this task is fine" without
 * naming a single acceptance criterion it had checked — and the QA gate
 * accepted it, because `Object.values({}).every(...)` is vacuously true. The
 * report carried a status and some bullet lines; it did not carry a verdict in
 * any checkable sense.
 *
 * This module is the check that closes that. It is deliberately not a
 * *judgement*: it never decides whether the work is good, only whether the
 * round said enough to be judged. Missing coverage on a FAIL is information;
 * missing coverage on a PASS is a refusal.
 */

export interface QaVerdictCoverage {
  ok: boolean;
  /** Blocking reasons — non-empty means this report may not close its round. */
  problems: string[];
  /** Required ids the report gave a verdict for. */
  covered: string[];
  /** Required ids the report left unmapped. */
  uncovered: string[];
  /** Ids the report verdicted that were not required — allowed (QA may verify more), reported for audit. */
  extra: string[];
}

export interface CheckQaVerdictCoverageInput {
  report: Pick<QaReportArtifact, "status" | "mode" | "requirements" | "unverifiedBehaviour">;
  /** Ids from `requiredVerdictIds(contract)` — task, its ACs/DES, and every open finding. */
  required: readonly string[];
  /** The round's recorded mode decision, when one exists. */
  decision?: QaModeDecision;
}

/** The exact wording a caller surfaces on rejection, so prompts and tests agree on one phrase. */
export const BARE_PASS_REASON =
  "bare PASS rejected: the report maps no acceptance/design/task id to a verdict, so there is nothing to check it against";

export function checkQaVerdictCoverage(input: CheckQaVerdictCoverageInput): QaVerdictCoverage {
  const { report } = input;
  const required = [...new Set(input.required)];
  const verdicted = Object.keys(report.requirements);
  const requiredSet = new Set(required);
  const verdictedSet = new Set(verdicted);
  const covered = required.filter((id) => verdictedSet.has(id));
  const uncovered = required.filter((id) => !verdictedSet.has(id));
  const extra = verdicted.filter((id) => !requiredSet.has(id)).sort();
  const problems: string[] = [];

  if (required.length > 0 && verdicted.length === 0) {
    problems.push(`${BARE_PASS_REASON} (expected: ${required.join(", ")})`);
  } else if (report.status === "PASS" && uncovered.length > 0) {
    // A PASS may not be wider than its evidence. Naming the gap in
    // `## Unverified Behaviour` is the honest alternative and is accepted —
    // that is what "missing executable tests remain explicit Unverified
    // Behaviour" means when the missing thing is a whole acceptance criterion.
    const declared = new Set(
      report.unverifiedBehaviour.flatMap((line) => uncovered.filter((id) => line.includes(id))),
    );
    const undeclared = uncovered.filter((id) => !declared.has(id));
    if (undeclared.length > 0) {
      problems.push(
        `PASS does not cover ${undeclared.length} required id(s): ${undeclared.join(", ")} — ` +
          "give each an explicit verdict with evidence, or name it under `## Unverified Behaviour` as read-but-not-executed",
      );
    }
  }

  // A FULL decision is only discharged by a FULL report — the pre-existing
  // rule, checked here too so a caller that never reaches the gate (a
  // rejection converted to FAIL before the transition) reports the same reason.
  const close = canCloseWith(input.decision, report.mode as QaMode);
  if (!close.allowed && report.status === "PASS") problems.push(close.reason!);

  return { ok: problems.length === 0, problems, covered, uncovered, extra };
}

/** One-line audit rendering for the run log and evidence records. */
export function describeQaVerdictCoverage(coverage: QaVerdictCoverage): string {
  return (
    `verdict coverage ${coverage.covered.length}/${coverage.covered.length + coverage.uncovered.length}` +
    (coverage.uncovered.length > 0 ? `; uncovered ${coverage.uncovered.join(", ")}` : "") +
    (coverage.extra.length > 0 ? `; extra ${coverage.extra.join(", ")}` : "") +
    (coverage.ok ? "" : `; PROBLEMS: ${coverage.problems.join(" | ")}`)
  );
}
