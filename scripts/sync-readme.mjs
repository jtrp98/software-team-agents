#!/usr/bin/env node
/**
 * README synchronization — the one deterministic excerpt that must appear verbatim
 * in two places: the Quick Start of docs/getting-started.md (canonical source) and
 * README.md (front door). Everything else in README links instead of duplicating.
 *
 *   npm run docs:sync    regenerate README generated blocks from docs/ sources
 *   npm run docs:check   exit 1 when a generated block is stale (CI-wired)
 *
 * Source side (docs/getting-started.md):
 *   <!-- readme:quick-start:start --> ... <!-- readme:quick-start:end -->
 * Target side (README.md):
 *   <!-- generated: docs/getting-started.md#quick-start ... --> ... <!-- generated:end -->
 *
 * No dependencies. Blocks are declared in BLOCKS below; a missing marker is an
 * error, not a skip — a renamed anchor must be fixed here in the same change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BLOCKS = [
  {
    source: "docs/getting-started.md",
    id: "quick-start",
    target: "README.md",
  },
];

function extractSourceBlock(sourceRel, id) {
  const text = readFileSync(path.join(ROOT, sourceRel), "utf8");
  const open = `<!-- readme:${id}:start -->`;
  const close = `<!-- readme:${id}:end -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${sourceRel}: missing or malformed readme:${id} markers`);
  }
  return text.slice(start + open.length, end).trim();
}

function replaceTargetBlock(targetRel, sourceRel, id, content) {
  const file = path.join(ROOT, targetRel);
  const text = readFileSync(file, "utf8");
  const openRe = new RegExp(`<!-- generated: ${sourceRel}#${id}[^\n]*-->`);
  const close = "<!-- generated:end -->";
  const openMatch = text.match(openRe);
  const end = text.indexOf(close);
  if (!openMatch || end === -1) {
    throw new Error(
      `${targetRel}: missing generated block for ${sourceRel}#${id} — expected ${openRe} ... ${close}`,
    );
  }
  const blockIdx = text.indexOf(openMatch[0]);
  if (blockIdx > end) {
    throw new Error(`${targetRel}: generated block markers out of order for ${sourceRel}#${id}`);
  }
  const before = text.slice(0, blockIdx);
  const after = text.slice(end + close.length);
  return { file, next: `${before}<!-- generated: ${sourceRel}#${id} — npm run docs:sync; do not edit by hand -->\n${content}\n${close}${after}` };
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

const check = process.argv.includes("--check");

let failed = false;
for (const block of BLOCKS) {
  const content = extractSourceBlock(block.source, block.id);
  const { file, next } = replaceTargetBlock(block.target, block.source, block.id, content);
  const current = readFileSync(file, "utf8");
  const stale = normalize(current) !== normalize(next);
  if (check) {
    if (stale) {
      console.error(`STALE: ${block.target} generated block ${block.source}#${block.id} — run \`npm run docs:sync\``);
      failed = true;
    } else {
      console.log(`OK: ${block.target} ${block.source}#${block.id}`);
    }
  } else if (stale) {
    writeFileSync(file, next);
    console.log(`SYNCED: ${block.target} ${block.source}#${block.id}`);
  } else {
    console.log(`OK: ${block.target} ${block.source}#${block.id} (already up to date)`);
  }
}
if (failed) process.exit(1);
