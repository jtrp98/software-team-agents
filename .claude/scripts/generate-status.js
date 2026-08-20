#!/usr/bin/env node
/*
 * Generates `_docs/status.md` from the real module documents (T51).
 *
 * WHY THIS EXISTS
 *
 * Before T51, every agent hand-edited `_docs/status.md` as the last thing it did
 * (`policies/documentation.md` §2 said so directly). That is exactly the kind of duplicated
 * fact `check-status-sync.js` was built to catch drift in, not prevent: an agent
 * could always still write the wrong symbol, or forget to update it, and nothing would know
 * until the next drift check ran. This script removes the duplication instead of policing it —
 * `status.md`'s per-phase table is computed straight from `plan.md`'s task table (T52 — each
 * row's `Status` cell), `review.md`'s `## Review Outcome` line, `security.md`'s `## Open Findings` table, and
 * `deploy.md`'s Deploy History, every time it runs. There is nothing left for an agent to get
 * wrong by hand, because there is nothing left for an agent to hand-write.
 *
 * Not a hook -- nothing blocks on this. Run it via Bash: `node .claude/scripts/generate-status.js`.
 * Every agent runs it as the last thing it does, in place of hand-editing `status.md` directly
 * (`policies/documentation.md` §2 has the current rule). Exit code is always 0: this is a writer,
 * not a checker -- `check-status-sync.js` is still the tool for verifying an existing `status.md`
 * without regenerating it (useful in manual mode, before this script existed on a project, or as
 * a second opinion).
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *
 * The `## Scaffold` line is written once by `setup` and isn't derivable from any other document
 * (there is no "is this project scaffolded" fact sitting in a doc) -- this script preserves
 * whatever the existing `status.md` says there, verbatim, and only invents a placeholder the
 * first time the file doesn't exist yet.
 *
 * WHY THE OUTPUT FORMAT IS UNCHANGED
 *
 * The template this produces is byte-for-byte the same shape `policies/documentation.md` §2
 * always documented (`- Phase N — implemented X · verified Y · security Z · deployed W`,
 * `**Now**:`, `**Blocked on**:`) -- `check-status-sync.js`'s regexes, and every agent that reads
 * `status.md` expecting that shape, keep working unchanged. Only *who writes it* changed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function findModules() {
  const moduleDir = path.join(root, '_docs', 'module');
  if (!fs.existsSync(moduleDir)) return [];
  return fs
    .readdirSync(moduleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Phases in plan.md order, each with its task-table tally (T52) and whether it's gated. */
function parsePlanPhases(planMd) {
  const lines = planMd.split(/\r?\n/);
  const phases = []; // { num, name, gated, total, checked }
  let current = null;
  let sawHeaderRow = false;
  const headingRe = /^##\s*Phase\s*(\d+)\s*:?\s*(.*?)\s*$/i;

  for (const line of lines) {
    const h = line.match(headingRe);
    if (h) {
      current = { num: Number(h[1]), name: h[2].replace(/🔒.*$/, '').trim(), gated: /🔒/.test(line), total: 0, checked: 0 };
      phases.push(current);
      sawHeaderRow = false;
      continue;
    }
    if (/^##\s+/.test(line) && current && !headingRe.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|?\s*:?-{2,}/.test(trimmed)) continue; // table separator row
    if (!sawHeaderRow) { sawHeaderRow = true; continue; } // the table's own header row
    const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    const status = (cells[1] || '').toLowerCase();
    if (!status) continue;
    current.total++;
    if (status === 'verified') current.checked++;
  }
  return phases;
}

function implementedSymbol(phase) {
  if (phase.total === 0) return '⬜';
  if (phase.checked === phase.total) return '✅';
  if (phase.checked === 0) return '⬜';
  return '⚠️';
}

/** Reads `**Status:** <emoji> ... (FULL|TARGETED)` under `## Review Outcome — Phase N`. */
function verifiedFor(reviewMd, phaseNum) {
  if (!reviewMd) return { symbol: '⬜', mode: null };
  const heading = new RegExp(`^##\\s*Review Outcome\\s*[-–—]+.*\\bPhase\\s*${phaseNum}\\b`, 'im');
  const lines = reviewMd.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => heading.test(l));
  if (startIdx === -1) return { symbol: '⬜', mode: null };
  for (let i = startIdx + 1; i < lines.length && i < startIdx + 6; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const m = lines[i].match(/\*\*Status:\*\*\s*(✅|⚠️|❌).*?\((FULL|TARGETED)\)/i);
    if (m) return { symbol: m[1], mode: m[2].toUpperCase() };
  }
  return { symbol: '⬜', mode: null };
}

