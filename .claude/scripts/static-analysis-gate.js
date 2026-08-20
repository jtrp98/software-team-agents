#!/usr/bin/env node
/*
 * Static Analysis Gate (T22) — the automated sweep that runs once, right before qa-engineer
 * trusts a round, instead of "lint/typecheck/build/test" being a checklist re-derived from
 * memory every time. Runs `lint`, `format`, `typecheck`, `build`, `test` in every package.json
 * this repo has that defines the script, plus a repo-wide `security_scan` (T23 — Security as
 * Continuous: this is the "Code" checkpoint, independent of whatever `security` audits later)
 * and `dependency_scan` (T24 — Dependency Security).
 *
 * `dependency_scan` is deliberately NOT a live `npm audit`/registry call: this gate runs on
 * every FULL QA round, and a check that needs network access would make verification
 * non-deterministic (flaky offline, and silently stale the moment the advisory feed changes
 * under it). Instead it's an offline match against a small bundled list of known-vulnerable
 * version floors (`KNOWN_VULNERABLE_PACKAGES` below) — same curated-not-exhaustive tradeoff as
 * `security_scan`, and for the same reason: a real SCA tool is what `security_scan` already
 * says it isn't a replacement for `security`'s audit.
 *
 * COMPLEMENTS, DOES NOT DUPLICATE, `require-green-before-stop.js`
 *
 * That hook runs only `typecheck`/`lint`, per individual engineer stop, because `build`/`test`
 * are too slow to pay for on every stop (its own header explains why). This script is the full
 * sweep, meant to run once per phase, right before `qa-engineer` starts verifying — a different
 * checkpoint at a different cadence, not a wider version of the same one.
 *
 * A package that doesn't define a given script is reported `skipped`, not `failed` — most
 * projects here have no `format` script, and that's a fact about the project, not a defect.
 *
 * `security_scan` is a curated pattern sweep, not a real SAST tool — it exists to catch the
 * handful of constructs that are wrong in essentially every context (eval, shelling out to a
 * string built from input, disabled TLS verification, a hardcoded JWT-secret fallback, …), not
 * to replace `security`'s adversarial read of the code. It complements that agent; it doesn't
 * substitute for it — a clean scan here is not a security sign-off.
 *
 * Run standalone: `node .claude/scripts/static-analysis-gate.js [--json]`
 * Exit 0 = every check that ran passed. Exit 1 = at least one failed. `--json` prints a
 * machine-readable report instead of the human-readable one.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const asJson = process.argv.includes('--json');

const CHECKS = ['lint', 'format', 'typecheck', 'build', 'test'];
const NOT_YET_IMPLEMENTED = [];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.workflow', '.next', 'build']);

// Curated, not exhaustive — a handful of real historical advisories against packages this
// stack's own dependency tree is likely to pull in, kept as illustration of the mechanism
// rather than as a live feed. `maxVulnerableVersion` is the highest version still affected —
// anything strictly greater is treated as fixed. Real SCA (npm audit / Snyk / OSV) is a
// separate tool this gate does not try to replace; see the header comment for why.
const KNOWN_VULNERABLE_PACKAGES = [
  { name: 'lodash', maxVulnerableVersion: '4.17.20', advisory: 'CVE-2021-23337 — command injection via template' },
  { name: 'minimist', maxVulnerableVersion: '1.2.5', advisory: 'CVE-2021-44906 — prototype pollution' },
  { name: 'node-fetch', maxVulnerableVersion: '2.6.6', advisory: 'CVE-2022-0235 — exposure of sensitive info via redirect' },
  { name: 'json5', maxVulnerableVersion: '1.0.1', advisory: 'CVE-2022-46175 — prototype pollution' },
  { name: 'express', maxVulnerableVersion: '4.17.2', advisory: 'CVE-2022-24999 — qs DoS via array-crafted query string' },
  { name: 'jsonwebtoken', maxVulnerableVersion: '8.5.1', advisory: 'CVE-2022-23529 — arbitrary code execution via crafted secret/key' },
  { name: 'semver', maxVulnerableVersion: '7.5.1', advisory: 'CVE-2022-25883 — ReDoS in range parsing' },
];

// Directories the security scan actually reads code from — everywhere app/API code and the
// schema live, per CLAUDE.md's stack. Anything else (docs, config, this script's own folder) is
// out of scope: scanning the whole repo would flag this file's own pattern list as a match.
const SECURITY_SCAN_DIRS = ['app', 'components', 'server', 'src', 'pages', 'prisma'];
const SECURITY_SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.prisma']);

// Curated, not exhaustive — constructs that are wrong in essentially every context in this
// stack, not project-specific style. Each pattern names the risk it flags, not just what it
// matches, so a hit is actionable without opening this file.
const SECURITY_PATTERNS = [
  { name: 'eval / Function constructor', pattern: /\beval\s*\(|new\s+Function\s*\(/ },
  { name: 'shell exec with string concatenation/interpolation', pattern: /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^,)]+\+)/ },
  { name: 'React dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/ },
  { name: 'raw SQL built from a template/interpolated string', pattern: /\$queryRawUnsafe\s*\(|\$executeRawUnsafe\s*\(/ },
  { name: 'TLS certificate verification disabled', pattern: /rejectUnauthorized\s*:\s*false/ },
  { name: 'hardcoded fallback secret (JWT/session)', pattern: /(?:JWT_SECRET|SESSION_SECRET|process\.env\.\w*SECRET\w*)\s*(?:\|\||\?\?)\s*['"`][^'"`]+['"`]/ },
  { name: 'CORS wildcard origin combined with credentials', pattern: /Access-Control-Allow-Origin['"`]?\s*[:=]\s*['"`]\*/ },
];

