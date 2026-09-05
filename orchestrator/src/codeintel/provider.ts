/**
 * The seam between the orchestrator and any code-intelligence tool.
 *
 * WHY AN INTERFACE AT ALL: the tool behind it (Graphify) releases almost daily,
 * and every operation here has a plain fallback (search/read as before) if it
 * disappears tomorrow. The interface keeps that switch a config change, not a
 * refactor: everything on this side of the seam is a Framework-owned DTO, and
 * nothing from the tool leaks through — not its node ids, not its JSON shapes,
 * not its error strings.
 *
 * THE CONTRACT EVERY IMPLEMENTATION MUST HONOUR:
 *
 *   1. Results are *candidate discovery evidence*, never truth — the caller
 *      must read real source before acting (enforced by the evidence block in
 *      resolver.ts).
 *   2. Every candidate carries a concrete source location and a provenance tag
 *      (`extracted` = read off the AST, `inferred` = guessed by a semantic
 *      pass). An untagged candidate would let a guess masquerade as fact.
 *   3. Any failure THROWS. Nothing here returns sentinel values — the resolver
 *      maps a throw onto the same search/read path the pipeline used before
 *      this module existed, so a broken provider degrades instead of crashing
 *      a task.
 */

/** Where a fact came from. `inferred` results are hypotheses, not observations. */
export type Provenance = "extracted" | "inferred";

/** A concrete place in the target's source tree — relative, forward-slash. */
export interface CodeLocation {
  /** Path relative to the target repository root (e.g. `src/helpers/api/response.ts`). */
  file: string;
  /** 1-based line when the tool could pin one; absent means "somewhere in this file". */
  line?: number;
}

/** A bounded, line-addressable excerpt read from the current working tree. */
export interface CodeSpan {
  startLine: number;
  endLine: number;
  text: string;
}

/** One candidate context item. Deliberately boring — this crosses the whole pipeline. */
export interface CodeCandidate {
  location: CodeLocation;
  /** Symbol name when the hit is a definition/call site rather than a whole file. */
  symbol?: string;
  /** Relation that produced the hit (e.g. `imports_from`, `calls`) — informational. */
  relation?: string;
  /** Source declaration line when it can be recovered safely from the working tree. */
  signature?: string;
  /** Bounded source evidence recovered from the working tree after path validation. */
  span?: CodeSpan;
  /**
   * Relative ranking in (0, 1], higher is better. Derived from the tool's own
   * ordering; consumers must only compare scores within one result set.
   */
  score: number;
  provenance: Provenance;
}

/**
 * Whether the index matches the checkout. The four states are exactly the ones
 * freshness policy acts on: `fresh` may be queried; anything else must
 * fall back rather than silently serve an old map.
 */
export type FreshnessStatus = "fresh" | "stale" | "missing" | "error";

export interface ProviderStatus {
  status: FreshnessStatus;
  /** Revision the caller asked about. */
  targetRevision: string;
  /** Revision the index was built from, when known. */
  indexedRevision: string | null;
  /** ISO timestamp of the indexing run, when known. */
  indexedAt: string | null;
}

/** Identifies both the registered target and where its checkout lives now. */
export interface TargetRef {
  targetId: string;
  /** Absolute path of the local checkout (from `.workflow/targets.local.yaml`). */
  rootPath: string;
  /** Current HEAD of that checkout — computed by the caller, compared by freshness. */
  revision: string;
}

export interface RelevantCodeQuery {
  target: TargetRef;
  /** What the task is about, in free text — already scoped by the resolver's caller. */
  description: string;
}

export interface RelationQuery {
  target: TargetRef;
  /** Symbol (or file) to walk relations from. */
  symbol: string;
}

export interface PathQuery {
  target: TargetRef;
  from: string;
  to: string;
}

export interface ImpactQuery {
  target: TargetRef;
  symbol: string;
  /** How far reverse traversal may go (tool default when absent). */
  depth?: number;
}

export type CodeIntelOperation =
  | "findRelevantCode"
  | "getDependencies"
  | "getDependents"
  | "findPath"
  | "getImpact";

/**
 * The seven operations every provider implements. Availability + status
 * first, five queries after — every query path goes through the
 * resolver's status gate, never around it.
 */
export interface CodeIntelligenceProvider {
  isAvailable(): Promise<boolean>;
  getStatus(target: TargetRef): Promise<ProviderStatus>;
  findRelevantCode(query: RelevantCodeQuery): Promise<CodeCandidate[]>;
  getDependencies(query: RelationQuery): Promise<CodeCandidate[]>;
  getDependents(query: RelationQuery): Promise<CodeCandidate[]>;
  findPath(query: PathQuery): Promise<CodeCandidate[]>;
  getImpact(query: ImpactQuery): Promise<CodeCandidate[]>;
}

/**
 * The failure taxonomy. One base class so callers can catch broadly; named
 * subclasses so audit records and tests can be precise about *why* a
 * fallback happened.
 */
export class CodeIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeIntelligenceError";
  }
}
export class ProviderNotInstalledError extends CodeIntelligenceError {}
export class ProviderUnavailableError extends CodeIntelligenceError {}
export class ProviderTimeoutError extends CodeIntelligenceError {}
export class MalformedResponseError extends CodeIntelligenceError {}
export class OversizedOutputError extends CodeIntelligenceError {}
export class StaleIndexError extends CodeIntelligenceError {}
export class MissingIndexError extends CodeIntelligenceError {}
export class IndexError extends CodeIntelligenceError {}
export class CapabilityDeniedError extends CodeIntelligenceError {}
