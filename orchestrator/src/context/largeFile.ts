import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { estimateInputTokens } from "./contextBudget.js";

/**
 * Large File Context Policy — the one shared definition of "too large to enter
 * a model conversation whole", for every role and every file type.
 *
 * The failure it exists for: a 400k-character `design.md` (or a 1 MB JSON
 * fixture, a generated `.ts`, a log) is returned whole by one tool call or one
 * `sta context` render, and every later agentic turn re-sends it as history.
 * One read becomes hundreds of thousands of cumulative input tokens.
 *
 * Nothing here truncates. A large file is never cut to fit: it is replaced by
 * an index (Markdown headings or fixed line windows) whose every entry names
 * the exact 1-based line range to read, so any part of the file stays
 * reachable by a bounded read. Three enforcement points share these numbers:
 *
 * - `docSelection.boundLargeSelection` — `sta context` / module-doc rendering;
 * - `.claude/hooks/block-large-read.js` — the runtime PreToolUse guard (it
 *   receives these values through `largeFilePolicyEnv`, or reads the same
 *   `.sta/config.yaml` keys itself when a person drives the session);
 * - `policies/documentation.md` §10a — the rule every agent is told.
 */
export interface LargeFilePolicy {
  /** A text file (or a rendered selection) above this many characters is "large": never returned whole. */
  largeFileChars: number;
  /** One bounded read window from a large file may return at most this many characters. */
  maxReadWindowChars: number;
  /** Distinct-coverage ceiling, as a share of a large file, before further reads of it are refused in one session. */
  maxFileReadShare: number;
}

export const DEFAULT_LARGE_FILE_POLICY: Readonly<LargeFilePolicy> = Object.freeze({
  largeFileChars: 100_000,
  maxReadWindowChars: 40_000,
  maxFileReadShare: 0.5,
});

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function share(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

/** Environment wins over `.sta/config.yaml`, which wins over the defaults — the same order the hook applies. */
export function resolveLargeFilePolicy(config: StaConfig | null | undefined, env: NodeJS.ProcessEnv = process.env): LargeFilePolicy {
  const configured = config?.context_budget;
  const largeFileChars = positiveInt(env.STA_LARGE_FILE_CHARS) ?? configured?.large_file_chars ?? DEFAULT_LARGE_FILE_POLICY.largeFileChars;
  const window = positiveInt(env.STA_MAX_READ_WINDOW_CHARS) ?? configured?.max_read_window_chars ?? DEFAULT_LARGE_FILE_POLICY.maxReadWindowChars;
  return {
    largeFileChars,
    // A window larger than the large-file threshold would let one "bounded" read return a whole large file.
    maxReadWindowChars: Math.min(window, largeFileChars),
    maxFileReadShare: share(env.STA_MAX_FILE_READ_SHARE) ?? configured?.max_file_read_share ?? DEFAULT_LARGE_FILE_POLICY.maxFileReadShare,
  };
}

/** Missing or invalid optional configuration keeps the defaults, like every other budget resolver. */
export function resolveLargeFilePolicyFromProject(projectRoot: string, env: NodeJS.ProcessEnv = process.env): LargeFilePolicy {
  try {
    return resolveLargeFilePolicy(loadStaConfig(projectRoot), env);
  } catch (error) {
    if (error instanceof StaConfigMissingError || error instanceof StaConfigInvalidError) return resolveLargeFilePolicy(null, env);
    throw error;
  }
}

/** How an adapter hands the resolved policy to the runtime's hook process. */
export function largeFilePolicyEnv(policy: LargeFilePolicy): Record<string, string> {
  return {
    STA_LARGE_FILE_CHARS: String(policy.largeFileChars),
    STA_MAX_READ_WINDOW_CHARS: String(policy.maxReadWindowChars),
    STA_MAX_FILE_READ_SHARE: String(policy.maxFileReadShare),
  };
}

export interface OutlineEntry {
  level: number;
  heading: string;
  /** 1-based, inclusive — exactly what `Read offset=<startLine>` and `sed -n 'start,endp'` take. */
  startLine: number;
  endLine: number;
  chars: number;
  /** Traceability ids that appear in the section body, so a lookup by id needs no body read. */
  ids: string[];
}

const ID_PATTERN = /\b(?:REQ|AC|DES|DEC|EVD|TP)-\d+(?:\.\d+)?\b/g;

/**
 * Heading outline with body sizes. Fenced blocks are skipped (a `## ` inside a
 * code sample is not a boundary), matching `sections.ts`. Each entry spans to
 * the next heading of the same or a higher level.
 */
export function markdownOutline(text: string, maxLevel = 3): OutlineEntry[] {
  const lines = text.split(/\r?\n/);
  const heads: { level: number; heading: string; index: number }[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i]);
    if (match && match[1].length <= maxLevel) heads.push({ level: match[1].length, heading: match[2].trim(), index: i });
  }
  return heads.map((head, n) => {
    // A document title (`# `) would otherwise span the whole file; its useful
    // range is the preamble before the first sub-heading.
    const next = head.level === 1 ? heads[n + 1] : heads.slice(n + 1).find((candidate) => candidate.level <= head.level);
    const end = next ? next.index : lines.length;
    const body = lines.slice(head.index, end);
    return {
      level: head.level,
      heading: head.heading,
      startLine: head.index + 1,
      endLine: end,
      chars: body.join("\n").length,
      ids: [...new Set(body.join("\n").match(ID_PATTERN) ?? [])],
    };
  });
}

