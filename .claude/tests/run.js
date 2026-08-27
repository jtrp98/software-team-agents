#!/usr/bin/env node
/*
 * Self-test for this project's harness — the guards in `.claude/hooks/` and the checkers in
 * `.claude/scripts/`.
 *
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE FOLDER
 *
 * Those files are the only rules in this pipeline that don't depend on an agent remembering
 * them (`policies/git.md` §5, `policies/security.md` §5a, `policies/documentation.md` §5b,
 * `policies/coding.md` §5c). That makes them load-bearing — and
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
const CODEX_HOOKS = path.join(ROOT, '.codex', 'hooks');
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

function runStaticGateJson(projectRoot, env) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'static-analysis-gate.js'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot, ...(env || {}) },
    cwd: projectRoot,
    timeout: 60000,
  });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* asserted by callers */ }
  return { status: res.status, stdout: res.stdout, report };
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

function writeProfileFixture(root, name, commands, sourceRoots, extensions) {
  const commandLines = Object.entries(commands).map(([key, value]) => `    ${key}: ${value}`).join('\n');
  const sourceLines = sourceRoots.map((sourceRoot) => `    - ${sourceRoot}`).join('\n');
  write(path.join(root, '.agent-team', 'config.yaml'), `schema_version: 1\ntarget_id: fixture\nregistered_at: 2026-08-27T00:00:00Z\nrole: dev\nstack:\n  profile: ${name}\n  package_manager: fixture\n  commands:\n${commandLines}\n  schema_paths: []\n  source_roots:\n${sourceLines}\n  detected_at: 2026-08-27T00:00:00Z\n  fingerprint: sha256:fixture\noverrides: []\n`);
  write(path.join(root, 'stacks', name, 'stack.yaml'), `stack: ${name}\nscan_extensions: [${extensions.join(', ')}]\n`);
}

function commandStubEnvironment(root, names) {
  const bin = path.join(root, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) {
    if (process.platform === 'win32') {
      write(path.join(bin, `${name}.cmd`), '@exit /b 0\r\n');
    } else {
      const executable = path.join(bin, name);
      write(executable, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(executable, 0o755);
    }
  }
  return { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
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
// 0b. every guard still LOADS inside an ESM target project
//
// `node --check` above passes in THIS repo because its root package.json has no
// "type" field, so .js resolves to CommonJS. A target project that declares
// "type": "module" flips that resolution: every `require(...)` throws
// ReferenceError and the hook exits 1 — and PreToolUse only blocks on exit 2,
// so all six guards stayed wired up and enforced nothing. That shipped, and it
// is invisible to a syntax check by construction. The fix is the
// package.json marker pinning each directory to CommonJS; this asserts the
// marker exists AND that the guards actually run under the hostile condition.
// ---------------------------------------------------------------------------

section('0b. ESM host — a guard that cannot load fails OPEN, and --check cannot see it');

for (const dir of [HOOKS, SCRIPTS]) {
  if (!fs.existsSync(dir)) continue;
  const rel = path.relative(ROOT, dir).replace(/\\/g, '/');
  const markerPath = path.join(dir, 'package.json');
  let declaredType = null;
  if (fs.existsSync(markerPath)) {
    try {
      declaredType = JSON.parse(fs.readFileSync(markerPath, 'utf8')).type;
    } catch {
      declaredType = '<unparseable>';
    }
  }
  check(`${rel}/package.json pins CommonJS`, declaredType, 'commonjs');
}

// The .codex/hooks mirrors are the same CommonJS files in a different directory —
// they need their own marker or an ESM host breaks only the Codex runtime's
// guards, which no other check here would notice.
check('.codex/hooks/package.json pins CommonJS', (() => {
  const markerPath = path.join(CODEX_HOOKS, 'package.json');
  if (!fs.existsSync(markerPath)) return '<missing>';
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8')).type;
  } catch {
    return '<unparseable>';
  }
})(), 'commonjs');

withTempProject((dir) => {
  // A target project shaped like the real failure: ESM root, guards copied in —
  // both runtimes' copies.
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-host', type: 'module' }, null, 2));
  for (const [srcDir, destName] of [[HOOKS, '.claude/hooks'], [SCRIPTS, '.claude/scripts'], [CODEX_HOOKS, '.codex/hooks']]) {
    if (!fs.existsSync(srcDir)) continue;
    fs.cpSync(srcDir, path.join(dir, destName), { recursive: true });
  }

  // Loading is what is under test, so run each guard with input it will not act
  // on: a crash exits 1, a guard that loaded and declined to block exits 0.
  for (const hooksDir of [path.join(dir, '.claude', 'hooks'), path.join(dir, '.codex', 'hooks')]) {
    const rel = path.relative(dir, hooksDir).replace(/\\/g, '/');
    for (const file of fs.readdirSync(hooksDir).filter((f) => f.endsWith('.js'))) {
      const res = spawnSync(process.execPath, [path.join(hooksDir, file)], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: {} }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        cwd: dir,
        timeout: 200000,
      });
      check(`loads under "type":"module": ${rel}/${file}`, res.status, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// 1. block-git.js — `policies/git.md` §5
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
  ['a pipe inside quotes is not mistaken for two commands', { tool_name: 'Bash', tool_input: { command: `grep "foo|bar" file.txt` } }, ALLOW],

  // PowerShell carries the same commands as Bash — every rule above must hold
  // for it too, or switching shells is a bypass.
  ['PowerShell git commit is blocked', { tool_name: 'PowerShell', tool_input: { command: 'git commit -m "x"' } }, BLOCK],
  ['PowerShell reading .git/ directly is blocked', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content .git/HEAD' } }, BLOCK],
  ['PowerShell git push is blocked', { tool_name: 'PowerShell', tool_input: { command: 'git push origin main' } }, BLOCK],
  ['PowerShell git status is allowed (read-only)', { tool_name: 'PowerShell', tool_input: { command: 'git status' } }, ALLOW],

  // Wrappers and indirection that once slipped through.
  ['bash -c wrapped git commit is blocked', { tool_name: 'Bash', tool_input: { command: 'bash -c "git commit -m x"' } }, BLOCK],
  ['sh -c wrapped git push is blocked', { tool_name: 'Bash', tool_input: { command: `sh -c 'git push origin main'` } }, BLOCK],
  ['powershell -Command wrapped git reset is blocked', { tool_name: 'Bash', tool_input: { command: 'powershell -Command "git reset --hard HEAD"' } }, BLOCK],
  ['a variable holding the git name is resolved ($g=git; $g commit)', { tool_name: 'Bash', tool_input: { command: 'g=git; $g commit -m x' } }, BLOCK],
];

for (const [name, input, expected] of gitCases) {
  check(name, runHook('block-git.js', input), expected);
}

// ---------------------------------------------------------------------------
// 2. block-outside-repo.js — `policies/security.md` §5a
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
    ['a canonical runtime-granted Target work root is allowed', { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'target-work', 'src', 'x.ts') } }, ALLOW, { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify([path.join(os.tmpdir(), 'target-work')]) }],
    ['a sibling of a runtime-granted Target root remains blocked', { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'target-other', 'x.ts') } }, BLOCK, { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify([path.join(os.tmpdir(), 'target-work')]) }],
    ['Bash is out of scope for this guard', { tool_name: 'Bash', tool_input: { command: `echo hi > ${outside}` } }, ALLOW],
    ['an array of paths is checked element by element (one outside → blocked)', { tool_name: 'Write', tool_input: { file_path: ['_docs/module/m/plan.md', outside] } }, BLOCK],
    ['an array of paths all inside the repo is allowed', { tool_name: 'Write', tool_input: { file_path: ['_docs/module/m/plan.md', 'app/x.ts'] } }, ALLOW],
    ['a non-string, non-array path cannot resolve — fail open, no crash', { tool_name: 'Write', tool_input: { file_path: { nested: outside } } }, ALLOW],
  ];

  for (const [name, input, expected, extraEnv] of cases) {
    check(name, runHook('block-outside-repo.js', input, { ...env, ...extraEnv }), expected);
  }
});

