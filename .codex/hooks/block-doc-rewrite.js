#!/usr/bin/env node
/*
 * PreToolUse guard for `policies/documentation.md` §4 — "Amend, don't regenerate".
 *
 * Once a module doc exists, agents are supposed to amend it section-by-section with `Edit`,
 * never replace it with a `Write` — a prompt instruction that only holds as long as every
 * agent remembers it. This hook enforces the mechanical half: a `Write` whose target is one
 * of the seven per-module docs, and which already exists on disk, is blocked before it runs.
 *
 * Deliberately NOT blocked:
 *   - `Write` when the file does NOT exist yet — that's the doc's first creation
 *     (business-analyst making requirement.md, system-analyst making design.md, ...).
 *   - `Write` to anything else — this only watches the docs conventions.md §1 names.
 *   - `Edit`/`MultiEdit` on these docs — amending is the allowed path. A `MultiEdit` can
 *     still gut a doc, but it goes through the same visible diff an `Edit` does, and
 *     blocking it wholesale would break every legitimate amend.
 *   - `NotebookEdit` — it only targets `.ipynb`, which the module-doc rule below never matches.
 *   - Shell redirection (`cat > doc`) — out of scope by design, same line
 *     `block-outside-repo.js` draws.
 *
 * PreToolUse input carries no subagent identity, only tool_name/tool_input, so this can't
 * special-case "except business-analyst creating it for the first time" — the file-exists
 * check already produces that behavior structurally.
 *
 * Blocks by exiting 2, which returns the message on stderr to the model. Anything it can't
 * parse or resolve is allowed through — a guard that fails closed on malformed input would
 * break unrelated work, and this is a backstop, not the only rule.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
  let reason;
  try {
    reason = check(input || {});
  } catch {
    process.exit(0); // never trap an agent because this guard itself broke — same contract as the other guards
  }
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
  process.exit(0);
});

/** The per-module docs named in conventions.md §1. */
const GUARDED_NAMES = new Set([
  'requirement.md',
  'design.md',
  'plan.md',
  'test-plan.md',
  'review.md',
  'security.md',
  'deploy.md',
]);

/** Only a path under `_docs/module/<name>/` is a module doc — not a same-named file elsewhere. */
const MODULE_DOC = /(^|[/\\])_docs[/\\]module[/\\][^/\\]+[/\\]([^/\\]+)$/;

function check(input) {
  if (input.tool_name !== 'Write') return null;

  const rawPath = (input.tool_input || {}).file_path;
  if (!rawPath || typeof rawPath !== 'string') return null;

  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(MODULE_DOC);
  if (!match || !GUARDED_NAMES.has(match[2])) return null;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);

  let exists;
  try {
    exists = fs.existsSync(abs);
  } catch {
    return null;
  }
  if (!exists) return null;

  return deny(rawPath, match[2]);
}

function deny(rawPath, filename) {
  return [
    `Blocked: \`Write\` to \`${rawPath}\`, which already exists.`,
    '',
    '`policies/documentation.md` §4 — "Amend, don\'t regenerate": once a module doc exists,',
    `it's amended with \`Edit\`, section by section, never replaced with \`Write\`. A full rewrite`,
    'of an existing `' + filename + '` silently destroys history, the `## Change Log`, and any',
    'other agent\'s prior work in it.',
    '',
    'Use `Edit` on the specific section that needs to change, and append a dated line to the',
    "document's `## Change Log` — don't retry this as a `Write`.",
  ].join('\n');
}