/** True when security.md's `## Open Findings` table still has an unresolved row for this phase. */
function securityFor(reviewGated, securityMd, phaseNum) {
  if (!reviewGated) return 'n/a';
  if (!securityMd) return '⬜';
  const section = sectionBody(securityMd, /open\s+findings/i);
  if (section === null) return '⬜';
  const phaseTag = new RegExp(`\\bphase\\s*${phaseNum}\\b`, 'i');
  const rows = section.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/^\|?\s*:?-{2,}/.test(l.trim()));
  const forPhase = rows.filter((r) => phaseTag.test(r));
  if (forPhase.length === 0) {
    // No open row for this phase. Only ✅ once security actually looked at it —
    // a `## Findings — Phase N` round section having existed at some point is that evidence.
    const everAudited = new RegExp(`^##\\s*Findings\\s*[-–—]+.*\\bPhase\\s*${phaseNum}\\b`, 'im').test(securityMd);
    return everAudited ? '✅' : '⬜';
  }
  const stillOpen = forPhase.some((r) => /🔵|🟣/.test(r));
  return stillOpen ? '⚠️' : '✅';
}

function sectionBody(markdown, headingMatch) {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^##\s+/.test(l) && headingMatch.test(l));
  if (startIdx === -1) return null;
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(startIdx + 1, end).join('\n');
}

/** True when deploy.md's Deploy History mentions this phase with a successful outcome. */
function deployedFor(deployMd, phaseNum) {
  if (!deployMd) return '⬜';
  const section = sectionBody(deployMd, /deploy history/i);
  if (section === null) return '⬜';
  const phaseTag = new RegExp(`\\bphase\\s*${phaseNum}\\b`, 'i');
  const rows = section.split(/\r?\n/).filter((l) => phaseTag.test(l));
  if (rows.length === 0) return '⬜';
  const anySuccess = rows.some((r) => !/\bfail(ed)?\b/i.test(r));
  return anySuccess ? '✅' : '⬜';
}

/** The first blocking row's issue text from `## Open Issues — all phases`, or null. */
function blockedOn(reviewMd) {
  if (!reviewMd) return null;
  const section = sectionBody(reviewMd, /open\s+issues?/i);
  if (section === null) return null;
  let sawHeaderRow = false;
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || /^\|?\s*:?-{2,}/.test(trimmed)) continue;
    if (trimmed.startsWith('|') && !sawHeaderRow) { sawHeaderRow = true; continue; } // the table's own header row
    if (/non-?blocking/i.test(trimmed)) continue;
    if (!/blocking|blocker/i.test(trimmed)) continue;
    const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    return cells[0] || trimmed;
  }
  return null;
}

function docsLine(moduleDir) {
  const has = (name) => fs.existsSync(path.join(moduleDir, name)) ? '✅' : '⬜';
  return `Docs: requirement ${has('requirement.md')} · design ${has('design.md')} · plan ${has('plan.md')}`;
}

