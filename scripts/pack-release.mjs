#!/usr/bin/env node
/**
 * Internal release packaging (planning/v1 CHECKLIST_PACKAGING_DISTRIBUTION).
 *
 * Repeatable, gated, deterministic:
 *   1. `npm pack --dry-run` must pass before anything is written.
 *   2. `npm pack` writes `<name>-<version>.tgz` into `release/`.
 *   3. The artifact's own contents are inspected (`tar -tf`) against hard
 *      exclusions (.git, node_modules, coverage, temp/local configs,
 *      secret-looking files) — the release fails closed if any appear.
 *   4. A SHA-256 sidecar (`<tgz>.sha256`) is written next to it for internal
 *      distribution integrity checks.
 *
 * Run through `npm run release`, which gates this behind typecheck + tests +
 * build so a failing suite never produces an artifact.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const releaseDir = path.join(repoRoot, "release");

function npm(args) {
  const isWin = process.platform === "win32";
  // Windows: npm is npm.cmd — modern Node refuses .cmd spawns without a shell
  // (EINVAL), so go through one and quote every argument ourselves.
  const quoted = isWin ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  return execFileSync(isWin ? "npm.cmd" : "npm", quoted, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: isWin,
  });
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
if (!pkg.name || !pkg.version) {
  console.error("[release] package.json must declare name and version");
  process.exit(1);
}
if (pkg.private !== true) {
  console.error('[release] package.json must keep "private": true — distribution is the .tgz only');
  process.exit(1);
}

// 1 — dry-run gate: nothing may proceed if a bare pack cannot even be simulated.
console.log("[release] npm pack --dry-run ...");
npm(["pack", "--dry-run"]);

// 2 — real pack into release/.
fs.mkdirSync(releaseDir, { recursive: true });
console.log("[release] npm pack -> release/ ...");
npm(["pack", "--pack-destination", releaseDir]);
const tgz = path.join(releaseDir, `${pkg.name}-${pkg.version}.tgz`);
if (!fs.existsSync(tgz)) {
  console.error(`[release] expected artifact missing: ${tgz}`);
  process.exit(1);
}

// 3 — inspect exactly what ships, straight from the artifact itself
// (ground truth — immune to npm's interleaved prepack output). tar -tf works
// on Windows 10+, Linux and macOS alike; entries look like `package/<path>`.
const tar = spawnSync("tar", ["-tf", tgz], { encoding: "utf8", shell: process.platform === "win32" });
if (tar.error || tar.status !== 0) {
  console.error(`[release] cannot list ${path.basename(tgz)}: ${tar.stderr ?? tar.error}`);
  process.exit(1);
}
const entries = tar.stdout
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.endsWith("/"))
  .map((l) => l.replace(/^package\//, ""));

const FORBIDDEN = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules\//,
  /(^|\/)coverage\//,
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|pfx|p12)$/i,
  /id_rsa|id_ed25519|credentials|secrets?\.(ya?ml|json|txt)$/i,
  /\.log$|\.tmp$|~$/,
];
const violations = entries.filter((p) => FORBIDDEN.some((re) => re.test(p)));
if (violations.length > 0) {
  console.error("[release] forbidden files inside package — fix before distributing:");
  for (const v of violations) console.error(`  ! ${v}`);
  fs.rmSync(tgz, { force: true }); // never leave a bad artifact lying around
  process.exit(1);
}

// 4 — SHA-256 sidecar.
const hash = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
fs.writeFileSync(`${tgz}.sha256`, `${hash}  ${path.basename(tgz)}\n`, "utf8");

const sizeMb = (fs.statSync(tgz).size / (1024 * 1024)).toFixed(2);
console.log("[release] package contents:");
for (const entry of entries) console.log(`   ${entry}`);
console.log(
  `[release] OK: ${path.basename(tgz)} (${sizeMb} MB, ${entries.length} files)\n` +
    `[release] sha256: ${hash}\n` +
    `[release] artifact: ${tgz}`,
);
