#!/usr/bin/env node
/*
 * Stop / SubagentStop guard: an agent that changed application code doesn't get to finish
 * while the mechanical checks are red.
 *
 * WHY THIS EXISTS -- it's a token-cost fix, not just a quality one.
 *
 * The expensive failure mode in this pipeline is the dev<->QA round trip. An engineer finishes,
 * `qa-engineer` is invoked, reads plan.md + design.md + requirement.md + schema.prisma + the
 * real code, finds a typecheck error, routes it back; the engineer starts again from a FRESH
 * context, re-reads everything, fixes one line, and QA re-runs from a fresh context too. Round
 * three costs exactly as much as round one -- nothing amortizes. And most of what that loop
 * catches on the first pass is what a compiler catches for free: type errors, lint failures,
 * schema drift. That is an expensive model being used as a linter.
 *
 * This hook moves those checks to the cheapest possible place -- inside the engineer's own run,
 * while it still has every relevant file in context. A failure caught here is fixed in-context
 * for the price of one edit, instead of costing two fresh-context agent runs. Every such fix is
 * a QA round trip that never happens.
 *
 * HOW IT DECIDES WHETHER TO RUN
 *
 * Stop hooks carry no agent identity (same limitation as every hook in this folder -- see
 * block-doc-rewrite.js), so this can't say "only for frontend-engineer/backend-engineer".
 * It uses a proxy that turns out to be better than identity anyway: **did this run change
 * application code?** Doc-only agents (business-analyst, system-analyst, project-manager,
 * qa-engineer writing review.md) touch `_docs/**` and `.claude/**` and never trip it. An
 * engineer that touched app source does.
 *
 * Read-only git (`git diff --name-only`, `git ls-files`) is how it sees what changed. That is
 * consistent with `policies/git.md` §5, on two counts: §5 binds *agents*, and this is harness code,
 * not an agent; and even for agents §5 explicitly allows read-only inspection. Nothing here
 * changes repository state.
 *
 * LOOP SAFETY -- the important part
 *
 * `stop_hook_active` is true when the agent is already continuing *because* this hook blocked it
 * once. In that case this hook exits 0 and lets the run finish, reporting what's still red.
 * So the worst case is exactly ONE forced in-context fix attempt, never a loop -- and that one
 * attempt is the whole saving. If the failure turns out not to be the engineer's to fix (a
 * schema gap that belongs to `system-analyst`), the correct move is what the message tells it:
 * state that in the handoff and finish -- attempt two is allowed through by design.
 *
 * Runs `typecheck` and `lint` only (fast, unambiguous, and unambiguously the engineer's job).
 * `build` and `test` stay with `qa-engineer` -- too slow to pay for on every agent stop.
 * Also runs this repo's two drift scripts when they apply.
 *
 * WHICH package.json those scripts come from is decided by the changed files themselves, not by
 * scanning the repo: each changed file resolves to the nearest package.json at or above it, and
 * every distinct owner is checked. See packagesOwning() for why that direction is load-bearing.
 *
 * Exits 2 to block with the failure text on stderr; 0 to allow. Anything it can't parse,
 * resolve, or run is allowed through -- a guard that fails closed here would trap every agent
 * in the project, and this is a cost optimization, not the correctness guarantee.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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

/** Paths that aren't application code -- a run touching only these is not an engineer run. */
const NON_CODE = [
  /^_docs\//,
  /^\.claude\//,
  /^[^/]*\.md$/i,
  /^\.gitignore$/,
];

