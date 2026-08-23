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
 * Two deliberate exceptions, both the harness's own mechanisms rather than an agent going rogue:
 *   1. Claude Code's scratchpad convention, under the OS temp dir, e.g.
 *      `...\AppData\Local\Temp\claude\<project>\<session>\scratchpad\...`.
 *   2. Claude Code's persistent auto-memory store, under
 *      `~/.claude/projects/<project-key>/memory/...` — the `MEMORY.md` index and its per-topic
 *      files, which are meant to survive across sessions and therefore can't live under the repo
 *      root or the (session-scoped) temp dir. Scoped narrowly to exactly that `memory` folder one
 *      level under a project key, not the whole `~/.claude/projects/` tree (which also holds
 *      session transcripts and other per-project state this hook has no business touching).
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

const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function check(input) {
  const tool = input.tool_name || '';
  if (!PATH_TOOLS.has(tool)) return null;

  const args = input.tool_input || {};
  const rawPath = args.file_path || args.notebook_path || args.path;
  // An array means several destinations (some MCP file tools): each element gets
  // the same treatment a plain string would. Anything else non-string can't be
  // resolved to a path and falls through to this guard's fail-open default.
  const candidates = Array.isArray(rawPath)
    ? rawPath.filter((p) => typeof p === 'string' && p !== '')
    : typeof rawPath === 'string' ? [rawPath] : [];
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const reason = checkOne(candidate);
    if (reason) return reason;
  }
  return null;
}

function checkOne(rawPath) {
  const root = normalize(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const target = normalize(path.resolve(root, rawPath));

  if (isUnder(target, root)) return null;
  if (writableWorkRoots().some((workRoot) => isUnder(target, workRoot))) return null;
  if (isUnder(target, normalize(path.join(os.tmpdir(), 'claude')))) return null;
  if (isMemoryDir(target)) return null;

  return deny(rawPath, root);
}

/** Canonical Target roots come only from runtime preflight. Invalid input grants nothing. */
function writableWorkRoots() {
  let roots;
  try { roots = JSON.parse(process.env.AGENTCLAUDE_WRITABLE_WORK_ROOTS || '[]'); } catch { return []; }
  if (!Array.isArray(roots)) return [];
  return roots.filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate)).map(normalize);
}

/** Allows writes under exactly `~/.claude/projects/<project-key>/memory/...`. */
function isMemoryDir(target) {
  let home;
  try {
    home = os.homedir();
  } catch {
    // No resolvable home directory (some containers/service accounts): the memory
    // store can't exist, so nothing here is exempt — but this guard must not be
    // what crashes. `null` root matches nothing.
    return false;
  }
  if (!home) return false;
  const projectsRoot = normalize(path.join(home, '.claude', 'projects'));
  if (!isUnder(target, projectsRoot)) return false;
  if (target === projectsRoot) return false;
  const rel = target.slice(projectsRoot.length + 1);
  const parts = rel.split('/');
  return parts.length >= 2 && parts[1] === 'memory';
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
