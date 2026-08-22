import type { AgentStage } from "../types.js";
import { type DocKind, CATEGORY_TO_DOC, selectDocContext } from "./contextManager.js";
import { CONTEXT_POLICY } from "./contextSelection.js";

/**
 * T116 — Token Benchmark.
 *
 * `contextManager.ts`'s `selectDocContext()`/`ContextManager.savings()` (T05)
 * already compute a before/after byte count, and `contextManager.test.ts`
 * already proves `savedPct > 0` on a synthetic fixture. Neither one is a
 * benchmark: proving the mechanism can reduce context on a document built to
 * exercise it is not the same claim as knowing what it saves on a document a
 * real project actually produced, at whatever size and heading style that
 * project's agents happened to write. This module exists to run the same
 * mechanism against real documents and report a real number — the T113/T115
 * pattern applied to T05 instead of to adoption/accuracy.
 *
 * WHY THIS DOES NOT USE `ContextManager` DIRECTLY
 *
 * `ContextManager` resolves paths through `moduleDocPath()`, which is fixed to
 * `_docs/module/<name>/` (T113's §22.3 finding: not every real project's docs
 * live there — `sb-web-helper` nests under `_docs/hkt/module/<name>/`).
 * Threading a `docsRoot` through `ContextManager` the way `adopt` threads one
 * through the legacy-import stages is future work this benchmark does not
 * need: `selectDocContext()` itself is pure and only wants markdown text, so
 * a caller that already has the right file open can benchmark it without the
 * path-resolution layer at all.
 *
 * WHY A CHARS-PER-TOKEN ESTIMATE, NOT AN EXACT TOKEN COUNT
 *
 * No tokenizer is a dependency of this repo (T24's dependency list stays
 * short on purpose), and these documents mix Thai prose with English/code
 * identifiers (§11), for which a Latin-only tokenizer heuristic would already
 * be wrong in a way this project cannot correct without shipping a real
 * tokenizer. `runLog.ts` (T28) already made this same call for
 * `context_chars` — measure size in characters, exactly, and let a token
 * figure be a labeled order-of-magnitude estimate on top rather than a second
 * fact that competes with the first. `CHARS_PER_TOKEN_ESTIMATE` exists only to
 * put that estimate in a unit a person reads faster than a raw byte count.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimatedTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/** The real markdown text of whichever module documents are available. Missing ones are simply absent from a role's per-doc breakdown, the same as `ContextManager.read()` returning `null`. */
export type DocSet = Partial<Record<DocKind, string>>;

export interface RoleBenchmarkSpec {
  stage: AgentStage;
  /** Passed straight to `selectDocContext` for `plan`/`design` — omit for a role/doc pair with no phase concept. */
  phases?: number[];
}

export interface DocBenchmark {
  doc: DocKind;
  bytesBefore: number;
  bytesAfter: number;
  fullDocument: boolean;
  reason: string;
}

export interface RoleBenchmarkResult {
  stage: AgentStage;
  docs: DocBenchmark[];
  bytesBefore: number;
  bytesAfter: number;
  savedPct: number;
}

export interface TokenBenchmarkReport {
  roles: RoleBenchmarkResult[];
  totals: {
    bytesBefore: number;
    bytesAfter: number;
    savedPct: number;
    estTokensBefore: number;
    estTokensAfter: number;
    estTokensSaved: number;
  };
}

/**
 * Runs §10's slicing for each `{stage, phases}` spec against one real set of
 * module documents, and totals the result across every role — the aggregate
 * a person actually wants ("how much does this save across a phase's worth of
 * agent runs"), not just one role's number.
 *
 * A role with no entry in `CONTEXT_POLICY` contributes nothing rather than
 * throwing — `selectContext()` already treats an unlisted stage as reading
 * nothing, and a benchmark should report the same silence, not a crash.
 */
export function benchmarkContextSlicing(docs: DocSet, specs: RoleBenchmarkSpec[]): TokenBenchmarkReport {
  const roles: RoleBenchmarkResult[] = specs.map(({ stage, phases }) => {
    const policy = CONTEXT_POLICY[stage];
    const docKinds = policy ? [...new Set(policy.reads.map((c) => CATEGORY_TO_DOC[c]).filter((d): d is DocKind => d !== undefined))] : [];

    const docResults: DocBenchmark[] = [];
    for (const doc of docKinds) {
      const markdown = docs[doc];
      if (markdown === undefined) continue;
      const selected = selectDocContext({ stage, doc, phases }, markdown);
      docResults.push({
        doc,
        bytesBefore: selected.bytesBefore,
        bytesAfter: selected.bytesAfter,
        fullDocument: selected.fullDocument,
        reason: selected.reason,
      });
    }

    const bytesBefore = docResults.reduce((n, d) => n + d.bytesBefore, 0);
    const bytesAfter = docResults.reduce((n, d) => n + d.bytesAfter, 0);
    const savedPct = bytesBefore === 0 ? 0 : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 100);

    return { stage, docs: docResults, bytesBefore, bytesAfter, savedPct };
  });

  const bytesBefore = roles.reduce((n, r) => n + r.bytesBefore, 0);
  const bytesAfter = roles.reduce((n, r) => n + r.bytesAfter, 0);
  const savedPct = bytesBefore === 0 ? 0 : Math.round(((bytesBefore - bytesAfter) / bytesBefore) * 100);

  return {
    roles,
    totals: {
      bytesBefore,
      bytesAfter,
      savedPct,
      estTokensBefore: estimatedTokens(bytesBefore),
      estTokensAfter: estimatedTokens(bytesAfter),
      estTokensSaved: estimatedTokens(bytesBefore - bytesAfter),
    },
  };
}

/** One readable line per role, worst-to-best is not implied — order follows the input specs. For a pilot write-up or a CLI, not for parsing. */
export function describeBenchmark(report: TokenBenchmarkReport): string[] {
  const lines = report.roles.map(
    (r) =>
      `${r.stage}: ${r.bytesBefore.toLocaleString()} -> ${r.bytesAfter.toLocaleString()} bytes (${r.savedPct}% saved)` +
      (r.docs.some((d) => d.fullDocument) ? ` — passed through whole: ${r.docs.filter((d) => d.fullDocument).map((d) => d.doc).join(", ")}` : ""),
  );
  lines.push(
    `TOTAL: ${report.totals.bytesBefore.toLocaleString()} -> ${report.totals.bytesAfter.toLocaleString()} bytes ` +
      `(${report.totals.savedPct}% saved, ~${report.totals.estTokensSaved.toLocaleString()} tokens saved at ${CHARS_PER_TOKEN_ESTIMATE} chars/token)`,
  );
  return lines;
}
