import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, runDoctor } from "./doctor.js";
import { buildTemplates } from "../packaging/templateBuilder.js";
import { defaultTargetConfig, writeTargetConfig, writeTargetManifest } from "../targetcli/targetMeta.js";

const NOW = "2026-08-22T09:00:00Z";

let base: string;
let configPath: string;
let knowledgeRoot: string;
let projectRoot: string;

function gitInit(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sta-doctor-"));
  configPath = path.join(base, "installation.yaml");
  knowledgeRoot = path.join(base, "knowledge");
  projectRoot = path.join(base, "project");
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* left for the OS */
  }
});

const passingProbe = () => Promise.resolve({ available: true, version: "2.1.239 (test)" });
const failingProbe = () => Promise.resolve({ available: false, reason: "`claude` binary not found (test)" });

describe("runDoctor (T166)", () => {
  it("on a bare machine reports FAILs with actionable fixes and exits non-zero", async () => {
    const report = await runDoctor({ installationConfigPath: path.join(base, "missing.yaml"), probe: failingProbe });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName["Installation config (Knowledge root binding)"].status).toBe("FAIL");
    expect(byName["Installation config (Knowledge root binding)"].fix).toContain("configure knowledge-root");
    expect(byName["Runtime adapter (claude CLI)"].status).toBe("FAIL");
    // Skipped-by-scope checks are warnings, not failures — they don't block.
    expect(byName["Knowledge root standalone"].status).toBe("WARNING");
    expect(exitCodeFor(report)).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("passes every structural check on a fully configured three-repo fixture", async () => {
    gitInit(knowledgeRoot);
    // The doctor's "Framework installation" check validates only the live
    // `.agent-team/` layout. Writing a real `.agent-team/manifest.json` also
    // turns on "Managed asset freshness" (gated on `isTargetInitialized`),
    // which requires a real git Target, so this fixture is a real one too.
    gitInit(projectRoot);
    writeTargetManifest(projectRoot, { schema_version: 1, framework_version: "0.0.0-doctor-test", installed_at: NOW, updated_at: NOW, files: [] });
    writeTargetConfig(projectRoot, defaultTargetConfig("doctor-fixture", NOW));
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ command: "node block-git.js" }], Stop: [{}], SubagentStop: [{}] } }),
    );
    fs.writeFileSync(
      path.join(knowledgeRoot, "targets.yaml"),
      "schema_version: 1\ntargets:\n  - target_id: sb-web-helper\n    name: SB Web Helper\n    remote_url: https://github.com/Jabjai-Corporation/sb-web-helper.git\n    status: active\n",
    );
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`);
    // Managed asset freshness now runs for real (see above) — an empty
    // templates dir gives it nothing to plan against, matching how the other
    // fixture in this file avoids comparing a fixture framework_version
    // against this repo's real, unrelated templates snapshot.
    const templatesDir = path.join(base, "empty-templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.0.0-doctor-test", generated_at: NOW, files: [] }),
    );

    const report = await runDoctor({
      installationConfigPath: configPath,
      projectRoot,
      templatesDir,
      probe: passingProbe,
    });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName["V3 configuration"]).toMatchObject({
      status: "PASS",
      detail: expect.stringContaining("not configured — defaults apply"),
    });
    expect(byName["Installation config (Knowledge root binding)"].status).toBe("PASS");
    expect(byName["Knowledge root standalone"].status).toBe("PASS");
    expect(byName["Target registry (targets.yaml)"].status).toBe("PASS");
    // A registered target without a local mapping is usable-with-caveat.
    expect(byName["Local Target mappings (.workflow/targets.local.yaml)"].status).toBe("WARNING");
    expect(byName["Local Target mappings (.workflow/targets.local.yaml)"].fix).toMatch(/targets\.local\.yaml/);
    expect(byName["Runtime adapter (claude CLI)"].status).toBe("PASS");
    expect(exitCodeFor(report)).toBe(0);
  });

  it("reports pre-V3 omission as PASS and remains byte-for-byte read-only", async () => {
    gitInit(knowledgeRoot);
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "pre-v3", installed_at: NOW, updated_at: NOW, files: [] }),
    );
    fs.writeFileSync(path.join(projectRoot, ".sta", "config.yaml"), "schema_version: 1\n");
    fs.writeFileSync(path.join(knowledgeRoot, "targets.yaml"), "schema_version: 1\ntargets: []\n");
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`);
    const before = fs.readFileSync(path.join(projectRoot, ".sta", "config.yaml"));

    const report = await runDoctor({ projectRoot, installationConfigPath: configPath, probe: passingProbe });
    expect(report.checks.find((entry) => entry.name === "V3 configuration")).toMatchObject({
      status: "PASS",
      detail: expect.stringContaining("V3 config not configured — defaults apply"),
    });
    expect(fs.readFileSync(path.join(projectRoot, ".sta", "config.yaml"))).toEqual(before);
  });

  it("reports an invalid Knowledge schema as FAIL while naming the first problem", async () => {
    fs.mkdirSync(path.join(knowledgeRoot, ".workflow"), { recursive: true });
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\n`);
    // Items live one level down: <knowledge repo>/knowledge/<module|_project>/...
    fs.mkdirSync(path.join(knowledgeRoot, "knowledge", "_project", "requirement"), { recursive: true });
    fs.writeFileSync(path.join(knowledgeRoot, "knowledge", "_project", "requirement", "REQ-BROKEN.yaml"), "schema_version: 9\nid: REQ-1\nkind: requirement\n");

    const report = await runDoctor({ installationConfigPath: configPath, probe: passingProbe });
    const schema = report.checks.find((c) => c.name === "Knowledge schema (items load cleanly)")!;
    expect(schema.status).toBe("FAIL");
    expect(schema.detail).toMatch(/problem/);
    expect(schema.fix).toContain("--check-knowledge");
  });

  it("accepts an npm-installed framework package (no .git) as the Framework root — T168 clean-machine catch", async () => {
    // configureKnowledgeRoot must not demand a Git checkout when the CLI runs
    // from node_modules: end users install via npm, and there is no .git there.
    const { configureKnowledgeRoot } = await import("./installation.js");
    const pkgDir = path.join(base, "node_modules", "software-team-agents");
    fs.mkdirSync(path.join(pkgDir, "orchestrator", "dist"), { recursive: true }); // no .git anywhere
    gitInit(knowledgeRoot); // the Knowledge root itself must still be a standalone repo
    const config = configureKnowledgeRoot(knowledgeRoot, configPath, pkgDir);
    expect(config.knowledge_root).toBe(fs.realpathSync.native(knowledgeRoot));
  });

  it("never throws — a check that explodes lands as its own FAIL with the message attached", async () => {
    const explodingProbe = () => Promise.reject(new Error("probe exploded"));
    const report = await runDoctor({ installationConfigPath: path.join(base, "nope.yaml"), probe: explodingProbe });
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.ok).toBe(false);
  });

  it("T-V5-002 (characterization — red until T-V5-005): doctor in an .agent-team-only workspace runs its project checks and never prescribes sta init --force", async () => {
    // The workspace shape `software-team-agents init` produces:
    // .agent-team/{config.yaml,manifest.json}, no .sta/ anywhere, and the
    // machine's installation binding points at it (a BA Knowledge workspace).
    const workspace = path.join(base, "agent-team-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    gitInit(workspace);
    fs.mkdirSync(path.join(workspace, ".agent-team"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.0.0-doctor-test", installed_at: NOW, updated_at: NOW, files: [] }),
    );
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "config.yaml"),
      `schema_version: 1\ntarget_id: ${path.basename(workspace)}\nregistered_at: ${NOW}\nrole: ba\noverrides: []\n`,
    );
    fs.writeFileSync(path.join(workspace, "targets.yaml"), "schema_version: 1\ntargets: []\n");
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(workspace)}\n`);
    const templatesDir = path.join(base, "empty-templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // The obvious invocation: no --project-root, standing inside the workspace.
    const originalCwd = process.cwd();
    process.chdir(workspace);
    let report: Awaited<ReturnType<typeof runDoctor>>;
    try {
      report = await runDoctor({ installationConfigPath: configPath, templatesDir, probe: passingProbe });
    } finally {
      process.chdir(originalCwd);
    }

    // Collect every way today's output is wrong, so one red run names them all.
    const violations: string[] = [];
    for (const c of report.checks) {
      if ((c.detail ?? "").includes("no --project-root given")) violations.push(`check "${c.name}" skipped: ${c.detail}`);
      if (`${c.name}\n${c.detail ?? ""}\n${c.fix ?? ""}`.includes("sta init --force")) {
        violations.push(`check "${c.name}" prescribes the legacy destructive installer: ${c.fix ?? c.detail}`);
      }
    }
    if (!report.checks.some((c) => c.name === "Target profile (.agent-team/config.yaml stack)")) {
      violations.push("project-scoped Target profile check did not run at all");
    }
    expect(violations).toEqual([]);
  });

  it("T-V5-005: an instruction-surface path no command manages produces no Fix: line", async () => {
    const workspace = path.join(base, "opencode-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    gitInit(workspace);
    fs.mkdirSync(path.join(workspace, ".agent-team"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.0.0-doctor-test", installed_at: NOW, updated_at: NOW, files: [] }),
    );
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "config.yaml"),
      `schema_version: 1\ntarget_id: ${path.basename(workspace)}\nregistered_at: ${NOW}\nrole: ba\noverrides: []\n`,
    );
    fs.mkdirSync(path.join(workspace, ".opencode"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".opencode", "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.x"}}\n');
    fs.writeFileSync(configPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(workspace)}\n`);

    const report = await runDoctor({ projectRoot: workspace, installationConfigPath: configPath, probe: passingProbe });
    const entry = report.checks.find((c) => c.name === "Instruction surface: .opencode/package.json");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("PASS");
    expect(entry!.fix).toBeUndefined();
  });

  it("T-V5-022: zero warnings sourced from .agent-team/backups/ while genuine nested instructions still warn", async () => {
    const workspace = path.join(base, "backup-nested-ws");
    fs.mkdirSync(workspace, { recursive: true });
    gitInit(workspace);
    fs.mkdirSync(path.join(workspace, ".agent-team", "backups", "2026-09-01"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".agent-team", "backups", "2026-09-01", "AGENTS.md"), "# backup agents\n");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "AGENTS.md"), "# nested agents\n");
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.0.0-doctor-test", installed_at: NOW, updated_at: NOW, files: [] }),
    );
    fs.writeFileSync(
      path.join(workspace, ".agent-team", "config.yaml"),
      `schema_version: 1\ntarget_id: ${path.basename(workspace)}\nregistered_at: ${NOW}\nrole: dev\noverrides: []\n`,
    );

    const report = await runDoctor({ projectRoot: workspace, installationConfigPath: configPath, probe: passingProbe });
    const backupChecks = report.checks.filter((c) => c.name.includes(".agent-team/backups"));
    expect(backupChecks).toHaveLength(0);

    const nestedEntry = report.checks.find((c) => c.name === "Instruction surface: src/AGENTS.md");
    expect(nestedEntry).toBeDefined();
    expect(nestedEntry!.status).toBe("WARNING");
    expect(nestedEntry!.detail).toContain("may shadow or contradict the root bootstrap");
  });

  it("T-V5-005: the sta init --force remediation is replaced by the sync lifecycle everywhere", async () => {
    const report = await runDoctor({ installationConfigPath: path.join(base, "missing.yaml"), probe: passingProbe });
    for (const c of report.checks) {
      expect(`${c.name}\n${c.detail ?? ""}\n${c.fix ?? ""}`).not.toContain("sta init --force");
    }
  });

  it("T-V5-005: a cwd that is not an initialised workspace reports skipped-by-scope, not failures", async () => {
    const bare = path.join(base, "bare-directory");
    fs.mkdirSync(bare, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(bare);
    let report: Awaited<ReturnType<typeof runDoctor>>;
    try {
      report = await runDoctor({ installationConfigPath: path.join(base, "missing.yaml"), probe: passingProbe });
    } finally {
      process.chdir(originalCwd);
    }
    const scoped = report.checks.filter((c) => ["Framework installation", "State store (.workflow/state.db)", "Guard wiring (.claude/settings.json)", "V3 configuration"].includes(c.name));
    expect(scoped.length).toBe(4);
    for (const c of scoped) {
      expect(c.status).toBe("WARNING");
      expect(c.detail).toContain("is not an initialised workspace");
    }
  });

  it("T-V5-014: reports a stale Framework snapshot by source path and stays silent elsewhere", async () => {
    const framework = path.join(base, "framework");
    fs.mkdirSync(path.join(framework, ".git"), { recursive: true });
    fs.mkdirSync(path.join(framework, "orchestrator"), { recursive: true });
    fs.writeFileSync(path.join(framework, "orchestrator", "package.json"), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(framework, "CLAUDE.md"), "# snapshot v1\n");
    buildTemplates(framework, path.join(framework, "templates"), NOW);
    const builtBefore = fs.readFileSync(path.join(framework, "templates", "CLAUDE.md"), "utf8");
    fs.writeFileSync(path.join(framework, "CLAUDE.md"), "# snapshot v2\n");

    const stale = await runDoctor({ projectRoot: framework, installationConfigPath: path.join(base, "missing.yaml"), probe: passingProbe });
    expect(stale.checks.find((entry) => entry.name === "Template snapshot")).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("CLAUDE.md (changed)"),
    });
    expect(fs.readFileSync(path.join(framework, "templates", "CLAUDE.md"), "utf8")).toBe(builtBefore);

    buildTemplates(framework, path.join(framework, "templates"), NOW);
    const clean = await runDoctor({ projectRoot: framework, installationConfigPath: path.join(base, "missing.yaml"), probe: passingProbe });
    expect(clean.checks.find((entry) => entry.name === "Template snapshot")).toMatchObject({ status: "PASS" });

    const downstream = path.join(base, "downstream");
    fs.mkdirSync(downstream, { recursive: true });
    const outside = await runDoctor({ projectRoot: downstream, installationConfigPath: path.join(base, "missing.yaml"), probe: passingProbe });
    expect(outside.checks.some((entry) => entry.name === "Template snapshot")).toBe(false);
  });

  it("does not leak configuration file contents into any detail or fix text", async () => {
    const secretMarker = "SUPER_SECRET_TOKEN_VALUE_12345";
    fs.mkdirSync(path.join(knowledgeRoot, ".git"), { recursive: true });
    fs.writeFileSync(configPath, `version: 1\nknowledge_root: ${JSON.stringify(knowledgeRoot)}\ntoken: ${secretMarker}\n`);
    const report = await runDoctor({ installationConfigPath: configPath, probe: passingProbe });
    for (const c of report.checks) {
      expect(`${c.detail ?? ""}${c.fix ?? ""}`).not.toContain(secretMarker);
    }
  });
});