function buildModuleSection(name, moduleDir) {
  const planMd = readIfExists(path.join(moduleDir, 'plan.md'));
  const reviewMd = readIfExists(path.join(moduleDir, 'review.md'));
  const securityMd = readIfExists(path.join(moduleDir, 'security.md'));
  const deployMd = readIfExists(path.join(moduleDir, 'deploy.md'));

  const lines = [`## ${name}`, '', docsLine(moduleDir), ''];

  if (!planMd) {
    lines.push('(no `plan.md` yet)', '', '**Now**: waiting on `project-manager` to write `plan.md`', '**Blocked on**: —', '');
    return { lines, nextAgent: 'project-manager', stage: 'Planning' };
  }

  const phases = parsePlanPhases(planMd);
  if (phases.length === 0) {
    lines.push('(no `## Phase N` sections with a task table found in `plan.md`)', '', '**Now**: —', '**Blocked on**: —', '');
    return { lines, nextAgent: '—', stage: '—' };
  }

  let firstOpen = null;
  for (const phase of phases) {
    const impl = implementedSymbol(phase);
    const verified = verifiedFor(reviewMd, phase.num);
    const security = securityFor(phase.gated, securityMd, phase.num);
    const deployed = deployedFor(deployMd, phase.num);
    const modeSuffix = verified.mode ? ` (${verified.mode})` : '';
    lines.push(`- Phase ${phase.num} — implemented ${impl} · verified ${verified.symbol}${modeSuffix} · security ${security} · deployed ${deployed}`);

    const done = impl === '✅' && verified.symbol === '✅' && (security === '✅' || security === 'n/a') && deployed === '✅';
    if (!done && !firstOpen) firstOpen = { phase, impl, verified, security, deployed };
  }
  lines.push('');

  let now, nextAgent, stage;
  if (!firstOpen) {
    now = 'All phases complete — no further action.';
    nextAgent = '—';
    stage = 'All phases complete';
  } else {
    const { phase, impl, verified, security, deployed } = firstOpen;
    stage = `Phase ${phase.num}`;
    if (impl !== '✅') {
      now = `Phase ${phase.num} — ${phase.total - phase.checked} of ${phase.total} unchecked in \`plan.md\``;
      nextAgent = 'backend-engineer/frontend-engineer';
      stage += ' implementation';
    } else if (verified.symbol !== '✅') {
      now = `Phase ${phase.num} — implemented, waiting on \`qa-engineer\``;
      nextAgent = 'qa-engineer';
      stage += ' verification';
    } else if (security !== '✅' && security !== 'n/a') {
      now = `Phase ${phase.num} — 🔒 security gate open, waiting on \`security\``;
      nextAgent = 'security';
      stage += ' security review';
    } else {
      now = `Phase ${phase.num} — verified, waiting on \`devops\` to deploy`;
      nextAgent = 'devops';
      stage += ' deploy';
    }
  }
  const blocked = blockedOn(reviewMd);
  lines.push(`**Now**: ${now}`, `**Blocked on**: ${blocked || '—'}`, '');

  return { lines, nextAgent, stage };
}

function existingScaffoldSection(existingStatusMd) {
  if (!existingStatusMd) return '## Scaffold\nNot scaffolded yet — run the `setup` agent before Phase 1.\n';
  const m = existingStatusMd.match(/## Scaffold\n[\s\S]*?(?=\n## |$)/);
  return m ? m[0].trimEnd() + '\n' : '## Scaffold\nNot scaffolded yet — run the `setup` agent before Phase 1.\n';
}

function main() {
  const statusPath = path.join(root, '_docs', 'status.md');
  const modules = findModules();
  const existing = readIfExists(statusPath);

  if (modules.length === 0) {
    console.log('No module found under `_docs/module/` — nothing to generate. Run `business-analyst` first.');
    process.exit(0);
  }

  const sections = [];
  const table = ['| Module | Stage | Next agent |', '|---|---|---|'];

  for (const name of modules) {
    const moduleDir = path.join(root, '_docs', 'module', name);
    const built = buildModuleSection(name, moduleDir);
    sections.push(built.lines.join('\n'));
    table.push(`| ${name} | ${built.stage} | ${built.nextAgent} |`);
  }

  const out =
    '# Project Status\n\n' +
    existingScaffoldSection(existing) +
    '\n## Modules\n\n' +
    table.join('\n') +
    '\n\n' +
    sections.join('\n');

  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, out.trimEnd() + '\n', 'utf8');
  console.log(`Wrote _docs/status.md from ${modules.length} module(s): ${modules.join(', ')}`);
  process.exit(0);
}

main();
