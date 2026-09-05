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

export interface DeterministicCheckResult {
  id: DeterministicCheckId;
  status: "PASS" | "FAIL";
  durationMs: number;
  /** Tail of the tool's own output — the evidence an engineer fixes from. */
  outputSummary: string;
}

export interface DeterministicVerification {
  /** Checks selected for this task, already normalized into fixed execution order. */
  required: DeterministicCheckId[];
  ran: DeterministicCheckResult[];
  failures: DeterministicCheckResult[];
  /** Checks not configured for this project — recorded so absence stays visible. */
  skipped: DeterministicCheckId[];
  /** Required policy levels which produced no executable evidence. */
  missingRequired: string[];
  /** `skipped` is deliberately distinct from a successful verification. */
  status: "passed" | "failed" | "skipped";
  enforcement: "warn" | "enforce";
  passed: boolean;
}

export interface DeterministicVerificationOptions {
  /** RuntimeTask.required_verification levels. Omitted preserves the full historical order. */
  levels?: readonly string[];
  /** Defaults to warning-only; enforcement requires an explicit policy value. */
  enforcement?: "warn" | "enforce";
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
  const enforcement = options.enforcement ?? "warn";
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
      skipped.push(id);
      continue;
    }
    ran.push(result);
    if (result.status === "FAIL") {
      failures.push(result);
      // Later checks would fail on the same root cause — spend nothing more on
      // them, but record them as not-run rather than letting their absence read
      // as "passed implicitly".
      const failedAt = required.indexOf(id);
      skipped.push(...required.slice(failedAt + 1));
      break;
    }
  }

  const missingRequired = [...unsupportedRequired, ...skipped];
  const status = failures.length > 0 ? "failed" : ran.length === 0 ? "skipped" : "passed";
  const passed = failures.length === 0 && !(enforcement === "enforce" && missingRequired.length > 0);
  return { required, ran, failures, skipped, missingRequired, status, enforcement, passed };
}

/** One-line summary for prompts / logs / the evidence package. */
export function renderDeterministicVerification(v: DeterministicVerification): string[] {
  if (v.status === "skipped") {
    const lines = ["deterministic verification: no checks configured for this project — SKIPPED (not PASS)"];
    if (v.enforcement === "enforce" && v.missingRequired.length > 0) {
      lines.push(`BLOCKED by test-pyramid enforcement; missing required evidence: ${v.missingRequired.join(", ")}`);
    }
    return lines;
  }
  const lines = v.ran.map(
    (r) => `- ${r.id}: ${r.status} (${r.durationMs}ms)${r.outputSummary ? ` — ${firstLine(r.outputSummary)}` : ""}`,
  );
  for (const id of v.skipped) lines.push(`- ${id}: SKIPPED (not configured)`);
  for (const level of v.missingRequired.filter((level) => checkForLevel(level) === null)) {
    lines.push(`- ${level}: SKIPPED (no V3 runtime runner)`);
  }
  if (!v.passed) {
    const f = v.failures[0];
    if (f) lines.push(`BLOCKED before LLM QA by deterministic check \`${f.id}\`:`, tail(f.outputSummary));
    else lines.push(`BLOCKED by test-pyramid enforcement; missing required evidence: ${v.missingRequired.join(", ")}`);
  } else if (v.missingRequired.length > 0) {
    lines.push(`WARNING (warn-only): missing required evidence: ${v.missingRequired.join(", ")}`);
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
