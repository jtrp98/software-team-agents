#!/usr/bin/env node
/*
 * status.md / plan.md consistency checker for `policies/documentation.md` §2 --
 * "`status.md` is an index, not a source of truth. If it ever disagrees with the actual
 * documents or code, the documents and code win."
 *
 * Nothing currently checks that disagreement mechanically -- an agent has to notice it by
 * reading both. This script does the noticing for free: for every module folder, it counts
 * `verified` rows per phase in `plan.md`'s task table (T52) and compares them against what
 * `status.md` claims (the `implemented` symbol on each `- Phase N -- ...` line, and the
 * `**Now**: ... X of Y unchecked` line), and reports every mismatch.
 *
 * Not a hook -- blocks nothing. Run via Bash: `node .claude/scripts/check-status-sync.js`.
 * Exit code 0 = status.md matches plan.md everywhere checked, 1 = at least one drift found.
 * Use it as a cheap first pass before deciding whether a phase needs a full qa-engineer
 * round, or just to catch a stale index before anyone acts on it.
 *
 * Parsing follows the exact status.md template in `policies/documentation.md` §2 and the
 * `## Phase N` / task-table structure every plan.md uses since T52 (a `| Task | Status | Owner |
 * Depends on |` row per task). A module whose plan has no parseable `## Phase N` section is
 * reported as DRIFT and fails the run — an unreadable plan is not a clean one — rather than
 * being silently skipped or treated as passing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function findModules() {
  const moduleDir = path.join(root, '_docs', 'module');
  if (!fs.existsSync(moduleDir)) return [];
  return fs
    .readdirSync(moduleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, planPath: path.join(moduleDir, e.name, 'plan.md') }))
    .filter((m) => fs.existsSync(m.planPath));
}

/** Counts task-table rows (T52) per `## Phase N` block in plan.md, by Status cell. */
function parsePlan(text) {
  const lines = text.split(/\r?\n/);
  const phases = new Map(); // phaseNum -> { total, checked, unchecked }
  let current = null;
  let sawHeaderRow = false;
  const phaseHeadingRe = /^##\s*Phase\s*(\d+)\b/i;

  for (const line of lines) {
    const headingMatch = line.match(phaseHeadingRe);
    if (headingMatch) {
      current = Number(headingMatch[1]);
      sawHeaderRow = false;
      if (!phases.has(current)) phases.set(current, { total: 0, checked: 0, unchecked: 0 });
      continue;
    }
    if (/^##\s+/.test(line) && current !== null && !phaseHeadingRe.test(line)) {
      current = null; // left the phase section for some other ## heading
      continue;
    }
    if (current === null) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|?\s*:?-{2,}/.test(trimmed)) continue; // table separator row
    if (!sawHeaderRow) { sawHeaderRow = true; continue; } // the table's own header row
    const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    const status = (cells[1] || '').toLowerCase();
    if (!status) continue;
    const stat = phases.get(current);
    stat.total++;
    if (status === 'verified') stat.checked++;
    else stat.unchecked++;
  }
  return phases;
}

/** Extracts the `## <moduleName>` section body from status.md, up to the next `## ` heading. */
function extractModuleSection(statusText, moduleName) {
  const lines = statusText.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRegex(moduleName)}\\s*$`, 'i');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IMPL_SYMBOLS = { '✅': 'done', '⬜': 'not-started', '⚠️': 'partial', 'n/a': 'n/a' };

/** Parses `- Phase N -- implemented <symbol> ...` lines from a module's status.md section. */
function parseStatusPhases(sectionText) {
  const phases = new Map(); // phaseNum -> { implemented: 'done'|'not-started'|'partial'|'n/a'|null, raw }
  const re = /^-\s*Phase\s*(\d+)\s*[-–—]+\s*implemented\s*(✅|⬜|⚠️|n\/a)/gim;
  let m;
  while ((m = re.exec(sectionText)) !== null) {
    phases.set(Number(m[1]), { implemented: IMPL_SYMBOLS[m[2]] || null, raw: m[0] });
  }
  return phases;
}

/** Parses the `**Now**: Phase N ... -- X of Y unchecked in \`plan.md\`` line, if present. */
function parseNowLine(sectionText) {
  const m = sectionText.match(/\*\*Now\*\*:.*?Phase\s*(\d+).*?(\d+)\s+of\s+(\d+)\s+unchecked/i);
  if (!m) return null;
  return { phase: Number(m[1]), unchecked: Number(m[2]), total: Number(m[3]) };
}