export interface LineWindow {
  startLine: number;
  endLine: number;
  chars: number;
}

/** Consecutive line windows of at most `windowChars` each (a single longer line is its own window). */
export function lineWindows(text: string, windowChars: number): LineWindow[] {
  const lines = text.split(/\r?\n/);
  const out: LineWindow[] = [];
  let start = 0;
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    if (i > start && chars + cost > windowChars) {
      out.push({ startLine: start + 1, endLine: i, chars });
      start = i;
      chars = 0;
    }
    chars += cost;
  }
  if (start < lines.length) out.push({ startLine: start + 1, endLine: lines.length, chars });
  return out;
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

export type SectionVerdict = "read" | "check" | "skip";

export interface LargeFileIndexOptions {
  filePath: string;
  text: string;
  policy: LargeFilePolicy;
  /** Why the content was not rendered whole — carried into the header so the index is self-explaining. */
  reason: string;
  /** Per-heading guidance from a stage's §10 selection. Absent → every entry is unrated. */
  verdictFor?: (entry: OutlineEntry, parent: OutlineEntry | undefined) => SectionVerdict | undefined;
  /** Upper bound on listed entries; the rest are summarized, never silently dropped. */
  maxEntries?: number;
}

const VERDICT_LABEL: Record<SectionVerdict, string> = { read: "READ", check: "CHECK", skip: "skip" };

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The bounded stand-in for a large file. Size is O(headings), not O(file): the
 * real 413k-character design.md renders to roughly 10k characters.
 */
