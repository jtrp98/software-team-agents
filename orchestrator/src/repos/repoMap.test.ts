import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { RepoMapError, checkRepoMap, hasRepoMap, loadRepoMap, loadStageRoots, reposPath, stageRoots } from "./repoMap.js";

function tmpDir(prefix = "orchestrator-repos-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("a project with no repos.yaml (T42 — most projects are one repo)", () => {
  it("hasRepoMap is false", () => {
    expect(hasRepoMap(tmpDir())).toBe(false);
  });

  it("checkRepoMap passes with a note, not an error", () => {
    const result = checkRepoMap(tmpDir());
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain("the same repo");
  });

  it("loadStageRoots returns undefined", () => {
    expect(loadStageRoots(tmpDir())).toBeUndefined();
  });
});

describe("a valid repos.yaml", () => {
  it("loads, resolves roots relative to the file's own directory, and flattens to a stage -> root map", () => {
    const root = tmpDir();
    const backend = path.join(root, "..", "backend-repo");
    const frontend = path.join(root, "frontend-repo");
    fs.mkdirSync(backend, { recursive: true });
    fs.mkdirSync(frontend, { recursive: true });
    fs.writeFileSync(
      reposPath(root),
      "version: 1\nrepos:\n" +
        "  - name: backend\n    root: ../backend-repo\n    stages: [backend-engineer]\n" +
        "  - name: frontend\n    root: ./frontend-repo\n    stages: [frontend-engineer, qa-engineer]\n",
      "utf8",
    );

    const map = loadRepoMap(root);
    expect(map.version).toBe(1);
    expect(map.repos).toEqual([
      { name: "backend", root: path.resolve(backend), stages: [AgentStage.BACKEND_ENGINEER] },
      { name: "frontend", root: path.resolve(frontend), stages: [AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER] },
    ]);

    expect(stageRoots(map)).toEqual({
      [AgentStage.BACKEND_ENGINEER]: path.resolve(backend),
      [AgentStage.FRONTEND_ENGINEER]: path.resolve(frontend),
      [AgentStage.QA_ENGINEER]: path.resolve(frontend),
    });

    expect(loadStageRoots(root)).toEqual(stageRoots(map));
  });

  it("passes --check-repos with no notes", () => {
    const root = tmpDir();
    const backend = path.join(root, "backend");
    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(reposPath(root), "version: 1\nrepos:\n  - name: backend\n    root: ./backend\n    stages: [backend-engineer]\n", "utf8");

    const result = checkRepoMap(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe("a broken repos.yaml", () => {
  it("loadRepoMap throws RepoMapError on invalid YAML", () => {
    const root = tmpDir();
    fs.writeFileSync(reposPath(root), "version: [not\n  valid", "utf8");
    expect(() => loadRepoMap(root)).toThrow(RepoMapError);
  });

  it("loadRepoMap throws RepoMapError on an unknown stage name", () => {
    const root = tmpDir();
    fs.writeFileSync(reposPath(root), "version: 1\nrepos:\n  - name: x\n    root: .\n    stages: [not-a-real-stage]\n", "utf8");
    expect(() => loadRepoMap(root)).toThrow(RepoMapError);
  });

  it("checkRepoMap fails when a repo name repeats", () => {
    const root = tmpDir();
    const a = path.join(root, "a");
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(
      reposPath(root),
      "version: 1\nrepos:\n  - name: a\n    root: ./a\n    stages: [backend-engineer]\n  - name: a\n    root: ./a\n    stages: [devops]\n",
      "utf8",
    );
    const result = checkRepoMap(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('"a"') && p.includes("more than once"))).toBe(true);
  });

  it("checkRepoMap fails when a declared root does not exist", () => {
    const root = tmpDir();
    fs.writeFileSync(reposPath(root), "version: 1\nrepos:\n  - name: ghost\n    root: ./nowhere\n    stages: [devops]\n", "utf8");
    const result = checkRepoMap(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("not a directory");
  });

  it("checkRepoMap fails when the same stage is claimed by two repos", () => {
    const root = tmpDir();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(
      reposPath(root),
      "version: 1\nrepos:\n  - name: a\n    root: ./a\n    stages: [devops]\n  - name: b\n    root: ./b\n    stages: [devops]\n",
      "utf8",
    );
    const result = checkRepoMap(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('stage "devops"') && p.includes("both"))).toBe(true);
  });
});
