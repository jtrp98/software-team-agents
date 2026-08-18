#!/usr/bin/env node
/*
 * PreToolUse guard for `.claude/shared/conventions.md` §4 — "Amend, don't regenerate".
 *
 * That rule is a prompt instruction: once a module doc exists, every agent is supposed to
 * amend it section-by-section with `Edit`, never blow it away with a full `Write`. Like the
 * git and outside-repo rules, it only holds as long as every agent remembers it — so this
 * hook enforces the mechanical half of it: a `Write` call whose target is one of the six
 * per-module docs, and which already exists on disk, is blocked before it runs. `Edit` is
 * unaffected — that's the whole point, it's the only allowed way to change an existing doc.
 *
 * Deliberately NOT blocked:
 *   - `Write` to one of these paths when the file does NOT exist yet — that's the doc's first
 *     creation (business-analyst making requirement.md, system-analyst making design.md, ...),
 *     which is exactly what `Write` is for.
 *   - `Write` to anything else (app code, `.claude/...`, `status.md`, or an archived round
 *     under a module's `review` subfolder) — this only watches the six live docs conventions.md
 *     §1 names.
 *   - `Edit`/`MultiEdit` on these docs — amending is the allowed path, not the blocked one.
 *
 * This hook cannot and does not know *which agent* is calling it — PreToolUse input carries
 * no subagent identity, only tool_name/tool_input. So it can't special-case "except
 * business-analyst creating it for the first time" by name; it doesn't need to, because the
 * file-exists check already produces exactly that behavior structurally.
 *
 * Blocks by exiting 2, which returns the message on stderr to the model.
 * Anything it can't parse or resolve is allowed through — a guard that fails closed on
 * malformed input would break unrelated work, and this is a backstop, not the only rule.
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
  const reason = check(input || {});
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
  process.exit(0);
});

/** The six per-module docs conventions.md §1 names, plus their fixed filenames. */
const GUARDED_NAMES = new Set([
  'requirement.md',
  'design.md',
  'plan.md',
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
    '`.claude/shared/conventions.md` §4 — "Amend, don\'t regenerate": once a module doc exists,',
    `it's amended with \`Edit\`, section by section, never replaced with \`Write\`. A full rewrite`,
    'of an existing `' + filename + '` silently destroys history, the `## Change Log`, and any',
    'other agent\'s prior work in it.',
    '',
    'Use `Edit` on the specific section that needs to change, and append a dated line to the',
    "document's `## Change Log` — don't retry this as a `Write`.",
  ].join('\n');
}
