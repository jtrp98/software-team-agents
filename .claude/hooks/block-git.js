#!/usr/bin/env node
/*
 * PreToolUse guard for `.claude/shared/conventions.md` §5 — "No agent runs git".
 *
 * That rule is a prompt instruction, which means it holds only as long as every agent
 * remembers it. This hook enforces it at the tool-call layer instead: a state-changing
 * git command, or any direct access to `.git/`, is blocked before it runs.
 *
 * Deliberately NOT blocked:
 *   - read-only inspection (`git status`, `log`, `diff`, `show`, ...) — it changes nothing,
 *     and a blocked read costs a round-trip for no safety gain
 *   - writing files that merely relate to git (`.gitignore`, `.github/workflows/*`) — §5
 *     allows those explicitly for `setup`/`devops`
 *
 * Blocks by exiting 2, which returns the message on stderr to the model.
 * Anything it can't parse is allowed through: a guard that fails closed on malformed
 * input would break unrelated work, and this is a backstop, not the only rule.
 */

'use strict';

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

/** `.git` as a path element — not `.gitignore`, `.github`, or a `…/repo.git` clone URL. */
const DOT_GIT = /(?:^|[^\w.\-])\.git(?![\w-])/;

/** Subcommands that only read. Anything not listed is treated as state-changing. */
const READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'describe', 'shortlog', 'whatchanged',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'grep',
  'name-rev', 'merge-base', 'check-ignore', 'count-objects', 'var', 'version', 'help',
]);

/** Wrappers to look through before deciding whether the command is git. */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'winpty', 'stdbuf']);

/** Global flags that consume the next token, so it isn't mistaken for the subcommand. */
const FLAGS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function check(input) {
  const tool = input.tool_name || '';
  const args = input.tool_input || {};

  if (tool === 'Bash') return checkCommand(String(args.command || ''));

  const path = String(args.file_path || args.notebook_path || args.path || '');
  if (path && DOT_GIT.test(path.replace(/\\/g, '/'))) {
    return deny(`writing inside \`.git/\` (${path})`);
  }
  return null;
}

function checkCommand(command) {
  if (!command) return null;

  if (DOT_GIT.test(command)) {
    return deny('a command that touches `.git/` directly');
  }

  for (const segment of splitSegments(command)) {
    const verdict = checkSegment(segment);
    if (verdict) return verdict;
  }
  return null;
}

/** Split on shell operators so `foo && git commit` is checked as two commands. */
function splitSegments(command) {
  return command.split(/\|\||&&|\$\(|[;|&\n(){}`]/);
}

function checkSegment(segment) {
  let tokens = tokenize(segment);

  // Strip leading `FOO=bar` assignments and wrapper commands.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || WRAPPERS.has(basename(tokens[0])))) {
    tokens = tokens.slice(1);
  }
  if (!tokens.length || basename(tokens[0]) !== 'git') return null;

  const sub = subcommand(tokens.slice(1));
  if (!sub) return null; // bare `git`, `git --version`

  if (READ_ONLY.has(sub)) return null;
  if (sub === 'config' && tokens.some((t) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(t))) return null;
  if (sub === 'remote' && isReadOnlyArg(tokens, sub, ['show', 'get-url', '-v', '--verbose'], true)) return null;
  // Bare `git stash` means "stash push" — only the explicit read subcommands are safe.
  if (sub === 'stash' && isReadOnlyArg(tokens, sub, ['list', 'show'], false)) return null;
  if (sub === 'notes' && isReadOnlyArg(tokens, sub, ['list', 'show'], true)) return null;

  return deny(`\`git ${sub}\``);
}

function isReadOnlyArg(tokens, sub, allowed, bareIsReadOnly) {
  const rest = tokens.slice(tokens.indexOf(sub) + 1).filter((t) => t !== '');
  return rest.length === 0 ? bareIsReadOnly : allowed.includes(rest[0]);
}

function subcommand(rest) {
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (FLAGS_WITH_VALUE.has(token)) { i++; continue; }
    if (token.startsWith('-')) continue;
    return token.toLowerCase();
  }
  return null;
}

function basename(token) {
  return token.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
}

/** Minimal shell tokenizer — quotes off, whitespace splits. Enough to find the command word. */
function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function deny(what) {
  return [
    `Blocked: ${what}.`,
    '',
    'Version control belongs to the user (`.claude/shared/conventions.md` §5) — no agent in this',
    'pipeline runs git or touches `.git/`. Read-only inspection (`git status`, `log`, `diff`, `show`)',
    'is allowed; anything that changes repository state is not.',
    '',
    'Writing a file that relates to git — `.gitignore`, a CI workflow — is fine and is not affected',
    'by this hook. If the user genuinely wants a git command run, they run it themselves.',
  ].join('\n');
}
