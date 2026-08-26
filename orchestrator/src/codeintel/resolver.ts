import * as path from "node:path";
import { AgentStage } from "../types.js";
import { UNIVERSAL_DENY, matchesGlob } from "../agents/pathPermissions.js";
import { assertOperationAllowed } from "./capabilities.js";
import {
  CodeCandidate,
  CodeIntelligenceError,
  CodeIntelligenceProvider,
  CodeIntelOperation,
  IndexError,
  MalformedResponseError,
  MissingIndexError,
  OversizedOutputError,
  ProviderNotInstalledError,
  ProviderStatus,
  ProviderTimeoutError,
  ProviderUnavailableError,
  StaleIndexError,
  TargetRef,
} from "./provider.js";

/**
 * T-GR5 / T-GR6 / T-GR11 / T-GR13 — the one door between the pipeline and a
 * code-intelligence provider.
 *
 * THE FLOW (fixed by TASKS §0.1): ask → freshness gate → scoped query →
 * rank/top-N/dedupe → permission filter → evidence block. The output is text
 * plus candidates that travel through the existing context-injection channel;
 * nothing here touches runtimes, hooks, or settings.
 *
 * WHY EVERY FAILURE IS A FALLBACK, NOT AN ERROR: the pipeline ran to completion
 * before this module existed. A missing tool, a stale index, a timeout — none
 * of them may change task outcomes, so every failure mode collapses onto the
 * same answer: `{ used: false }`, and the caller proceeds with plain search and
 * read exactly as before. With the feature OFF (the default) the resolver never
 * even constructs a provider — behaviour is bit-for-bit what it was (T-GR11).
 *
 * B6 (no permission bypass): the capability matrix decides whether a role may
 * ask at all; the path filter re-checks every returned candidate against the
 * same workspace roots and UNIVERSAL_DENY floor as any other read. A provider
 * that returns a path outside scope loses that path — the tool widens nothing.
 */

/** Telemetry kinds (T-GR13) — rendered through `sta audit` like every other event. */
export const CODE_INTEL_EVENTS = {
  QUERY: "CODE_INTELLIGENCE_QUERY",
  HIT: "CODE_INTELLIGENCE_HIT",
  FALLBACK: "CODE_INTELLIGENCE_FALLBACK",
  STALE: "CODE_INTELLIGENCE_STALE",
  ERROR: "CODE_INTELLIGENCE_ERROR",
  DENIED: "CODE_INTELLIGENCE_DENIED",
  SOURCE_VERIFIED: "CODE_INTELLIGENCE_SOURCE_VERIFIED",
} as const;

/**
 * Why a query answered "don't use the graph". The distinction matters operationally:
 * "disabled"/"not-installed" means the machine is fine; "stale" asks for a rebuild;
 * "timeout"/"malformed"/"oversized" are tool health signals worth watching.
 */
export type FallbackReason =
  | "disabled"
  | "capability-denied"
  | "not-installed"
  | "unavailable"
  | "timeout"
  | "stale"
  | "missing-index"
  | "index-error"
  | "empty-result"
  | "no-allowed-candidates"
  | "malformed"
  | "oversized"
  | "provider-error";

export interface CodeContextResult {
  /** false ⇒ ignore everything else and search/read as usual. */
  used: boolean;
  fallbackReason?: FallbackReason;
  candidates: CodeCandidate[];
  /**
   * Rendered evidence for the prompt. Empty unless `used`. Carries the
   * source-verification directive (T-GR6) — an evidence block without it would
   * invite copy-paste analysis from a map that might be stale.
   */
  evidenceBlock: string;
}

export interface ResolveCodeContextRequest {
  role: AgentStage;
  operation: CodeIntelOperation;
  target: TargetRef;
  /** Audit owner. Without a task there is no trail to append to, so no telemetry. */
  taskId?: string;
  /** For findRelevantCode. */
  description?: string;
  /** For dependencies/dependents/impact. */
  symbol?: string;
  /** For findPath. */
  from?: string;
  to?: string;
  depth?: number;
}

export interface CodeIntelResolverDeps {
  provider?: CodeIntelligenceProvider;
  /** Feature switch. Default OFF — absence must equal the pre-feature pipeline. */
  enabled?: boolean;
  /** Roots results may point into; defaults to the target checkout itself. */
  allowedRoots?: string[];
  topN?: number;
  store?: { appendEvent: (event: { taskId: string; at: number; type: string; payload: Record<string, unknown> }) => void };
  now?: () => number;
}