function run(input) {
  // Already continuing because this hook blocked once -- release, don't loop. See header.
  if (input.stop_hook_active === true) return null;

  const changed = changedFiles();
  if (changed === null) return null;              // not a git repo / git unavailable
  const code = changed.filter((f) => !NON_CODE.some((re) => re.test(f)));
  if (code.length === 0) return null;             // doc-only run

  const failures = [];

  for (const script of ['typecheck', 'lint']) {
    for (const dir of packagesOwning(code, script)) {
      const res = spawnSync('npm', ['run', '--silent', script], {
        cwd: dir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 180000,
      });
      if (res.error || res.status !== 0) {
        failures.push({
          label: `npm run ${script}` + (dir === root ? '' : ` (in ${path.relative(root, dir)})`),
          output: tail((res.stdout || '') + (res.stderr || ''), 40) || String(res.error || 'exited non-zero'),
        });
      }
    }
  }

  for (const script of ['check-schema-contract.js', 'check-status-sync.js']) {
    const file = path.join(root, '.claude', 'scripts', script);
    if (!fs.existsSync(file)) continue;
    const res = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 60000 });
    if (res.status === 1) {
      failures.push({ label: `node .claude/scripts/${script}`, output: tail(res.stdout || '', 40) });
    }
  }

  if (failures.length === 0) return null;
  return deny(failures, code);
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

/** Does `<dir>/package.json` exist and actually define `script`? */
function definesScript(dir, script) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!(pkg && pkg.scripts && typeof pkg.scripts[script] === 'string');
  } catch {
    return false; // unparseable package.json -- treat as not defining it
  }
}

/**
 * The packages that actually OWN the changed code, i.e. for each changed file the nearest
 * `package.json` at or above it that defines `script`. Every distinct owner is returned, so a
 * run touching two workspaces gets both checked.
 *
 * It resolves upward from the files rather than scanning the repo, and that direction is the
 * whole point. The first version scanned root plus one level down and took the first package
 * defining the script — which had two failure modes, both of them silent:
 *
 *   - Wrong package. Adding `orchestrator/` (which defines `typecheck`) to this repo meant an
 *     engineer's change to app code got graded against the orchestrator's typecheck instead.
 *     Green there, so the guard passed the run through: it fails OPEN, looking installed and
 *     enforcing nothing — exactly the failure this folder's self-test exists to catch.
 *   - Invisible package. Anything deeper than one level (`packages/api/`, `apps/web/`) was
 *     never checked at all.
 *
 * Walking up from the changed file can't do either: the answer is a property of the file, not
 * of directory iteration order. Nothing above `root` is ever consulted.
 */
function packagesOwning(codeFiles, script) {
  const owners = new Set();
  const rootResolved = path.resolve(root);

  for (const rel of codeFiles) {
    let dir = path.resolve(path.dirname(path.join(root, rel)));
    // A path from git is repo-relative, but a `..` in one would escape the repo -- don't follow it.
    if (dir !== rootResolved && !dir.startsWith(rootResolved + path.sep)) continue;

    for (;;) {
      if (definesScript(dir, script)) {
        owners.add(dir);
        break;
      }
      if (dir === rootResolved) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...owners];
}

function tail(text, lines) {
  const all = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return all.slice(-lines).join('\n');
}

function deny(failures, code) {
  const parts = [
    'Not finished: the mechanical checks are red on code this run changed.',
    '',
    'You changed application code, so these run before you hand off — deliberately here rather',
    'than in `qa-engineer`. A type error found by QA costs two fresh-context agent runs to fix',
    '(QA reads every doc and all the code, routes it back, you start over from nothing). Found',
    'here, it costs one edit while you still have the files in context. Fix them now.',
    '',
  ];
  for (const f of failures) {
    parts.push(`### ${f.label}`, '```', f.output, '```', '');
  }
  parts.push(
    `Changed code files: ${code.slice(0, 15).join(', ')}${code.length > 15 ? `, +${code.length - 15} more` : ''}`,
    '',
    '**If a failure is not yours to fix** — a schema drift that belongs to `system-analyst`, a',
    'contract gap you must not improvise around (`policies/architecture.md` §7) — do not',
    'invent a fix to make this pass. Say so explicitly in your handoff and finish; this guard',
    'allows the next attempt through so it can never trap you.',
  );
  return parts.join('\n');
}
