import * as child_process from "node:child_process";
import * as path from "node:path";
import {
  CodeCandidate,
  CodeIntelligenceError,
  ImpactQuery,
  MalformedResponseError,
  OversizedOutputError,
  PathQuery,
  ProviderNotInstalledError,
  ProviderStatus,
  ProviderTimeoutError,
  ProviderUnavailableError,
  Provenance,
  RelevantCodeQuery,
  RelationQuery,
  CodeIntelligenceProvider,
  TargetRef,
} from "./provider.js";
import { assertQueryAllowed, getStatus, graphFileFor } from "./freshness.js";

/**
 * T-GR2 — the only code in the Framework that knows Graphify exists.
 *
 * Transport: CLI subprocess (decided from T-GR0 — local queries measured at
 * 1–2s, no server to keep alive; MCP stdio adds a process for no gain in V1).
 * Every call goes through the freshness gate FIRST (T-GR3) — there is no public
 * method that reaches the binary without one.
 *
 * What may never happen here, per hard bans:
 *   - graph.json / GRAPH_REPORT.md contents flowing into LLM context. The tool
 *     is asked narrow questions and only normalized candidates come back out.
 *   - logging anything beyond metadata (command shape, timings, counts).
 */

export interface GraphifyProviderConfig {
  /** Binary name or path. Resolved via PATH by default (`graphify`). */
  command?: string;
  /**
   * Version pin (from `uv tool install graphifyy@<v>`). When set, availability
   * means "present AND this version" — the tool releases near-daily and an
   * untracked upgrade must not change behaviour under a running pipeline.
   */
  pinnedVersion?: string;
  /** Per-invocation timeout. Generous because first queries warm OS file cache. */
  timeoutMs?: number;
  /** Hard byte cap on captured stdout; beyond it the result is unusable anyway. */
  maxOutputBytes?: number;
  /** Cap on candidates returned per query (applied after parse + ranking). */
  maxCandidates?: number;
}

export const DEFAULT_GRAPHIFY_CONFIG: Required<Omit<GraphifyProviderConfig, "pinnedVersion">> = {
  command: "graphify",
  timeoutMs: 30_000,
  maxOutputBytes: 2_000_000,
  maxCandidates: 50,
};

/** Injectable so tests run deterministic fixtures without a real binary (T-GR14). */
export type SubprocessRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes: number },
) => Promise<SubprocessResult>;

export interface SubprocessResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the runner killed the process at the timeout instead of waiting for exit. */
  timedOut?: boolean;
}

export class GraphifyProvider implements CodeIntelligenceProvider {
  private readonly config: Required<Omit<GraphifyProviderConfig, "pinnedVersion">> & Pick<GraphifyProviderConfig, "pinnedVersion">;
  private readonly run: SubprocessRunner;
  private readonly cacheRoot: string;

  constructor(
    options: { config?: GraphifyProviderConfig; runner?: SubprocessRunner; cacheRoot: string },
  ) {
    // Undefined entries must not clobber defaults (`{command: undefined}` would
    // erase "graphify" — exactly what an env-var-miss produces).
    const provided = Object.fromEntries(Object.entries(options.config ?? {}).filter(([, value]) => value !== undefined));
    this.config = { ...DEFAULT_GRAPHIFY_CONFIG, ...provided };
    this.run = options.runner ?? spawnRunner;
    this.cacheRoot = options.cacheRoot;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run(this.config.command, ["--version"], {
        timeoutMs: Math.min(this.config.timeoutMs, 10_000),
        maxOutputBytes: 64_000,
      });
      if (result.code !== 0) return false;
      if (this.config.pinnedVersion) {
        // The binary prints its own banner ("graphifyy v0.9.49 …"), so compare
        // the version token, tolerating an optional v-prefix on either side.
        // Prefix matching the whole stdout would never match; exact token match
        // means an untracked upgrade reads as "unavailable" — fallback, not drift.
        const reported = /v?(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
        const expected = this.config.pinnedVersion.replace(/^v/, "");
        return reported === expected;
      }
      return true;
    } catch (error) {
      if (error instanceof ProviderTimeoutError) return false;
      throw error;
    }
  }