const DEFAULT_TOP_N = 20;

export async function resolveCodeContext(
  deps: CodeIntelResolverDeps,
  req: ResolveCodeContextRequest,
): Promise<CodeContextResult> {
  if (deps.enabled !== true || !deps.provider) {
    return { used: false, fallbackReason: "disabled", candidates: [], evidenceBlock: "" };
  }

  const emit = telemetryEmitter(deps, req);

  // Capability gate first: a denied query is audited loudly and answers nothing.
  try {
    assertOperationAllowed(req.role, req.operation);
  } catch (error) {
    emit(CODE_INTEL_EVENTS.DENIED, { role: req.role, operation: req.operation, reason: message(error) });
    return { used: false, fallbackReason: "capability-denied", candidates: [], evidenceBlock: "" };
  }

  // Freshness gate second — no query reaches the provider without one.
  const status = await deps.provider.getStatus(req.target).catch((error: unknown): ProviderStatus | null => {
    emit(CODE_INTEL_EVENTS.ERROR, { operation: req.operation, reason: message(error) });
    return null;
  });
  if (!status) {
    return { used: false, fallbackReason: "provider-error", candidates: [], evidenceBlock: "" };
  }
  if (status.status === "stale") {
    emit(CODE_INTEL_EVENTS.STALE, { operation: req.operation, indexed_revision: status.indexedRevision });
    return { used: false, fallbackReason: "stale", candidates: [], evidenceBlock: "" };
  }
  if (status.status === "missing") {
    return fallback(emit, req, "missing-index");
  }
  if (status.status === "error") {
    return fallback(emit, req, "index-error");
  }

  emit(CODE_INTEL_EVENTS.QUERY, { operation: req.operation, target_id: req.target.targetId });

  let candidates: CodeCandidate[];
  try {
    candidates = await dispatch(deps.provider, req);
  } catch (error) {
    return fallback(emit, req, reasonFor(error), message(error));
  }

  if (candidates.length === 0) {
    return fallback(emit, req, "empty-result");
  }

  const ranked = rankAndTrim(candidates, deps.topN ?? DEFAULT_TOP_N);
  const allowed = ranked.filter((candidate) => passesPathFilter(candidate, req.target, deps.allowedRoots));
  if (allowed.length === 0) {
    return fallback(emit, req, "no-allowed-candidates");
  }

  emit(CODE_INTEL_EVENTS.HIT, { operation: req.operation, candidates: allowed.length });
  return {
    used: true,
    candidates: allowed,
    evidenceBlock: renderEvidenceBlock(req.role, req.target.targetId, allowed),
  };
}

async function dispatch(provider: CodeIntelligenceProvider, req: ResolveCodeContextRequest): Promise<CodeCandidate[]> {
  switch (req.operation) {
    case "findRelevantCode":
      if (!req.description) throw new ProviderUnavailableError("findRelevantCode needs a description");
      return provider.findRelevantCode({ target: req.target, description: req.description });
    case "getDependencies":
      return provider.getDependencies({ target: req.target, symbol: requiredSymbol(req.symbol, req.operation) });
    case "getDependents":
      return provider.getDependents({ target: req.target, symbol: requiredSymbol(req.symbol, req.operation) });
    case "findPath":
      if (!req.from || !req.to) throw new ProviderUnavailableError("findPath needs from/to symbols");
      return provider.findPath({ target: req.target, from: req.from, to: req.to });
    case "getImpact":
      return provider.getImpact({ target: req.target, symbol: requiredSymbol(req.symbol, req.operation), depth: req.depth });
  }
}

function requiredSymbol(symbol: string | undefined, operation: CodeIntelOperation): string {
  if (!symbol) throw new ProviderUnavailableError(`${operation} needs a symbol`);
  return symbol;
}

/**
 * B6 — the provider widens nothing. A candidate survives only if it points
 * inside an allowed root AND does not match the universal write-deny floor
 * (.git, node_modules, dist…). Relative traversal tricks (`../`) die at the
 * path.resolve + containment check.
 */
