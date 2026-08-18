#!/usr/bin/env node
/*
 * Self-test for this project's harness — the guards in `.claude/hooks/` and the checkers in
 * `.claude/scripts/`.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE FOLDER
 *
 * Those files are the only rules in this pipeline that don't depend on an agent remembering
 * them (`.claude/shared/conventions.md` §5, §5a, §5b, §5c). That makes them load-bearing — and
 * until this harness existed, nothing checked that they still worked.
 *
 * That gap was not theoretical. `block-doc-rewrite.js` shipped its first draft with a `*​/`
 * sequence inside a comment (it was quoting a glob path), which closed the block comment early
 * and made the whole file a SyntaxError. Node exits 1 on a SyntaxError, and a PreToolUse hook
 * only blocks on exit code 2 — so a hook with a typo **fails open**: still wired in
 * `settings.json`, still looking installed, enforcing absolutely nothing, silently. Case group
 * 0 below exists specifically to catch that class of failure, and it is why this file is worth
 * more than any individual guard it tests.
 *
 * Run: `node .claude/tests/run.js`
 * Exit 0 = every case passed · 1 = at least one failed.
 *
 * No dependencies, no install step. This project's test framework is opt-in and usually absent
 * (`setup` defaults to none), so the harness that guards the harness cannot require one.
 *
 * FIXTURE STRATEGY
 *
 * Every guard resolves the project root from `CLAUDE_PROJECT_DIR`, so most cases run against a
 * throwaway temp directory and never touch the real repo. The exception is
 * `require-green-before-stop.js`, which asks read-only git what changed: it needs a real git
 * repo, so its code-change cases create a short-lived fixture folder inside this repo and
 * remove it in a `finally`. Nothing here runs a state-changing git command.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS = path.join(ROOT, '.claude', 'hooks');
const SCRIPTS = path.join(ROOT, '.claude', 'scripts');

let passed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// harness plumbing
// ---------------------------------------------------------------------------

function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name} — expected exit ${expected}, got ${actual}`);
    console.log(`  FAIL  ${name}  (expected exit ${expected}, got ${actual})`);
  }
}

/** Feeds a hook its PreToolUse/Stop JSON on stdin and returns the exit code. */
function runHook(hookFile, input, env) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, hookFile)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    cwd: (env && env.CLAUDE_PROJECT_DIR) || ROOT,
    timeout: 200000,
  });
  return res.status;
}

/** Runs one of the checker scripts and returns its exit code. */
function runScript(scriptFile, env) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, scriptFile)], {
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    cwd: (env && env.CLAUDE_PROJECT_DIR) || ROOT,
    timeout: 60000,
  });
  return res.status;
}

/** Makes a throwaway project root, runs fn(dir), always removes it afterwards. */
function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentclaude-selftest-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 0. every guard still parses  ←  the fail-open case described in the header
// ---------------------------------------------------------------------------

section('0. syntax — a guard that does not parse fails OPEN, so this runs first');

for (const dir of [HOOKS, SCRIPTS, path.join(ROOT, '.claude', 'tests')]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const full = path.join(dir, file);
    const res = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    check(`parses: ${path.relative(ROOT, full).replace(/\\/g, '/')}`, res.status, 0);
  }
}

// ---------------------------------------------------------------------------
// 1. block-git.js — conventions.md §5
// ---------------------------------------------------------------------------

section('1. block-git.js — no agent runs git (§5)');

const BLOCK = 2;
const ALLOW = 0;

