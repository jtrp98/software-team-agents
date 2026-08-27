#!/usr/bin/env node
/**
 * T-V1-18 — the unified V1 release gate: one command, one exit code.
 *
 *   exit 0     → the tree is releasable
 *   non-zero   → do not tag V1
 *
 * Everything here already existed as its own gate (CI, checkers, suites); this
 * script only runs them in release order so no artifact can be produced from a
 * state any single gate would have rejected. Steps:
 *
 *   1. typecheck + full test suite + build (orchestrator)
 *      — includes the AI-boundary, context-scope and runtime-conformance suites,
 *        which live inside `npm test` by design rather than as parallel tracks.
 *   2. hooks/scripts self-test (.claude/tests/run.js)
 *   3. every repository-consistency checker (the 15 `--check-*` gates + bindings)
 *   4. templates snapshot is exactly what the current sources regenerate
 *      — plus version consistency between package.json and the stamped manifest
 *   5. packaged-distribution E2E against the real .tgz (packs its own artifact;
 *      proves install→init→bind→sync→launch-surface without this repo)
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const isWin = process.platform === "win32";

const failures = [];
let step = 0;

/** Quotes one token for a shell command line (our paths never embed quotes). */
function q(token) {
  return /\s/.test(token) ? `"${token}"` : token;
}

function run(name, command, options = {}) {
  step += 1;
  const label = `${String(step).padStart(2, "0")} ${name}`;
  console.log(`\n[gate] ${label}\n[gate] $ ${command}`);
  const res = spawnSync(command, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: true,
    timeout: options.timeoutMs ?? 900_000,
  });
  if (res.status === 0) {
    console.log(`[gate] ok — ${name}`);
  } else {
    failures.push(name);
    const tail = typeof res.stdout === "string" || typeof res.stderr === "string"
      ? `\n${[(res.stdout ?? ""), (res.stderr ?? "")].join("\n").trim().split("\n").slice(-30).join("\n")}`
      : "";
    console.error(`[gate] FAIL — ${name} (exit ${res.status ?? "signal"})${options.quiet ? tail : ""}`);
  }
}

// --- 1 · code health ---------------------------------------------------------
run("typecheck (orchestrator)", "npm run typecheck", { cwd: path.join(repoRoot, "orchestrator"), quiet: true });
run("test suite (incl. AI boundary, context scope, runtime conformance)", "npm test", { cwd: path.join(repoRoot, "orchestrator"), quiet: true });
run("build (orchestrator)", "npm run build", { cwd: path.join(repoRoot, "orchestrator"), quiet: true });

// --- 2 · hooks & scripts -----------------------------------------------------
run("hooks/scripts self-test", "node .claude/tests/run.js");

// --- 3 · repository-consistency checkers ------------------------------------
const distCli = "node orchestrator/dist/cli.js";
for (const flag of [
  "--check-contracts",
  "--check-layout",
  "--check-prompt-budget",
  "--check-workflows",
  "--check-profile",
  "--check-decisions",
  "--check-test-pyramid",
  "--check-review-separation",
  "--check-escalation-policy",
  "--check-workspace",
  "--check-repos",
  "--check-environments",
  "--check-doc-structure",
  "--check-knowledge",
  "--check-roles",
  // The bindings check is what caught the last silent rendering drift; CI does
  // not run it yet, so the release gate is where it must pass.
  "--check-bindings",
]) {
  run(`checker ${flag}`, `${distCli} ${flag}`, { quiet: true });
}

// Installation check, the way CI runs it: against a freshly-init'd project,
// not the framework repo itself (which is a dev checkout, not a sta project).
{
  const tmpInit = fs.mkdtempSync(path.join(os.tmpdir(), "sta-gate-install-"));
  try {
    fs.writeFileSync(
      path.join(tmpInit, "package.json"),
      JSON.stringify({ name: "sta-installation-check", private: true, scripts: { build: "tsc", test: "node --test" } }, null, 2),
    );
    fs.writeFileSync(path.join(tmpInit, "package-lock.json"), JSON.stringify({ name: "sta-installation-check", lockfileVersion: 3 }));
    run(
      "initialize installation-check fixture",
      [q("node"), q(path.join(repoRoot, "orchestrator", "dist", "cli.js")), "init", "--mode", "legacy-project", "--templates", q(path.join(repoRoot, "templates")), "--project-root", q(tmpInit)].join(" "),
      { quiet: true, timeoutMs: 120_000 },
    );
    run("checker --check-installation (fresh init)", `${distCli} --check-installation --project-root ${q(tmpInit)}`, { quiet: true });
  } finally {
    fs.rmSync(tmpInit, { recursive: true, force: true });
  }
}

// --- 4 · templates snapshot & version consistency ----------------------------
run("templates snapshot regenerates byte-identically", `${distCli} --build-templates templates`, { quiet: true });
{
  const dirty = spawnSync("git status --porcelain -- templates", { cwd: repoRoot, encoding: "utf8", shell: true });
  step += 1;
  if ((dirty.stdout ?? "").trim() === "" && dirty.status === 0) {
    console.log("[gate] ok — templates/ matches its sources");
  } else {
    failures.push("templates snapshot drift");
    console.error(`[gate] FAIL — templates/ drifted from sources:\n${dirty.stdout}`);
  }
}
{
  step += 1;
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates", "manifest.json"), "utf8"));
  if (pkg.version === manifest.framework_version) {
    console.log("[gate] ok — package.json and templates/manifest.json agree on version");
  } else {
    failures.push("version inconsistency");
    console.error(`[gate] FAIL — package.json=${pkg.version} manifest=${manifest.framework_version}`);
  }
}

// --- 5 · packaged distribution E2E -------------------------------------------
run("packaged .tgz E2E (fresh env, real bins)", "node scripts/packaged-e2e.mjs");

console.log("\n=========================================");
if (failures.length > 0) {
  console.error(`[gate] NOT RELEASABLE — ${failures.length} failed step(s):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`[gate] RELEASABLE — all ${step} steps passed`);
