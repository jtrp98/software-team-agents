#!/usr/bin/env node
/*
 * PreToolUse guard: no file-writing tool call may land outside the project's repo root.
 *
 * The pipeline's agents each own one folder or file set (`_docs/module/<name>/`, app source,
 * `.claude/...`) and every path in their prompts is written relative to the repo root. A path
 * that resolves outside it is either a mistake (a bad relative path, a misread absolute path)
 * or scope creep neither this pipeline nor the user asked for — worth blocking mechanically
 * rather than trusting every agent to self-check every write.
 *
 * Root is `$CLAUDE_PROJECT_DIR` if the harness provides it, else the hook's own cwd (Claude
 * Code always launches PreToolUse hooks with the project directory as cwd).
 *
 * One deliberate exception: Claude Code's own scratchpad convention writes temp files under
 * the OS temp dir, e.g. `...\AppData\Local\Temp\claude\<project>\<session>\scratchpad\...`.
 * That's the harness's own mechanism for exactly this kind of repo, not an agent going rogue,
 * so it's allowed through rather than fighting the tool that told it to write there.
 *
 * Only checks tools that take a destination path (Write/Edit/MultiEdit/NotebookEdit). Bash is
 * deliberately out of scope here — firewalling every path a shell command might touch (temp
 * files, package manager caches, redirects) reliably is a much bigger problem than this guard
 * is trying to solve, and a wrong block there costs more false positives than it prevents.
 *
 * Blocks by exiting 2, which returns the message on stderr to the model. Anything this can't
 * parse or resolve is allowed through — a guard that fails closed on malformed input breaks
 * unrelated work, and this is a backstop, not the only rule.
 */

'use strict';

const path = require('path');
const os = require('os');

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

const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function check(input) {
  const tool = input.tool_name || '';
  if (!PATH_TOOLS.has(tool)) return null;

  const args = input.tool_input || {};
  const rawPath = args.file_path || args.notebook_path || args.path;
  if (!rawPath || typeof rawPath !== 'string') return null;

  const root = normalize(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const target = normalize(path.resolve(root, rawPath));

  if (isUnder(target, root)) return null;
  if (isUnder(target, normalize(path.join(os.tmpdir(), 'claude')))) return null;

  return deny(rawPath, root);
}

/** Case-insensitive on Windows, backslashes normalized to forward slashes, no trailing slash. */
function normalize(p) {
  let n = path.resolve(p).replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function isUnder(target, root) {
  return target === root || target.startsWith(root + '/');
}

function deny(rawPath, root) {
  return [
    `Blocked: writing to \`${rawPath}\`, which resolves outside the project root (${root}).`,
    '',
    'Every agent in this pipeline owns paths relative to the repo root — `_docs/module/<name>/`,',
    'app source, `.claude/...` — and a write that lands outside it is either a bad path or scope',
    'the user never asked for. If this really is intentional (e.g. editing a file the user named',
    'elsewhere on disk), tell the user what you were about to write and let them confirm or do it',
    'themselves — this hook does not distinguish "asked for" from "accidental".',
  ].join('\n');
}