export function passesPathFilter(candidate: CodeCandidate, target: TargetRef, allowedRoots?: string[]): boolean {
  const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [target.rootPath];
  const absolute = path.resolve(target.rootPath, candidate.location.file);
  const insideSomeRoot = roots.some((root) => {
    const canonical = path.resolve(root);
    return absolute === canonical || absolute.startsWith(canonical + path.sep);
  });
  if (!insideSomeRoot) return false;
  const relative = path.relative(path.resolve(target.rootPath), absolute).replace(/\\/g, "/");
  return !UNIVERSAL_DENY.some((glob) => matchesGlob(glob, relative) || matchesGlob(glob, candidate.location.file));
}

export function rankAndTrim(candidates: CodeCandidate[], topN: number): CodeCandidate[] {
  const seen = new Set<string>();
  const out: CodeCandidate[] = [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  for (const candidate of sorted) {
    const key = `${candidate.location.file}:${candidate.location.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * T-GR6 — the guardrail lives IN the artifact, so it cannot be forgotten.
 *
 * Every role gets the same principle sentence and its own concrete rule; the
 * automated test pins these lines, so deleting or softening them fails CI
 * before an evidence block can ever reach a prompt dressed as truth.
 */
export const SOURCE_OF_TRUTH_SENTENCE = "Graphify discovers → Source confirms → Compiler checks → Tests verify.";

export function renderEvidenceBlock(role: AgentStage, targetId: string, candidates: CodeCandidate[]): string {
  const roleRule =
    role === AgentStage.QA_ENGINEER
      ? `- You are QA: verify each finding against real source files and test results BEFORE any verdict. A graph hit NEVER decides pass/fail.`
      : role === AgentStage.SYSTEM_ANALYST
        ? `- You are SA: cross-check every statement below against requirement/design documents AND the actual source files before drawing any conclusion.`
        : `- You are DEV: open and read each relevant file below BEFORE writing or changing any code.`;
  const lines = [
    `## Code intelligence evidence — target \`${targetId}\` (DISCOVERY ONLY)`,
    "",
    SOURCE_OF_TRUTH_SENTENCE,
    "- Graph result is discovery evidence, not implementation truth.",
    roleRule,
    "- If any item below contradicts the real source code, the source code wins — discard the graph claim.",
    "",
    `Candidates (${candidates.length}, provenance-tagged):`,
    ...candidates.map(
      (candidate, index) =>
        `${index + 1}. [${candidate.provenance}] ${candidate.location.file}${candidate.location.line ? `:L${candidate.location.line}` : ""}${candidate.symbol ? ` — ${candidate.symbol}` : ""}${candidate.relation ? ` (${candidate.relation})` : ""}`,
    ),
  ];
  return lines.join("\n");
}

function fallback(
  emit: (type: string, payload: Record<string, unknown>) => void,
  req: ResolveCodeContextRequest,
  reason: FallbackReason,
  detail?: string,
): CodeContextResult {
  emit(CODE_INTEL_EVENTS.FALLBACK, { operation: req.operation, reason, detail });
  return { used: false, fallbackReason: reason, candidates: [], evidenceBlock: "" };
}

function reasonFor(error: unknown): FallbackReason {
  if (error instanceof ProviderNotInstalledError) return "not-installed";
  if (error instanceof ProviderTimeoutError) return "timeout";
  if (error instanceof StaleIndexError) return "stale";
  if (error instanceof MissingIndexError) return "missing-index";
  if (error instanceof IndexError) return "index-error";
  if (error instanceof MalformedResponseError) return "malformed";
  if (error instanceof OversizedOutputError) return "oversized";
  if (error instanceof ProviderUnavailableError) return "unavailable";
  if (error instanceof CodeIntelligenceError) return "provider-error";
  return "provider-error";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/**
 * T-GR13 — audit entries carry METADATA ONLY: counts, revisions, reasons, and
 * at most the top few file paths (paths are already visible in the repo; file
 * contents and secrets never enter a payload — B7).
 */
function telemetryEmitter(
  deps: CodeIntelResolverDeps,
  req: ResolveCodeContextRequest,
): (type: string, payload: Record<string, unknown>) => void {
  return (type, payload) => {
    if (!deps.store || !req.taskId) return;
    try {
      deps.store.appendEvent({
        taskId: req.taskId,
        at: (deps.now ?? Date.now)(),
        type,
        payload: { role: req.role, ...payload },
      });
    } catch {
      // Telemetry must never break the pipeline that hosts it (T-GR11 posture).
    }
  };
}
