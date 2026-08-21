#!/usr/bin/env node
/*
 * Stop / SubagentStop guard (T25 — Secret Detection): an agent doesn't get to finish a run that
 * leaves a hardcoded secret sitting in a file it just wrote or edited.
 *
 * WHY THIS RUNS AT STOP, NOT ONCE PER PHASE LIKE static-analysis-gate.js
 *
 * TASKS.md's T25 spec says "agent ต้องตรวจก่อนส่งงาน" — before *handing off*, which is a
 * per-agent-stop event, not a once-per-phase gate. A secret written by `backend-engineer` and
 * only caught when `qa-engineer` runs `static-analysis-gate.js` later has already sat in the
 * file across a full agent turn; catching it here is the same "cheapest possible place" logic
 * `require-green-before-stop.js` already uses for typecheck/lint (see that file's header) — and
 * this shares its shape: read-only git diff to find what changed, block only on that, exit 2
 * with the reason on stderr, exit 0 for everything else including "not a git repo" and "can't
 * tell what changed" (fail open, never trap an agent because this guard broke).
 *
 * WHY `.env` IS EXCLUDED AND `.env.example` IS NOT
 *
 * CLAUDE.md/`setup.md`: `.env` is where real secret values are *supposed* to live, and it's
 * gitignored by convention — flagging it would just be noise on every project's first scaffold.
 * `.env.example` is the opposite case: it's meant to hold placeholder values and is committed by
 * convention, so a real-looking secret landing there is exactly the mistake this hook exists to
 * catch, not an exception to it.
 *
 * WHAT THIS DOES NOT CLAIM TO BE
 *
 * A curated pattern list (AWS keys, private-key blocks, connection strings with embedded
 * credentials, a handful of secret-shaped variable assignments), same honesty as
 * `static-analysis-gate.js`'s `security_scan`/`dependency_scan`: catches the obvious cases,
 * not a substitute for `security`'s own audit or a real secret-scanning tool (gitleaks/trufflehog).
 *
 * Exits 2 to block with the reason on stderr; 0 to allow.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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
  let result;
  try {
    result = run(input || {});
  } catch {
    process.exit(0); // never trap an agent because this guard itself broke
  }
  if (result) {
    console.error(result);
    process.exit(2);
  }
  process.exit(0);
});

/** Files never scanned — `.env` is the convention-approved place for real secret values. */
const EXCLUDE_EXACT = new Set(['.env']);
// `.claude/` is harness code, not project content this pipeline produces — its hooks/scripts/
// self-test deliberately contain secret-shaped literals as their OWN test fixtures (this file's
// patterns, and run.js's cases for them), so scanning it is self-referential and would flag the
// harness's own tests every time they're edited, not a real leak into the project being built.
const EXCLUDE_DIRS = [/^node_modules\//, /^\.git\//, /^dist\//, /^\.next\//, /^\.workflow\//, /^\.claude\//];

// Values that are obviously not real secrets — excluded from the generic key/value pattern so
// scaffolding a `.env.example` with normal placeholders doesn't trip this every time.
const PLACEHOLDER_VALUE = /^(changeme|change_me|change-me|placeholder|your[-_]?\w*|example\w*|xxx+|dummy|fake|test|password\d*|secret)$/i;

/**
 * Each entry either has a plain `pattern` (any match on a line is a hit), or a `find` function
 * that returns the matched literal (or null) so the placeholder check above can apply to it.
 */
const SECRET_PATTERNS = [
  { name: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', pattern: /-----BEGIN\s?(RSA|EC|DSA|OPENSSH|PGP)?\s?PRIVATE KEY-----/ },
  {
    name: 'database connection string with an embedded, non-placeholder password',
    find: (line) => {
      const m = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\/\s'"]+:([^@\/\s'"]+)@/.exec(line);
      if (!m) return null;
      const password = m[1];
      if (PLACEHOLDER_VALUE.test(password)) return null;
      return password;
    },
  },
  {
    name: 'hardcoded secret-shaped value (api key / token / password / secret)',
    find: (line) => {
      const m = /(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i.exec(line);
      if (!m) return null;
      const value = m[1];
      if (PLACEHOLDER_VALUE.test(value)) return null;
      if (/^\$\{.*\}$|process\.env\./.test(value)) return null; // referencing an env var is the correct pattern, not a leak
      if (!/^[A-Za-z0-9_\-/+.=]+$/.test(value)) return null; // not secret-shaped (plain words, sentences)
      return value;
    },
  },
];

function run(input) {
  if (input.stop_hook_active === true) return null; // already retried once -- see header

  const changed = changedFiles();
  if (changed === null) return null; // not a git repo / git unavailable

  const hits = [];
  for (const rel of changed) {
    if (EXCLUDE_EXACT.has(path.basename(rel)) || EXCLUDE_DIRS.some((re) => re.test(rel))) continue;
    const full = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // deleted, binary, or unreadable -- not this guard's job
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const entry of SECRET_PATTERNS) {
        const matched = entry.pattern ? entry.pattern.test(line) : entry.find(line) !== null;
        if (matched) hits.push(`${rel}:${i + 1} — ${entry.name}`);
      }
    });
  }

  if (hits.length === 0) return null;
  return deny(hits);
}

/** Tracked modifications plus untracked files, repo-relative with forward slashes. */
function changedFiles() {
  const out = [];
  for (const args of [['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    let text;
    try {
      text = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    for (const line of text.split(/\r?\n/)) {
      const f = line.trim().replace(/\\/g, '/');
      if (f) out.push(f);
    }
  }
  return [...new Set(out)];
}

function deny(hits) {
  const parts = [
    'Not finished: a file this run changed looks like it contains a hardcoded secret.',
    '',
    'Real secret values belong in `.env` (gitignored) or come from `process.env.*` at runtime --',
    'never hardcoded in application code, docs, or `.env.example` (which is committed and must',
    'only hold placeholders). Move the value out before handing off.',
    '',
    ...hits.slice(0, 20).map((h) => `  - ${h}`),
  ];
  if (hits.length > 20) parts.push(`  ...+${hits.length - 20} more`);
  parts.push(
    '',
    '**If this is a false positive** (a placeholder that happens to look secret-shaped, a test',
    'fixture value, a pattern discussed in a comment) -- rephrase it so it no longer matches',
    '(e.g. reference it via `process.env.X` or use an obvious placeholder like `changeme`)',
    'rather than reintroducing the same literal; this guard allows the next attempt through so',
    'it can never trap you.',
  );
  return parts.join('\n');
}
