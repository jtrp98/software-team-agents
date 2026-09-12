import * as fs from "node:fs";
import * as path from "node:path";
import {
  CodeCandidate,
  CodeIntelligenceProvider,
  ImpactQuery,
  PathQuery,
  ProviderStatus,
  ProviderUnavailableError,
  RelationQuery,
  RelevantCodeQuery,
  TargetRef,
} from "./provider.js";

/**
 * The always-available baseline (T-V8-023): bounded filename/text search over
 * the CURRENT working tree, with no install, no index, and no staleness
 * concept — it reads what is there right now, so it is `fresh` by
 * construction. This is what a run gets when no graph provider is
 * installed/configured, or a configured one reports no usable index (see
 * `fallbackChainProvider.ts`).
 *
 * WHY THIS DOES NOT ANSWER RELATION/PATH/IMPACT QUERIES: those require a real
 * dependency graph. A keyword scan across a symbol name can produce plausible
 * garbage (same identifier reused unrelated elsewhere) that would be far
 * worse than an honest "unavailable" — so those four operations throw
 * `ProviderUnavailableError` rather than fabricate a graph answer. Runtime-
 * native LSP/compiler tools, when the executing runtime exposes them, are the
 * intended way to answer "definitions/references/implementations/types" and
 * "what depends on this" — STA does not build a language-server client (see
 * V8-PROBLEM-ANALYSIS.md §7.2, §8).
 *
 * Every result is `provenance: "inferred"` — a filename/text hit is a
 * hypothesis about relevance, never an extracted structural fact.
 */

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".workflow",
  "vendor",
]);

/** Extensions worth reading for content matches. Anything else is scored on filename only. */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php",
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".css", ".scss", ".html", ".sql", ".prisma", ".proto",
]);

export interface NativeSearchProviderConfig {
  /** Hard cap on directory entries visited in one query. Keeps a huge repo bounded. */
  maxFilesScanned?: number;
  /** Hard cap on wall-clock time spent walking, in ms. */
  maxScanMs?: number;
  /** Bytes read per candidate file before giving up on content matching. */
  maxFileBytes?: number;
  /** Candidates returned, before the resolver's own top-N/evidence caps apply. */
  maxCandidates?: number;
  /** Directory basenames to skip while walking. Merged with the built-in noise list. */
  extraSkipDirs?: string[];
  now?: () => number;
}

const DEFAULTS: Required<Omit<NativeSearchProviderConfig, "extraSkipDirs" | "now">> = {
  maxFilesScanned: 4_000,
  maxScanMs: 2_000,
  maxFileBytes: 200_000,
  maxCandidates: 50,
};

const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 12;

export class NativeSearchProvider implements CodeIntelligenceProvider {
  private readonly config: Required<Omit<NativeSearchProviderConfig, "extraSkipDirs" | "now">>;
  private readonly skipDirs: Set<string>;
  private readonly now: () => number;

  constructor(config: NativeSearchProviderConfig = {}) {
    const provided = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
    this.config = { ...DEFAULTS, ...provided };
    this.skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.extraSkipDirs ?? [])]);
    this.now = config.now ?? Date.now;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** No index, so nothing can go stale — the checkout IS the answer. */
  async getStatus(target: TargetRef): Promise<ProviderStatus> {
    return {
      status: "fresh",
      targetRevision: target.revision,
      indexedRevision: target.revision,
      indexedAt: null,
    };
  }

  async findRelevantCode(query: RelevantCodeQuery): Promise<CodeCandidate[]> {
    const terms = extractTerms(query.description);
    if (terms.length === 0) return [];

    const deadline = this.now() + this.config.maxScanMs;
    const hits: { candidate: CodeCandidate; rank: number }[] = [];
    let scanned = 0;

    const walk = (dir: string): void => {
      if (scanned >= this.config.maxFilesScanned || this.now() >= deadline) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (scanned >= this.config.maxFilesScanned || this.now() >= deadline) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned += 1;
        const relative = path.relative(query.target.rootPath, full).replace(/\\/g, "/");
        const scored = scoreFile(full, relative, terms, this.config.maxFileBytes);
        if (scored) hits.push(scored);
      }
    };

    walk(query.target.rootPath);

    hits.sort((a, b) => b.rank - a.rank);
    return hits.slice(0, this.config.maxCandidates).map((hit, index) => ({
      ...hit.candidate,
      score: Math.max(0.01, 1 / (index + 1)),
    }));
  }

  async getDependencies(query: RelationQuery): Promise<CodeCandidate[]> {
    throw unavailable("getDependencies", query.symbol);
  }

  async getDependents(query: RelationQuery): Promise<CodeCandidate[]> {
    throw unavailable("getDependents", query.symbol);
  }

  async findPath(query: PathQuery): Promise<CodeCandidate[]> {
    throw unavailable("findPath", `${query.from} -> ${query.to}`);
  }

  async getImpact(query: ImpactQuery): Promise<CodeCandidate[]> {
    throw unavailable("getImpact", query.symbol);
  }
}

function unavailable(operation: string, subject: string): ProviderUnavailableError {
  return new ProviderUnavailableError(
    `native text search has no dependency graph; ${operation}(${subject}) requires a graph provider or a runtime-native LSP/compiler tool`,
  );
}

/** Lowercase word-ish tokens, deduped, capped — same shape of bound as the resolver's own query limits. */
export function extractTerms(description: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of description.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TERM_LENGTH || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

function scoreFile(
  absolute: string,
  relative: string,
  terms: string[],
  maxFileBytes: number,
): { candidate: CodeCandidate; rank: number } | null {
  const lowerName = relative.toLowerCase();
  let rank = 0;
  for (const term of terms) {
    if (lowerName.includes(term)) rank += 3;
  }

  let matchedLine: number | undefined;
  const ext = path.extname(relative).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      stat = { size: Infinity } as fs.Stats;
    }
    if (stat.size > 0 && stat.size <= maxFileBytes) {
      try {
        const content = fs.readFileSync(absolute, "utf8");
        const lines = content.split(/\r?\n/);
        for (const term of terms) {
          const idx = lines.findIndex((line) => line.toLowerCase().includes(term));
          if (idx >= 0) {
            rank += 1;
            if (matchedLine === undefined) matchedLine = idx + 1;
          }
        }
      } catch {
        // Unreadable/binary-despite-extension — filename score still stands.
      }
    }
  }

  if (rank === 0) return null;
  return {
    rank,
    candidate: {
      location: { file: relative, line: matchedLine },
      score: 1,
      provenance: "inferred",
    },
  };
}
