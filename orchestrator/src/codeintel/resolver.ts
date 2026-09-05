import * as fs from "node:fs/promises";
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
 * The one door between the pipeline and a code-intelligence provider.
 *
 * THE FLOW: ask → freshness gate → scoped query → rank/top-N/dedupe →
 * permission filter → evidence block. The output is text plus candidates
 * that travel through the existing context-injection channel; nothing
 * here touches runtimes, hooks, or settings.
 *
 * WHY EVERY FAILURE IS A FALLBACK, NOT AN ERROR: the pipeline ran to completion
 * before this module existed. A missing tool, a stale index, a timeout — none
 * of them may change task outcomes, so every failure mode collapses onto the
 * same answer: `{ used: false }`, and the caller proceeds with plain search and
 * read exactly as before. With the feature OFF (the default) the resolver never
 * even constructs a provider — behaviour is bit-for-bit what it was.
 *
 * No permission bypass: the capability matrix decides whether a role may
 * ask at all; the path filter re-checks every returned candidate against the
 * same workspace roots and UNIVERSAL_DENY floor as any other read. A provider
 * that returns a path outside scope loses that path — the tool widens nothing.
 */

/** Telemetry kinds — rendered through `sta audit` like every other event. */
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
   * source-verification directive — an evidence block without it would
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
  /** Maximum source lines recovered around one graph location. */
  spanLines?: number;
  /** Maximum UTF-8 bytes in one recovered source span. */
  maxSpanBytes?: number;
  /** Maximum candidates allowed into one evidence block. */
  maxEvidenceCandidates?: number;
  /** Maximum UTF-8 bytes in the complete rendered evidence block. */
  maxEvidenceBlockBytes?: number;
  /** Test seam; called only after lexical and real-path validation. */
  readSourceFile?: (absolutePath: string) => Promise<string>;
  store?: { appendEvent: (event: { taskId: string; at: number; type: string; payload: Record<string, unknown> }) => void };
  now?: () => number;
}