const gitCases = [
  // [description, tool input, expected]
  ['git commit is blocked', { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, BLOCK],
  ['git push is blocked', { tool_name: 'Bash', tool_input: { command: 'git push origin master' } }, BLOCK],
  ['git init is blocked', { tool_name: 'Bash', tool_input: { command: 'git init' } }, BLOCK],
  ['git checkout is blocked', { tool_name: 'Bash', tool_input: { command: 'git checkout -- .' } }, BLOCK],
  ['git reset --hard is blocked', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' } }, BLOCK],
  ['bare git stash is blocked (it means stash push)', { tool_name: 'Bash', tool_input: { command: 'git stash' } }, BLOCK],
  ['git config --set is blocked', { tool_name: 'Bash', tool_input: { command: 'git config user.name x' } }, BLOCK],
  ['chained git commit is blocked', { tool_name: 'Bash', tool_input: { command: 'npm test && git commit -m x' } }, BLOCK],
  ['sudo-wrapped git commit is blocked', { tool_name: 'Bash', tool_input: { command: 'sudo git commit -m x' } }, BLOCK],
  ['env-prefixed git commit is blocked', { tool_name: 'Bash', tool_input: { command: 'FOO=bar git commit -m x' } }, BLOCK],
  ['touching .git/ directly is blocked', { tool_name: 'Bash', tool_input: { command: 'rm -rf .git/hooks' } }, BLOCK],
  ['writing inside .git/ is blocked', { tool_name: 'Write', tool_input: { file_path: '.git/config' } }, BLOCK],

  ['git status is allowed (read-only)', { tool_name: 'Bash', tool_input: { command: 'git status' } }, ALLOW],
  ['git log is allowed (read-only)', { tool_name: 'Bash', tool_input: { command: 'git log --oneline -5' } }, ALLOW],
  ['git diff is allowed (read-only)', { tool_name: 'Bash', tool_input: { command: 'git diff HEAD' } }, ALLOW],
  ['git stash list is allowed (read-only)', { tool_name: 'Bash', tool_input: { command: 'git stash list' } }, ALLOW],
  ['git config --get is allowed (read-only)', { tool_name: 'Bash', tool_input: { command: 'git config --get user.name' } }, ALLOW],
  ['writing .gitignore is allowed (§5: a file, not a git command)', { tool_name: 'Write', tool_input: { file_path: '.gitignore' } }, ALLOW],
  ['writing a CI workflow is allowed', { tool_name: 'Write', tool_input: { file_path: '.github/workflows/ci.yml' } }, ALLOW],
  ['unrelated command is allowed', { tool_name: 'Bash', tool_input: { command: 'npm install' } }, ALLOW],
  ['a repo.git clone URL is not mistaken for .git/', { tool_name: 'Bash', tool_input: { command: 'echo https://example.com/repo.git' } }, ALLOW],
];

for (const [name, input, expected] of gitCases) {
  check(name, runHook('block-git.js', input), expected);
}

// ---------------------------------------------------------------------------
// 2. block-outside-repo.js — conventions.md §5a
// ---------------------------------------------------------------------------

section('2. block-outside-repo.js — every write stays inside the repo (§5a)');

withTempProject((tmp) => {
  const env = { CLAUDE_PROJECT_DIR: tmp };
  const outside = process.platform === 'win32' ? 'C:/Windows/Temp/evil.txt' : '/etc/evil.txt';
  const scratch = path.join(os.tmpdir(), 'claude', 'proj', 'sess', 'scratchpad', 'note.md');
  const memory = path.join(os.homedir(), '.claude', 'projects', 'C--src-AgentClaude', 'memory', 'x.md');
  const notMemory = path.join(os.homedir(), '.claude', 'projects', 'C--src-AgentClaude', 'transcript.jsonl');

  const cases = [
    ['absolute path outside the repo is blocked', { tool_name: 'Write', tool_input: { file_path: outside } }, BLOCK],
    ['../ escape is blocked', { tool_name: 'Write', tool_input: { file_path: '../escaped.md' } }, BLOCK],
    ['Edit outside the repo is blocked', { tool_name: 'Edit', tool_input: { file_path: outside } }, BLOCK],
    ['non-memory file under ~/.claude/projects is blocked', { tool_name: 'Write', tool_input: { file_path: notMemory } }, BLOCK],

    ['relative path inside the repo is allowed', { tool_name: 'Write', tool_input: { file_path: '_docs/module/m/plan.md' } }, ALLOW],
    ['absolute path inside the repo is allowed', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'app/page.tsx') } }, ALLOW],
    ['the temp scratchpad is allowed (harness convention)', { tool_name: 'Write', tool_input: { file_path: scratch } }, ALLOW],
    ['the auto-memory store is allowed (harness convention)', { tool_name: 'Write', tool_input: { file_path: memory } }, ALLOW],
    ['Bash is out of scope for this guard', { tool_name: 'Bash', tool_input: { command: `echo hi > ${outside}` } }, ALLOW],
  ];

  for (const [name, input, expected] of cases) {
    check(name, runHook('block-outside-repo.js', input, env), expected);
  }
});

// ---------------------------------------------------------------------------
// 3. block-doc-rewrite.js — conventions.md §5b
// ---------------------------------------------------------------------------

section('3. block-doc-rewrite.js — amend existing docs with Edit, never Write (§5b)');

