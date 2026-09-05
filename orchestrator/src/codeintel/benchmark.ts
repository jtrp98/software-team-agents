import * as fs from "node:fs";
import * as path from "node:path";
import { estimateInputTokens } from "../context/contextBudget.js";
import type { CodeIntelligenceProvider } from "./provider.js";

/**
 * Discovery-level half of an A/B benchmark: for the same question, how much
 * reading does a graph-assisted discovery point at versus a full sweep of
 * the task's scope directories? Side A (naive) is that full worst case;
 * side B is the unique candidate files the provider names, at real byte
 * size. Tokens are estimated at ~4 bytes/token on both sides, so the RATIO
 * is meaningful even where the absolute number is rough.
 *
 * This does NOT measure wrong-file edits, defects missed, or verdict
 * quality — those need orchestrated agent runs with people watching.
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

export interface EngineeringRetrievalSide {
  /** Agent-level full-file source opens; resolver span reads are not agent reopens. */
  fileOpens: number;
  /** UTF-8 bytes entering agent context from evidence plus full-file opens. */
  contextBytes: number;
}

export interface EngineeringRetrievalBenchmark {
  off: EngineeringRetrievalSide;
  on: EngineeringRetrievalSide;
  evidenceBlockBytes: number;
  codeResultEquivalent: boolean;
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
  return { filesConsidered: files.length, estTokens: estimateInputTokens(bytes), wallMs };
}

function uniqueFiles(candidates: { location: { file: string } }[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.location.file))];
}

function bytesForFiles(targetRoot: string, files: readonly string[]): number {
  return [...new Set(files)].reduce((sum, file) => {
    try {
      return sum + fs.statSync(path.join(targetRoot, file)).size;
    } catch {
      return sum;
    }
  }, 0);
}

/**
 * Same-task A/B accounting for retrieval cost.
 *
 * OFF models the pre-retrieval engineer opening every relevant candidate in
 * full. ON includes the bounded evidence block and still charges every file
 * the engineer will edit as a mandatory full-file open. Callers provide the
 * independently produced code results so equivalence is explicit rather than
 * inferred from token savings.
 */
export function measureEngineeringRetrieval(opts: {
  targetRoot: string;
  candidateFiles: readonly string[];
  editedFiles: readonly string[];
  evidenceBlock: string;
  codeResultOff: string | Buffer;
  codeResultOn: string | Buffer;
}): EngineeringRetrievalBenchmark {
  const candidateFiles = [...new Set(opts.candidateFiles)];
  const editedFiles = [...new Set(opts.editedFiles)];
  const evidenceBlockBytes = Buffer.byteLength(opts.evidenceBlock, "utf8");
  return {
    off: {
      fileOpens: candidateFiles.length,
      contextBytes: bytesForFiles(opts.targetRoot, candidateFiles),
    },
    on: {
      fileOpens: editedFiles.length,
      contextBytes: evidenceBlockBytes + bytesForFiles(opts.targetRoot, editedFiles),
    },
    evidenceBlockBytes,
    codeResultEquivalent: Buffer.from(opts.codeResultOff).equals(Buffer.from(opts.codeResultOn)),
  };
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
  return { filesConsidered: uniqueFiles(candidates).length, estTokens: estimateInputTokens(bytes), wallMs };
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

/** Shared stable renderer for deterministic token-workload baselines. */
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
