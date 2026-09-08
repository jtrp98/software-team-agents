import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { appendJournalRecord, writeRunManifest, type KnownJournalRecord, type RunManifest } from "../../run/journal.js";
import { getChangedSummary, runChangedVerb } from "./changed.js";

function git(dir: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}

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
      expect(summary.run).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("adds the optional structured run field when a bounded run exists", async () => {
    const fixture = createFixtureGitRepo();
    try {
      const baseBranch = git(fixture.dir, "branch", "--show-current");
      const baseSha = git(fixture.dir, "rev-parse", "HEAD");
      const runId = "01J00000000000000000000062";
      const runBranch = `sta/run/orders/${runId}`;
      git(fixture.dir, "switch", "-c", runBranch, baseSha);
      fs.writeFileSync(path.join(fixture.dir, "run.txt"), "checkpoint\n");
      git(fixture.dir, "add", "run.txt");
      git(fixture.dir, "commit", "-m", "sta(BE-1): checkpoint");
      const checkpointSha = git(fixture.dir, "rev-parse", "HEAD");
      const manifest: RunManifest = {
        run_id: runId, created_at: "2026-09-07T00:00:00.000Z", target_root: fixture.dir, target_id: "target",
        knowledge_root: fixture.dir, module: "orders", wave: 1, plan_hash: "hash", task_order: ["BE-1"],
        base_branch: baseBranch, base_sha: baseSha, run_branch: runBranch, runtime_id: "claude-code", tier: "T2",
        model: "opus", max_tasks: 1, sta_version: "1.1.0",
      };
      writeRunManifest(fixture.dir, manifest);
      const records: KnownJournalRecord[] = [
        { ts: "2026-09-07T00:00:00.000Z", kind: "RUN_STARTED" },
        { ts: "2026-09-07T00:00:01.000Z", kind: "RUN_ISOLATED" },
        { ts: "2026-09-07T00:00:02.000Z", kind: "TASK_READY", task_id: "BE-1" },
        { ts: "2026-09-07T00:00:03.000Z", kind: "TASK_STARTED", task_id: "BE-1" },
        { ts: "2026-09-07T00:00:04.000Z", kind: "TASK_AGENT_DONE", task_id: "BE-1" },
        { ts: "2026-09-07T00:00:05.000Z", kind: "GATE_RESULT", task_id: "BE-1", result: "passed", summary: "typecheck" },
        { ts: "2026-09-07T00:00:06.000Z", kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha: checkpointSha },
        { ts: "2026-09-07T00:00:07.000Z", kind: "RUN_COMPLETED" },
        { ts: "2026-09-07T00:00:08.000Z", kind: "HUMAN_REVIEW_REQUIRED" },
      ];
      for (const record of records) appendJournalRecord(fixture.dir, runId, record);

      const summary = await getChangedSummary(fixture.dir);
      expect(summary.run).toEqual({
        run_id: runId,
        run_branch: runBranch,
        checkpoints: [{ task_id: "BE-1", sha: checkpointSha, subject: "sta(BE-1): checkpoint" }],
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runChangedVerb(["--project-root", fixture.dir], fixture.dir)).toBe(0);
        const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(output).toContain(`BE-1 CHECKPOINTED at ${checkpointSha}`);
        expect(output).toContain("CHECKPOINTED is not a QA verdict");
        expect(output).not.toMatch(/\bBE-1\s+(?:complete|done|passed)\b/i);
      } finally {
        logSpy.mockRestore();
      }
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