export const DEFAULT_TOP_N = 8;
export const DEFAULT_SPAN_LINES = 40;
export const MAX_SPAN_LINES = 80;
export const DEFAULT_MAX_SPAN_BYTES = 3_000;
export const DEFAULT_MAX_EVIDENCE_CANDIDATES = 8;
export const DEFAULT_MAX_EVIDENCE_BLOCK_BYTES = 16_384;
const MAX_SIGNATURE_BYTES = 400;

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

  const candidateLimit = Math.min(
    cappedPositiveInt(deps.topN, DEFAULT_TOP_N, DEFAULT_MAX_EVIDENCE_CANDIDATES),
    cappedPositiveInt(deps.maxEvidenceCandidates, DEFAULT_MAX_EVIDENCE_CANDIDATES, DEFAULT_MAX_EVIDENCE_CANDIDATES),
  );
  const ranked = rankAndTrim(candidates, candidateLimit);
  const allowed = ranked.filter((candidate) => passesPathFilter(candidate, req.target, deps.allowedRoots));
  if (allowed.length === 0) {
    return fallback(emit, req, "no-allowed-candidates");
  }

  // Candidate source supplied by an index is never trusted. Only after the
  // lexical permission filter above do we resolve symlinks, re-check the real
  // path, and read a bounded excerpt from the current working tree.
  const enriched = await Promise.all(
    allowed.map((candidate) => enrichFromWorkingTree(candidate, req.target, deps)),
  );
  const verified = enriched.filter((candidate): candidate is CodeCandidate => candidate !== null);
  if (verified.length === 0) {
    return fallback(emit, req, "no-allowed-candidates");
  }

  const evidenceBlock = renderEvidenceBlock(req.role, req.target.targetId, verified, {
    maxCandidates: candidateLimit,
    maxBytes: cappedPositiveInt(
      deps.maxEvidenceBlockBytes,
      DEFAULT_MAX_EVIDENCE_BLOCK_BYTES,
      DEFAULT_MAX_EVIDENCE_BLOCK_BYTES,
    ),
  });
  if (evidenceBlock === "") {
    return fallback(emit, req, "oversized", "evidence block cap is smaller than the required source-of-truth guardrail");
  }

  emit(CODE_INTEL_EVENTS.HIT, { operation: req.operation, candidates: verified.length });
  return {
    used: true,
    candidates: verified,
    evidenceBlock,
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
 * The provider widens nothing. A candidate survives only if it points
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

async function enrichFromWorkingTree(
  candidate: CodeCandidate,
  target: TargetRef,
  deps: CodeIntelResolverDeps,
): Promise<CodeCandidate | null> {
  // Strip provider/index source payloads even if a future provider starts
  // returning them. Current working-tree bytes always win.
  const verified: CodeCandidate = { ...candidate, signature: undefined, span: undefined };
  const resolution = await readableRealPath(candidate, target, deps.allowedRoots);
  if (resolution.kind === "denied") return null;
  if (resolution.kind === "unreadable") return verified;

  let source: string;
  try {
    source = await (deps.readSourceFile ?? readUtf8Source)(resolution.path);
  } catch {
    return verified;
  }

  const evidence = sourceEvidence(
    source,
    candidate.location.line,
    cappedPositiveInt(deps.spanLines, DEFAULT_SPAN_LINES, MAX_SPAN_LINES),
    cappedPositiveInt(deps.maxSpanBytes, DEFAULT_MAX_SPAN_BYTES, DEFAULT_MAX_SPAN_BYTES),
  );
  return { ...verified, ...evidence };
}

async function readableRealPath(
  candidate: CodeCandidate,
  target: TargetRef,
  allowedRoots?: string[],
): Promise<{ kind: "allowed"; path: string } | { kind: "denied" } | { kind: "unreadable" }> {
  // This lexical filter is deliberately repeated at the read boundary. Do not
  // move realpath/stat/read calls above it: denied candidates must cause no
  // source filesystem access at all.
  if (!passesPathFilter(candidate, target, allowedRoots)) return { kind: "denied" };
  try {
    const absolute = path.resolve(target.rootPath, candidate.location.file);
    const realCandidate = await fs.realpath(absolute);
    const roots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [target.rootPath];
    const realRoots = await Promise.all(roots.map((root) => fs.realpath(path.resolve(root))));
    if (!realRoots.some((root) => isWithin(realCandidate, root))) return { kind: "denied" };
    const relative = path.relative(await fs.realpath(path.resolve(target.rootPath)), realCandidate).replace(/\\/g, "/");
    if (UNIVERSAL_DENY.some((glob) => matchesGlob(glob, relative) || matchesGlob(glob, candidate.location.file))) return { kind: "denied" };
    return { kind: "allowed", path: realCandidate };
  } catch {
    return { kind: "unreadable" };
  }
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

async function readUtf8Source(absolutePath: string): Promise<string> {
  return fs.readFile(absolutePath, "utf8");
}

function sourceEvidence(
  source: string,
  indexedLine: number | undefined,
  maxLines: number,
  maxBytes: number,
): Pick<CodeCandidate, "signature" | "span"> {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const anchor = indexedLine ?? 1;
  // An out-of-range indexed location is stale evidence. Do not relocate the
  // symbol heuristically and accidentally make an old graph claim look valid.
  if (anchor < 1 || anchor > lines.length) return {};

  const before = Math.floor((maxLines - 1) / 2);
  const startIndex = Math.max(0, Math.min(anchor - 1 - before, Math.max(0, lines.length - maxLines)));
  const selected: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(startIndex, startIndex + maxLines)) {
    const nextBytes = Buffer.byteLength(line, "utf8") + (selected.length === 0 ? 0 : 1);
    // Keep line evidence exact. A minified/oversized first line yields no span
    // rather than a plausible-looking fragment.
    if (bytes + nextBytes > maxBytes) break;
    selected.push(line);
    bytes += nextBytes;
  }

  const signatureLine = lines[anchor - 1].trim();
  const signature = signatureLine !== "" && Buffer.byteLength(signatureLine, "utf8") <= MAX_SIGNATURE_BYTES
    ? signatureLine
    : undefined;
  if (selected.length === 0) return { signature };
  return {
    signature,
    span: {
      startLine: startIndex + 1,
      endLine: startIndex + selected.length,
      text: selected.join("\n"),
    },
  };
}

function positiveInt(value: number | undefined, fallbackValue: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallbackValue;
}

function cappedPositiveInt(value: number | undefined, fallbackValue: number, hardMax: number): number {
  return Math.min(positiveInt(value, fallbackValue), hardMax);
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
 * The guardrail lives IN the artifact, so it cannot be forgotten.
 *
 * Every role gets the same principle sentence and its own concrete rule; the
 * automated test pins these lines, so deleting or softening them fails CI
 * before an evidence block can ever reach a prompt dressed as truth.
 */
export const SOURCE_OF_TRUTH_SENTENCE = "Graphify discovers → Source confirms → Compiler checks → Tests verify.";

export function renderEvidenceBlock(
  role: AgentStage,
  targetId: string,
  candidates: CodeCandidate[],
  limits: { maxCandidates?: number; maxBytes?: number } = {},
): string {
  const roleRule =
    role === AgentStage.QA_ENGINEER
      ? `- You are QA: verify each finding against real source files and test results BEFORE any verdict. A graph hit NEVER decides pass/fail.`
      : role === AgentStage.SYSTEM_ANALYST
        ? `- You are SA: cross-check every statement below against requirement/design documents AND the actual source files before drawing any conclusion.`
        : `- You are DEV: use a span only when sufficient. Open the real file when (a) the required edit lies outside the span, (b) surrounding imports/types are necessary, (c) the evidence conflicts with expectations, or (d) you are about to edit that file.`;
  const candidateLimit = cappedPositiveInt(
    limits.maxCandidates,
    DEFAULT_MAX_EVIDENCE_CANDIDATES,
    DEFAULT_MAX_EVIDENCE_CANDIDATES,
  );
  const byteLimit = cappedPositiveInt(
    limits.maxBytes,
    DEFAULT_MAX_EVIDENCE_BLOCK_BYTES,
    DEFAULT_MAX_EVIDENCE_BLOCK_BYTES,
  );
  const eligible = candidates.slice(0, candidateLimit);
  const prefix = [
    `## Code intelligence evidence — target \`${targetId}\` (DISCOVERY ONLY)`,
    "",
    SOURCE_OF_TRUTH_SENTENCE,
    "- Graph result is discovery evidence, not implementation truth.",
    roleRule,
    "- If any item below contradicts the real source code, the source code wins — discard the graph claim.",
    "",
  ];
  const rendered: string[] = [];
  for (const candidate of eligible) {
    const item = renderCandidate(candidate, rendered.length + 1);
    const projected = [...prefix, `Candidates (${rendered.length + 1}, provenance-tagged):`, ...rendered, item].join("\n");
    if (Buffer.byteLength(projected, "utf8") > byteLimit) break;
    rendered.push(item);
  }
  const block = [...prefix, `Candidates (${rendered.length}, provenance-tagged):`, ...rendered].join("\n");
  if (Buffer.byteLength(block, "utf8") <= byteLimit) return block;
  // Never truncate source-of-truth language. The resolver treats an empty
  // rendering as an oversized fallback, so the old search/read path wins.
  return "";
}

function renderCandidate(candidate: CodeCandidate, index: number): string {
  const location = candidate.span
    ? `${candidate.location.file}:L${candidate.span.startLine}-L${candidate.span.endLine}`
    : `${candidate.location.file}${candidate.location.line ? `:L${candidate.location.line}` : ""}`;
  const heading = `${index}. [${candidate.provenance}] ${location}${candidate.symbol ? ` — ${candidate.symbol}` : ""}${candidate.relation ? ` (${candidate.relation})` : ""}`;
  const parts = [heading];
  if (candidate.signature) parts.push(`Signature: ${candidate.signature}`);
  if (candidate.span) {
    const fence = candidate.span.text.includes("```") ? "````" : "```";
    parts.push(fence, candidate.span.text, fence);
  }
  return parts.join("\n");
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
 * Audit entries carry METADATA ONLY: counts, revisions, reasons, and at most
 * the top few file paths (paths are already visible in the repo; file
 * contents and secrets never enter a payload).
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
      // Telemetry must never break the pipeline that hosts it.
    }
  };
}
