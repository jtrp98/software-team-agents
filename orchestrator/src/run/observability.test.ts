import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandLayer } from "../git/commandLayer.js";
import type { RunManifest } from "./journal.js";
import { deriveMergeAdvisory, listOrphanRunBranches, renderMergeAdvisory } from "./observability.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function repository(): { root: string; manifest: RunManifest; gitLayer: GitCommandLayer } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-observability-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "STA Test");
  git(root, "config", "user.email", "sta@example.test");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  const runBranch = "sta/run/orders/01J00000000000000000000060";
  git(root, "switch", "-c", runBranch, baseSha);
  fs.writeFileSync(path.join(root, "run.txt"), "run\n");
  git(root, "add", "run.txt");
  git(root, "commit", "-m", "sta(BE-1): checkpoint");
  const manifest: RunManifest = {
    run_id: "01J00000000000000000000060",
    created_at: "2026-09-07T00:00:00.000Z",
    target_root: root,
    target_id: "target",
    knowledge_root: root,
    module: "orders",
    wave: 1,
    plan_hash: "hash",
    task_order: ["BE-1"],
    base_branch: "main",
    base_sha: baseSha,
    run_branch: runBranch,
    runtime_id: "claude-code",
    tier: "T2",
    model: "opus",
    max_tasks: 1,
    sta_version: "1.1.0",
  };
  return { root, manifest, gitLayer: new GitCommandLayer({ cwd: root }) };
}

function advanceBase(root: string, file: string): string {
  git(root, "switch", "main");
  fs.writeFileSync(path.join(root, file), "base advanced\n");
  git(root, "add", file);
  git(root, "commit", "-m", "advance base");
  return git(root, "rev-parse", "main");
}

describe("T-V7-030 — merge advisory", () => {
  it("recommends a display-only ff-only command when the base is unchanged", async () => {
    const fixture = repository();
    const advisory = await deriveMergeAdvisory(fixture.manifest, "HUMAN_REVIEW", fixture.gitLayer);
    expect(advisory).toEqual({
      kind: "ready",
      command: `git switch main && git merge --ff-only ${fixture.manifest.run_branch}`,
    });
    expect(renderMergeAdvisory(fixture.manifest, advisory).join("\n")).not.toMatch(/tasks? (done|complete|passed)/i);
  });

  it("reports an advanced base and commit count when paths do not overlap", async () => {
    const fixture = repository();
    advanceBase(fixture.root, "base-advance.txt");
    const advisory = await deriveMergeAdvisory(fixture.manifest, "HUMAN_REVIEW", fixture.gitLayer);
    expect(advisory).toMatchObject({ kind: "diverged", advanced_by: 1, overlapping_paths: [] });
    expect(renderMergeAdvisory(fixture.manifest, advisory).join("\n")).toContain("base branch advanced by 1 commit");
  });

  it("lists overlapping paths when both branches changed the same path", async () => {
    const fixture = repository();
    git(fixture.root, "switch", fixture.manifest.run_branch);
    fs.writeFileSync(path.join(fixture.root, "base.txt"), "run changed base\n");
    git(fixture.root, "add", "base.txt");
    git(fixture.root, "commit", "-m", "change shared path on run");
    advanceBase(fixture.root, "base.txt");
    const advisory = await deriveMergeAdvisory(fixture.manifest, "HUMAN_REVIEW", fixture.gitLayer);
    expect(advisory).toMatchObject({ kind: "diverged", advanced_by: 1, overlapping_paths: ["base.txt"] });
    expect(renderMergeAdvisory(fixture.manifest, advisory).join("\n")).toContain("overlapping paths: base.txt");
  });

  it("emits no merge advice for a halted run", async () => {
    const fixture = repository();
    const advisory = await deriveMergeAdvisory(fixture.manifest, "HALTED", fixture.gitLayer);
    expect(advisory).toEqual({ kind: "none", reason: "halted" });
    expect(renderMergeAdvisory(fixture.manifest, advisory)).toEqual([]);
  });

  it("fails closed when the base no longer descends from the recorded SHA", async () => {
    const fixture = repository();
    git(fixture.root, "switch", "--orphan", "replacement");
    fs.writeFileSync(path.join(fixture.root, "replacement.txt"), "replacement\n");
    git(fixture.root, "add", "replacement.txt");
    git(fixture.root, "commit", "-m", "replacement root");
    git(fixture.root, "branch", "-f", "main", "HEAD");
    const advisory = await deriveMergeAdvisory(fixture.manifest, "HUMAN_REVIEW", fixture.gitLayer);
    expect(advisory).toMatchObject({ kind: "unavailable" });
    expect(renderMergeAdvisory(fixture.manifest, advisory).join("\n")).toContain("No merge command was generated");
  });

  it("T-V7-031 refuses malicious stored branch input before it reaches a rendered ref command", async () => {
    const fixture = repository();
    const unsafeManifest = { ...fixture.manifest, base_branch: "main;Write-Output_PWNED" };
    const advisory = await deriveMergeAdvisory(unsafeManifest, "HUMAN_REVIEW", fixture.gitLayer);
    const rendered = renderMergeAdvisory(unsafeManifest, advisory).join("\n");
    expect(advisory).toMatchObject({ kind: "unavailable" });
    expect(rendered).toContain("No merge command was generated");
    expect(rendered).not.toContain("git switch");
    expect(rendered).not.toContain("Write-Output_PWNED");
  });

  it("lists an orphan run branch without removing it", async () => {
    const fixture = repository();
    const before = git(fixture.root, "rev-parse", fixture.manifest.run_branch);
    const orphans = await listOrphanRunBranches(fixture.root, []);
    expect(orphans).toContainEqual({ target_root: fixture.root, branch: fixture.manifest.run_branch });
    expect(git(fixture.root, "rev-parse", fixture.manifest.run_branch)).toBe(before);
  });
});
