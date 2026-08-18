#!/usr/bin/env node
/*
 * Schema/design drift checker for `.claude/shared/conventions.md` §7 — "The design is the
 * contract". `qa-engineer` is supposed to read `schema.prisma` and every module's `design.md`
 * Data Model section field-by-field and catch any divergence. Read-and-compare-by-eye misses
 * things on a long schema, so this script does the comparison mechanically instead: parse
 * `model` blocks out of both, diff field-by-field, and report.
 *
 * This is NOT a hook — nothing here blocks a tool call. It's a script `qa-engineer` (or anyone)
 * runs via Bash: `node .claude/scripts/check-schema-contract.js`. Output is a report; exit code
 * is 0 when every module's Data Model matches its slice of schema.prisma with no unclaimed
 * models, 1 otherwise, so it can gate a CI step later if this project ever gets one.
 *
 * Scoping rule this script implements (conventions.md §7):
 *   - every model a module's design.md declares must exist in schema.prisma, field for field
 *     (missing/renamed/retyped/dropped-relation = drift, always reported)
 *   - a model schema.prisma has that NO design.md declares is drift (an improvised change) --
 *     but a model schema.prisma has that SOME OTHER module's design.md declares is fine; this
 *     script sees every design.md at once, so that cross-module lookup is just a set union,
 *     not the per-module Grep qa-engineer does by hand.
 *
 * Parsing is regex-based, not a real Prisma parser -- it's good enough to catch name/type/
 * attribute drift in the common case (single-line fields inside a `model X { ... }` block).
 * A schema using constructs this can't parse is reported as "could not parse" for that model
 * rather than silently treated as matching.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function findSchemaPrisma() {
  const candidates = [
    path.join(root, 'prisma', 'schema.prisma'),
    path.join(root, 'api', 'prisma', 'schema.prisma'),
    path.join(root, 'schema.prisma'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findModuleDesignDocs() {
  const moduleDir = path.join(root, '_docs', 'module');
  if (!fs.existsSync(moduleDir)) return [];
  return fs
    .readdirSync(moduleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, file: path.join(moduleDir, e.name, 'design.md') }))
    .filter((m) => fs.existsSync(m.file));
}

/** Extracts the `## Data Model` section body, up to the next `## ` heading or EOF. */
function extractDataModelSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Data Model\s*$/.test(lines[i].trim())) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Parses `model Name { ... }` blocks into Map<modelName, Map<fieldName, signature>>.
 * `signature` is the normalized rest of the field line (type + attributes), so a rename,
 * retype, or dropped attribute shows up as a changed value under the same key structure.
 * Block-level attributes (`@@...`) and blank/comment lines are skipped -- they aren't fields.
 */
function parseModels(text) {
  const models = new Map();
  if (!text) return models;
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/gs;
  let m;
  while ((m = modelRe.exec(text)) !== null) {
    const [, name, body] = m;
    const fields = new Map();
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const fieldMatch = line.match(/^(\w+)\s+(.+)$/);
      if (!fieldMatch) continue;
      const [, fieldName, rest] = fieldMatch;
      fields.set(fieldName, rest.replace(/\s+/g, ' ').replace(/\s*\/\/.*$/, '').trim());
    }
    models.set(name, fields);
  }
  return models;
}

function diffFields(schemaFields, designFields) {
  const issues = [];
  for (const [fieldName, designSig] of designFields) {
    if (!schemaFields.has(fieldName)) {
      issues.push(`missing field \`${fieldName}\` (design.md has \`${designSig}\`, schema.prisma has none)`);
      continue;
    }
    const schemaSig = schemaFields.get(fieldName);
    if (schemaSig !== designSig) {
      issues.push(`field \`${fieldName}\` differs -- design.md: \`${designSig}\` vs schema.prisma: \`${schemaSig}\``);
    }
  }
  return issues;
}

function main() {
  const schemaPath = findSchemaPrisma();
  if (!schemaPath) {
    console.log('No schema.prisma found yet (checked prisma/, api/prisma/, repo root) -- nothing to check. Run this after `setup` has scaffolded the project.');
    process.exit(0);
  }

  const modules = findModuleDesignDocs();
  if (modules.length === 0) {
    console.log('No `_docs/module/*/design.md` found -- nothing to check.');
    process.exit(0);
  }

  const schemaModels = parseModels(fs.readFileSync(schemaPath, 'utf8'));
  const claimed = new Set();
  let drift = false;

  console.log(`Comparing ${schemaPath} against ${modules.length} module design doc(s):\n`);

  for (const mod of modules) {
    const designText = fs.readFileSync(mod.file, 'utf8');
    const dataModelSection = extractDataModelSection(designText);
    if (dataModelSection === null) {
      console.log(`## ${mod.name}\n  (no \`## Data Model\` section found in design.md -- skipped)\n`);
      continue;
    }
    const designModels = parseModels(dataModelSection);
    if (designModels.size === 0) {
      console.log(`## ${mod.name}\n  (Data Model section has no parseable \`model\` blocks -- skipped)\n`);
      continue;
    }

    console.log(`## ${mod.name}`);
    for (const [modelName, designFields] of designModels) {
      claimed.add(modelName);
      if (!schemaModels.has(modelName)) {
        console.log(`  DRIFT: model \`${modelName}\` is in design.md but not in schema.prisma`);
        drift = true;
        continue;
      }
      const issues = diffFields(schemaModels.get(modelName), designFields);
      if (issues.length === 0) {
        console.log(`  OK: model \`${modelName}\` matches`);
      } else {
        drift = true;
        console.log(`  DRIFT: model \`${modelName}\`:`);
        for (const issue of issues) console.log(`    - ${issue}`);
      }
    }
    console.log('');
  }

  const unclaimed = [...schemaModels.keys()].filter((name) => !claimed.has(name));
  if (unclaimed.length > 0) {
    drift = true;
    console.log('## Unclaimed models (in schema.prisma, not declared by ANY module\'s design.md)');
    console.log('These are the improvised-schema-change case conventions.md §7 calls out as a hard ❌:');
    for (const name of unclaimed) console.log(`  - ${name}`);
    console.log('');
  }

  console.log(drift ? 'Result: DRIFT FOUND -- see above.' : 'Result: no drift -- schema.prisma matches every module\'s design.md.');
  process.exit(drift ? 1 : 0);
}

main();
