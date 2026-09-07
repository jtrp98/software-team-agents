import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCommandLayer } from "./commandLayer.js";
import {
  createIsolatedRunBranch,
  generatedRunBranch,
  inspectRepositoryPreflight,
  RepositoryPreflightError,
  type RepositoryRefusalKind,
} from "./preflight.js";

function run(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-git-preflight-"));
  run(root, ["init", "-b", "main"]);
  run(root, ["config", "user.name", "Fixture"]);
  run(root, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  run(root, ["add", "--", "base.txt"]);
  run(root, ["commit", "-m", "initial", "--"]);
  return root;
}

async function refusal(
  root: string,
  kind: RepositoryRefusalKind,
  commandPattern: RegExp,
): Promise<void> {
  try {
    await inspectRepositoryPreflight(new GitCommandLayer({ cwd: root }), "module", "run-1");
    throw new Error("preflight unexpectedly allowed the repository");
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryPreflightError);
    expect((error as RepositoryPreflightError).kind).toBe(kind);
    expect((error as Error).message).toMatch(commandPattern);
  }
}

describe("repository preflight refusal matrix", () => {
  it("refuses modified tracked files first with a runnable restore command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "base.txt"), "modified\n");
      await refusal(root, "modified-tracked", /Run: git restore --worktree -- "base\.txt"/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses staged files with a runnable unstage command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "base.txt"), "staged\n");
      run(root, ["add", "--", "base.txt"]);
      await refusal(root, "staged", /Run: git restore --staged -- "base\.txt"/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses untracked non-ignored files with a runnable preserve command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "new.txt"), "new\n");
      await refusal(root, "untracked", /Run: git add -- "new\.txt" && git commit -m/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("allows untracked ignored files", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".gitignore"), "*.generated\n");
      run(root, ["add", "--", ".gitignore"]);
      run(root, ["commit", "-m", "ignore generated", "--"]);
      fs.writeFileSync(path.join(root, "cache.generated"), "ignored\n");
      await expect(inspectRepositoryPreflight(new GitCommandLayer({ cwd: root }), "module", "run-1"))
        .resolves.toMatchObject({ baseBranch: "main" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an in-progress merge with a runnable continuation command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), `${run(root, ["rev-parse", "HEAD"])}\n`);
      await refusal(root, "merge", /Run: git merge --continue/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an in-progress rebase with a runnable continuation command", async () => {
    const root = fixture();
    try {
      const rebase = path.join(root, ".git", "rebase-merge");
      fs.mkdirSync(rebase);
      fs.writeFileSync(path.join(rebase, "head-name"), "refs/heads/main\n");
      fs.writeFileSync(path.join(rebase, "onto"), `${run(root, ["rev-parse", "HEAD"])}\n`);
      fs.writeFileSync(path.join(rebase, "orig-head"), `${run(root, ["rev-parse", "HEAD"])}\n`);
      fs.writeFileSync(path.join(rebase, "msgnum"), "1\n");
      fs.writeFileSync(path.join(rebase, "end"), "1\n");
      await refusal(root, "rebase", /Run: git rebase --continue/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["CHERRY_PICK_HEAD", "cherry-pick", /Run: git cherry-pick --continue/],
    ["REVERT_HEAD", "revert", /Run: git revert --continue/],
  ] as const)("refuses %s with its runnable continuation command", async (marker, kind, command) => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".git", marker), `${run(root, ["rev-parse", "HEAD"])}\n`);
      await refusal(root, kind, command);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses detached HEAD with a runnable switch command", async () => {
    const root = fixture();
    try {
      run(root, ["switch", "--detach", "HEAD"]);
      await refusal(root, "detached-head", /Run: git switch -/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an in-progress bisect with a runnable reset command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".git", "BISECT_LOG"), "git bisect start\n");
      await refusal(root, "bisect", /Run: git bisect reset/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses submodules with a runnable inspection command", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".gitmodules"), "[submodule \"fixture\"]\n\tpath = fixture\n\turl = ../fixture\n");
      run(root, ["add", "--", ".gitmodules"]);
      run(root, ["commit", "-m", "submodule declaration", "--"]);
      await refusal(root, "submodules", /Run: git submodule status/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses sparse checkout with the exact disable command", async () => {
    const root = fixture();
    try {
      run(root, ["sparse-checkout", "init", "--cone"]);
      await refusal(root, "sparse-checkout", /Run: git sparse-checkout disable/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["pre-commit", "commit-msg"])("refuses executable %s and names its path", async (name) => {
    const root = fixture();
    try {
      const hook = path.join(root, ".git", "hooks", name);
      fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(hook, 0o755);
      await refusal(root, "commit-hook", new RegExp(`${name}.*Run: Rename-Item`));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("allows Git LFS attributes with an explicit pointer/object warning", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      run(root, ["add", "--", ".gitattributes"]);
      run(root, ["commit", "-m", "lfs declaration", "--"]);
      const result = await inspectRepositoryPreflight(new GitCommandLayer({ cwd: root }), "module", "run-1");
      expect(result.warnings).toEqual([expect.stringMatching(/pointer\/object state is not validated/)]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses an existing generated run branch without moving it", async () => {
    const root = fixture();
    try {
      const branch = generatedRunBranch("module", "run-1");
      run(root, ["branch", branch]);
      const before = run(root, ["rev-parse", `refs/heads/${branch}`]);
      await refusal(root, "branch-collision", /Run: git branch -m/);
      expect(run(root, ["rev-parse", `refs/heads/${branch}`])).toBe(before);
      expect(run(root, ["branch", "--show-current"])).toBe("main");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("per-run branch isolation", () => {
  it("sanitizes bounded segments and produces a ref Git itself accepts", () => {
    const branch = generatedRunBranch("a b/c;rm -rf /", "run id:1");
    expect(branch).toBe("sta/run/a_b_c_rm_-rf__/run_id_1");
    expect(() => execFileSync("git", ["check-ref-format", "--branch", branch])).not.toThrow();
    expect(branch.split("/").every((segment) => segment.length <= 64)).toBe(true);
  });

  it.each([
    ["module.", "run-1"],
    [".module", "run-1"],
    ["module", "run.lock"],
    ["..", "run-1"],
  ])("refuses a generated ref when sanitized segments remain invalid (%s / %s)", (moduleName, runId) => {
    expect(() => generatedRunBranch(moduleName, runId)).toThrow("not a valid Git branch name");
  });

  it("captures base identity before creation and leaves the repository on the run branch", async () => {
    const root = fixture();
    try {
      const before = run(root, ["rev-parse", "HEAD"]);
      const result = await createIsolatedRunBranch(new GitCommandLayer({ cwd: root }), "module", "run-2");
      expect(result).toMatchObject({ baseBranch: "main", baseSha: before, branchCreated: true });
      expect(run(root, ["branch", "--show-current"])).toBe(result.runBranch);
      expect(run(root, ["rev-parse", "refs/heads/main"])).toBe(before);
      expect(run(root, ["rev-parse", `refs/heads/${result.runBranch}`])).toBe(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
