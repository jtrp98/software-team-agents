#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vite",
  "templates",
  ".workflow",
  "release",
  ".cache",
]);

// High-confidence mojibake patterns (avoiding single legitimate Thai characters)
const PATTERNS = [
  { name: "U+FFFD replacement char", re: /\uFFFD/g },
  { name: "CP1252 emoji (ðŸ...)", re: /ðŸ/g },
  { name: "CP874 em-dash (โ€”)", re: /โ€”/g },
  { name: "CP874 en-dash (โ€“)", re: /โ€“/g },
  { name: "CP874 Thai mojibake cluster (เน€เธ)", re: /เน€เธ/g },
  { name: "CP874 Thai mojibake cluster (เธขเธ)", re: /เธขเธ/g },
  { name: "CP874 corrupted status (โ Œ)", re: /โ Œ/g },
  { name: "CP874 corrupted status (โ ธ๏ธ )", re: /โ ธ๏ธ /g },
  { name: "CP874 corrupted status (๐Ÿšซ)", re: /๐Ÿšซ/g },
];

const EXCLUDED_FILES = new Set([
  "orchestrator/src/encoding/unicodeRoundTrip.test.ts", // Test fixtures testing detector
  "scripts/check-mojibake.mjs",
]);

let violations = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(REPO_ROOT, full).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(full);
    } else if (ent.isFile()) {
      if (EXCLUDED_FILES.has(rel)) continue;
      checkFile(full, rel);
    }
  }
}

function checkFile(full, rel) {
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return;
  }
  for (let i = 0; i < Math.min(buf.length, 1024); i++) {
    if (buf[i] === 0) return; // Binary file
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");

  for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
    const line = lines[lineNum - 1];
    for (const pat of PATTERNS) {
      if (pat.re.test(line)) {
        console.error(`[MOJIBAKE] ${rel}:${lineNum} [${pat.name}]`);
        console.error(`   ${line.trim().slice(0, 140)}`);
        violations++;
      }
    }
  }
}

console.log(`Scanning repository at ${REPO_ROOT} for Unicode mojibake...`);
walk(REPO_ROOT);

if (violations > 0) {
  console.error(`\nFound ${violations} high-confidence mojibake occurrence(s).`);
  process.exit(1);
} else {
  console.log("\nZero mojibake detected across repository. All text files are clean UTF-8.");
  process.exit(0);
}