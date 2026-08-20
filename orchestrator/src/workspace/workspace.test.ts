import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceError, checkWorkspace, hasWorkspace, loadWorkspace, workspacePath } from "./workspace.js";

function tmpDir(prefix = "orchestrator-workspace-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
