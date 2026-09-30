#!/usr/bin/env node
/*
 * PreToolUse guard: a large file never enters an agent's conversation whole.
 *
 * WHY THIS EXISTS
 *
 * One whole-file read of a 400k-character design.md (or a 1 MB JSON fixture, a
 * generated .ts, a log) puts ~100k+ tokens into the conversation, and every
 * later agentic turn re-sends it as history: a single tool call becomes
 * hundreds of thousands of cumulative input tokens. Prompt rules alone
 * (`policies/documentation.md` §10a) are not a safety boundary, so this hook
 * enforces the same Large File Context Policy the orchestrator applies to its
 * own renders (`orchestrator/src/context/largeFile.ts`).
 *
 * WHAT IT DOES
 *
 * - `Read` of a text file above `large_file_chars`: allowed only as a bounded
 *   window (`offset`/`limit`) of at most `max_read_window_chars`. A read with
 *   no window, or a window that is still too large, is refused with the file's
 *   section index (Markdown) or line-window map (anything else) — every part
 *   of the file stays reachable, nothing is truncated.
 * - Paging: distinct lines read from one large file in one session are
 *   tracked; once they would exceed `max_file_read_share` of the file, new
 *   ranges are refused (re-reading an already-read range is allowed and only
 *   recorded as a duplicate). Walking a file window by window is the same
 *   whole-file read, just slower.
 * - `Bash`/`PowerShell`: a bare whole-file dump (`cat`, `type`, `Get-Content`
 *   without -TotalCount/-Head/-Tail, `more`, `less`, `nl`, `bat`) of a large
 *   file is refused. A piped or redirected command is left alone — `grep`,
 *   `sed -n`, `head` are exactly the bounded tools this policy points to.
 *   This half is best-effort by nature; the `Read` half is exact.
 * - Every decision is appended (metadata only — never content) to a read
 *   ledger: `STA_READ_LEDGER` when the orchestrator set one for the run,
 *   otherwise a per-session file under the OS temp dir. The ledger is what
 *   `sta tokens` reports as retrieval and what the coverage check reads.
 *
 * Thresholds: env `STA_LARGE_FILE_CHARS` / `STA_MAX_READ_WINDOW_CHARS` /
 * `STA_MAX_FILE_READ_SHARE` (set by the orchestrator from `.sta/config.yaml`),
 * else the same keys under `context_budget:` in `.sta/config.yaml`, else
 * 100000 / 40000 / 0.5. `STA_LARGE_READ_GUARD=off` disables the guard for a
 * person's own session; nothing an agent does can set it for its hook.
 *
 * Exits 2 to block with the explanation on stderr; 0 to allow. Anything it
 * cannot parse or stat is allowed through — same fail-open contract as every
 * other guard here: this bounds cost, it must never trap an agent.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { largeFileChars: 100000, maxReadWindowChars: 40000, maxFileReadShare: 0.5 };
/** Claude Code's `Read` returns this many lines when no `limit` is given. */
const READ_DEFAULT_LIMIT = 2000;
const NON_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|zip|gz|tgz|7z|woff2?|ttf|otf|mp[34]|mov|wasm|sqlite|db)$/i;
const DUMP_COMMANDS = new Set(['cat', 'type', 'more', 'less', 'nl', 'bat', 'tac', 'get-content', 'gc']);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  let reason = null;
  try {
    reason = check(input || {});
  } catch {
    process.exit(0);
  }
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
  process.exit(0);
});

function positiveInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function share(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
}

/** The keys are distinctive enough to read by regex — the same no-dependency posture as the other hooks' YAML reads. */
function configValue(text, key) {
  const match = new RegExp(`^\\s+${key}:\\s*([0-9.]+)\\s*(#.*)?$`, 'm').exec(text);
  return match ? match[1] : undefined;
}

function resolvePolicy(root) {
  let config = '';
  try { config = fs.readFileSync(path.join(root, '.sta', 'config.yaml'), 'utf8'); } catch { config = ''; }
  const largeFileChars = positiveInt(process.env.STA_LARGE_FILE_CHARS) ?? positiveInt(configValue(config, 'large_file_chars')) ?? DEFAULTS.largeFileChars;
  const window = positiveInt(process.env.STA_MAX_READ_WINDOW_CHARS) ?? positiveInt(configValue(config, 'max_read_window_chars')) ?? DEFAULTS.maxReadWindowChars;
  return {
    largeFileChars,
    maxReadWindowChars: Math.min(window, largeFileChars),
    maxFileReadShare: share(process.env.STA_MAX_FILE_READ_SHARE) ?? share(configValue(config, 'max_file_read_share')) ?? DEFAULTS.maxFileReadShare,
  };
}

