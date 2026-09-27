/**
 * Deterministic verification before LLM QA.
 *
 * The expensive model must not be the first thing to discover a broken
 * typecheck. Every check a tool can run runs first, in a fixed order, and a
 * failure stops the sequence: the round goes back to implementation with the
 * tool's own output as evidence, and qa-engineer is never invoked to explain
 * what `tsc` already said plainly.
 *
 * The runner is injected — this module owns *when* and *in what order*, not
 * *how* each command executes (that belongs to the caller's Target stack).
 * A check returning null means "not configured for this project", which is
 * recorded as skipped rather than guessed at.
 */

export type DeterministicCheckId = "lint" | "typecheck" | "unit-tests" | "integration-tests" | "build";

/** Fixed order — cheapest, most-localized checks first; build last because it subsumes little but costs most. */
export const DETERMINISTIC_ORDER: readonly DeterministicCheckId[] = [
  "lint",
  "typecheck",
  "unit-tests",
  "integration-tests",
  "build",
];

export interface DeterministicTargetResult {
  targetId?: string;
  root: string;
  status: "PASS" | "FAIL";
  durationMs: number;
  outputSummary: string;
}

export interface DeterministicCheckResult {
  id: DeterministicCheckId;
  status: "PASS" | "FAIL";
  durationMs: number;
  /** Tail of the tool's own output — the evidence an engineer fixes from. */
  outputSummary: string;
  /**
   * V13 TASK-018 — the real process exit code the command produced, when the
   * runner knows one; null when the runner graded a report that carries no
   * exit code (the static-analysis gate's per-check rows) and absent when the
   * runner predates the field.
   */
  exitCode?: number | null;
  /** Per-Target results when verification ran across multiple targets (T-V9-015). */
  targetResults?: readonly DeterministicTargetResult[];
}

export interface DeterministicVerification {
  /** Checks selected for this task, already normalized into fixed execution order. */
  required: DeterministicCheckId[];
  ran: DeterministicCheckResult[];
  failures: DeterministicCheckResult[];
  /** Checks not configured for this project — recorded so absence stays visible. */
  skipped: DeterministicCheckId[];
  /** Required sweep-owned checks which produced no executable evidence — each one blocks. */
  missingRequired: string[];
  /**
   * Required policy levels with no deterministic runner (api/e2e). The sweep
   * cannot produce their evidence; they stay the QA strategy floor's visible
   * requirements, recorded here instead of blocking a stage on a check that
   * can never run.
   */
  runnerless: string[];
  /** `skipped` is deliberately distinct from a successful verification. */
  status: "passed" | "failed" | "skipped";
  /**
   * V13 TASK-017 — required deterministic guards are always enforced. The
   * historical `warn` posture (a missing required check passes) is deleted:
   * a required check that produced no evidence blocks the stage.
   */
  enforcement: "enforce";
  passed: boolean;
  selection?: {
    source: string;
    taskTypes: string[];
    levels: string[];
    reason: string;
  };
  /**
   * V13 TASK-018 — sha256 over the change-set fingerprint the sweep graded,
   * when the hook captured one: evidence that these test/build results speak
   * about exactly this source state, and that a later edit invalidates them.
   */
  changeSetDigest?: string;
}

export interface DeterministicVerificationOptions {
  /** RuntimeTask.required_verification levels. Omitted preserves the full historical order. */
  levels?: readonly string[];
}

/**
 * Returns one check's result, or null when the project has no such check
 * configured. Must never throw for a normal tool failure — report FAIL.
 */
export type DeterministicRunner = (
  id: DeterministicCheckId,
) => Promise<DeterministicCheckResult | null> | DeterministicCheckResult | null;

function checkForLevel(level: string): DeterministicCheckId | null {
  switch (level) {
    case "lint": return "lint";
    case "typecheck": return "typecheck";
    case "unit":
    case "unit-tests": return "unit-tests";
    case "integration":
    case "integration-tests": return "integration-tests";
    case "build": return "build";
    default: return null;
  }
}

/**
 * Checks the deterministic runner can never execute (V13 TASK-017/018) — a
 * required one is recorded as `runnerless`, not missing, because the sweep
 * owns no way to produce its evidence (the QA strategy enforces it instead).
 * The project runner is the authority on this; importing it here keeps one
 * declaration.
 */
import { SWEEP_RUNNERLESS_CHECKS } from "./projectRunner.js";

export function deterministicChecksForLevels(levels: readonly string[]): DeterministicCheckId[] {
  const selected = new Set(levels.map(checkForLevel).filter((id): id is DeterministicCheckId => id !== null));
  return DETERMINISTIC_ORDER.filter((id) => selected.has(id));
}

