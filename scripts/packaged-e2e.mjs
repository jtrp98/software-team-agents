#!/usr/bin/env node
/**
 * T-V1-06 / T-V1-07 — packaged-distribution E2E: the release artifact is
 * installed into a fresh environment and driven through its real bin surface.
 * Everything here runs against the packed `.tgz`, never the source checkout —
 * a packaging mistake (missing file, broken bin, bad manifest, unresolved
 * path) must fail HERE, not at some user's first `init`.
 *
 *   npm pack → .tgz → fresh env → npm install
 *     → --version (both CLIs) → configure knowledge-root
 *     → init (detected) → repeated init → status → sync no-change
 *     → modified managed file → conflict → force sync + backup
 *     → invalid workspace → session without a Knowledge binding reaches the
 *       runtime probe (V10 TASK-027)
 *     → launch surface with the runtime binary absent
 *
 * Determinism on a configured machine: every child runs with
 * STA_INSTALLATION_CONFIG pointed inside the temp environment, so the
 * machine's real installation.yaml is never consulted (see
 * `defaultInstallationConfigPath`). STA_TEST_HARNESS=1 rides along as the
 * explicit harness contract that lets the children accept that override (the
 * internal test/E2E channel of DR §9, package B — undeclared production
 * invocations refuse it). Paths deliberately contain spaces — the
 * quoting is part of what T-V1-07 asks this script to prove on Windows.
 *
 * The full launch of a real agent against real credentials is T-V1-15's
 * dogfood, not this script's: here "launch" proves the artifact's preflight,
 * binding resolution and runtime-probe diagnostics work end to end up to the
 * runtime boundary, and stop there honestly.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installPackedWithRetry } from "./packed-install-retry.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const RETIRED_COMPILED_PATHS = [
  "orchestrator/dist/packaging/initCommand.js",
  "orchestrator/dist/packaging/initCommand.test.js",
  "orchestrator/dist/packaging/upgradeCommand.js",
  "orchestrator/dist/packaging/upgradeCommand.test.js",
  "orchestrator/dist/routing/routingPolicy.js",
  "orchestrator/dist/run/eligibility.js",
  "orchestrator/dist/run/eligibility.test.js",
  "orchestrator/dist/run/killWaveFixture.test.js",
  "orchestrator/dist/run/recovery.js",
  "orchestrator/dist/run/recovery.test.js",
  "orchestrator/dist/run/waveRunner.js",
  "orchestrator/dist/run/waveRunner.test.js",
];

let step = 0;
let failures = 0;
function ok(name) {
  step += 1;
  console.log(`[e2e] ${String(step).padStart(2, "0")} ok — ${name}`);
}
function fail(name, detail) {
  step += 1;
  failures += 1;
  console.error(`[e2e] ${String(step).padStart(2, "0")} FAIL — ${name}\n${detail}`);
}

function expectCond(name, condition, detail = "") {
  if (condition) ok(name);
  else fail(name, detail);
}

function npm(args, cwd) {
  const isWin = process.platform === "win32";
  const quoted = isWin ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  return execFileSync(isWin ? "npm.cmd" : "npm", quoted, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
    shell: isWin,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Quotes one token for a shell command line (our args never embed quotes). */