/** Every file under `dir` whose extension is in `exts`, SKIP_DIRS pruned from the walk. */
function findFiles(dir, exts, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) findFiles(full, exts, out);
    } else if (exts.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Scans every matching file under the security-relevant dirs for the curated pattern list. */
function runSecurityScan() {
  const files = [];
  for (const dir of SECURITY_SCAN_DIRS) findFiles(path.join(root, dir), SECURITY_SCAN_EXTS, files);

  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { name, pattern } of SECURITY_PATTERNS) {
        if (pattern.test(line)) hits.push(`${path.relative(root, file)}:${i + 1} — ${name}`);
      }
    });
  }

  return {
    dir: '(repo)',
    check: 'security_scan',
    status: hits.length === 0 ? 'passed' : 'failed',
    output: hits.length ? hits.join('\n') : undefined,
  };
}

/** Strips range prefixes (^, ~, >=, ...) and takes the leading `N.N.N` token; null if unparseable (git urls, "latest", "workspace:*", ...). */
function parseVersion(spec) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(spec || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1/0/1, comparing major then minor then patch. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Scans every found package.json's declared dependencies against the curated advisory list. */
function runDependencyScan(packageDirs) {
  const hits = [];

  for (const dir of packageDirs) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    for (const { name, maxVulnerableVersion, advisory } of KNOWN_VULNERABLE_PACKAGES) {
      if (!(name in declared)) continue;
      const declaredVersion = parseVersion(declared[name]);
      const ceiling = parseVersion(maxVulnerableVersion);
      if (!declaredVersion || !ceiling) continue; // can't parse (git url, "latest", workspace:*, ...) -- not our call to make
      if (compareVersions(declaredVersion, ceiling) <= 0) {
        hits.push(`${path.relative(root, dir) || '.'}/package.json — ${name}@${declared[name]} — ${advisory}`);
      }
    }
  }

  return {
    dir: '(repo)',
    check: 'dependency_scan',
    status: hits.length === 0 ? 'passed' : 'failed',
    output: hits.length ? hits.join('\n') : undefined,
  };
}

/** Every directory under `dir` (dir included) that holds a `package.json`, node_modules/dist/etc. pruned from the walk. */
function findPackageDirs(dir, out) {
  if (fs.existsSync(path.join(dir, 'package.json'))) out.push(dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    findPackageDirs(path.join(dir, e.name), out);
  }
  return out;
}

function scriptsIn(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return (pkg && pkg.scripts) || {};
  } catch {
    return {};
  }
}

function tail(text, lines) {
  const all = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return all.slice(-lines).join('\n');
}

function runOne(dir, check) {
  const res = spawnSync('npm', ['run', '--silent', check], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 300000,
  });
  const passed = !res.error && res.status === 0;
  return {
    dir: path.relative(root, dir) || '.',
    check,
    status: passed ? 'passed' : 'failed',
    output: passed ? undefined : tail((res.stdout || '') + (res.stderr || ''), 40),
  };
}

function main() {
  const packageDirs = findPackageDirs(root, []);
  const results = [];

  for (const dir of packageDirs) {
    const scripts = scriptsIn(dir);
    for (const check of CHECKS) {
      if (typeof scripts[check] !== 'string') {
        results.push({ dir: path.relative(root, dir) || '.', check, status: 'skipped', reason: 'no such script' });
        continue;
      }
      results.push(runOne(dir, check));
    }
  }

  results.push(runSecurityScan());
  results.push(runDependencyScan(packageDirs));

  for (const { check, reason } of NOT_YET_IMPLEMENTED) {
    results.push({ dir: '(repo)', check, status: 'not_implemented', reason });
  }

  const ok = results.every((r) => r.status !== 'failed');
  const report = { ok, results };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of results) {
      const label = `${r.dir} :: ${r.check}`;
      if (r.status === 'passed') console.log(`  ok    ${label}`);
      else if (r.status === 'skipped') console.log(`  skip  ${label} (${r.reason})`);
      else if (r.status === 'not_implemented') console.log(`  n/a   ${label} (${r.reason})`);
      else {
        console.log(`  FAIL  ${label}`);
        for (const line of (r.output || '').split('\n')) console.log(`        ${line}`);
      }
    }
    console.log(ok ? '\nstatic analysis gate: PASS' : '\nstatic analysis gate: FAIL');
  }

  process.exit(ok ? 0 : 1);
}

main();
