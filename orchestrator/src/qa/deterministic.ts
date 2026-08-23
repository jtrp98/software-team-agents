/**
 * QA03 — Deterministic verification before LLM QA.
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
  ran: DeterministicCheckResult[];
  failures: DeterministicCheckResult[];
  /** Checks not configured for this project — recorded so absence stays visible. */
  skipped: DeterministicCheckId[];
  passed: boolean;
}

/**
 * Returns one check's result, or null when the project has no such check
 * configured. Must never throw for a normal tool failure — report FAIL.
 */
export type DeterministicRunner = (
  id: DeterministicCheckId,
) => Promise<DeterministicCheckResult | null> | DeterministicCheckResult | null;

export async function runDeterministicVerification(runner: DeterministicRunner): Promise<DeterministicVerification> {
  const ran: DeterministicCheckResult[] = [];
  const failures: DeterministicCheckResult[] = [];
  const skipped: DeterministicCheckId[] = [];

  for (const id of DETERMINISTIC_ORDER) {
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
      const failedAt = DETERMINISTIC_ORDER.indexOf(id);
      skipped.push(...DETERMINISTIC_ORDER.slice(failedAt + 1));
      break;
    }
  }

  return { ran, failures, skipped, passed: failures.length === 0 };
}

/** One-line summary for prompts / logs / the evidence package. */
export function renderDeterministicVerification(v: DeterministicVerification): string[] {
  if (v.ran.length === 0 && v.skipped.length === DETERMINISTIC_ORDER.length) {
    return ["deterministic verification: no checks configured for this project"];
  }
  const lines = v.ran.map(
    (r) => `- ${r.id}: ${r.status} (${r.durationMs}ms)${r.outputSummary ? ` — ${firstLine(r.outputSummary)}` : ""}`,
  );
  for (const id of v.skipped) lines.push(`- ${id}: SKIPPED (not configured)`);
  if (!v.passed) {
    const f = v.failures[0];
    lines.push(`BLOCKED before LLM QA by deterministic check \`${f.id}\`:`, tail(f.outputSummary));
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