// ---------------------------------------------------------------------------
// 3. block-doc-rewrite.js — `policies/documentation.md` §5b
// ---------------------------------------------------------------------------

section('3. block-doc-rewrite.js — amend existing docs with Edit, never Write (§5b)');

withTempProject((tmp) => {
  const env = { CLAUDE_PROJECT_DIR: tmp };
  const mod = path.join(tmp, '_docs', 'module', 'sales-crm');

  for (const f of ['requirement.md', 'design.md', 'plan.md', 'test-plan.md', 'review.md', 'security.md', 'deploy.md']) {
    write(path.join(mod, f), `# ${f}\n\n## Change Log\n- 2026-08-18 created\n`);
  }
  write(path.join(mod, 'review', 'phase-1.md'), '# archived round\n');
  write(path.join(tmp, '_docs', 'status.md'), '# Project Status\n');

  const cases = [
    ['Write over an existing plan.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'plan.md') } }, BLOCK],
    ['Write over an existing test-plan.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'test-plan.md') } }, BLOCK],
    ['Write over an existing design.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'design.md') } }, BLOCK],
    ['Write over an existing review.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'review.md') } }, BLOCK],
    ['Write over an existing security.md is blocked', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'security.md') } }, BLOCK],
    ['relative path to an existing doc is blocked too', { tool_name: 'Write', tool_input: { file_path: '_docs/module/sales-crm/requirement.md' } }, BLOCK],

    ['Write to a doc that does not exist yet is allowed (first creation)', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs/module/new-mod/requirement.md') } }, ALLOW],
    ['Edit on an existing doc is allowed — that is the point', { tool_name: 'Edit', tool_input: { file_path: path.join(mod, 'plan.md') } }, ALLOW],
    ['MultiEdit on an existing doc is allowed', { tool_name: 'MultiEdit', tool_input: { file_path: path.join(mod, 'plan.md') } }, ALLOW],
    ['Write to an archived round is allowed (not one of the seven)', { tool_name: 'Write', tool_input: { file_path: path.join(mod, 'review', 'phase-1.md') } }, ALLOW],
    ['Write to status.md is allowed (not a per-module doc)', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'status.md') } }, ALLOW],
    ['Write to app code named plan.md elsewhere is allowed', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'app', 'plan.md') } }, ALLOW],
  ];

  for (const [name, input, expected] of cases) {
    check(name, runHook('block-doc-rewrite.js', input, env), expected);
  }
});

// ---------------------------------------------------------------------------
// 4. check-schema-contract.js — `policies/architecture.md` §7
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
// 5. check-status-sync.js — `policies/documentation.md` §2
// ---------------------------------------------------------------------------

section('5. check-status-sync.js — status.md is an index, and must agree with plan.md (§2)');

function taskRows(statuses) {
  return statuses.map((s) => `| task | ${s} | backend-engineer | — |`).join('\n');
}

function planDoc(phase1Statuses, phase2Statuses) {
  const header = '| Task | Status | Owner | Depends on |\n|---|---|---|---|';
  return `# Plan\n\n## Plan Summary\nx\n\n## Phase 1: A\n${header}\n${taskRows(phase1Statuses)}\n\n## Phase 2: B\n${header}\n${taskRows(phase2Statuses)}\n`;
}

function statusDoc(p1, p2, nowUnchecked, nowTotal) {
  return `# Project Status\n\n## Scaffold\nScaffolded\n\n## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| m | Phase 2 | backend-engineer |\n\n## m\n\nDocs: requirement ✅ · design ✅ · plan ✅\n- Phase 1 — implemented ${p1} · verified ✅ (FULL) · security ✅ · deployed ✅\n- Phase 2 — implemented ${p2} · verified ⬜ · security ⬜ · deployed ⬜\n\n**Now**: Phase 2 \`[backend]\` tasks — ${nowUnchecked} of ${nowTotal} unchecked in \`plan.md\`\n**Blocked on**: —\n`;
}

