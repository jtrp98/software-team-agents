import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as gitExports from "./index.js";
import {
  defaultGitProcessRunner,
  GIT_COMMAND_ALLOW_LIST,
  GitCommandLayer,
  isPathWithinRoot,
  type GitProcessRunner,
} from "./commandLayer.js";

function fixture(configureIdentity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-git-layer-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  if (configureIdentity) {
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  }
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  execFileSync("git", ["add", "--", "base.txt"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial", "--"],
    { cwd: root },
  );
  return root;
}

describe("closed Git command layer", () => {
  it("compares Windows root prefixes case-insensitively without accepting sibling prefixes", () => {
    expect(isPathWithinRoot("C:\\Repo\\Source\\file.ts", "c:\\repo", "win32")).toBe(true);
    expect(isPathWithinRoot("C:\\Repository\\file.ts", "c:\\repo", "win32")).toBe(false);
  });

  it("exports the one exact allow-list and no forbidden convenience methods", () => {
    expect(GIT_COMMAND_ALLOW_LIST).toEqual([
      "rev-parse",
      "symbolic-ref",
      "status --porcelain",
      "ls-files",
      "diff",
      "log",
      "cat-file",
      "merge-base",
      "switch -c",
      "branch",
      "add -- <paths>",
      "commit -m",
    ]);
    const surface = new Set([
      ...Object.keys(gitExports),
      ...Object.getOwnPropertyNames(GitCommandLayer.prototype),
    ]);
    for (const absent of ["push", "remote", "reset", "clean", "rebase", "merge", "tag", "revert", "cherryPick", "filterBranch"]) {
      expect(surface.has(absent)).toBe(false);
    }
  });

  it("rejects an unknown command before the process runner is called", async () => {
    const root = fixture();
    let spawned = 0;
    const processRunner: GitProcessRunner = async () => {
      spawned += 1;
      return { stdout: "", stderr: "" };
    };
    try {
      const git = new GitCommandLayer({ cwd: root, processRunner });
      await expect(git.execute({ command: "outside" } as never)).rejects.toThrow("outside the closed allow-list");
      expect(spawned).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("always uses an argument array, shell:false, a timeout and non-interactive Git", async () => {
    const root = fixture();
    const calls: Array<{ args: readonly string[]; options: Parameters<GitProcessRunner>[1] }> = [];
    try {
      const git = new GitCommandLayer({
        cwd: root,
        timeoutMs: 1234,
        environment: { PATH: process.env.PATH },
        processRunner: async (args, options) => {
          calls.push({ args, options });
          return { stdout: "main\n", stderr: "" };
        },
      });
      await git.symbolicRefHead();
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      expect(calls[0].options).toMatchObject({ shell: false, timeout: 1234, windowsHide: true });
      expect(calls[0].options.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(calls[0].options.env.GIT_ASKPASS).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Git command integration", () => {
  it("stages a file literally named -rf only as a path", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "-rf"), "not a flag\n");
      await new GitCommandLayer({ cwd: root }).addPaths(["-rf"]);
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" });
      expect(staged.trim()).toBe("-rf");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses configured STA identity per invocation without changing repository config", async () => {
    const root = fixture(false);
    const calls: string[][] = [];
    try {
      fs.writeFileSync(path.join(root, "identity.txt"), "identity\n");
      const git = new GitCommandLayer({
        cwd: root,
        identity: { name: "STA Checkpoint", email: "sta@example.invalid" },
        processRunner: async (args, options) => {
          calls.push([...args]);
          return defaultGitProcessRunner(args, options);
        },
      });
      await git.addPaths(["identity.txt"]);
      const committed = await git.commit("identity checkpoint");
      expect(committed.identitySource).toBe("sta");
      expect(calls.find((args) => args.includes("commit"))).toEqual(expect.arrayContaining([
        "-c", "user.name=STA Checkpoint", "-c", "user.email=sta@example.invalid",
      ]));
      expect(execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: root, encoding: "utf8" }).trim())
        .toBe("STA Checkpoint <sta@example.invalid>");
      const config = fs.readFileSync(path.join(root, ".git", "config"), "utf8");
      expect(config).not.toContain("STA Checkpoint");
      expect(config).not.toContain("sta@example.invalid");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a commit without either repository or configured STA identity", async () => {
    const root = fixture(false);
    try {
      fs.writeFileSync(path.join(root, "identity.txt"), "identity\n");
      const git = new GitCommandLayer({
        cwd: root,
        environment: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(root, "no-global-config"),
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: root,
          USERPROFILE: root,
        },
      });
      await git.addPaths(["identity.txt"]);
      await expect(git.commit("identity checkpoint")).rejects.toThrow(/git config user\.name/);
      expect(fs.readFileSync(path.join(root, ".git", "config"), "utf8")).not.toContain("user =");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bypasses configured commit signing and reports it", async () => {
    const root = fixture();
    const calls: string[][] = [];
    try {
      execFileSync("git", ["config", "commit.gpgSign", "true"], { cwd: root });
      fs.writeFileSync(path.join(root, "signed.txt"), "checkpoint\n");
      const git = new GitCommandLayer({
        cwd: root,
        processRunner: async (args, options) => {
          calls.push([...args]);
          return defaultGitProcessRunner(args, options);
        },
      });
      await git.addPaths(["signed.txt"]);
      const committed = await git.commit("unsigned checkpoint");
      expect(committed.gpgSigningBypassed).toBe(true);
      expect(calls.find((args) => args.includes("commit"))).toContain("--no-gpg-sign");
      expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf8" }).trim())
        .toBe("unsigned checkpoint");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries an index lock no more than twice and preserves Git stderr", async () => {
    const root = fixture();
    let attempts = 0;
    const countingRunner: GitProcessRunner = async (args, options) => {
      attempts += 1;
      return defaultGitProcessRunner(args, options);
    };
    try {
      fs.writeFileSync(path.join(root, "locked.txt"), "locked\n");
      fs.writeFileSync(path.join(root, ".git", "index.lock"), "held\n");
      const git = new GitCommandLayer({ cwd: root, processRunner: countingRunner, retryDelayMs: 1, sleep: async () => {} });
      await expect(git.addPaths(["locked.txt"])).rejects.toMatchObject({
        stderr: expect.stringContaining("index.lock"),
      });
      expect(attempts).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a Windows-style case-only rename as a changed state", async () => {
    const root = fixture();
    try {
      execFileSync("git", ["config", "core.ignoreCase", "false"], { cwd: root });
      fs.writeFileSync(path.join(root, "Case.txt"), "case\n");
      execFileSync("git", ["add", "--", "Case.txt"], { cwd: root });
      execFileSync("git", ["commit", "-m", "case fixture", "--"], { cwd: root });
      fs.renameSync(path.join(root, "Case.txt"), path.join(root, "case.txt"));
      expect((await new GitCommandLayer({ cwd: root }).statusPorcelain()).stdout).toMatch(/Case\.txt|case\.txt/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an over-limit Windows path before Git sees it", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "long.txt"), "long\n");
      const git = new GitCommandLayer({ cwd: root, platform: "win32", windowsPathLimit: root.length + 4 });
      await expect(git.addPaths(["long.txt"])).rejects.toThrow("exceeds the Windows path limit");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