function check(input) {
  if (String(process.env.STA_LARGE_READ_GUARD || '').toLowerCase() === 'off') return null;
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const base = input.cwd || root;
  const policy = resolvePolicy(root);
  if (tool === 'Read') return checkRead(input, args, base, policy);
  if (tool === 'Bash' || tool === 'PowerShell') return checkShell(input, args, base, policy);
  return null;
}

/** Text of a regular file, or null for anything that is not one (binary, missing, a directory). */
function loadText(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile() || NON_TEXT.test(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString('utf8');
}

function resolveFile(base, raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const unquoted = raw.replace(/^["']|["']$/g, '');
  return path.isAbsolute(unquoted) ? unquoted : path.resolve(base, unquoted);
}

function checkRead(input, args, base, policy) {
  const file = resolveFile(base, args.file_path);
  if (!file) return null;
  const text = loadText(file);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const offset = positiveInt(args.offset) ?? 1;
  const limit = positiveInt(args.limit) ?? READ_DEFAULT_LIMIT;
  const start = Math.min(offset, lines.length);
  const end = Math.min(lines.length, start + limit - 1);
  const chars = rangeChars(lines, start, end);
  const entry = { tool: 'Read', path: file, startLine: start, endLine: end, chars, fileChars: text.length };

  if (text.length <= policy.largeFileChars) {
    record(input, { ...entry, decision: 'allow', duplicate: isDuplicate(input, file, start, end) });
    return null;
  }
  const windowed = args.offset !== undefined || args.limit !== undefined;
  if (!windowed || chars > policy.maxReadWindowChars) {
    const why = windowed
      ? `the requested window (lines ${start}-${end}) is ${fmt(chars)} chars, above max_read_window_chars ${fmt(policy.maxReadWindowChars)}`
      : 'a Read with no offset/limit asks for the file from the top';
    const shown = indexShown(input, file);
    record(input, { ...entry, decision: 'block', reason: 'window' });
    return denial(file, text, lines, policy, why, shown);
  }
  const prior = readIntervals(input, file);
  const duplicate = prior.some(([a, b]) => a <= start && end <= b);
  if (!duplicate && policy.maxFileReadShare < 1) {
    const covered = coveredChars(lines, [...prior, [start, end]]);
    if (covered > policy.maxFileReadShare * text.length) {
      const shown = indexShown(input, file);
      record(input, { ...entry, decision: 'block', reason: 'coverage' });
      const before = coveredChars(lines, prior);
      return [
        `Blocked by the Large File Context Policy (\`policies/documentation.md\` §10a): this session has already read ${pct(before, text.length)} of \`${file}\` (${fmt(before)} of ${fmt(text.length)} chars) in separate ranges; lines ${start}-${end} would take it past max_file_read_share ${Math.round(policy.maxFileReadShare * 100)}%.`,
        'Reading a large file window by window is the whole-file read this policy prevents. Grep this file for the exact rule/id/term you still need and read only that range. Ranges already read may be re-read.',
        '',
        shown ? INDEX_ALREADY_SHOWN : indexFor(file, text, lines, policy),
      ].join('\n');
    }
  }
  record(input, { ...entry, decision: 'allow', duplicate });
  return null;
}

/** Segments of a command line joined by `&&`, `||`, `;` or newlines — each is its own command. */
function segments(command) {
  return String(command).split(/&&|\|\||;|\r?\n/).map((part) => part.trim()).filter(Boolean);
}

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^["']|["']$/g, ''));
}

function checkShell(input, args, base, policy) {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return null;
  for (const segment of segments(command)) {
    // A pipe or a redirect bounds or diverts the output: grep/sed/head are
    // the retrieval tools this policy recommends, and `> file` never reaches
    // the conversation.
    if (/[|>]/.test(segment)) continue;
    const parts = tokens(segment);
    if (parts.length < 2) continue;
    const name = path.basename(parts[0]).toLowerCase().replace(/\.exe$/, '');
    if (!DUMP_COMMANDS.has(name)) continue;
    if ((name === 'get-content' || name === 'gc') && parts.some((part) => /^-(totalcount|head|first|tail|last|readcount)$/i.test(part))) continue;
    const operands = parts.slice(1).filter((part, index, all) => !part.startsWith('-') || /^-(path|literalpath)$/i.test(all[index - 1] || ''))
      .filter((part) => !/^-(path|literalpath)$/i.test(part));
    for (const operand of operands) {
      const file = resolveFile(base, operand);
      if (!file) continue;
      const text = loadText(file);
      if (text === null || text.length <= policy.largeFileChars) continue;
      const lines = text.split(/\r?\n/);
      const shown = indexShown(input, file);
      record(input, { tool: input.tool_name, path: file, startLine: 1, endLine: lines.length, chars: text.length, fileChars: text.length, decision: 'block', reason: 'shell-dump' });
      return denial(file, text, lines, policy, `\`${name}\` would print the whole file into this conversation`, shown);
    }
  }
  return null;
}

/** A repeated refusal must not re-send the same index into the conversation it is protecting. */
const INDEX_ALREADY_SHOWN = '(The section index for this file was already shown earlier in this session — use those line ranges.)';

function indexShown(input, file) {
  return ledgerEntries(input).some((entry) => entry.decision === 'block' && entry.path === file);
}

function denial(file, text, lines, policy, why, shown) {
  return [
    `Blocked by the Large File Context Policy (\`policies/documentation.md\` §10a): \`${file}\` is ${fmt(text.length)} chars / ${fmt(lines.length)} lines (~${fmt(Math.ceil(text.length / 4))} tokens est.), above large_file_chars ${fmt(policy.largeFileChars)} — it is never read whole, and ${why}.`,
    `Do instead: Grep this file for the rule, id, symbol or term you need (with line numbers), then Read with offset/limit around the hit — at most ${fmt(policy.maxReadWindowChars)} chars per read (sed -n '<start>,<end>p' from a shell) — and widen to an adjacent range only if the evidence is still insufficient. If what you need is not found, search again with other terms; do not fall back to the whole file.`,
    '',
    shown ? INDEX_ALREADY_SHOWN : indexFor(file, text, lines, policy),
  ].join('\n');
}

/** Headings with 1-based line ranges for Markdown; fixed line windows for anything else. Bounded by entry count, not file size. */
function indexFor(file, text, lines, policy) {
  const max = 80;
  if (/\.(md|markdown|mdx)$/i.test(file) || /^#{1,3}\s/m.test(text)) {
    const heads = [];
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
      if (fenced) continue;
      const match = /^(#{1,3})\s+(.*\S)\s*$/.exec(lines[i]);
      if (match) heads.push({ level: match[1].length, heading: match[2].trim(), index: i });
    }
    if (heads.length > 0) {
      const out = ['Section index (1-based line ranges):'];
      heads.slice(0, max).forEach((head, n) => {
        const next = head.level === 1 ? heads[n + 1] : heads.slice(n + 1).find((candidate) => candidate.level <= head.level);
        const endLine = next ? next.index : lines.length;
        const chars = rangeChars(lines, head.index + 1, endLine);
        const title = head.heading.length > 90 ? `${head.heading.slice(0, 89)}…` : head.heading;
        out.push(`${'  '.repeat(head.level - 1)}- ${'#'.repeat(head.level)} ${title} — lines ${head.index + 1}-${endLine} (${fmt(chars)} chars)`);
      });
      if (heads.length > max) out.push(`- … ${heads.length - max} more heading(s): Grep \`^#{1,3} \` with line numbers for the rest.`);
      return out.join('\n');
    }
  }
  const out = [`Line windows of ≤${fmt(policy.maxReadWindowChars)} chars (Grep for a symbol/key first, then read around the hit):`];
  let start = 1;
  let chars = 0;
  let count = 0;
  for (let i = 1; i <= lines.length && count < 40; i++) {
    const cost = lines[i - 1].length + 1;
    if (i > start && chars + cost > policy.maxReadWindowChars) {
      out.push(`- lines ${start}-${i - 1} (${fmt(chars)} chars)`);
      count++;
      start = i;
      chars = 0;
    }
    chars += cost;
  }
  if (count < 40) out.push(`- lines ${start}-${lines.length} (${fmt(chars)} chars)`);
  else out.push('- … further windows follow the same size');
  return out.join('\n');
}

function rangeChars(lines, start, end) {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += lines[i - 1].length + 1;
  return sum;
}

function coveredChars(lines, intervals) {
  const sorted = intervals.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged.reduce((sum, [a, b]) => sum + rangeChars(lines, a, Math.min(b, lines.length)), 0);
}

function ledgerPath(input) {
  if (process.env.STA_READ_LEDGER) return process.env.STA_READ_LEDGER;
  if (!input.session_id) return null;
  return path.join(os.tmpdir(), 'sta-read-ledger', `${String(input.session_id).replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
}

function ledgerEntries(input) {
  const file = ledgerPath(input);
  if (!file) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
}

function readIntervals(input, file) {
  return ledgerEntries(input)
    .filter((entry) => entry.decision === 'allow' && entry.path === file && Number.isInteger(entry.startLine) && Number.isInteger(entry.endLine))
    .map((entry) => [entry.startLine, entry.endLine]);
}

function isDuplicate(input, file, start, end) {
  return readIntervals(input, file).some(([a, b]) => a <= start && end <= b);
}

function record(input, entry) {
  const file = ledgerPath(input);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8');
  } catch {
    // observability is best-effort; the decision above never depends on it being written
  }
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function pct(part, whole) {
  return `${Math.round((part / Math.max(1, whole)) * 100)}%`;
}