withTempProject((tmp) => {
  check('no status.md yet → passes', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['verified', 'verified'], ['verified', 'pending', 'pending']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 2, 3));
  check('status.md agrees with plan.md → passes', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['verified', 'verified'], ['verified', 'pending', 'pending']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '✅', 2, 3));
  check('claims implemented ✅ with tasks still unchecked → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['verified', 'verified'], ['verified', 'verified', 'verified']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 0, 3));
  check('claims implemented ⬜ with every task checked → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['verified', 'verified'], ['verified', 'pending', 'pending']));
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 7, 9));
  check('**Now** line with wrong counts → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), planDoc(['verified', 'verified'], ['verified', 'pending', 'pending']));
  write(path.join(tmp, '_docs', 'status.md'), '# Project Status\n\n## Scaffold\nScaffolded\n');
  check('module missing from status.md entirely → fails', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  // The regression this case pins: a heading at the wrong level (`###` instead of
  // `##`) once made the whole plan unparseable, and the script answered "no drift"
  // — exit 0 — while status.md went on claiming things no readable plan backed.
  // An unreadable plan is a failure to report, not a clean bill of health.
  const badPlan = planDoc(['verified'], []).replace(/## Phase 1/g, '### Phase 1');
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), badPlan);
  write(path.join(tmp, '_docs', 'status.md'), statusDoc('✅', '⬜', 0, 1));
  check('a plan.md with no parseable `## Phase N` section → fails (unreadable is not clean)', runScript('check-status-sync.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

// ---------------------------------------------------------------------------
// 6. static-analysis-gate.js — the full sweep before qa-engineer trusts a round (T22)
// ---------------------------------------------------------------------------

section('6. static-analysis-gate.js — lint/format/typecheck/build/test before QA (T22)');

/** A package.json whose scripts each exit with the given codes; missing keys mean "no such script". */
function writeGatePackage(dir, name, exits) {
  const scripts = {};
  for (const [script, code] of Object.entries(exits)) {
    scripts[script] = `node -e "process.exit(${code})"`;
  }
  write(path.join(dir, 'package.json'), JSON.stringify({ name, scripts }, null, 2));
}

withTempProject((tmp) => {
  check('no package.json anywhere → passes (nothing to check, nothing failed)', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'ok-pkg', { lint: 0, typecheck: 0, build: 0, test: 0 });
  check('every defined script exits 0 → passes', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'red-pkg', { lint: 0, typecheck: 1, build: 0 });
  check('one script exits non-zero → fails', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'partial-pkg', { lint: 0 });
  check('a package missing format/typecheck/build/test entirely → still passes (skipped, not failed)', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'root-pkg', { lint: 0 });
  writeGatePackage(path.join(tmp, 'packages', 'api'), 'nested-red', { typecheck: 1 });
  check('a red script in a nested package is not missed by scanning only the root', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'json-pkg', { lint: 0 });
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'static-analysis-gate.js'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    cwd: tmp,
    timeout: 60000,
  });
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  check(
    '--json reports security_scan and dependency_scan as real results, not omitting either',
    parsed &&
      parsed.ok === true &&
      parsed.results.some((r) => r.check === 'dependency_scan' && r.status === 'passed') &&
      parsed.results.some((r) => r.check === 'security_scan' && r.status === 'passed')
      ? 0
      : 1,
    0,
  );
});

withTempProject((tmp) => {
  writeGatePackage(tmp, 'legacy-node', { lint: 0 });
  const result = runStaticGateJson(tmp);
  const golden = {
    ok: true,
    results: [
      { dir: '.', check: 'lint', status: 'passed' },
      { dir: '.', check: 'format', status: 'skipped', reason: 'no such script' },
      { dir: '.', check: 'typecheck', status: 'skipped', reason: 'no such script' },
      { dir: '.', check: 'build', status: 'skipped', reason: 'no such script' },
      { dir: '.', check: 'test', status: 'skipped', reason: 'no such script' },
      { dir: '(repo)', check: 'security_scan', status: 'passed' },
      { dir: '(repo)', check: 'dependency_scan', status: 'passed' },
    ],
  };
  check('no-profile Node --json output stays byte-identical to the legacy golden', result.stdout === `${JSON.stringify(golden, null, 2)}\n` ? 0 : 1, 0);
});

for (const fixture of [
  {
    name: 'dotnet',
    tools: ['dotnet'],
    commands: { lint: 'dotnet format --verify-no-changes', typecheck: 'dotnet build', build: 'dotnet build', test: 'dotnet test' },
    extension: '.cs',
    sourceFile: 'src/Program.cs',
  },
  {
    name: 'python',
    tools: ['ruff', 'mypy', 'uv', 'pytest'],
    commands: { lint: 'ruff check', typecheck: 'mypy .', build: 'uv build', test: 'pytest' },
    extension: '.py',
    sourceFile: 'src/main.py',
  },
  {
    name: 'node',
    tools: ['npm'],
    commands: { lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build', test: 'npm run test' },
    extension: '.ts',
    sourceFile: 'src/index.ts',
  },
]) {
  withTempProject((tmp) => {
    writeProfileFixture(tmp, fixture.name, fixture.commands, ['src'], [fixture.extension]);
    write(path.join(tmp, fixture.sourceFile), '// safe fixture\n');
    if (fixture.name === 'node') write(path.join(tmp, 'package.json'), '{"name":"node-fixture"}\n');
    const result = runStaticGateJson(tmp, commandStubEnvironment(tmp, fixture.tools));
    const expectedRows = [
      { dir: '(repo)', check: 'lint', command: fixture.commands.lint, status: 'passed' },
      { dir: '(repo)', check: 'format', status: 'skipped', reason: 'no such profile command' },
      { dir: '(repo)', check: 'typecheck', command: fixture.commands.typecheck, status: 'passed' },
      { dir: '(repo)', check: 'build', command: fixture.commands.build, status: 'passed' },
      { dir: '(repo)', check: 'test', command: fixture.commands.test, status: 'passed' },
      { dir: '(repo)', check: 'security_scan', status: 'passed' },
      fixture.name === 'node'
        ? { dir: '(repo)', check: 'dependency_scan', status: 'passed' }
        : { dir: '(repo)', check: 'dependency_scan', status: 'skipped', reason: `no dependency manifest this scan understands for profile ${fixture.name}` },
    ];
    const golden = { ok: true, verification: 'passed', profile: fixture.name, results: expectedRows };
    check(`${fixture.name} profile gate uses resolved commands and matches its JSON golden`, result.status === 0 && JSON.stringify(result.report) === JSON.stringify(golden) ? 0 : 1, 0);
  });
}

withTempProject((tmp) => {
  const commands = { lint: 'dotnet format --verify-no-changes', typecheck: 'dotnet build', build: 'dotnet build', test: 'dotnet test' };
  writeProfileFixture(tmp, 'dotnet', commands, ['src'], ['.cs']);
  write(path.join(tmp, 'outside', 'Evil.cs'), 'class Evil { void Run(string input) { eval(input); } }\n');
  write(path.join(tmp, 'src', 'Ignored.ts'), 'eval(input);\n');
  const env = commandStubEnvironment(tmp, ['dotnet']);
  check('profile security_scan excludes files outside source_roots and extensions', runStaticGateJson(tmp, env).status, 0);
  write(path.join(tmp, 'src', 'Evil.cs'), 'class Evil { void Run(string input) { eval(input); } }\n');
  check('profile security_scan reads declared source_roots and extensions', runStaticGateJson(tmp, env).status, 1);
});

withTempProject((tmp) => {
  writeProfileFixture(tmp, 'unsupported', {}, [], []);
  const result = runStaticGateJson(tmp);
  check('all profile checks skipped exits 2 and reports unverified, never passed', result.status === 2 && result.report && result.report.ok === false && result.report.verification === 'unverified' ? 0 : 1, 0);
  check('a profile without scan extensions reports security_scan skipped', result.report && result.report.results.some((row) => row.check === 'security_scan' && row.status === 'skipped' && /no security scan extensions/.test(row.reason)) ? 0 : 1, 0);
  check('an unsupported dependency profile reports dependency_scan skipped with a reason', result.report && result.report.results.some((row) => row.check === 'dependency_scan' && row.status === 'skipped' && /no dependency manifest/.test(row.reason)) ? 0 : 1, 0);
});

// ---------------------------------------------------------------------------
// 6a. static-analysis-gate.js's security_scan — the "Code" checkpoint of T23 (Security as Continuous)
// ---------------------------------------------------------------------------

section("6a. static-analysis-gate.js's security_scan — curated dangerous-pattern sweep (T23)");

withTempProject((tmp) => {
  check('no app code at all → security_scan passes (nothing to scan)', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'app', 'api', 'run.ts'), "export function run(input: string) {\n  return eval(input);\n}\n");
  check('eval() in app/ → security_scan fails the gate', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'components', 'Rich.tsx'), 'export const Rich = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n');
  check('dangerouslySetInnerHTML → security_scan fails the gate', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'server', 'auth.ts'), "const secret = process.env.JWT_SECRET || 'dev-secret';\n");
  check('hardcoded JWT-secret fallback → security_scan fails the gate', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'server', 'db.ts'), "await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);\n");
  check('$queryRawUnsafe with interpolation → security_scan fails the gate', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'src', 'safe.ts'), "export const greeting = 'hello ' + name;\nconsole.log(greeting);\n");
  check('ordinary code with no dangerous pattern → security_scan passes', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'docs', 'README.md'), 'Example: `eval(someString)` is dangerous, do not do it.\n');
  check('a dangerous pattern mentioned only in docs/ (outside the scanned dirs) is not flagged', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

// ---------------------------------------------------------------------------
// 6b. static-analysis-gate.js's dependency_scan — offline curated advisory match (T24)
// ---------------------------------------------------------------------------

section("6b. static-analysis-gate.js's dependency_scan — offline curated advisory match (T24)");

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'no-deps', dependencies: {} }, null, 2));
  check('no dependencies at all → dependency_scan passes', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'vuln-pkg', dependencies: { lodash: '4.17.20' } }, null, 2));
  check('a dependency pinned exactly at the vulnerable ceiling → dependency_scan fails', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'caret-pkg', dependencies: { lodash: '^4.17.15' } }, null, 2));
  check('a range spec (^4.17.15) resolving below the ceiling → dependency_scan fails', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'fixed-pkg', dependencies: { lodash: '4.17.21' } }, null, 2));
  check('a version strictly above the vulnerable ceiling → dependency_scan passes', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'devdep-pkg', devDependencies: { minimist: '1.2.0' } }, null, 2));
  check('a vulnerable devDependency is checked too, not just dependencies', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'unparseable-pkg', dependencies: { lodash: 'latest', minimist: 'workspace:*' } }, null, 2));
  check('an unparseable version spec ("latest", "workspace:*") is not our call to make — not flagged', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, 'package.json'), JSON.stringify({ name: 'root-pkg', dependencies: {} }, null, 2));
  write(path.join(tmp, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'nested-pkg', dependencies: { lodash: '4.17.19' } }, null, 2));
  check('a vulnerable dependency in a nested package is not missed by scanning only the root', runScript('static-analysis-gate.js', { CLAUDE_PROJECT_DIR: tmp }), 1);
});