withTempProject((tmp) => {
  const env = { CLAUDE_PROJECT_DIR: tmp };
  const mod = path.join(tmp, '_docs', 'module', 'sales-crm');

  for (const f of ['requirement.md', 'design.md', 'plan.md', 'review.md', 'security.md', 'deploy.md']) {
    write(path.join(mod, f), `# ${f}\n\n## Change Log\n- 2026-08-18 created\n`);
  }
  write(path.join(mod, 'review', 'phase-1.md'), '# archived round\n');
  write(path.join(tmp, '_docs', 'status.md'), '# Project Status\n');

  const cases = [
    ['Write over an existing plan.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'plan.md') } }, BLOCK],
    ['Write over an existing design.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'design.md') } }, BLOCK],
    ['Write over an existing review.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'review.md') } }, BLOCK],
    ['Write over an existing security.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'security.md') } }, BLOCK],
    ['relative path to an existing doc is blocked too', { tool_name: 'Write', tool_input: { file_path: '_docs/module/sales-crm/requirement.md' } }, BLOCK],

    ['Write to a doc that does not exist yet is allowed (first creation)', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs/module/new-mod/requirement.md') } }, ALLOW],
    ['Edit on an existing doc is allowed — that is the point', { tool_name: 'Edit', tool_input: { file_path: path.join(mod, 'plan.md') } }, ALLOW],
    ['MultiEdit on an existing doc is allowed', { tool_name: 'MultiEdit', tool_input: { file_path: path.join(mod, 'plan.md') } }, ALLOW],
    ['Write to an archived round is allowed (not one of the six)', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'review', 'phase-1.md') } }, ALLOW],
    ['Write to status.md is allowed (not a per-module doc)', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'status.md') } }, ALLOW],
    ['Write to app code named plan.md elsewhere is allowed', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'app', 'plan.md') } }, ALLOW],
  ];

  for (const [name, input, expected] of cases) {
    check(name, runHook('block-doc-rewrite.js', input, env), expected);
  }
});

// ---------------------------------------------------------------------------
// 4. check-schema-contract.js — conventions.md §7
// ---------------------------------------------------------------------------

section('4. check-schema-contract.js — design.md Data Model is the contract (§7)');

const DEAL_SCHEMA = `model Deal {
  id      String @id @default(cuid())
  title   String
  amount  Int
}
`;

function designDoc(body) {
  return `# Module\n\n## Feasibility Summary\nok\n\n## Data Model\n${body}\n## Risks & Dependencies\nnone\n`;
}