  async getStatus(target: TargetRef): Promise<ProviderStatus> {
    return getStatus(this.cacheRoot, target.targetId, target.revision);
  }

  async findRelevantCode(query: RelevantCodeQuery): Promise<CodeCandidate[]> {
    assertQueryAllowed(await this.getStatus(query.target));
    const args = [
      "query",
      query.description,
      "--graph",
      this.graph(query.target),
      "--budget",
      String(Math.min(2000, this.config.maxCandidates * 40)),
    ];
    return this.candidatesFor(args, parseNodeLines, "query");
  }

  async getDependencies(query: RelationQuery): Promise<CodeCandidate[]> {
    assertQueryAllowed(await this.getStatus(query.target));
    return this.explain(query.symbol, "outbound", "getDependencies", query.target);
  }

  async getDependents(query: RelationQuery): Promise<CodeCandidate[]> {
    assertQueryAllowed(await this.getStatus(query.target));
    return this.explain(query.symbol, "inbound", "getDependents", query.target);
  }

  async findPath(query: PathQuery): Promise<CodeCandidate[]> {
    assertQueryAllowed(await this.getStatus(query.target));
    // Undirected on purpose: T-GR0 showed directed search misses real paths
    // across import/call direction changes, which made the feature look broken
    // when the data was fine. For discovery evidence, reachability beats strict
    // directionality; the relation labels stay visible in results.
    const args = ["path", query.from, query.to, "--undirected", "--graph", this.graph(query.target)];
    return this.candidatesFor(args, parseAffectedLines, "path");
  }

  async getImpact(query: ImpactQuery): Promise<CodeCandidate[]> {
    assertQueryAllowed(await this.getStatus(query.target));
    const args = ["affected", query.symbol, "--graph", this.graph(query.target)];
    if (query.depth !== undefined) args.push("--depth", String(Math.max(1, Math.min(5, query.depth))));
    return this.candidatesFor(args, parseAffectedLines, "impact");
  }

  private graph(target: TargetRef): string {
    return graphFileFor(this.cacheRoot, target.targetId, target.revision);
  }

  private explain(
    symbol: string,
    direction: "inbound" | "outbound",
    operation: string,
    target: TargetRef,
  ): Promise<CodeCandidate[]> {
    const args = ["explain", symbol, "--graph", this.graph(target)];
    return this.candidatesFor(args, (stdout) => parseExplainLines(stdout, direction), operation);
  }

  private async candidatesFor(
    args: string[],
    parser: (stdout: string) => CodeCandidate[],
    operation: string,
  ): Promise<CodeCandidate[]> {
    const result = await this.execute(args, operation);
    if (!result.stdout.trim()) return [];
    const parsed = parser(result.stdout);
    if (parsed.length === 0 && !hasKnownMarker(result.stdout)) {
      throw new MalformedResponseError(`unrecognised ${operation} output shape (${result.stdout.length} bytes)`);
    }
    return parsed.slice(0, this.config.maxCandidates);
  }

  private async execute(args: string[], operation: string): Promise<SubprocessResult> {
    let result: SubprocessResult;
    try {
      result = await this.run(this.config.command, args, {
        timeoutMs: this.config.timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes,
      });
    } catch (error) {
      // Typed errors the transport raised on purpose keep their identity —
      // the resolver maps them onto distinct fallback reasons.
      if (error instanceof CodeIntelligenceError) throw error;
      // ENOENT surfaces as a thrown error with that code on win32/posix alike.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        throw new ProviderNotInstalledError(`"${this.config.command}" is not installed or not on PATH`);
      }
      throw new ProviderUnavailableError(`${operation} failed to start: ${String(error).slice(0, 200)}`);
    }
    if (result.timedOut) {
      throw new ProviderTimeoutError(`${operation} exceeded ${this.config.timeoutMs}ms`);
    }
    if (result.code === 127 || /is not recognized|command not found/i.test(result.stderr)) {
      throw new ProviderNotInstalledError(`"${this.config.command}" is not installed or not on PATH`);
    }
    if (result.code !== 0) {
      // Metadata only: the last stderr line names the failure mode; full output stays out of logs (B7).
      const lastLine = result.stderr.trim().split(/\r?\n/).pop() ?? "(no stderr)";
      throw new ProviderUnavailableError(`${operation} exited ${result.code}: ${lastLine.slice(0, 300)}`);
    }
    return result;
  }
}