// ---------------------------------------------------------------------------
// 7. require-green-before-stop.js — `policies/coding.md` §5c
// ---------------------------------------------------------------------------

section('7. require-green-before-stop.js — no handing off red code (§5c)');

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

/** A package.json whose `typecheck` exits with the code we want, plus a changed .ts file for it to own. */
function writeFixturePackage(dir, name, typecheckExit) {
  write(path.join(dir, 'package.json'), JSON.stringify({
    name,
    scripts: { typecheck: `node -e "process.exit(${typecheckExit})"` },
  }, null, 2));
  write(path.join(dir, 'deal.ts'), 'export const x: number = 1;\n');
}

function withRepoFixture(typecheckExit, fn) {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  try {
    writeFixturePackage(FIXTURE, 'selftest-fixture', typecheckExit);
    return fn();
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
  }
}

/**
 * Two packages nested two levels down, one green and one red, neither reachable by the
 * "scan root plus one level, take the first match" resolution the hook shipped with.
 *
 * This is the regression case for a fail-open that actually happened: once `orchestrator/`
 * (which defines `typecheck`) existed at the repo root, the hook graded every engineer's change
 * against the orchestrator's green typecheck and let red app code hand off. Nesting both
 * packages below the scan depth, and making the green one the only thing an ordering-based
 * resolver could find, means this case can only pass if the hook resolves upward from the
 * changed files — not by iterating directories, whose order is a filesystem detail.
 */
