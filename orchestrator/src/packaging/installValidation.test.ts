import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTemplates } from "./templateBuilder.js";
import { runInit } from "./initCommand.js";
import { validateInstallation } from "./installValidation.js";

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
});
