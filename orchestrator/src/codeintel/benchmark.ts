import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeIntelligenceProvider } from "./provider.js";

/**
 * T-GR12 harness — the discovery-level half of the A/B benchmark.
 *
 * WHAT THIS MEASURES HONESTLY, WITHOUT RUNNING AGENTS: for the same question,
 * how much reading does a graph-assisted discovery point at versus what the
 * pre-provider pipeline would have had to sweep? Side A (naive) is the full
 * worst case the old flow faced — every code file under the task's scope
 * directories, each one potentially opened and grepped. Side B is the unique
 * candidate files the provider names, at their real byte size. Tokens are
 * estimated at ~4 bytes/token, the same convention graphify's own benchmark
 * uses; both sides use it, so the RATIO is meaningful even where the absolute
 * number is rough.
 *
 * WHAT THIS DOES NOT MEASURE (and must not pretend to): wrong-file edits,
 * defects missed, verdict quality — those need orchestrated agent runs with
 * people watching, which is the other half of T-GR12. This module exists so
 * that half starts from recorded numbers instead of opinions.
 */

export interface BenchmarkCase {
  id: string;
  /** Free-text question, as a role would phrase it before starting work. */
  description: string;
  /** Directories of the target the pre-provider flow would have swept. */
  scopeDirs: string[];
}

export interface DiscoverySide {
  filesConsidered: number;
  estTokens: number;
  wallMs: number;
}

export interface BenchmarkRow {
  id: string;
  naive: DiscoverySide;
  graph: DiscoverySide;
  tokenReduction: number;
}

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);

function walkCodeFiles(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walkCodeFiles(root, rel, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(rel);
  }
}

/** Side A — everything the scope could have made an agent open. */
export function measureNaive(targetRoot: string, scopeDirs: string[], wallMs: number): DiscoverySide {
  const files: string[] = [];
  for (const dir of scopeDirs) walkCodeFiles(targetRoot, dir, files);
  const bytes = files.reduce((sum, file) => {
    try {
      return sum + fs.statSync(path.join(targetRoot, file)).size;
    } catch {
      return sum;
    }
  }, 0);
  return { filesConsidered: files.length, estTokens: Math.ceil(bytes / 4), wallMs };
}

function uniqueFiles(candidates: { location: { file: string } }[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.location.file))];
}

/** Side B — what the graph says to read instead. */
export async function measureGraph(
  provider: CodeIntelligenceProvider,
  targetRoot: string,
  target: { targetId: string; rootPath: string; revision: string },
  description: string,
): Promise<DiscoverySide> {
  const started = Date.now();
  const candidates = await provider.findRelevantCode({ target, description });
  const wallMs = Date.now() - started;
  const bytes = uniqueFiles(candidates).reduce((sum, file) => {
    try {
      return sum + fs.statSync(path.join(targetRoot, file)).size;
    } catch {
      // A candidate outside this checkout counts as nothing here — the resolver's
      // permission filter should already have dropped it; this is belt and braces.
      return sum;
    }
  }, 0);
  return { filesConsidered: uniqueFiles(candidates).length, estTokens: Math.ceil(bytes / 4), wallMs };
}

export async function runDiscoveryBenchmark(
  cases: BenchmarkCase[],
  opts: {
    provider: CodeIntelligenceProvider;
    targetRoot: string;
    targetId: string;
    revision: string;
  },
): Promise<BenchmarkRow[]> {
  const rows: BenchmarkRow[] = [];
  for (const testCase of cases) {
    const naiveStarted = Date.now();
    const naive = measureNaive(opts.targetRoot, testCase.scopeDirs, Date.now() - naiveStarted);
    const graph = await measureGraph(opts.provider, opts.targetRoot, { targetId: opts.targetId, rootPath: opts.targetRoot, revision: opts.revision }, testCase.description);
    rows.push({
      id: testCase.id,
      naive,
      graph,
      tokenReduction: graph.estTokens > 0 ? Math.round((naive.estTokens / graph.estTokens) * 10) / 10 : Infinity,
    });
  }
  return rows;
}

/** Pure renderer — locked by test so reports stay comparable across rounds. */
export function renderBenchmarkMarkdown(rows: BenchmarkRow[], header: { targetId: string; revision: string; date: string }): string {
  const lines = [
    `# Code-intelligence discovery benchmark — round`,
    "",
    `Target \`${header.targetId}\` @ \`${header.revision.slice(0, 12)}\` · ${header.date} · tokens ≈ bytes/4 · local-only (--code-only)`,
    "",
    "| Case | Naive files | Naive tok | Graph files | Graph tok | Reduction | Graph ms |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.naive.filesConsidered} | ${row.naive.estTokens.toLocaleString()} | ${row.graph.filesConsidered} | ${row.graph.estTokens.toLocaleString()} | ${Number.isFinite(row.tokenReduction) ? `${row.tokenReduction}x` : "—"} | ${row.graph.wallMs} |`,
    );
  }
  const naiveTotal = rows.reduce((sum, row) => sum + row.naive.estTokens, 0);
  const graphTotal = rows.reduce((sum, row) => sum + row.graph.estTokens, 0);
  lines.push("", `Total estimated reading: ${naiveTotal.toLocaleString()} → ${graphTotal.toLocaleString()} tokens (${naiveTotal > 0 && graphTotal > 0 ? `${Math.round((naiveTotal / graphTotal) * 10) / 10}x less` : "n/a"}).`);
  lines.push("", "_Discovery-level only. Agent-level metrics (wrong-file edits, defects missed, verdict quality) require orchestrated runs with people watching._");
  return lines.join("\n");
}

/** Shared stable renderer for deterministic token-workload baselines (T-V3TOK-004). */
export function renderTokenBenchmarkMarkdown(rows: ReadonlyArray<{
  workload: string;
  inputTokens: number;
  modelCalls: number;
  filesOpened: number;
  docBytes: number;
  retries: number;
  outputTokens: number | null;
  qualityGatesPassed: number | null;
}>, header: { date: string }): string {
  const lines = [
    "# Token workload benchmark — baseline",
    "",
    `Generated ${header.date} · deterministic fixture bytes/4 input-token estimate · no live model calls`,
    "",
    "| Workload | Input tok | Output tok | Total tok | Model calls | Files opened | Doc bytes in context | Retries | Quality gates passed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    const unknown = "not reported";
    lines.push(`| ${row.workload} | ${row.inputTokens.toLocaleString()} | ${row.outputTokens?.toLocaleString() ?? unknown} | ${row.inputTokens.toLocaleString()} (input only) | ${row.modelCalls} | ${row.filesOpened} | ${row.docBytes.toLocaleString()} | ${row.retries} | ${row.qualityGatesPassed?.toLocaleString() ?? unknown} |`);
  }
  return lines.join("\n");
}