function withNestedRepoFixture(fn) {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  try {
    writeFixturePackage(path.join(FIXTURE, 'green-pkg'), 'selftest-green', 0);
    writeFixturePackage(path.join(FIXTURE, 'red-pkg'), 'selftest-red', 1);
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

withNestedRepoFixture(() => {
  check(
    'red package nested below scan depth → still blocked (checks the file’s owner, not the first package found)',
    runHook('require-green-before-stop.js', { stop_hook_active: false }),
    BLOCK,
  );
});

check(
  'doc-only run (this repo currently has no changed app code) → allowed',
  runHook('require-green-before-stop.js', { stop_hook_active: false }),
  ALLOW,
);

// ---------------------------------------------------------------------------
// 8. block-secret-leak.js — no handing off a hardcoded secret (T25)
// ---------------------------------------------------------------------------

section('8. block-secret-leak.js — no handing off a hardcoded secret (T25)');

check(
  'stop_hook_active → always allowed (loop safety, same rail as require-green-before-stop.js)',
  runHook('block-secret-leak.js', { stop_hook_active: true }),
  ALLOW,
);

withTempProject((tmp) => {
  check(
    'not a git repo → allowed (guard fails open, never traps)',
    runHook('block-secret-leak.js', { stop_hook_active: false }, { CLAUDE_PROJECT_DIR: tmp }),
    ALLOW,
  );
});

/** Writes one file into the shared repo fixture, cleans it up afterwards. */
function withFixtureFile(relPath, contents, fn) {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  try {
    write(path.join(FIXTURE, relPath), contents);
    return fn();
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
  }
}

// These fixture values are built from separate string parts, joined only at runtime, so the
// real-credential-shaped value never sits as one contiguous literal in this file's own source.
// GitHub's push-protection secret scanning flags exact matches of real credential shapes (AWS
// keys, Stripe keys) even inside a test fixture that never becomes a working secret anywhere --
// splitting the literal stops a byte-pattern scan of THIS file from matching, while the
// *fixture file* these tests write out still gets the fully-joined string, so
// `block-secret-leak.js` is exercised exactly as before.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const FAKE_STRIPE_KEY = ['sk', 'live', '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'].join('_');
const FAKE_PRIVATE_KEY_BLOCK = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') + '\nMIIEow...\n' + ['-----END', 'RSA PRIVATE KEY-----'].join(' ') + '\n';

withFixtureFile('leak.ts', `export const key = '${FAKE_AWS_KEY}';\n`, () => {
  check('an AWS access key ID → blocked', runHook('block-secret-leak.js', { stop_hook_active: false }), BLOCK);
});

withFixtureFile('key.pem', FAKE_PRIVATE_KEY_BLOCK, () => {
  check('a private key block → blocked', runHook('block-secret-leak.js', { stop_hook_active: false }), BLOCK);
});

withFixtureFile('db.ts', "export const url = 'postgres://admin:hunter2@db.internal:5432/app';\n", () => {
  check('a connection string with embedded credentials → blocked', runHook('block-secret-leak.js', { stop_hook_active: false }), BLOCK);
});

withFixtureFile('auth.ts', `const apiKey = '${FAKE_STRIPE_KEY}';\n`, () => {
  check('a hardcoded, secret-shaped api-key assignment → blocked', runHook('block-secret-leak.js', { stop_hook_active: false }), BLOCK);
});

withFixtureFile('ok-env-ref.ts', "const apiKey = process.env.API_KEY;\n", () => {
  check('reading the secret from process.env → allowed (the correct pattern, not a leak)', runHook('block-secret-leak.js', { stop_hook_active: false }), ALLOW);
});

withFixtureFile('.env.example', "API_KEY=changeme\nDATABASE_URL=postgres://user:password@localhost:5432/app\n", () => {
  check('.env.example with obvious placeholders → allowed', runHook('block-secret-leak.js', { stop_hook_active: false }), ALLOW);
});

withFixtureFile('.env.example', `API_KEY='${FAKE_STRIPE_KEY}'\n`, () => {
  check('.env.example with a real-looking secret → blocked (it is committed by convention, unlike .env)', runHook('block-secret-leak.js', { stop_hook_active: false }), BLOCK);
});

withFixtureFile('.env', `API_KEY='${FAKE_STRIPE_KEY}'\n`, () => {
  check('.env with a real secret → allowed (it is the convention-approved, gitignored place for one)', runHook('block-secret-leak.js', { stop_hook_active: false }), ALLOW);
});

withFixtureFile('leak.ts', `export const key = '${FAKE_AWS_KEY}';\n`, () => {
  check('same secret, already retried once → allowed (cannot trap an agent)', runHook('block-secret-leak.js', { stop_hook_active: true }), ALLOW);
});

check(
  'doc-only run (this repo currently has no leaked secret) → allowed',
  runHook('block-secret-leak.js', { stop_hook_active: false }),
  ALLOW,
);

// ---------------------------------------------------------------------------
// 9. block-path-permissions.js -- each agent writes only what its contract allows (T15)
// ---------------------------------------------------------------------------

section('9. block-path-permissions.js -- per-agent write paths (T15)');

/** Feeds the hook a write attempt, optionally as a named agent. */
function runPathHook(tool, filePath, role, extraEnv) {
  const env = {};
  if (role) env.AGENTCLAUDE_ROLE = role;
  Object.assign(env, extraEnv || {});
  return runHook('block-path-permissions.js', { tool_name: tool, tool_input: { file_path: filePath } }, env);
}

check(
  'no role set -> a normal write is allowed (hooks carry no identity; this is the honest floor)',
  runPathHook('Write', path.join(ROOT, 'server', 'x.ts')),
  ALLOW,
);

check(
  'no role set -> .workflow/ is still blocked (the floor applies to everyone)',
  runPathHook('Write', path.join(ROOT, '.workflow', 'state.db')),
  BLOCK,
);

// T99: a role workspace records that a *person* acknowledged a change. An agent
// that could write one could mark work seen on that person's behalf, which is the
// one thing V1.5's design forbids -- so it is on the floor, not in a contract.
check(
  'no role set -> knowledge/_roles/ is blocked (only a person writes a role workspace)',
  runPathHook('Write', path.join(ROOT, 'knowledge', '_roles', 'sales-crm', 'ba.yaml')),
  BLOCK,
);

check(
  'business-analyst writing its own lane\'s workspace -> still blocked (no agent, no mode, no exception)',
  runPathHook('Edit', path.join(ROOT, 'knowledge', '_roles', 'sales-crm', 'ba.yaml'), 'business-analyst'),
  BLOCK,
);

check(
  'a non-write tool is never this hook\'s business',
  runPathHook('Read', path.join(ROOT, '_docs', 'module', 'm', 'design.md'), 'backend-engineer'),
  ALLOW,
);

check(
  'backend-engineer writing server code -> allowed',
  runPathHook('Write', path.join(ROOT, 'server', 'routes', 'deal.ts'), 'backend-engineer'),
  ALLOW,
);

check(
  'backend-engineer writing design.md -> blocked (an engineer editing a contract has changed the rule)',
  runPathHook('Write', path.join(ROOT, '_docs', 'module', 'crm', 'design.md'), 'backend-engineer'),
  BLOCK,
);

check(
  'frontend-engineer writing schema.prisma -> blocked (backend owns it)',
  runPathHook('Edit', path.join(ROOT, 'prisma', 'schema.prisma'), 'frontend-engineer'),
  BLOCK,
);

check(
  'system-analyst writing design.md -> allowed (it owns it)',
  runPathHook('Write', path.join(ROOT, '_docs', 'module', 'crm', 'design.md'), 'system-analyst'),
  ALLOW,
);

check(
  'qa-engineer writing application code -> blocked (a verifier that fixes is not verifying)',
  runPathHook('Write', path.join(ROOT, 'server', 'routes', 'deal.ts'), 'qa-engineer'),
  BLOCK,
);

const targetWorkRoot = path.join(os.tmpdir(), 'agentclaude-target-work');
check(
  'backend-engineer may write only the runtime-granted canonical Target root',
  runPathHook('Write', path.join(targetWorkRoot, 'src', 'route.ts'), 'backend-engineer', { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify([targetWorkRoot]) }),
  ALLOW,
);
check(
  'runtime-granted Target root still blocks .git writes',
  runPathHook('Write', path.join(targetWorkRoot, '.git', 'config'), 'backend-engineer', { AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify([targetWorkRoot]) }),
  BLOCK,
);

check(
  'any role writing the pipeline\'s own contracts -> blocked',
  runPathHook('Write', path.join(ROOT, 'contracts', 'backend-engineer.yaml'), 'backend-engineer'),
  BLOCK,
);

check(
  'an unknown role -> allowed (fail open rather than trap a run on a typo)',
  runPathHook('Write', path.join(ROOT, 'server', 'x.ts'), 'architect'),
  ALLOW,
);

check(
  'a role name that looks like a path -> allowed, and reads no file',
  runPathHook('Write', path.join(ROOT, 'server', 'x.ts'), '../../etc/passwd'),
  ALLOW,
);

// The hook reads contracts/*.yaml with its own minimal reader, because hooks take no
// dependencies. That agreement is only safe if something checks it: a contract
// reformatted into block style must fail here rather than silently disabling the guard.
(function contractsStillReadableByTheHook() {
  const agents = ['setup', 'business-analyst', 'system-analyst', 'project-manager', 'test-planner', 'uxui-designer', 'backend-engineer',
                  'frontend-engineer', 'qa-engineer', 'security', 'devops'];
  let bad = [];
  for (const agent of agents) {
    const text = fs.readFileSync(path.join(ROOT, 'contracts', agent + '.yaml'), 'utf8');
    const write = /^\s*write:\s*\[([^\]]*)\]\s*$/m.exec(text);
    const deny = /^\s*deny:\s*\[([^\]]*)\]\s*$/m.exec(text);
    if (!write || !deny || write[1].trim() === '') bad.push(agent);
  }
  check(
    'every contract still exposes write/deny in the flow style the hook can read',
    bad.length === 0 ? 0 : 1,
    0,
  );
})();

// ---------------------------------------------------------------------------
// 9b. T-UX13 — Target-workspace deny of Knowledge-side artifacts
// ---------------------------------------------------------------------------

section('9b. T-UX13 — role: dev workspace blocks BA artifacts, whatever the session identity');

const DEV_CONFIG = 'schema_version: 1\ntarget_id: t\nregistered_at: 2026-08-24T00:00:00Z\noverrides: []\nrole: dev\n';
const BA_CONFIG = 'schema_version: 1\ntarget_id: t\nregistered_at: 2026-08-24T00:00:00Z\noverrides: []\nrole: ba\n';