function q(token) {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** Runs one of the installed bins through the shell, exactly like a user would. */
function runBin(binPath, args, options = {}) {
  const res = spawnSync([binPath, ...args].map(q).join(" "), {
    cwd: options.cwd,
    encoding: "utf8",
    shell: true,
    timeout: options.timeoutMs ?? 120_000,
    env: options.env,
    input: "",
  });
  return { status: res.status, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

// --- 0 · preflight -----------------------------------------------------------

if (!fs.existsSync(path.join(repoRoot, "orchestrator", "dist", "cli.js"))) {
  console.error("[e2e] orchestrator/dist missing — run `npm run build` first (or use `npm run release`)");
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sta-packaged-e2e-"));
const npmCache = path.join(stage, "npm-cache");
fs.mkdirSync(npmCache, { recursive: true });
console.log(`[e2e] stage: ${stage}`);

try {
  // --- 1 · pack the real artifact -------------------------------------------
  let tgz;
  try {
    npm(["pack", "--pack-destination", stage], repoRoot);
    tgz = path.join(stage, `${pkg.name}-${pkg.version}.tgz`);
    expectCond("npm pack produced the artifact", fs.existsSync(tgz), tgz);
  } catch (e) {
    fail("npm pack", String(e));
  }
  if (!tgz || !fs.existsSync(tgz)) process.exit(1);

  // --- 2 · fresh-environment install ----------------------------------------
  const fresh = path.join(stage, "fresh env");
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, "package.json"), JSON.stringify({ name: "fresh-env", private: true }, null, 2));
  try {
    installPackedWithRetry(npm, fresh, tgz, "e2e");
    ok(`npm install <tgz> into "${path.basename(fresh)}" (path contains a space)`);
  } catch (e) {
    fail("npm install <tgz>", String(e));
    process.exit(1);
  }

  const pkgDir = path.join(fresh, "node_modules", "software-team-agents");
  const binDir = path.join(fresh, "node_modules", ".bin");
  const staBin = path.join(binDir, process.platform === "win32" ? "sta.cmd" : "sta");
  const targetBin = path.join(binDir, process.platform === "win32" ? "software-team-agents.cmd" : "software-team-agents");

  const retiredStillShipped = RETIRED_COMPILED_PATHS.filter((rel) => fs.existsSync(path.join(pkgDir, ...rel.split("/"))));
  expectCond(
    "shipped payload excludes every retired wave-lifecycle module",
    retiredStillShipped.length === 0,
    retiredStillShipped.join("\n"),
  );

  // --- fixtures (spaces everywhere on purpose) -------------------------------
  const knowledgeRepo = path.join(stage, "Knowledge Repo");
  const targetRepo = path.join(stage, "Target App");
  for (const dir of [knowledgeRepo, targetRepo]) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRepo, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(knowledgeRepo, "targets.yaml"), "schema_version: 1\ntargets: []\n");
  fs.writeFileSync(
    path.join(targetRepo, "package.json"),
    JSON.stringify({ name: "target-app", version: "0.1.0", scripts: { build: "tsc", test: "node --test" } }),
  );
  fs.writeFileSync(path.join(targetRepo, "package-lock.json"), JSON.stringify({ name: "target-app", lockfileVersion: 3 }));
  fs.mkdirSync(path.join(targetRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(targetRepo, "src", "index.ts"), 'export const app = () => "hello";\n');

  const installationConfig = path.join(stage, "installation.yaml");
  // STA_TEST_HARNESS is the explicit packaged-E2E contract (DR §9, package B):
  // the child CLI refuses an undeclared STA_INSTALLATION_CONFIG override.
  const baseEnv = { ...process.env, STA_INSTALLATION_CONFIG: installationConfig, STA_TEST_HARNESS: "1" };

  // --- 3 · version consistency ----------------------------------------------
  for (const [label, bin] of [["sta", staBin], ["software-team-agents", targetBin]]) {
    const r = runBin(bin, ["--version"], { env: baseEnv });
    expectCond(`${label} --version reports ${pkg.version}`, r.status === 0 && r.out.trim().includes(pkg.version), r.out);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "templates", "manifest.json"), "utf8"));
  expectCond(
    "shipped manifest version matches the package version",
    manifest.framework_version === pkg.version,
    `manifest=${manifest.framework_version} package=${pkg.version}`,
  );

  // --- 3b · root prompt files ship and are readable (T-V2R-14) ---------------
  for (const [file, marker] of [
    ["prompt-setup.md", "prompt-setup.md"],
    ["prompt-update-knowledge.md", "prompt-update-knowledge.md"],
  ]) {
    const p = path.join(pkgDir, file);
    const shipped = fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(marker);
    expectCond(`shipped payload contains readable ${file}`, shipped, p);
  }

  // --- 4 · no Knowledge binding needed: the workspace IS the Knowledge root (V10 TASK-027/026)
  // The preflight is per session: a session opened with the single entry
  // command from its own Knowledge workspace needs no binding. The first hard
  // failure left on this path is the runtime probe — PATH is stripped so that
  // failure is deterministic and nothing launches.
  const missingConfigEnv = { ...baseEnv, STA_INSTALLATION_CONFIG: path.join(stage, "does-not-exist.yaml") };
  {
    const nodeDir = path.dirname(process.execPath);
    const pathSep = process.platform === "win32" ? ";" : ":";
    const stripped = { ...missingConfigEnv, PATH: [nodeDir, process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"].join(pathSep) };
    const r = runBin(targetBin, ["open"], { cwd: knowledgeRepo, env: stripped, timeoutMs: 180_000 });
    expectCond(
      "open without any Knowledge binding reaches the runtime probe instead of refusing on Knowledge",
      r.status !== 0 && /[Rr]untime \(claude\)/.test(r.out),
      r.out.slice(-800),
    );
  }

  // --- 5 · bind Knowledge through the real CLI ------------------------------
  {
    const r = runBin(staBin, ["configure", "knowledge-root", knowledgeRepo], { env: baseEnv });
    expectCond("sta configure knowledge-root binds the Knowledge repo", r.status === 0 && fs.existsSync(installationConfig), r.out);
  }

  // --- 6 · init: detected role, idempotent repeat ---------------------------
  {
    const first = runBin(targetBin, ["init"], { cwd: targetRepo, env: baseEnv });
    expectCond("init detects the Target as DEV and materializes managed assets", first.status === 0 && /DEV/i.test(first.out), first.out);
    expectCond("init shipped guard wiring (.claude/settings.json)", fs.existsSync(path.join(targetRepo, ".claude", "settings.json")));
    const second = runBin(targetBin, ["init"], { cwd: targetRepo, env: baseEnv });
    expectCond("repeated init succeeds and reports re-initialization", second.status === 0 && /re-initialized/i.test(second.out), second.out);
  }

  // --- 7 · status: machine-readable, current --------------------------------
  let backupDirFromOutput = null;
  {
    const r = runBin(targetBin, ["status", "--json"], { cwd: targetRepo, env: baseEnv });
    expectCond("status --json exits 0", r.status === 0, r.out);
    let parsed = null;
    try {
      parsed = JSON.parse(r.out);
    } catch {
      /* handled below */
    }
    expectCond(
      "status reports role dev, UP_TO_DATE sync and the installed Framework version",
      parsed && parsed.role === "dev" && parsed.syncState === "UP_TO_DATE" && parsed.frameworkVersion === pkg.version,
      JSON.stringify(parsed)?.slice(0, 400),
    );
  }

  // --- 8 · sync no-change ----------------------------------------------------
  {
    const r = runBin(targetBin, ["sync"], { cwd: targetRepo, env: baseEnv });
    expectCond("sync with no changes exits 0", r.status === 0, r.out);
  }

  // --- 9 · modified managed file → conflict → force + backup -----------------
  {
    const managed = path.join(targetRepo, ".claude", "agents", "backend-engineer.md");
    expectCond("managed role definition exists after init", fs.existsSync(managed), managed);
    fs.appendFileSync(managed, "\n<!-- local edit -->\n");
    const conflict = runBin(targetBin, ["sync"], { cwd: targetRepo, env: baseEnv });
    expectCond(
      "sync stops on the locally-modified managed file (exit 2, recovery advice)",
      conflict.status === 2 && /local modifications|force/i.test(conflict.out),
      conflict.out.slice(0, 600),
    );
    const forced = runBin(targetBin, ["sync", "--force"], { cwd: targetRepo, env: baseEnv });
    backupDirFromOutput = /backed up in (.+)/.exec(forced.out)?.[1]?.trim() ?? null;
    expectCond(
      "forced sync overwrites (backed up first)",
      forced.status === 0 && !forced.out.includes("local edit") && backupDirFromOutput !== null && fs.existsSync(backupDirFromOutput),
      forced.out.slice(0, 600),
    );
    const restored = fs.readFileSync(managed, "utf8");
    expectCond("the local edit was replaced by the shipped content", !restored.includes("local edit"));
  }

  // --- 10 · invalid workspace -------------------------------------------------
  {
    // Has the standalone-repo marker but neither Knowledge nor app-source
    // markers, so role *detection* is what must refuse — with guidance that
    // does not name the retired --role flag (V10 TASK-026).
    const nowhere = path.join(stage, "Not A Workspace");
    fs.mkdirSync(path.join(nowhere, ".git"), { recursive: true });
    const r = runBin(targetBin, ["init"], { cwd: nowhere, env: baseEnv });
    expectCond(
      "init in a marker-less directory refuses and points at the Knowledge workspace",
      r.status !== 0 && /neither Knowledge markers/i.test(r.out),
      r.out.slice(0, 400),
    );
  }

  // --- 10b · retired two-lane names are caught, not aliased (V10 TASK-026) ----
  {
    for (const retired of ["ba", "dev"]) {
      const r = runBin(targetBin, [retired], { cwd: knowledgeRepo, env: baseEnv });
      expectCond(
        `${retired} exits non-zero naming the replacement command`,
        r.status === 64 && r.out.includes(`'${retired}' was retired in V10`) && r.out.includes("software-team-agents open"),
        r.out.slice(0, 400),
      );
    }
    const warned = runBin(targetBin, ["init", "--role", "ba"], { cwd: knowledgeRepo, env: baseEnv });
    expectCond(
      "--role is accepted and ignored with a warning",
      warned.status === 0 && /--role is retired and ignored/i.test(warned.out),
      warned.out.slice(0, 400),
    );
  }

  // --- 11 · launch surface with the runtime binary absent ---------------------
  // Minimal PATH so `claude` cannot exist here: preflight must reach the probe
  // through bindings and managed files, then report the runtime honestly —
  // never hang, never half-launch.
  {
    const nodeDir = path.dirname(process.execPath);
    const pathSep = process.platform === "win32" ? ";" : ":";
    const strippedEnv = { ...baseEnv, PATH: [nodeDir, process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"].join(pathSep) };
    const absent = spawnSync("claude --version", { shell: true, env: strippedEnv, encoding: "utf8" });
    expectCond("guard: `claude` is genuinely unreachable under the stripped PATH", absent.status !== 0, `status ${absent.status}`);
    const r = runBin(targetBin, ["open"], { cwd: knowledgeRepo, env: strippedEnv, timeoutMs: 180_000 });
    expectCond(
      "open with the runtime binary absent fails closed naming the runtime",
      r.status !== 0 && /[Rr]untime \(claude\)/.test(r.out),
      r.out.slice(-800),
    );
  }
} finally {
  if (failures === 0) {
    fs.rmSync(stage, { recursive: true, force: true });
    console.log("[e2e] stage cleaned");
  } else {
    console.log(`[e2e] stage kept for inspection: ${stage}`);
  }
}

if (failures > 0) {
  console.error(`[e2e] FAILED: ${failures} step(s)`);
  process.exit(1);
}
console.log("[e2e] all steps passed — the packaged artifact works without the Framework source repo");
