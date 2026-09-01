import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { runInit } from "./initCommand.js";
import { validateInstallation } from "./installValidation.js";
import { runTargetSync } from "../targetcli/syncEngine.js";
import { defaultTargetConfig, writeTargetConfig } from "../targetcli/targetMeta.js";

const roots: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  }
}

function fixtureTemplatesDir(): string {
  const source = tmpDir("sta-validate-source-");
  writeFiles(source, {
    "CLAUDE.md": "# rules\n",
    "layout.yaml": "version: 1\n",
    "orchestrator/package.json": JSON.stringify({ name: "@agentclaude/orchestrator", version: "0.1.0" }),
  });
  const templatesDir = path.join(source, "templates");
  buildTemplates(source, templatesDir, "2026-08-20T09:00:00Z");
  return templatesDir;
}

describe("validateInstallation", () => {
  it("reports a missing manifest as a problem", () => {
    const project = tmpDir("sta-validate-project-");
    const result = validateInstallation(project);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(".sta");
  });

  it("T-V5-002 (characterization — red until T-V5-004): an .agent-team-only workspace counts as installed", () => {
    // The shape `software-team-agents init` actually produces: .agent-team/
    // metadata and synced files, no .sta/ anywhere (F-01). A health check must
    // not call a correctly installed workspace broken.
    const templatesDir = fixtureTemplatesDir();
    const workspace = tmpDir("sta-validate-agentteam-");
    fs.mkdirSync(path.join(workspace, ".git")); // standalone-repo marker, as the sync engine inspects it
    fs.writeFileSync(path.join(workspace, "package.json"), '{"name":"fixture"}\n', "utf8");
    writeTargetConfig(workspace, defaultTargetConfig(path.basename(workspace), "2026-08-20T09:00:00Z", "ba"));
    runTargetSync({ targetRoot: workspace, templatesDir, now: "2026-08-20T09:00:00Z" });

    expect(fs.existsSync(path.join(workspace, ".agent-team", "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".agent-team", "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".sta"))).toBe(false);

    const result = validateInstallation(workspace);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("passes clean right after init", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpDir("sta-validate-project-");
    runInit(project, templatesDir, "2026-08-20T09:00:00Z");

    const result = validateInstallation(project);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("notes a user-modified file rather than treating it as a problem", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpDir("sta-validate-project-");
    runInit(project, templatesDir, "2026-08-20T09:00:00Z");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# edited by the project\n", "utf8");

    const result = validateInstallation(project);
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.includes("CLAUDE.md"))).toBe(true);
  });

  it("reports a tracked file that vanished as a problem", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpDir("sta-validate-project-");
    runInit(project, templatesDir, "2026-08-20T09:00:00Z");
    fs.rmSync(path.join(project, "CLAUDE.md"));

    const result = validateInstallation(project);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CLAUDE.md"))).toBe(true);
  });

  it("reports a missing .sta/config.yaml as a problem", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpDir("sta-validate-project-");
    runInit(project, templatesDir, "2026-08-20T09:00:00Z");
    fs.rmSync(path.join(project, ".sta", "config.yaml"));

    const result = validateInstallation(project);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("config.yaml"))).toBe(true);
  });

  it("validates V3 blocks when present without changing schema_version", () => {
    const templatesDir = fixtureTemplatesDir();
    const project = tmpDir("sta-validate-project-");
    runInit(project, templatesDir, "2026-08-20T09:00:00Z");
    fs.writeFileSync(
      path.join(project, ".sta", "config.yaml"),
      "schema_version: 1\nexecution:\n  mode: auto\n  allow_paid_fallback: false\nqa:\n  strategy: risk-based\nverification:\n  baseline: [unit]\n",
      "utf8",
    );
    expect(validateInstallation(project).ok).toBe(true);

    fs.writeFileSync(path.join(project, ".sta", "config.yaml"), "schema_version: 1\nexecution:\n  mode: automatic\n", "utf8");
    const invalid = validateInstallation(project);
    expect(invalid.ok).toBe(false);
    expect(invalid.problems.join("\n")).toMatch(/execution\.mode/);
  });
});