export function renderLargeFileIndex(opts: LargeFileIndexOptions): string {
  const lines = opts.text.split(/\r?\n/);
  const window = opts.policy.maxReadWindowChars;
  const header = [
    `_Large file — not rendered whole (${opts.reason})._`,
    `_File: \`${opts.filePath}\` — ${opts.text.length.toLocaleString("en-US")} chars, ${lines.length.toLocaleString("en-US")} lines, ~${estimateInputTokens(opts.text.length).toLocaleString("en-US")} tokens est. (chars/4; non-Latin text costs more)._`,
    `_Large File Context Policy (\`policies/documentation.md\` §10a): Grep for the rule/id/term you need, then read only the matching range (\`Read\` offset=<start> limit=<end-start+1>, or \`sed -n '<start>,<end>p'\`), at most ${window.toLocaleString("en-US")} chars per read; expand to an adjacent range only if the evidence is insufficient. Never page through the whole file._`,
    "",
  ];
  const max = opts.maxEntries ?? 150;
  if (isMarkdownPath(opts.filePath) || /^#{1,6}\s/m.test(opts.text)) {
    const full = markdownOutline(opts.text, 3);
    // Over the cap, sub-headings go first: every top-level section staying
    // listed matters more than detail inside a few of them.
    const outline = full.length > max ? full.filter((entry) => entry.level <= 2) : full;
    if (outline.length > 0) {
      const rated = opts.verdictFor !== undefined;
      const body: string[] = [rated ? "Section index (READ = this stage must read it; CHECK = relevance unknown, read if it matters; skip = not needed for this stage):" : "Section index:"];
      let parent: OutlineEntry | undefined;
      for (const entry of outline.slice(0, max)) {
        if (entry.level <= 2) parent = entry;
        const verdict = opts.verdictFor?.(entry, entry.level > 2 ? parent : undefined);
        const tag = verdict ? `[${VERDICT_LABEL[verdict]}] ` : "";
        const ids = entry.ids.length > 0 ? ` ids: ${clip(entry.ids.slice(0, 8).join(","), 80)}${entry.ids.length > 8 ? ` +${entry.ids.length - 8}` : ""}` : "";
        const big = entry.chars > window ? ` — larger than one read window; read by sub-heading or in ≤${window.toLocaleString("en-US")}-char slices` : "";
        body.push(`${"  ".repeat(Math.max(0, entry.level - 1))}- ${tag}${"#".repeat(entry.level)} ${clip(entry.heading, 100)} — lines ${entry.startLine}-${entry.endLine} (${entry.chars.toLocaleString("en-US")} chars)${ids}${big}`);
      }
      if (outline.length < full.length) body.push(`- (${full.length - outline.length} \`###\` sub-heading(s) omitted to keep this index bounded — Grep \`^### \` with line numbers inside a section's range for them.)`);
      if (outline.length > max) body.push(`- … ${outline.length - max} more heading(s) not listed — Grep \`^## \` with line numbers for the rest.`);
      return [...header, ...body].join("\n");
    }
  }
  const windows = lineWindows(opts.text, window);
  const body = [`Line windows of ≤${window.toLocaleString("en-US")} chars (no headings to index — Grep for a symbol/key first, then read around the hit):`];
  for (const w of windows.slice(0, max)) body.push(`- lines ${w.startLine}-${w.endLine} (${w.chars.toLocaleString("en-US")} chars)`);
  if (windows.length > max) body.push(`- … ${windows.length - max} more window(s)`);
  return [...header, ...body].join("\n");
}

/**
 * One line of the per-run read ledger the PreToolUse guard appends
 * (`STA_READ_LEDGER`). Metadata only — never file content.
 */
export interface ReadLedgerEntry {
  tool: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  chars: number;
  fileChars: number;
  decision: "allow" | "block";
  duplicate?: boolean;
  reason?: string;
}

export interface ReadLedgerSummary {
  /** Allowed file reads the guard saw. */
  reads: number;
  /** Characters those reads could return (upper bound: the runtime may cut long lines). */
  readChars: number;
  /** Reads of a range this session had already read — targeted re-reads, reported, not refused. */
  duplicateReads: number;
  /** Reads refused as whole-file/oversized/over-coverage. */
  blockedReads: number;
  /** The largest allowed reads, for "what consumed those tokens". */
  largest: { path: string; startLine: number | null; endLine: number | null; chars: number }[];
}

/** Tolerant of a partially written last line: a crashed hook must not break run accounting. */
export function summarizeReadLedger(jsonl: string, top = 5): ReadLedgerSummary {
  const entries: ReadLedgerEntry[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as ReadLedgerEntry;
      if (parsed && typeof parsed.path === "string" && typeof parsed.chars === "number") entries.push(parsed);
    } catch {
      // skip the torn line
    }
  }
  const allowed = entries.filter((entry) => entry.decision === "allow");
  return {
    reads: allowed.length,
    readChars: allowed.reduce((sum, entry) => sum + entry.chars, 0),
    duplicateReads: allowed.filter((entry) => entry.duplicate === true).length,
    blockedReads: entries.filter((entry) => entry.decision === "block").length,
    largest: [...allowed]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, top)
      .map((entry) => ({ path: entry.path, startLine: entry.startLine, endLine: entry.endLine, chars: entry.chars })),
  };
}