withTempProject((tmp) => {
  check('no schema.prisma yet → passes (nothing to compare)', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA));
  check('schema matches design → passes', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA.replace('amount  Int', 'amount  Float')));
  check('field type drift → fails', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA.replace('  title   String\n', '')));
  check('field present in schema but absent from design is not itself drift', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA + '\nmodel Ghost {\n  id String @id\n}\n');
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA));
  check('model no module declares → fails (improvised schema change)', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA));
  write(path.join(tmp, '_docs', 'module', 'other', 'design.md'), designDoc('model Other {\n  id String @id\n}\n'));
  check('a module declaring a model schema.prisma lacks → fails', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

// The real cross-module case §7 exists for: two modules, each owning its own models, both
// present in the one shared schema.prisma. Naively requiring the two files to be identical
// would produce a guaranteed false failure here — that must not happen.
withTempProject((tmp) => {
  const other = 'model Other {\n  id String @id\n}\n';
  write(path.join(tmp, 'prisma', 'schema.prisma'), `${DEAL_SCHEMA}\n${other}`);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), designDoc(DEAL_SCHEMA));
  write(path.join(tmp, '_docs', 'module', 'other', 'design.md'), designDoc(other));
  check('two modules each owning their own models → no false drift', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'a', 'design.md'), designDoc(DEAL_SCHEMA));
  write(path.join(tmp, '_docs', 'module', 'b', 'design.md'), designDoc(DEAL_SCHEMA));
  check('a model claimed by two modules is not flagged as unclaimed', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'prisma', 'schema.prisma'), DEAL_SCHEMA);
  write(path.join(tmp, '_docs', 'module', 'm', 'design.md'), '# Module\n\n## Feasibility Summary\nno data model section\n');
  check('design.md with no Data Model → its models count as unclaimed, so → fails', runScript('check-schema-contract.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

// ---------------------------------------------------------------------------
// 5. check-status-sync.js — conventions.md §2
// ---------------------------------------------------------------------------

section('5. check-status-sync.js — status.md is an index, and must agree with plan.md (§2)');

function planDoc(phase1Checked, phase2) {
  return `# Plan\n\n## Plan Summary\nx\n\n## Phase 1: A\n${phase1Checked.map((c) => `- [${c}] task`).join('\n')}\n\n## Phase 2: B\n${phase2.map((c) => `- [${c}] task`).join('\n')}\n`;
}

function statusDoc(p1, p2, nowUnchecked, nowTotal) {
  return `# Project Status\n\n## Scaffold\nScaffolded\n\n## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| m | Phase 2 | backend-engineer |\n\n## m\n\nDocs: requirement ✅ · design ✅ · plan ✅\n- Phase 1 — implemented ${p1} · verified ✅ (FULL) · security ✅ · deployed ✅\n- Phase 2 — implemented ${p2} · verified ⬜ · security ⬜ · deployed ⬜\n\n**Now**: Phase 2 \`[backend]\` tasks — ${nowUnchecked} of ${nowTotal} unchecked in \`plan.md\`\n**Blocked on**: —\n`;
}

withTempProject((tmp) => {
  check('no status.md yet → passes', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['x', 'x'], ['x', ' ', ' ']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 2, 3));
  check('status.md agrees with plan.md → passes', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['x', 'x'], ['x', ' ', ' ']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '✅', 2, 3));
  check('claims implemented ✅ with tasks still unchecked → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['x', 'x'], ['x', 'x', 'x']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 0, 3));
  check('claims implemented ⬜ with every task checked → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['x', 'x'], ['x', ' ', ' ']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 7, 9));
  check('**Now** line with wrong counts → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['x', 'x'], ['x', ' ', ' ']));
  write(path.join(tmp, '_docs', 'status.md'), '# Project Status\n\n## Scaffold\nScaffolded\n');
  check('module missing from status.md entirely → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

// ---------------------------------------------------------------------------
// 6. require-green-before-stop.js — conventions.md §5c
// ---------------------------------------------------------------------------

section('6. require-green-before-stop.js — no handing off red code (§5c)');

// Loop safety and the doc-only filter need no git repo at all.
check(
  'stop_hook_active → always allowed (loop safety, the critical rail)',
  runHook('require-green-before-stop.js', { stop_hook_active: true }),
  ALLOW,
);

withTempProject((tmp) => {
  check(
    'not a git repo → allowed (guard fails open, never traps)',
    runHook('require-green-before-stop.js', { stop_hook_active: false }, { CLAUDE_PROJECT_DIR: tmp }),
    ALLOW,
  );
});

// The code-change cases need real `git diff`/`git ls-files` output, so they use a short-lived
// fixture inside this repo. Read-only git only; removed in the finally below.
const FIXTURE = path.join(ROOT, '_selftest_fixture');

function withRepoFixture(typecheckExit, fn) {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  try {
    write(path.join(FIXTURE, 'package.json'), JSON.stringify({
      name: 'selftest-fixture',
      scripts: { typecheck: `node -e "process.exit(${typecheckExit})"` },
    }, null, 2));
    write(path.join(FIXTURE, 'deal.ts'), 'export const x: number = 1;\n');
    return fn();
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
  }
}

withRepoFixture(1, () => {
  check(
    'app code changed + typecheck red → blocked',
    runHook('require-green-before-stop.js', { stop_hook_active: false }),
    BLOCK,
  );
});

withRepoFixture(0, () => {
  check(
    'app code changed + typecheck green → allowed',
    runHook('require-green-before-stop.js', { stop_hook_active: false }),
    ALLOW,
  );
});

withRepoFixture(1, () => {
  check(
    'red but already retried once → allowed (cannot trap an agent)',
    runHook('require-green-before-stop.js', { stop_hook_active: true }),
    ALLOW,
  );
});

check(
  'doc-only run (this repo currently has no changed app code) → allowed',
  runHook('require-green-before-stop.js', { stop_hook_active: false }),
  ALLOW,
);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(70)}`);
if (failures.length === 0) {
  console.log(`All ${passed} case(s) passed — the harness enforces what it claims to.`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} FAILED:\n`);
for (const f of failures) console.log(`  - ${f}`);
console.log('\nA failing guard is worse than no guard: it looks installed and enforces nothing.');
process.exit(1);