withTempProject((tmp) => {
  write(path.join(tmp, '.agent-team', 'config.yaml'), DEV_CONFIG);
  const env = { CLAUDE_PROJECT_DIR: tmp };
  check(
    'role:dev workspace -> requirement.md blocked even interactively (no AGENTCLAUDE_ROLE)',
    runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'requirement.md') } }, env),
    BLOCK,
  );
  check('  design.md blocked too', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'design.md') } }, env), BLOCK);
  check('  uxui/ artifacts blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'uxui', 'design.md') } }, env), BLOCK);
  check('  knowledge items blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'knowledge', 'm', 'ux-design', 'UX-001.yaml') } }, env), BLOCK);
  check('  engineer-owned review.md still allowed', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'review.md') } }, env), ALLOW);
  check('  engineer-owned security.md still allowed', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'security.md') } }, env), ALLOW);
  check('  app source still allowed', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'src', 'app.ts') } }, env), ALLOW);

  // T-WG3 — the extended Knowledge-side set, plus the root-naming deny text.
  check('  plan.md blocked (Knowledge-side now)', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'plan.md') } }, env), BLOCK);
  check('  _docs/status.md blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'status.md') } }, env), BLOCK);
  check('  decisions blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'decisions', 'DR-001.yaml') } }, env), BLOCK);
  check('  targets.yaml blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'targets.yaml') } }, env), BLOCK);
  check('  knowledge-policy.yaml blocked', runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'knowledge-policy.yaml') } }, env), BLOCK);

  const kbEnv = { ...env, AGENTCLAUDE_KNOWLEDGE_ROOT: path.join(tmp, '..', 'knowledge-root-fixture') };
  const kbRes = spawnSync(process.execPath, [path.join(HOOKS, 'block-path-permissions.js')], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'requirement.md') } }),
    encoding: 'utf8',
    env: { ...process.env, ...kbEnv },
    cwd: tmp,
    timeout: 60000,
  });
  check('  deny text names the resolved Knowledge root when the launch provides it', kbRes.status === BLOCK && kbRes.stderr.includes('knowledge-root-fixture') ? 0 : 1, 0);

  write(path.join(tmp, '.agent-team', 'config.yaml'), BA_CONFIG);
  check(
    'role:ba workspace -> requirement.md allowed (the rule is dev-only)',
    runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'requirement.md') } }, env),
    ALLOW,
  );
  check(
    'role:ba workspace -> contracts blocked (T-WG3 mirror)',
    runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'contracts', 'backend-engineer.yaml') } }, env),
    BLOCK,
  );
  check(
    'role:ba workspace -> workflows blocked (T-WG3 mirror)',
    runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'workflows', 'feature.yml') } }, env),
    BLOCK,
  );
  check(
    'role:ba workspace -> requirement doc edits stay allowed',
    runHook('block-path-permissions.js', { tool_name: 'Edit', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'design.md') } }, env),
    ALLOW,
  );

  fs.rmSync(path.join(tmp, '.agent-team'), { recursive: true, force: true });
  check(
    'no .agent-team/config.yaml -> legacy behaviour, requirement.md allowed',
    runHook('block-path-permissions.js', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, '_docs', 'module', 'm', 'requirement.md') } }, env),
    ALLOW,
  );
});

// ---------------------------------------------------------------------------
// 10. generate-status.js — status.md computed from the real docs, not hand-written (T51)
// ---------------------------------------------------------------------------

section('10. generate-status.js — status.md is generated, not hand-written (T51)');

/** A plan.md phase's task table (T52), one row per [title, status]. */
function taskTable(rows) {
  const header = '| Task | Status | Owner | Depends on |\n|---|---|---|---|';
  return `${header}\n${rows.map(([title, status]) => `| ${title} | ${status} | backend-engineer | — |`).join('\n')}\n`;
}

function runGenerate(env) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'generate-status.js')], {
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    timeout: 60000,
  });
  return res.status;
}

withTempProject((tmp) => {
  check('no module yet -> exits 0, writes nothing', runGenerate({ CLAUDE_PROJECT_DIR: tmp }), 0);
  check('  and status.md was not created', fs.existsSync(path.join(tmp, '_docs', 'status.md')) ? 1 : 0, 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'),
    `# Plan\n\n## Phase 1: A\n${taskTable([['task one', 'verified'], ['task two', 'verified']])}\n## Phase 2: B 🔒\n${taskTable([['task three', 'pending']])}`);
  runGenerate({ CLAUDE_PROJECT_DIR: tmp });
  const out = fs.readFileSync(path.join(tmp, '_docs', 'status.md'), 'utf8');
  check('Phase 1 fully checked -> implemented ✅', /Phase 1 — implemented ✅/.test(out) ? 0 : 1, 0);
  check('Phase 2 untouched -> implemented ⬜', /Phase 2 — implemented ⬜/.test(out) ? 0 : 1, 0);
  check('no review.md yet -> verified ⬜', /Phase 1 — implemented ✅ · verified ⬜/.test(out) ? 0 : 1, 0);
  check('Phase 2 is gated and unaudited -> security ⬜', /Phase 2.*security ⬜/.test(out) ? 0 : 1, 0);
  check('Phase 1 has no gate -> security n\\/a', /Phase 1.*security n\/a/.test(out) ? 0 : 1, 0);
  check('Now line points at the first open phase', /\*\*Now\*\*: Phase 1/.test(out) ? 0 : 1, 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), `# Plan\n\n## Phase 1: A\n${taskTable([['task one', 'verified']])}`);
  write(path.join(tmp, '_docs', 'module', 'm', 'review.md'),
    '# Review\n\n## Review Outcome — Phase 1\n**Status:** ✅ Verified (FULL)\nAccepted.\n');
  write(path.join(tmp, '_docs', 'module', 'm', 'deploy.md'),
    '# Deploy\n\n## Deploy History\n| Date | Environment | Phase/Module | Outcome |\n|---|---|---|---|\n| 2026-01-01 | production | Phase 1 | success |\n');
  runGenerate({ CLAUDE_PROJECT_DIR: tmp });
  const out = fs.readFileSync(path.join(tmp, '_docs', 'status.md'), 'utf8');
  check('review.md\'s Status line drives verified + mode', /verified ✅ \(FULL\)/.test(out) ? 0 : 1, 0);
  check('deploy.md\'s history row drives deployed ✅', /deployed ✅/.test(out) ? 0 : 1, 0);
  check('fully done phase -> Now says complete', /\*\*Now\*\*: All phases complete/.test(out) ? 0 : 1, 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), `# Plan\n\n## Phase 1: A 🔒\n${taskTable([['task one', 'verified']])}`);
  write(path.join(tmp, '_docs', 'module', 'm', 'review.md'),
    '# Review\n\n## Review Outcome — Phase 1\n**Status:** ✅ Verified (FULL)\nAccepted.\n');
  write(path.join(tmp, '_docs', 'module', 'm', 'security.md'),
    '# Security\n\n## Open Findings — all rounds\n| Sev | Finding | Location | Status | Round | Routes to |\n|---|---|---|---|---|---|\n| 🟠 | x | Phase 1 | 🔵 Open | 1 | backend-engineer |\n');
  runGenerate({ CLAUDE_PROJECT_DIR: tmp });
  const out = fs.readFileSync(path.join(tmp, '_docs', 'status.md'), 'utf8');
  check('gated phase with an open finding -> security ⚠️, not ✅', /security ⚠️/.test(out) ? 0 : 1, 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), `# Plan\n\n## Phase 1: A\n${taskTable([['task one', 'verified']])}`);
  write(path.join(tmp, '_docs', 'module', 'm', 'review.md'),
    '# Review\n\n## Open Issues — all phases\n| Issue | Phase | Routes to | Blocking |\n|---|---|---|---|\n| BE-001 bug | 1 | backend-engineer | blocking |\n\n## Review Outcome — Phase 1\n**Status:** ⚠️ Partial (FULL)\nSent back.\n');
  runGenerate({ CLAUDE_PROJECT_DIR: tmp });
  const out = fs.readFileSync(path.join(tmp, '_docs', 'status.md'), 'utf8');
  check('a blocking Open Issues row surfaces under Blocked on', /\*\*Blocked on\*\*: .*BE-001/.test(out) ? 0 : 1, 0);
});