/** Real transport: capped capture + hard timeout kill. Kept tiny and untested-by-fixture on purpose. */
export const spawnRunner: SubprocessRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = child_process.spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > opts.maxOutputBytes) {
        child.kill();
        reject(new OversizedOutputError(`output exceeded ${opts.maxOutputBytes} bytes`));
        settled = true;
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });

function hasKnownMarker(stdout: string): boolean {
  return /^(NODE |-|Affected nodes|No directed path|No path)/m.test(stdout);
}

/**
 * Output shapes are locked by fixture tests against real v0.9.49 captures
 * (planning/v2/graphify-spike-evidence/). Unknown lines are skipped, not fatal:
 * the tool appends advisory banners between versions and one banner line must
 * not turn a usable answer into an error.
 */

function provenanceOf(text: string): Provenance {
  return /\bINFERRED\b/i.test(text) ? "inferred" : "extracted";
}

/** `query` output: `NODE label [src=file loc=L12 community=7]` per hit. */
export function parseNodeLines(stdout: string): CodeCandidate[] {
  const out: CodeCandidate[] = [];
  const lines = stdout.split(/\r?\n/);
  let seen = 0;
  for (const line of lines) {
    const match = /^NODE (.+) \[src=(\S+)(?: loc=L(\d+))?[^\]]*\]\s*$/.exec(line.trim());
    if (!match) continue;
    seen += 1;
    out.push({
      location: { file: normalizeRel(match[2]), line: match[3] ? Number(match[3]) : undefined },
      symbol: match[1],
      score: score(seen),
      provenance: provenanceOf(line),
    });
  }
  return dedupeByLocation(out);
}

/** `affected` / `path` output: `- label [relation] file:Lnn`, optionally `- label [relation] [INFERRED] file:Lnn`. */
export function parseAffectedLines(stdout: string): CodeCandidate[] {
  const out: CodeCandidate[] = [];
  let seen = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const match = /^- (\S+) \[([^\]]+)\](?: \[(EXTRACTED|INFERRED)\])? (\S+):L(\d+)\s*$/.exec(trimmed);
    if (!match) continue;
    seen += 1;
    out.push({
      location: { file: normalizeRel(match[4]), line: Number(match[5]) },
      symbol: match[1],
      relation: match[2],
      score: score(seen),
      provenance: match[3] ? (match[3].toLowerCase() as Provenance) : provenanceOf(trimmed),
    });
  }
  return dedupeByLocation(out);
}

/**
 * `explain` output connections: `  <-- label [relation] [PROVENANCE] file:Lnn`
 * (`<--` inbound = things this symbol serves, `-->` outbound = what it relies on).
 */
export function parseExplainLines(stdout: string, direction: "inbound" | "outbound"): CodeCandidate[] {
  const arrow = direction === "inbound" ? "<--" : "-->";
  const pattern = new RegExp(`^${arrow}\\s+(.+?) \\[([^\\]]+)\\](?: \\[(EXTRACTED|INFERRED)\\])? (\\S+):L(\\d+)$`);
  const out: CodeCandidate[] = [];
  let seen = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(arrow)) continue;
    const match = pattern.exec(trimmed);
    if (!match) continue;
    seen += 1;
    out.push({
      location: { file: normalizeRel(match[4]), line: Number(match[5]) },
      symbol: match[1],
      relation: match[2],
      score: score(seen),
      provenance: match[3] ? (match[3].toLowerCase() as Provenance) : "extracted",
    });
  }
  return dedupeByLocation(out);
}

function score(position: number): number {
  return Math.max(0.01, 1 / position);
}

function normalizeRel(file: string): string {
  return path.normalize(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

function dedupeByLocation(candidates: CodeCandidate[]): CodeCandidate[] {
  const seen = new Set<string>();
  const out: CodeCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.location.file}:${candidate.location.line ?? ""}:${candidate.symbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}
