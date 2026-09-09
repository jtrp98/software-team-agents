import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { defaultCacheRoot } from "../codeintel/cache.js";
import { GraphifyProvider } from "../codeintel/graphifyProvider.js";
import { resolveTargetRevision } from "../codeintel/targetRevision.js";
import { resolveCodeContext, type FallbackReason } from "../codeintel/resolver.js";
import type { CodeCandidate, CodeIntelligenceProvider } from "../codeintel/provider.js";
import type { TaskRetrievalQuery } from "../context/retrievalQuery.js";
import { contentHash } from "../artifacts/executionPacket.js";

/**
 * The one place the optional code-intelligence provider touches a run's prompt.
 *
 * The shape copies `sliceModuleDocsFor`'s "additive by design" contract:
 * whatever happens — feature off, tool absent, index stale, timeout, anything
 * thrown — the answer is `[]`, and the prompt is byte-identical to a pipeline
 * without this module. Context enrichment is an optimization; the run
 * proceeding is the requirement.
 *
 * OFF is the default and reads one env var: `STA_CODE_INTEL=on`. There is no
 * settings-file surface and no hook — enabling is a per-machine decision,
 * which is also why discovery scopes itself to the task's bound target root.
 */

export const CODE_INTEL_ENV = "STA_CODE_INTEL";
export const CODE_INTEL_PIN_ENV = "STA_CODE_INTEL_PIN";
/** Binary name/path override — needed where uv's tool bin dir is not on the spawning process's PATH. */
export const CODE_INTEL_BIN_ENV = "STA_CODE_INTEL_BIN";

export function codeIntelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["on", "true", "1"].includes((env[CODE_INTEL_ENV] ?? "").trim().toLowerCase());
}

/** Env → adapter config for the default construction path. Pure, so tests pin it without spawning anything. */
export function defaultProviderConfig(env: Record<string, string | undefined> = process.env): { pinnedVersion?: string; command?: string } {
  return { pinnedVersion: env[CODE_INTEL_PIN_ENV], command: env[CODE_INTEL_BIN_ENV] };
}

export interface CodeIntelSliceInput {
  stage: AgentStage;
  taskId?: string;
  /** Discovery query seed — the module this run works on. Used verbatim only when `query` is absent (T-V8-011: task semantics now win). */
  moduleName?: string;
  /** The bound target checkout whose index would be consulted. */
  targetRoot?: string;
  targetId?: string;
  /**
   * Task-first retrieval semantics (T-V8-011): objective, PM's Query hint,
   * constraints, and task/REQ/AC/DES/contract ids, built by
   * `buildTaskRetrievalQuery`. When its `description` is non-blank it
   * replaces the bare `moduleName` query; `source: "module-fallback"` (or an
   * absent `query`) preserves the pre-T-V8-011 module-name behaviour exactly.
   */
  query?: TaskRetrievalQuery;
  /** Skip revision resolution when the caller already resolved one for this same run (keeps a packet's retrieval candidates and its base_revision from disagreeing). */
  revision?: string;
}

export interface CodeIntelSliceDeps {
  enabled?: boolean;
  env?: Record<string, string | undefined>;
  providerFactory?: () => CodeIntelligenceProvider;
  resolveRevision?: (root: string) => Promise<string>;
  now?: () => number;
}

export interface CodeIntelContextResult {
  /** Rendered prompt fragments — `[]`, or `["", evidenceBlock]` exactly as `codeIntelSlices` always returned. */
  slices: string[];
  /** Structured hits, for callers (packet compilation) that need more than rendered text. `[]` whenever `slices` is `[]`. */
  candidates: CodeCandidate[];
  used: boolean;
  fallbackReason?: FallbackReason | "disabled" | "missing-inputs";
  /** Why the query looked the way it did — provenance for `sta context`/audit, independent of whether the provider hit. */
  queryReason: string;
  /** The exact description sent to `findRelevantCode`, task-specific unless nothing task-specific resolved. */
  description?: string;
}

const NO_QUERY_REASON = "no task-specific query was supplied; the bare module name was used (pre-T-V8-011 behaviour)";

