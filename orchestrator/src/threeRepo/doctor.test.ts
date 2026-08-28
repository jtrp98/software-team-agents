import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, runDoctor } from "./doctor.js";

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
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.0.0-doctor-test", installed_at: NOW, updated_at: NOW, files: [] }),
    );
    fs.writeFileSync(path.join(projectRoot, ".sta", "config.yaml"), "schema_version: 1\n");
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

    const report = await runDoctor({
      installationConfigPath: configPath,
      projectRoot,
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
