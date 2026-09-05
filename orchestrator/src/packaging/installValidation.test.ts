import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
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

describe("validateInstallation", () => {
  it("reports a missing manifest as a problem naming the current installer", () => {
    const project = tmpDir("sta-validate-project-");
    const result = validateInstallation(project);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("software-team-agents init");
  });

  it("an .agent-team-only workspace counts as installed", () => {
    // `software-team-agents init` produces .agent-team/ metadata and synced
    // files, no .sta/ anywhere — a correctly installed workspace must not be
    // reported as broken.
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

  /** A workspace still on the retired `.sta/`-only layout gets a distinct,
   * actionable message naming the conversion path, rather than being silently
   * treated the same as a never-initialized one. */
  it("reports a .sta/-only workspace as needing conversion, not just 'never initialized'", () => {
    const project = tmpDir("sta-validate-legacy-");
    fs.mkdirSync(path.join(project, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".sta", "manifest.json"),
      JSON.stringify({ schema_version: 1, framework_version: "0.1.0", installed_at: "x", updated_at: "x", files: [] }),
      "utf8",
    );

    const result = validateInstallation(project);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("legacy .sta/manifest.json");
    expect(result.problems[0]).toContain("software-team-agents init");
    expect(result.problems[0]).toContain("no content loss");
  });

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
});