function main() {
  const statusPath = path.join(root, '_docs', 'status.md');
  if (!fs.existsSync(statusPath)) {
    console.log('No `_docs/status.md` found yet -- nothing to check.');
    process.exit(0);
  }

  const modules = findModules();
  if (modules.length === 0) {
    console.log('No module with a `plan.md` found under `_docs/module/` -- nothing to check.');
    process.exit(0);
  }

  const statusText = fs.readFileSync(statusPath, 'utf8');
  let drift = false;

  console.log(`Comparing _docs/status.md against ${modules.length} module plan.md file(s):\n`);

  for (const mod of modules) {
    console.log(`## ${mod.name}`);
    const planPhases = parsePlan(fs.readFileSync(mod.planPath, 'utf8'));
    if (planPhases.size === 0) {
      // Unreadable is not clean: a plan this script cannot parse may say anything,
      // and status.md keeps claiming things about it — that is drift-shaped
      // silence, so it fails rather than skipping.
      console.log('  DRIFT: no `## Phase N` sections with a task table found in plan.md -- the plan could not be parsed');
      drift = true;
      console.log('');
      continue;
    }

    const section = extractModuleSection(statusText, mod.name);
    if (section === null) {
      console.log(`  DRIFT: status.md has no \`## ${mod.name}\` section for this module`);
      drift = true;
      console.log('');
      continue;
    }

    const statusPhases = parseStatusPhases(section);
    for (const [phaseNum, plan] of planPhases) {
      const status = statusPhases.get(phaseNum);
      if (!status) {
        console.log(`  DRIFT: plan.md has Phase ${phaseNum}, but status.md's section has no matching "- Phase ${phaseNum} -- implemented ..." line`);
        drift = true;
        continue;
      }
      const fullyChecked = plan.unchecked === 0 && plan.total > 0;
      if (status.implemented === 'done' && !fullyChecked) {
        console.log(`  DRIFT: Phase ${phaseNum} status.md says "implemented ✅" but plan.md has ${plan.unchecked}/${plan.total} unchecked task(s)`);
        drift = true;
      } else if (status.implemented === 'not-started' && fullyChecked) {
        console.log(`  DRIFT: Phase ${phaseNum} status.md says "implemented ⬜" but plan.md has all ${plan.total} task(s) checked`);
        drift = true;
      } else {
        console.log(`  OK: Phase ${phaseNum} (${plan.checked}/${plan.total} checked, status.md says implemented ${reverseSymbol(status.implemented)})`);
      }
    }

    const now = parseNowLine(section);
    if (now) {
      const real = planPhases.get(now.phase);
      if (!real) {
        console.log(`  DRIFT: **Now** line references Phase ${now.phase}, which plan.md doesn't have`);
        drift = true;
      } else if (real.unchecked !== now.unchecked || real.total !== now.total) {
        console.log(`  DRIFT: **Now** line says ${now.unchecked} of ${now.total} unchecked for Phase ${now.phase}, plan.md actually has ${real.unchecked} of ${real.total}`);
        drift = true;
      } else {
        console.log(`  OK: **Now** line matches plan.md (${real.unchecked} of ${real.total} unchecked)`);
      }
    }
    console.log('');
  }

  console.log(drift ? 'Result: DRIFT FOUND -- see above.' : 'Result: no drift -- status.md matches every plan.md checked.');
  process.exit(drift ? 1 : 0);
}

function reverseSymbol(key) {
  return Object.keys(IMPL_SYMBOLS).find((k) => IMPL_SYMBOLS[k] === key) || key;
}

main();
