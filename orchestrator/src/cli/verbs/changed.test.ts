import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { getChangedSummary, runChangedVerb } from "./changed.js";

function createFixtureGitRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-changed-test-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "base.txt"), "hello base", "utf8");
  spawnSync("git", ["add", "base.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("T-V6-017 — sta changed verb", () => {
  it("getChangedSummary returns valid structure with detected changes on git workspace", async () => {
    const fixture = createFixtureGitRepo();
    try {
      // Add an untracked file and modify a tracked file
      fs.writeFileSync(path.join(fixture.dir, "base.txt"), "modified", "utf8");
      fs.writeFileSync(path.join(fixture.dir, "untracked.txt"), "new", "utf8");

      const summary = await getChangedSummary(fixture.dir);
      expect(summary).toBeDefined();
      expect(summary.isGit).toBe(true);
      expect(summary.changedFiles).toContain("base.txt");
      expect(summary.changedFiles).toContain("untracked.txt");
      expect(summary.gate).toBeDefined();
      expect(["passed", "failed", "unverified"]).toContain(summary.gate.status);
      expect(summary.disclaimer).toContain("Deterministic compiler, linter and test gate only");
    } finally {
      fixture.cleanup();
    }
  });

  it("handles non-git directory gracefully without throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sta-non-git-"));
    try {
      const summary = await getChangedSummary(tmp);
      expect(summary.isGit).toBe(false);
      expect(summary.changedFiles).toEqual([]);
      expect(summary.gitError).toBeDefined();
      expect(summary.gate).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runChangedVerb exits 0 and supports --json flag", async () => {
    const fixture = createFixtureGitRepo();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runChangedVerb(["--json", "--project-root", fixture.dir], fixture.dir);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.isGit).toBe(true);
      expect(parsed.gate).toBeDefined();
      expect(parsed.disclaimer).toBeDefined();
    } finally {
      logSpy.mockRestore();
      fixture.cleanup();
    }
  });
});