/**
 * The one place the optional code-intelligence provider touches a run's prompt.
 *
 * Superset of the historical `codeIntelSlices` contract: same OFF-by-default,
 * same "any failure degrades to nothing" posture, now also returning the
 * structured candidates and the query provenance a caller may want (DEV/QA
 * packet compilation, `sta context` evidence) without re-querying.
 */
export async function codeIntelContext(input: CodeIntelSliceInput, deps: CodeIntelSliceDeps = {}): Promise<CodeIntelContextResult> {
  const queryReason = input.query?.reason ?? NO_QUERY_REASON;
  if (!(deps.enabled ?? codeIntelEnabled(deps.env))) {
    return { slices: [], candidates: [], used: false, fallbackReason: "disabled", queryReason };
  }
  if (!input.targetRoot || !input.moduleName || !input.targetId) {
    return { slices: [], candidates: [], used: false, fallbackReason: "missing-inputs", queryReason };
  }

  const description = input.query?.description?.trim() ? input.query.description : input.moduleName;

  let provider: CodeIntelligenceProvider;
  try {
    const built = deps.providerFactory?.();
    // An injected factory may return nothing (it is a test/extension seam) —
    // that means "use the default", never "silently disable": silent disables
    // are indistinguishable from broken installs when debugging.
    provider = built ?? new GraphifyProvider({ cacheRoot: defaultCacheRoot(), config: defaultProviderConfig(deps.env) });
    const revision = input.revision ?? (await (deps.resolveRevision ?? ((root) => resolveTargetRevision(root)))(input.targetRoot));
    const result = await resolveCodeContext(
      { enabled: true, provider, now: deps.now },
      {
        role: input.stage,
        operation: "findRelevantCode",
        description,
        target: { targetId: input.targetId, rootPath: input.targetRoot, revision },
        taskId: input.taskId,
      },
    );
    if (!result.used || result.evidenceBlock === "") {
      return { slices: [], candidates: [], used: false, fallbackReason: result.fallbackReason, queryReason, description };
    }
    return { slices: ["", result.evidenceBlock], candidates: result.candidates, used: true, queryReason, description };
  } catch {
    // Same posture as sliceModuleDocsFor: enrichment must never fail a run.
    return { slices: [], candidates: [], used: false, fallbackReason: "disabled", queryReason, description };
  }
}

/** Back-compat surface: every existing caller/test keeps working unchanged. */
export async function codeIntelSlices(input: CodeIntelSliceInput, deps: CodeIntelSliceDeps = {}): Promise<string[]> {
  return (await codeIntelContext(input, deps)).slices;
}

/**
 * Maps discovery candidates onto the packet's `retrieval_candidates` shape
 * (`{ path, symbol?, provenance, revision, hash }` — `artifacts/executionPacket.ts`
 * `RetrievalCandidateSchema`), computed straight off the current working
 * tree so `compileExecutionPacket`'s own drift check
 * (`contentHash(fs.readFileSync(candidate.path)) === candidate.hash`) can
 * verify them exactly like any other packet evidence. A candidate whose file
 * cannot be read is dropped rather than failing the whole packet — discovery
 * enrichment must never block a run.
 */
export function retrievalCandidatesForPacket(
  candidates: readonly CodeCandidate[],
  targetRoot: string,
  revision: string,
): { path: string; symbol?: string; provenance: string; revision: string; hash: string }[] {
  const out: { path: string; symbol?: string; provenance: string; revision: string; hash: string }[] = [];
  for (const candidate of candidates) {
    try {
      const absolute = path.resolve(targetRoot, candidate.location.file);
      const hash = contentHash(fs.readFileSync(absolute));
      out.push({
        path: absolute,
        symbol: candidate.symbol,
        provenance: `${candidate.provenance} discovery via findRelevantCode${candidate.relation ? ` (${candidate.relation})` : ""}`,
        revision,
        hash,
      });
    } catch {
      // Unreadable/denied candidate — same additive posture as the rest of this module.
    }
  }
  return out;
}