withTempProject((tmp) => {
  write(path.join(tmp, '_docs', 'status.md'), '# Project Status\n\n## Scaffold\nScaffolded — custom note.\n');
  write(path.join(tmp, '_docs', 'module', 'm', 'plan.md'), `# Plan\n\n## Phase 1: A\n${taskTable([['task', 'pending']])}`);
  runGenerate({ CLAUDE_PROJECT_DIR: tmp });
  const out = fs.readFileSync(path.join(tmp, '_docs', 'status.md'), 'utf8');
  check('an existing Scaffold section is preserved, not overwritten', /Scaffolded — custom note\./.test(out) ? 0 : 1, 0);
});

// ---------------------------------------------------------------------------
// 11. .claude/commands — prompt shortcuts stay frontmattered, guarded, and few
// ---------------------------------------------------------------------------

// Slash commands are prompts, not code, so nothing here executes one. The drift
// they risk is silent too: a command losing its guardrails import, a file that
// tells the model to run state-changing git, or someone growing the set without
// updating the mapping in planning/v2/claude-commands-TASKS.md §1.1. These cases
// read the real repo's .claude/commands/ because the shipped content IS the fixture.

section('11. .claude/commands — every command keeps its frontmatter, guardrails import, and the agreed set');

const COMMANDS_DIR = path.join(ROOT, '.claude', 'commands');
const GUARDRAILS_IMPORT = '@_shared/guardrails.md';