export async function runDeterministicVerification(
  runner: DeterministicRunner,
  options: DeterministicVerificationOptions = {},
): Promise<DeterministicVerification> {
  const ran: DeterministicCheckResult[] = [];
  const failures: DeterministicCheckResult[] = [];
  const skipped: DeterministicCheckId[] = [];
  const runnerless: string[] = [];
  const required = options.levels === undefined
    ? [...DETERMINISTIC_ORDER]
    : deterministicChecksForLevels(options.levels);
  const unsupportedRequired = (options.levels ?? []).filter((level) => checkForLevel(level) === null);

  for (const id of required) {
    let result: DeterministicCheckResult | null;
    try {
      result = await runner(id);
    } catch (e) {
      result = {
        id,
        status: "FAIL",
        durationMs: 0,
        outputSummary: `runner threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (result === null) {
      // A check the runner can never execute is a fact about the sweep, not a
      // skipped obligation; a check it could execute but this project has not
      // configured is missing required evidence and blocks.
      if (SWEEP_RUNNERLESS_CHECKS.includes(id)) runnerless.push(id);
      else skipped.push(id);
      continue;
    }
    ran.push(result);
    if (result.status === "FAIL") {
      failures.push(result);
      // Later checks would fail on the same root cause — spend nothing more on
      // them, but record them as not-run rather than letting their absence read
      // as "passed implicitly".
      const failedAt = required.indexOf(id);
      for (const later of required.slice(failedAt + 1)) {
        if (SWEEP_RUNNERLESS_CHECKS.includes(later)) runnerless.push(later);
        else skipped.push(later);
      }
      break;
    }
  }

  const missingRequired = [...skipped];
  const status = failures.length > 0 ? "failed" : ran.length === 0 ? "skipped" : "passed";
  // V13 TASK-017 — always enforced: a required check that produced no evidence
  // (not configured, or a failure stopped the sequence before it ran) blocks.
  // A required level the sweep can never grade (api/e2e, integration) is
  // recorded as `runnerless`, not missing: the sweep owns no evidence for it
  // to withhold, and the QA strategy enforces it instead.
  const passed = failures.length === 0 && missingRequired.length === 0;
  return { required, ran, failures, skipped, missingRequired, runnerless: [...unsupportedRequired, ...runnerless], status, enforcement: "enforce", passed };
}

/** One-line summary for prompts / logs / the evidence package. */
export function renderDeterministicVerification(v: DeterministicVerification): string[] {
  const selectionLines = v.selection
    ? [
        `verification selection: ${v.selection.source}; task types: ${v.selection.taskTypes.join(", ") || "(none)"}`,
        `selection reason: ${v.selection.reason}`,
      ]
    : [];
  if (v.status === "skipped") {
    const lines = [...selectionLines, "deterministic verification: no checks configured for this project — SKIPPED (not PASS)"];
    for (const level of v.runnerless) {
      lines.push(`- ${level}: NO RUNNER (QA strategy floor requirement, not a sweep check)`);
    }
    if (v.missingRequired.length > 0) {
      lines.push(`BLOCKED by test-pyramid enforcement; missing required evidence: ${v.missingRequired.join(", ")}`);
    }
    return lines;
  }
  const lines = [...selectionLines];
  for (const r of v.ran) {
    if (r.targetResults && r.targetResults.length > 1) {
      lines.push(`- ${r.id}: ${r.status} (${r.durationMs}ms)`);
      for (const t of r.targetResults) {
        const label = t.targetId ? `[${t.targetId}]` : `[${t.root}]`;
        lines.push(`  - ${label} ${t.status} (${t.durationMs}ms)${t.outputSummary ? ` — ${firstLine(t.outputSummary)}` : ""}`);
      }
    } else {
      lines.push(`- ${r.id}: ${r.status} (${r.durationMs}ms)${r.outputSummary ? ` — ${firstLine(r.outputSummary)}` : ""}`);
    }
  }
  for (const id of v.skipped) lines.push(`- ${id}: SKIPPED (not configured)`);
  for (const level of v.runnerless) {
    lines.push(`- ${level}: NO RUNNER (QA strategy floor requirement, not a sweep check)`);
  }
  if (!v.passed) {
    const f = v.failures[0];
    if (f) {
      const failedTargets = f.targetResults?.filter((t) => t.status === "FAIL");
      if (failedTargets && failedTargets.length > 0) {
        const names = failedTargets.map((t) => t.targetId ?? t.root).join(", ");
        lines.push(`BLOCKED before LLM QA by deterministic check \`${f.id}\` in Target (${names}):`, tail(f.outputSummary));
      } else {
        lines.push(`BLOCKED before LLM QA by deterministic check \`${f.id}\`:`, tail(f.outputSummary));
      }
    } else {
      lines.push(`BLOCKED by test-pyramid enforcement; missing required evidence: ${v.missingRequired.join(", ")}`);
    }
  }
  return lines;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}

function tail(s: string, maxLines = 20): string {
  const lines = s.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}
