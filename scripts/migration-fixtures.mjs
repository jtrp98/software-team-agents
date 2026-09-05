#!/usr/bin/env node
/**
 * T-V3R-072 — four compatibility fixtures driven only through a packed install.
 * Every path and installation config is isolated under a temporary directory
 * whose name contains spaces; the user's machine-wide configuration is never read.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sta-v3-migrations-"));
const stage = path.join(tempRoot, "Four Migration Fixtures With Spaces");
const npmCache = path.join(tempRoot, "npm-cache");
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(npmCache, { recursive: true });

let failures = 0;
let assertions = 0;

function q(token) {
  return /\s/.test(token) ? `"${token}"` : token;
}

function npm(args, cwd) {
  const win = process.platform === "win32";
  const argv = win ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args;
  return execFileSync(win ? "npm.cmd" : "npm", argv, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
    shell: win,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runBin(bin, args, options = {}) {
  const result = spawnSync([bin, ...args].map(q).join(" "), {
    cwd: options.cwd ?? stage,
    encoding: "utf8",
    env: options.env,
    shell: true,
    timeout: options.timeoutMs ?? 180_000,
    input: "",
  });
  return { status: result.status, out: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function assertFixture(condition, message, detail = "") {
  assertions += 1;
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ""}`);
}

function fixtureEnv(root) {
  return {
    ...process.env,
    AGENTCLAUDE_INSTALLATION_CONFIG: path.join(root, "Sandboxed Installation Config", "installation.yaml"),
  };
}

function gitRepo(root) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}

function knowledgeRepo(root) {
  gitRepo(root);
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(root, "_docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(root, "knowledge-policy.yaml"), "version: 1\n", "utf8");
  fs.writeFileSync(path.join(root, "targets.yaml"), "schema_version: 1\ntargets: []\n", "utf8");
}

function targetRepo(root) {
  gitRepo(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const fixture = true;\n", "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "migration-fixture", private: true, scripts: { build: "tsc", test: "node --test" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "migration-fixture", lockfileVersion: 3 }), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeSnapshot(root) {
  const snapshot = new Map();
  function walk(dir, relDir = "") {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = relDir ? `${relDir}/${name}` : name;
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) {
        snapshot.set(`${relative}/`, "dir");
        walk(absolute, relative);
      } else {
        snapshot.set(relative, sha256(fs.readFileSync(absolute)));
      }
    }
  }
  walk(root);
  return snapshot;
}

function sameSnapshot(left, right) {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

async function runFixture(name, body) {
  console.log(`\n[fixture] START ${name}`);
  try {
    const evidence = await body();
    console.log(`[fixture] PASS  ${name} — ${evidence}`);
  } catch (error) {
    failures += 1;
    console.error(`[fixture] FAIL  ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

if (!fs.existsSync(path.join(repoRoot, "orchestrator", "dist", "cli.js"))) {
  console.error("[fixture] orchestrator/dist missing — run npm run build first");
  process.exit(1);
}

let tgz;
let installRoot;
try {
  npm(["pack", "--silent", "--pack-destination", stage], repoRoot);
  tgz = path.join(stage, `${pkg.name}-${pkg.version}.tgz`);
  assertFixture(fs.existsSync(tgz), "npm pack did not produce the expected .tgz", tgz);

  installRoot = path.join(stage, "Packed Package Installation");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "package.json"), JSON.stringify({ name: "migration-harness", private: true }, null, 2));
  npm(["install", "--no-audit", "--no-fund", "--loglevel=error", tgz], installRoot);

  const packageRoot = path.join(installRoot, "node_modules", "software-team-agents");
  const binRoot = path.join(installRoot, "node_modules", ".bin");
  const staBin = path.join(binRoot, process.platform === "win32" ? "sta.cmd" : "sta");
  const targetBin = path.join(binRoot, process.platform === "win32" ? "software-team-agents.cmd" : "software-team-agents");

  const [{ Orchestrator }, { classifyTask }, { SqliteTaskStore }, { ArtifactType }, { ApprovalType }, { runDoctor }, targetMeta, DatabaseModule] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "orchestrator", "orchestrator.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "classification", "taskClassifier.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "store", "sqliteStore.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "artifacts", "schemas.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "gates", "approval.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "threeRepo", "doctor.js"))),
    import(pathToFileURL(path.join(packageRoot, "orchestrator", "dist", "targetcli", "targetMeta.js"))),
    import(pathToFileURL(path.join(installRoot, "node_modules", "better-sqlite3", "lib", "index.js"))),
  ]);
  const Database = DatabaseModule.default;

  function executorFor(taskId, stages) {
    return (request) => {
      stages.push(request.stage);
      if (request.stage === "qa-engineer") {
        return {
          outcome: { tokens: 1, cost: 0, result: "PASS" },
          artifactType: ArtifactType.QA_REPORT,
          artifact: {
            taskId,
            status: "PASS",
            mode: "FULL",
            requirements: { "REQ-FIXTURE": "PASS" },
            tests: { passed: 1, failed: 0 },
            evidence: ["packed migration fixture"],
            risks: [],
            hasAutomatedTests: true,
            unverifiedBehaviour: [],
          },
        };
      }
      return { outcome: { tokens: 1, cost: 0, result: "PASS" } };
    };
  }

  async function driveToTerminal(orchestrator, executor) {
    for (let index = 0; index < 30; index += 1) {
      const status = await orchestrator.step(executor);
      if (status.kind === "WAITING_FOR_HUMAN") {
        const field = status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved";
        orchestrator.provideHumanApproval(field, true);
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
    }
    throw new Error("task did not reach a terminal state within 30 steps");
  }

  await runFixture("existing Knowledge", async () => {
    const root = path.join(stage, "01 Existing Knowledge Fixture");
    const knowledge = path.join(root, "Existing Knowledge Repo");
    const target = path.join(root, "Existing Target App");
    knowledgeRepo(knowledge);
    targetRepo(target);
    const env = fixtureEnv(root);
    const configured = runBin(staBin, ["configure", "knowledge-root", knowledge], { cwd: packageRoot, env });
    assertFixture(configured.status === 0, "could not bind existing Knowledge", configured.out);
    const initialized = runBin(targetBin, ["init"], { cwd: target, env });
    assertFixture(initialized.status === 0, "could not initialize companion Target", initialized.out);

    const before = treeSnapshot(knowledge);
    const store = new SqliteTaskStore(path.join(target, ".workflow", "state.db"));
    const taskId = "T-V3R-072-KNOWLEDGE";
    const orchestrator = new Orchestrator(taskId, classifyTask({ isClearBugFix: true, touchesBackend: true }), { store });
    const stages = [];
    const terminal = await driveToTerminal(orchestrator, executorFor(taskId, stages));
    store.close();
    const after = treeSnapshot(knowledge);

    assertFixture(terminal.kind === "DEPLOYED", "packed full run did not deploy", JSON.stringify(terminal));
    assertFixture(sameSnapshot(before, after), "the full run changed the existing Knowledge tree");
    assertFixture(!fs.existsSync(path.join(knowledge, ".workflow", "packets")), "runtime packets appeared in Knowledge");
    assertFixture(!fs.existsSync(path.join(knowledge, ".workflow", "evidence")), "runtime evidence appeared in Knowledge");
    return `packed task ran ${stages.join(" -> ")}; Knowledge snapshot unchanged (${before.size} entries)`;
  });

  await runFixture("existing Target", async () => {
    const root = path.join(stage, "02 Existing Target Fixture");
    const knowledge = path.join(root, "Knowledge Repo");
    const target = path.join(root, "Untouched Pre V3 Target");
    knowledgeRepo(knowledge);
    targetRepo(target);
    const env = fixtureEnv(root);
    assertFixture(runBin(staBin, ["configure", "knowledge-root", knowledge], { cwd: packageRoot, env }).status === 0, "Knowledge bind failed");
    const initialized = runBin(targetBin, ["init"], { cwd: target, env });
    assertFixture(initialized.status === 0, "Target init failed", initialized.out);

    const preV3 = targetMeta.loadTargetConfig(target);
    targetMeta.writeTargetConfig(target, { ...preV3, execution: undefined, overrides: ["README.local.md"] });
    const configBefore = fs.readFileSync(targetMeta.targetConfigPath(target));
    const cleanSync = runBin(targetBin, ["sync"], { cwd: target, env });
    assertFixture(cleanSync.status === 0, "untouched pre-V3 Target did not sync", cleanSync.out);
    const statusRun = runBin(targetBin, ["status", "--json"], { cwd: target, env });
    const status = statusRun.status === 0 ? JSON.parse(statusRun.out) : undefined;
    assertFixture(status?.conflictCount === 0, "untouched Target reported conflicts", statusRun.out);
    assertFixture(status?.v3Configuration?.configured === false, "pre-V3 omission was not reported as defaults", statusRun.out);
    assertFixture(fs.readFileSync(targetMeta.targetConfigPath(target)).equals(configBefore), "sync rewrote the pre-V3 config");
    assertFixture(targetMeta.loadTargetConfig(target).overrides.includes("README.local.md"), "overrides did not survive sync");

    const managed = path.join(target, ".claude", "agents", "backend-engineer.md");
    fs.appendFileSync(managed, "\n<!-- retained local edit -->\n", "utf8");
    const conflict = runBin(targetBin, ["sync"], { cwd: target, env });
    assertFixture(conflict.status === 2, "edited managed file did not conflict", conflict.out);
    assertFixture(fs.readFileSync(managed, "utf8").includes("retained local edit"), "non-force sync overwrote the local edit");
    const forced = runBin(targetBin, ["sync", "--force"], { cwd: target, env });
    assertFixture(forced.status === 0, "explicit force sync failed", forced.out);
    const backupsRoot = path.join(target, ".agent-team", "backups");
    const backupFiles = fs.readdirSync(backupsRoot).flatMap((name) => {
      const candidate = path.join(backupsRoot, name, ".claude", "agents", "backend-engineer.md");
      return fs.existsSync(candidate) ? [candidate] : [];
    });
    assertFixture(backupFiles.some((file) => fs.readFileSync(file, "utf8").includes("retained local edit")), "force sync did not back up the edited bytes");
    return `zero clean conflicts; override retained; conflict exit 2; ${backupFiles.length} backup copy/copies verified`;
  });

  await runFixture("fresh installation", async () => {
    const root = path.join(stage, "03 Fresh Installation Fixture");
    const knowledge = path.join(root, "Fresh Knowledge Repo");
    const target = path.join(root, "Fresh Target App");
    gitRepo(knowledge);
    targetRepo(target);
    const env = fixtureEnv(root);

    const initKnowledge = runBin(staBin, ["init", "--mode", "three-repo", "--project-root", knowledge], { env });
    assertFixture(initKnowledge.status === 0, "fresh Knowledge init failed", initKnowledge.out);
    const bind = runBin(staBin, ["configure", "knowledge-root", knowledge], { cwd: packageRoot, env });
    assertFixture(bind.status === 0 && fs.existsSync(env.AGENTCLAUDE_INSTALLATION_CONFIG), "fresh bind failed", bind.out);
    const initTarget = runBin(targetBin, ["init"], { cwd: target, env });
    assertFixture(initTarget.status === 0, "fresh Target init failed", initTarget.out);
    const sync = runBin(targetBin, ["sync"], { cwd: target, env });
    assertFixture(sync.status === 0, "fresh Target sync failed", sync.out);
    const statusRun = runBin(targetBin, ["status", "--json"], { cwd: target, env });
    const status = statusRun.status === 0 ? JSON.parse(statusRun.out) : undefined;
    assertFixture(status?.syncState === "UP_TO_DATE" && status?.conflictCount === 0, "fresh status was not ready", statusRun.out);
    assertFixture(status?.v3Configuration?.detail?.includes("defaults apply"), "fresh defaults were not reported", statusRun.out);
    return "init -> bind -> Target init/sync -> status UP_TO_DATE, using sandboxed installation config";
  });

  // T-V5-038 — the `sta init --mode legacy-project` / `sta upgrade --mode
  // legacy-project` verbs this fixture used to drive are retired. The DB
  // schema-migration property this fixture proves was never actually caused
  // by those CLI calls (`SqliteTaskStore`'s own migration runs on open,
  // in-process, independent of any installer verb) — the legacy-project
  // calls only ever built the fixture's `.sta/` scaffolding around it. This
  // fixture now builds that scaffolding directly, and also proves doctor
  // still reads a hand-authored pre-V3 `.sta/config.yaml` (the config-read
  // path T-V5-040 owns, not this task; left untouched).
  await runFixture("upgrade (DB schema compatibility across the retired legacy installer)", async () => {
    const root = path.join(stage, "04 DB Migration Fixture");
    const knowledge = path.join(root, "Upgrade Knowledge Repo");
    const project = path.join(root, "Pre V3 Project");
    knowledgeRepo(knowledge);
    targetRepo(project);

    const env = fixtureEnv(root);
    const configured = runBin(staBin, ["configure", "knowledge-root", knowledge], { cwd: packageRoot, env });
    assertFixture(configured.status === 0, "upgrade fixture bind failed", configured.out);
    // A hand-authored pre-V3 `.sta/config.yaml` — no manifest.json alongside
    // it, so this is deliberately not an "installed" workspace by any
    // installer, live or retired; it only exercises doctor's config read.
    fs.mkdirSync(path.join(project, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(project, ".sta", "config.yaml"), "schema_version: 1\n", "utf8");
    const doctor = await runDoctor({
      projectRoot: project,
      installationConfigPath: env.AGENTCLAUDE_INSTALLATION_CONFIG,
      templatesDir: path.join(packageRoot, "templates"),
      probe: async () => ({ available: true, version: "fixture" }),
      capabilities: async () => ({ runtimeId: "claude-code", verified: [], unverified: [], missingRequired: [], fallbacks: [] }),
    });
    const doctorCheck = doctor.checks.find((entry) => entry.name === "V3 configuration");
    const doctorTranscript = `${doctorCheck?.status ?? "MISSING"} V3 configuration — ${doctorCheck?.detail ?? "missing"}`;
    assertFixture(doctorCheck?.status === "PASS" && doctorCheck.detail?.includes("not configured — defaults apply"), "pre-V3 doctor was not a PASS", doctorTranscript);

    const dbPath = path.join(project, ".workflow", "state.db");
    const taskId = "T-V3R-072-UPGRADE";
    const seedStore = new SqliteTaskStore(dbPath);
    const orchestrator = new Orchestrator(taskId, classifyTask({ isClearBugFix: true, touchesBackend: true }), { store: seedStore });
    await orchestrator.step(executorFor(taskId, []));
    seedStore.close();

    const legacyDb = new Database(dbPath);
    const row = legacyDb.prepare("SELECT state FROM tasks WHERE task_id = ?").get(taskId);
    const legacyTask = JSON.parse(row.state);
    delete legacyTask.runtimeTask;
    legacyDb.prepare("UPDATE tasks SET state = ? WHERE task_id = ?").run(JSON.stringify(legacyTask), taskId);
    for (const column of ["requested_runtime", "requested_model", "routing_basis", "fallback_reason", "fallback_count", "qa_effort", "estimated_input_tokens", "effort"]) {
      legacyDb.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    }
    legacyDb.pragma("user_version = 11");
    legacyDb.close();

    // Reopening the store — not any installer verb — is what performs the
    // migration; this is the property this fixture exists to prove.
    const migratedStore = new SqliteTaskStore(dbPath);
    const resumed = Orchestrator.resume(taskId, migratedStore);
    const resumedStages = [];
    const terminal = await driveToTerminal(resumed, executorFor(taskId, resumedStages));
    migratedStore.close();
    const versionDb = new Database(dbPath, { readonly: true });
    const migratedVersion = Number(versionDb.pragma("user_version", { simple: true }));
    versionDb.close();
    assertFixture(migratedVersion >= 16, "v11 DB did not traverse the required v16 compatibility step", String(migratedVersion));
    assertFixture(resumedStages[0] === "qa-engineer" && terminal.kind === "DEPLOYED", "task did not resume at its pre-upgrade stage", resumedStages.join(" -> "));

    return `doctor PASS reading pre-V3 .sta/config.yaml; DB v11 traversed to current v${migratedVersion}; resumed ${resumedStages.join(" -> ")}`;
  });

  // T-V5-038 acceptance: removed verbs error naming the replacement rather
  // than vanishing, and a `.sta/`-only workspace (as if installed by a
  // pre-T-V5-038 release, never touched by any installer this build ships)
  // converts to `.agent-team/` with no content loss.
  await runFixture("legacy .sta/ retirement: removed verbs + zero-loss conversion", async () => {
    const root = path.join(stage, "05 Legacy Sta Retirement Fixture");
    const knowledge = path.join(root, "Retirement Knowledge Repo");
    const project = path.join(root, "Legacy Sta Only Project");
    knowledgeRepo(knowledge);
    targetRepo(project);
    const env = fixtureEnv(root);
    assertFixture(runBin(staBin, ["configure", "knowledge-root", knowledge], { cwd: packageRoot, env }).status === 0, "bind failed");

    const legacyInit = runBin(staBin, ["init", "--mode", "legacy-project", "--project-root", project], { env });
    assertFixture(
      legacyInit.status !== 0 && /software-team-agents init/.test(legacyInit.out),
      "removed `sta init --mode legacy-project` did not error naming the replacement",
      legacyInit.out,
    );
    const legacyUpgrade = runBin(staBin, ["upgrade", "--mode", "legacy-project", "--project-root", project], { env });
    assertFixture(
      legacyUpgrade.status !== 0 && /software-team-agents init/.test(legacyUpgrade.out),
      "removed `sta upgrade --mode legacy-project` did not error naming the replacement",
      legacyUpgrade.out,
    );

    // Simulate a workspace a pre-T-V5-038 release left on `.sta/`: real
    // project source (from `targetRepo`) plus a `.sta/` manifest+config no
    // installer in this build ever wrote.
    fs.mkdirSync(path.join(project, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".sta", "manifest.json"),
      JSON.stringify({
        schema_version: 1,
        framework_version: "2.9.0-pre-v5-038",
        installed_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: [],
      }, null, 2),
    );
    fs.writeFileSync(path.join(project, ".sta", "config.yaml"), "schema_version: 1\n", "utf8");

    const beforeSource = {
      index: fs.readFileSync(path.join(project, "src", "index.ts")),
      pkg: fs.readFileSync(path.join(project, "package.json")),
    };

    const convert = runBin(targetBin, ["init"], { cwd: project, env });
    assertFixture(convert.status === 0, ".sta/-only workspace did not convert cleanly via software-team-agents init", convert.out);
    assertFixture(fs.existsSync(path.join(project, ".agent-team", "manifest.json")), "conversion did not produce .agent-team/manifest.json");

    const afterSource = {
      index: fs.readFileSync(path.join(project, "src", "index.ts")),
      pkg: fs.readFileSync(path.join(project, "package.json")),
    };
    assertFixture(beforeSource.index.equals(afterSource.index), "the project's own src/index.ts was not byte-identical after conversion — content lost");
    assertFixture(beforeSource.pkg.equals(afterSource.pkg), "the project's own package.json was not byte-identical after conversion — content lost");
    // The legacy .sta/ scaffolding itself is untouched (T-V5-038 removed the
    // installer, not any reader of an existing .sta/ directory).
    assertFixture(fs.existsSync(path.join(project, ".sta", "manifest.json")), "conversion deleted the legacy .sta/manifest.json");

    return `removed verbs both errored naming the replacement; .sta/-only workspace converted to .agent-team/ with its real project source (src/index.ts, package.json) byte-identical`;
  });
} catch (error) {
  failures += 1;
  console.error(`[fixture] HARNESS FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}

if (failures === 0) {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    // Windows can retain a short-lived native SQLite/npm handle after every
    // assertion has passed. Cleanup is best-effort and never fixture evidence.
    console.warn(`[fixture] cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`\n[fixture] ALL FIVE PASSED — ${assertions} assertions; packed .tgz; paths with spaces; sandboxed installation config`);
} else {
  console.error(`\n[fixture] ${failures} failure(s); stage kept for inspection: ${stage}`);
  process.exit(1);
}