if (!fs.existsSync(COMMANDS_DIR)) {
  check('.claude/commands exists', 1, 0);
} else {
  const dirents = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
  const commandFiles = dirents.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
  const subdirs = dirents.filter((e) => e.isDirectory()).map((e) => e.name);

  // Count is pinned to planning/v2/claude-commands-TASKS.md §1.1 (50 catalog − 17 personal/marketing
  // − rewrite [amend-don't-regenerate policy] − repurpose = 31). Change the number ONLY together
  // with that mapping document, and record why in the same diff.
  check(`command count is exactly 31 per TASKS \u00a71.1 (got ${commandFiles.length})`, commandFiles.length === 31 ? 0 : 1, 0);

  // Flat namespace: the only allowed subdirectory is _shared/ (imported fragments, not commands).
  check(
    `only _shared/ sits below commands/ (got ${subdirs.join(', ') || 'nothing'})`,
    subdirs.every((d) => d === '_shared') ? 0 : 1,
    0,
  );

  const FORBIDDEN = [
    [/\bgit\s+(add|commit|push|amend|rebase|merge|reset|revert)\b/i, 'a state-changing git command'],
    [/\.workflow\//, 'a reference writing into .workflow/ runtime state'],
    [/knowledge\/_roles\//, 'a reference writing into knowledge/_roles/'],
  ];

  const allMd = [...commandFiles, ...fs.readdirSync(path.join(COMMANDS_DIR, '_shared')).filter((f) => f.endsWith('.md')).map((f) => path.join('_shared', f))];

  for (const rel of allMd.map((r) => r.split(path.sep).join('/'))) {
    const body = fs.readFileSync(path.join(COMMANDS_DIR, ...rel.split('/')), 'utf8');
    const isSharedInclude = rel.startsWith('_shared/');
    const label = `commands/${rel}`;

    if (!body.startsWith('---')) {
      check(`${label}: has YAML frontmatter`, 1, 0);
      continue;
    }
    const end = body.indexOf('\n---', 3);
    const frontmatter = end === -1 ? '' : body.slice(3, end);
    const content = end === -1 ? body : body.slice(end + 4);

    check(`${label}: frontmatter declares description`, /^\s*description:\s*\S/m.test(frontmatter) ? 0 : 1, 0);
    if (!isSharedInclude) {
      check(`${label}: frontmatter declares argument-hint`, /^\s*argument-hint:/m.test(frontmatter) ? 0 : 1, 0);
      check(`${label}: imports ${GUARDRAILS_IMPORT}`, content.includes(GUARDRAILS_IMPORT) ? 0 : 1, 0);
    } else {
      // user-invocable:false on an include breaks the @-import from every command (spike T-CC1-d).
      check(`${label}: hides behind no user-invocable flag`, /user-invocable\s*:\s*false/.test(frontmatter) ? 1 : 0, 0);
    }

    for (const [pattern, what] of FORBIDDEN) {
      check(`${label}: never instructs ${what}`, pattern.test(content) ? 1 : 0, 0);
    }
  }
}



// ---------------------------------------------------------------------------
// 11b/11c. rendered command mirrors — .opencode/commands + .agents/skills
// ---------------------------------------------------------------------------

// The two mirror families are GENERATED from .claude/commands (byte-for-byte
// verification is `sta --check-bindings`'s job, which needs compiled dist).
// What this harness pins here is the content contract that survives any
// rendering: right count, no Claude-only syntax left behind, guardrails
// actually inlined, and no command instructing forbidden actions.

section('11b. .opencode/commands — OpenCode rendering stays prompt-pure');

const OC_COMMANDS_DIR = path.join(ROOT, '.opencode', 'commands');
if (!fs.existsSync(OC_COMMANDS_DIR)) {
  check('.opencode/commands exists', 1, 0);
} else {
  const ocFiles = fs.readdirSync(OC_COMMANDS_DIR, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
  check(`opencode commands count is exactly 31 mirroring TASKS \u00a71.1 (got ${ocFiles.length})`, ocFiles.length === 31 ? 0 : 1, 0);

  for (const name of ocFiles) {
    const label = `opencode/commands/${name}`;
    const body = fs.readFileSync(path.join(OC_COMMANDS_DIR, name), 'utf8');
    if (!body.startsWith('---')) {
      check(`${label}: has YAML frontmatter`, 1, 0);
      continue;
    }
    const end = body.indexOf('\n---', 3);
    const frontmatter = end === -1 ? '' : body.slice(3, end);
    const content = end === -1 ? '' : body.slice(end + 4);

    check(`${label}: frontmatter declares description`, /^\s*description:\s*\S/m.test(frontmatter) ? 0 : 1, 0);
    // Claude-only fields/syntax must not survive rendering.
    check(`${label}: drops argument-hint`, /argument-hint/.test(body) ? 1 : 0, 0);
    check(`${label}: has no @_shared import left`, /@_shared\//.test(body) ? 1 : 0, 0);
    // Guardrails are inlined: the numbered rules must be present.
    check(`${label}: guardrails rule 1 inlined`, content.includes('1. This command is a **prompt shortcut only**.') ? 0 : 1, 0);
  }

  const FORBIDDEN = [
    [/\bgit\s+(add|commit|push|amend|rebase|merge|reset|revert)\b/i, 'a state-changing git command'],
    [/\.workflow\//, 'a reference writing into .workflow/ runtime state'],
    [/knowledge\/_roles\//, 'a reference writing into knowledge/_roles/'],
  ];
  for (const name of ocFiles) {
    const content = fs.readFileSync(path.join(OC_COMMANDS_DIR, name), 'utf8');
    for (const [pattern, what] of FORBIDDEN) {
      check(`opencode/commands/${name}: never instructs ${what}`, pattern.test(content) ? 1 : 0, 0);
    }
  }
}

section('11c. .agents/skills — Codex Agent Skills stay human-invoked');

const SKILLS_DIR = path.join(ROOT, '.agents', 'skills');
if (!fs.existsSync(SKILLS_DIR)) {
  check('.agents/skills exists', 1, 0);
} else {
  const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  check(`skill count is exactly 31 mirroring TASKS \u00a71.1 (got ${skillDirs.length})`, skillDirs.length === 31 ? 0 : 1, 0);

  for (const dir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      check(`skills/${dir}/SKILL.md exists`, 1, 0);
      continue;
    }
    const body = fs.readFileSync(skillPath, 'utf8');
    const end = body.startsWith('---') ? body.indexOf('\n---', 3) : -1;
    const frontmatter = end === -1 ? '' : body.slice(3, end);
    const content = end === -1 ? '' : body.slice(end + 4);

    check(`skills/${dir}/SKILL.md: frontmatter names the skill`, new RegExp(`^\\s*name:\\s*${dir}\\s*$`, 'm').test(frontmatter) ? 0 : 1, 0);
    check(`skills/${dir}/SKILL.md: frontmatter declares description`, /^\s*description:\s*\S/m.test(frontmatter) ? 0 : 1, 0);
    check(`skills/${dir}/SKILL.md: drops argument-hint`, /argument-hint/.test(body) ? 1 : 0, 0);
    check(`skills/${dir}/SKILL.md: has no @_shared import left`, /@_shared\//.test(body) ? 1 : 0, 0);
    check(`skills/${dir}/SKILL.md: guardrails rule 1 inlined`, content.includes('1. This command is a **prompt shortcut only**.') ? 0 : 1, 0);

    const policyPath = path.join(SKILLS_DIR, dir, 'agents', 'openai.yaml');
    const policy = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : '';
    check(
      `skills/${dir}/agents/openai.yaml keeps implicit invocation off`,
      policy.includes('allow_implicit_invocation') && policy.includes('false') && !policy.match(/allow_implicit_invocation\s*:\s*true/) ? 0 : 1,
      0,
    );
  }

  const FORBIDDEN_SKILLS = [
    [/\bgit\s+(add|commit|push|amend|rebase|merge|reset|revert)\b/i, 'a state-changing git command'],
    [/\.workflow\//, 'a reference writing into .workflow/ runtime state'],
    [/knowledge\/_roles\//, 'a reference writing into knowledge/_roles/'],
  ];
  for (const dir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf8');
    for (const [pattern, what] of FORBIDDEN_SKILLS) {
      check(`skills/${dir}/SKILL.md: never instructs ${what}`, pattern.test(content) ? 1 : 0, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// 12. pm-improvements — the PM prompt stays a work-graph author, nothing more
// ---------------------------------------------------------------------------

section('12. pm-improvements — PM prompt/contract boundary regressions (T-PM0.2..T-PM9.2)');

// Each case pins one sentence of the authority model in .claude/agents/project-manager.md.
// The renderings (.codex/.opencode) are byte-verified against this file by `sta --check-bindings`,
// so asserting the source here covers every runtime. Delete a rule from the prompt and the
// corresponding case fails here rather than eroding silently.

const PM_PROMPT = fs.readFileSync(path.join(ROOT, '.claude', 'agents', 'project-manager.md'), 'utf8');
const PM_CONTRACT = fs.readFileSync(path.join(ROOT, 'contracts', 'project-manager.yaml'), 'utf8');

check('pm: decomposition is one independently verifiable unit, batched by shared boundary (T-PM3.1)',
  /one task = one independently verifiable unit of work/.test(PM_PROMPT) && /Batch when the boundary is shared/.test(PM_PROMPT) ? 0 : 1, 0);
// The old imperative sentences are what this pins gone; the words "per endpoint" may
// still appear inside the negation that replaced them ("nothing mandates one task per endpoint…").
check('pm: no mandatory per-endpoint/per-component/per-model split left behind',
  !/tasks — one task per endpoint/.test(PM_PROMPT) && !/that's 6 task rows/.test(PM_PROMPT) && !/one task per Prisma model\/migration/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: split rule names dependency/owner/security/migration boundaries (T-PM3.2)',
  /Split when a boundary differs[\s\S]{0,400}security sensitivity[\s\S]{0,200}deploy\/migration boundary/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: scaffolding fact comes from status.md Scaffold line, not Target filesystem inspection (T-PM6.1)',
  /## Scaffold` line/.test(PM_PROMPT) && !/\(does `package\.json`/.test(PM_PROMPT) && /Don't look for `package\.json`/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: Graphify owns code relationships — no inferring source files or impact analysis (T-PM2.2)',
  /Graphify.*owns source-code relationships/.test(PM_PROMPT) && /Never infer source files/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: orchestrator owns runtime readiness — PM never marks a task ready (T-PM5.1)',
  /orchestrator owns runtime readiness/.test(PM_PROMPT) && /you never mark a task ready/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: Plan Mode is an optional engineer-side preflight, never part of PM flow (T-PM9.1)',
  /Plan Mode is an engineer-side preflight/.test(PM_PROMPT) && /never part of your flow/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: re-plan only on meaningful triggers, not progress noise (T-PM9.2)',
  /Re-plan on meaningful triggers/.test(PM_PROMPT) && /is not a trigger/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: Depends on is machine-read and validated by sta --check-plan (T-PM1.1/T-PM1.3)',
  /`Depends on` is machine-read/.test(PM_PROMPT) && /--check-plan/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: waves are derived downstream; PM writes no wave numbers (T-PM1.2)',
  /Execution waves are derived downstream/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: acceptance criteria are references into design.md, not copied prose (T-PM4.2)',
  /references, not copies/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: prompt does not assign status regeneration to PM (no Bash tool exists here) (T-PM7.1)',
  !/regenerating it with `node \.claude\/scripts\/generate-status\.js`/.test(PM_PROMPT) && /not the one who runs that generator/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: contract write list owns plan.md only — generated status files are not writable by PM (T-PM7.2)',
  /write:\s*\["_docs\/module\/\*\/plan\.md"\]/.test(PM_CONTRACT) && !/_docs\/status[^"']*\]\s*$/.test(PM_CONTRACT.match(/write:.*/)?.[0] ?? '') ? 0 : 1, 0);
check('pm: blocking ambiguity escalates upstream (user question or back to system-analyst), never guessed (T-PM10.2)',
  /ask the user directly/.test(PM_PROMPT) && /stop and send it back to `system-analyst`/.test(PM_PROMPT) ? 0 : 1, 0);
check('pm: security-sensitive uncertainty splits rather than hides inside a batch (T-PM10.2)',
  /a sensitive endpoint hidden inside a CRUD batch costs a missed gate/.test(PM_PROMPT) ? 0 : 1, 0);



console.log(`\n${'-'.repeat(70)}`);
if (failures.length === 0) {
  console.log(`All ${passed} case(s) passed — the harness enforces what it claims to.`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} FAILED:\n`);
for (const f of failures) console.log(`  - ${f}`);
console.log('\nA failing guard is worse than no guard: it looks installed and enforces nothing.');
process.exit(1);
