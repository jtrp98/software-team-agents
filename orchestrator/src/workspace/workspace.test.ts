import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceError, checkWorkspace, hasWorkspace, loadWorkspace, workspacePath } from "./workspace.js";
import { defaultTargetConfig, writeTargetConfig } from "../targetcli/targetMeta.js";

function tmpDir(prefix = "orchestrator-workspace-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function withRole(root: string, role: "ba" | "dev"): void {
  writeTargetConfig(root, defaultTargetConfig(path.basename(root), "2026-01-01T00:00:00Z", role));
}

describe("a project with no workspace.yaml (T41 — most projects run standalone)", () => {
  it("hasWorkspace is false", () => {
    const root = tmpDir();
    expect(hasWorkspace(root)).toBe(false);
  });

  it("checkWorkspace passes with a note, not an error", () => {
    const root = tmpDir();
    const result = checkWorkspace(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain("runs standalone");
  });
});

describe("a valid workspace.yaml", () => {
  it("loads, and resolves relative roots against the file's own directory", () => {
    const root = tmpDir();
    const siblingA = path.join(root, "..", "sibling-a");
    const siblingB = path.join(root, "nested-b");
    fs.mkdirSync(siblingA, { recursive: true });
    fs.mkdirSync(siblingB, { recursive: true });
    fs.writeFileSync(
      workspacePath(root),
      "version: 1\nprojects:\n  - name: sibling-a\n    root: ../sibling-a\n  - name: nested-b\n    root: ./nested-b\n",
      "utf8",
    );

    const workspace = loadWorkspace(root);
    expect(workspace.version).toBe(1);
    expect(workspace.projects).toEqual([
      { name: "sibling-a", root: path.resolve(siblingA) },
      { name: "nested-b", root: path.resolve(siblingB) },
    ]);
  });

  it("passes --check-workspace with no notes", () => {
    const root = tmpDir();
    const other = path.join(root, "other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(workspacePath(root), `version: 1\nprojects:\n  - name: other\n    root: ./other\n`, "utf8");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe("a broken workspace.yaml", () => {
  it("loadWorkspace throws WorkspaceError on invalid YAML", () => {
    const root = tmpDir();
    fs.writeFileSync(workspacePath(root), "version: [this is not\n  a valid yaml document", "utf8");
    expect(() => loadWorkspace(root)).toThrow(WorkspaceError);
  });

  it("loadWorkspace throws WorkspaceError when the shape fails the schema", () => {
    const root = tmpDir();
    fs.writeFileSync(workspacePath(root), "version: 1\nprojects: []\n", "utf8"); // minItems: 1
    expect(() => loadWorkspace(root)).toThrow(WorkspaceError);
  });

  it("checkWorkspace fails (not just notes) when a project name repeats", () => {
    const root = tmpDir();
    const a = path.join(root, "a");
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(
      workspacePath(root),
      `version: 1\nprojects:\n  - name: a\n    root: ./a\n  - name: a\n    root: ./a\n`,
      "utf8",
    );

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('"a"') && p.includes("more than once"))).toBe(true);
  });

  it("checkWorkspace fails when a declared root does not exist", () => {
    const root = tmpDir();
    fs.writeFileSync(workspacePath(root), `version: 1\nprojects:\n  - name: ghost\n    root: ./nowhere\n`, "utf8");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("not a directory");
  });

  it("checkWorkspace fails when a declared root is a file, not a directory", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "not-a-dir"), "hi", "utf8");
    fs.writeFileSync(workspacePath(root), `version: 1\nprojects:\n  - name: f\n    root: ./not-a-dir\n`, "utf8");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("not a directory");
  });
});

describe("T-WG4 — misplaced-docs scanner (role: dev carries no _docs/ of its own)", () => {
  it("role: dev with _docs/module/** content is flagged, per file, with a hint at the Knowledge destination", () => {
    const root = tmpDir();
    withRole(root, "dev");
    write(root, "_docs/module/sb-compass/requirement.md", "# Sales Compass requirement\n");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("_docs/module/sb-compass/requirement.md") && p.includes("Knowledge repo"))).toBe(true);
  });

  it("role: dev with a Modules table in _docs/status.md is flagged", () => {
    const root = tmpDir();
    withRole(root, "dev");
    write(root, "_docs/status.md", "# Project Status\n\n## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| sb-compass | Planning | project-manager |\n");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("_docs/status.md") && p.includes("## Modules"))).toBe(true);
  });

  it("sb-compass fixture: module dir + status.md Modules table together, both flagged in one pass", () => {
    const root = tmpDir();
    withRole(root, "dev");
    write(root, "_docs/module/sb-compass/requirement.md", "# Sales Compass requirement\n");
    write(root, "_docs/status.md", "## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| sb-compass | Planning | project-manager |\n");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(false);
    expect(result.problems.filter((p) => p.includes("sb-compass") || p.includes("Modules")).length).toBeGreaterThanOrEqual(2);
  });

  it("role: ba (Knowledge repo) with the same _docs/module/** content is NOT flagged — that is exactly where it belongs", () => {
    const root = tmpDir();
    withRole(root, "ba");
    write(root, "_docs/module/sb-compass/requirement.md", "# Sales Compass requirement\n");
    write(root, "_docs/status.md", "## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| sb-compass | Planning | project-manager |\n");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("role absent (legacy-project / the Framework repo itself) is never flagged — no false positive", () => {
    const root = tmpDir();
    // No .agent-team/config.yaml at all — same shape as this Framework checkout.
    write(root, "_docs/module/sb-compass/requirement.md", "# Sales Compass requirement\n");
    write(root, "_docs/status.md", "## Modules\n\n| Module | Stage | Next agent |\n|---|---|---|\n| sb-compass | Planning | project-manager |\n");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("role: dev with no _docs/ at all stays clean", () => {
    const root = tmpDir();
    withRole(root, "dev");

    const result = checkWorkspace(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
});
