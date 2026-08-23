#!/usr/bin/env node
/*
 * PreToolUse guard for `policies/git.md` §5 — "No agent runs git".
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
 * Both shell tools are inspected — `Bash` and `PowerShell` (the matcher in
 * settings.json covers both). A guard that read only Bash commands would let every
 * rule here be bypassed by switching shells.
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

/** Tools that carry a whole command string rather than a destination path. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

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

/**
 * Shells whose `-c`/`-Command` argument is itself a command line to re-check:
 * `bash -c "git commit"` must resolve to the git call inside it, or the quotes
 * alone would hide it.
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'powershell', 'pwsh', 'cmd']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '--command', '-command', '/c', '-command']);

/** Global flags that consume the next token, so it isn't mistaken for the subcommand. */
const FLAGS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function check(input) {
  const tool = input.tool_name || '';
  const args = input.tool_input || {};

  if (COMMAND_TOOLS.has(tool)) return checkCommand(String(args.command || ''));

  const path = pathText(args);
  if (path && DOT_GIT.test(path)) {
    return deny(`writing inside \`.git/\` (${String(args.file_path || args.notebook_path || args.path)})`);
  }
  return null;
}

/**
 * Path-shaped tool input as one searchable string. A non-string that isn't an
 * array of strings can't be resolved to a path; stringify whatever is there so
 * the `.git` test still sees it instead of throwing on it.
 */
function pathText(args) {
  const rawPath = args.file_path || args.notebook_path || args.path;
  if (!rawPath) return '';
  if (Array.isArray(rawPath)) {
    return rawPath.map((p) => String(p ?? '').replace(/\\/g, '/')).join('\n');
  }
  return String(rawPath).replace(/\\/g, '/');
}

function checkCommand(command, vars, depth) {
  if (!command) return null;
  const env = vars || new Map();
  const depthLeft = depth === undefined ? 4 : depth;
  if (depthLeft <= 0) return null;

  if (DOT_GIT.test(command)) {
    return deny('a command that touches `.git/` directly');
  }

  for (const segment of splitSegments(command)) {
    const verdict = checkSegment(segment, env, depthLeft);
    if (verdict) return verdict;
  }
  return null;
}

/**
 * Split on shell operators so `foo && git commit` is checked as two commands,
 * without ever splitting inside quotes — `grep "a|b" file` is one grep whose
 * pattern happens to contain a pipe, not two commands.
 */
function splitSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = null; cur += ch; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { cur += ch + command[i + 1]; i++; continue; }
      cur += ch;
      continue;
    }
    // Quote characters stay in the segment text — tokenize() below is what
    // strips them. Dropping them here would fuse `` `git push` `` into bare
    // words and hide the substitution from the checks that look for it.
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (ch === '$' && command[i + 1] === '(') { out.push(cur); cur = ''; continue; }
    if (/[\n|;&(){}`]/.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((s) => s.trim() !== '');
}

function checkSegment(segment, env, depthLeft) {
  let tokens = tokenize(segment);

  // Record leading `FOO=bar` assignments so `$FOO` later in the chain resolves —
  // `g=git; $g commit` is a git commit wherever it appears.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const eq = tokens[0].indexOf('=');
    env.set(tokens[0].slice(0, eq), tokens[0].slice(eq + 1));
    tokens = tokens.slice(1);
  }
  // Strip wrapper commands (`sudo git ...`, `env git ...`).
  while (tokens.length && WRAPPERS.has(basename(tokens[0]))) {
    tokens = tokens.slice(1);
  }
  if (!tokens.length) return null;

  // Unwrap `bash -c "<command>"` / `powershell -Command "<command>"`: what sits
  // behind the flag is another command line, checked recursively.
  if (tokens.length >= 3 && SHELLS.has(basename(tokens[0])) && SHELL_COMMAND_FLAGS.has(tokens[1].toLowerCase())) {
    const inner = tokens.slice(2).join(' ');
    return checkCommand(inner, env, depthLeft - 1);
  }

  // Command substitution hiding inside an argument's quotes — ``echo "`git push`"``
  // never becomes its own segment, because the quotes are exactly what keeps the
  // splitter away from it. Pull the embedded commands out and check them too.
  for (const token of tokens) {
    for (const inner of extractSubCommands(token)) {
      const verdict = checkCommand(inner, env, depthLeft - 1);
      if (verdict) return verdict;
    }
  }

  tokens = tokens.map((t) => expandVars(t, env));
  if (basename(tokens[0]) !== 'git') return null;

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

/** Backtick spans and `$(...)` spans inside one already-tokenized argument. */
function extractSubCommands(token) {
  const out = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '`') {
      const end = token.indexOf('`', i + 1);
      if (end === -1) break;
      out.push(token.slice(i + 1, end));
      i = end;
    } else if (token[i] === '$' && token[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < token.length && depth > 0; j++) {
        if (token[j] === '(') depth++;
        else if (token[j] === ')') depth--;
      }
      if (depth !== 0) break;
      out.push(token.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return out;
}

/** `$NAME` and `${NAME}` against assignments seen earlier in this command line. */
function expandVars(token, env) {
  if (!env.size || !token.includes('$')) return token;
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => {
    const value = env.get(braced || bare);
    return value === undefined ? whole : value;
  });
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
  return token.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').replace(/\.ps1$/i, '').toLowerCase();
}

/** Minimal shell tokenizer — strips quotes, splits on whitespace. Enough to find the command word. */
function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) { cur += ch + segment[i + 1]; i++; }
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
    'Version control belongs to the user (`policies/git.md` §5) — no agent in this',
    'pipeline runs git or touches `.git/`. Read-only inspection (`git status`, `log`, `diff`, `show`)',
    'is allowed; anything that changes repository state is not.',
    '',
    'Writing a file that relates to git — `.gitignore`, a CI workflow — is fine and is not affected',
    'by this hook. If the user genuinely wants a git command run, they run it themselves.',
  ].join('\n');
}
