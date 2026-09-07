import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { checkGitOwnership } from "./ownershipCheck.js";

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-git-ownership-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, "orchestrator", "src", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

describe("git ownership checker", () => {
  it("is green on the real source tree and scans a non-zero file set", () => {
    const root = path.resolve(process.cwd(), "..");
    const result = checkGitOwnership(root);
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.problems).toEqual([]);
  });

  it("T-V7-031 remote push is unreachable: a planted push outside src/git turns the checker red", () => {
    const root = fixture({
      "feature.ts": 'import { execFile } from "node:child_process";\nexecFile("git", ["push", "origin", "main"]);\n',
    });
    try {
      const result = checkGitOwnership(root);
      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/forbidden git subcommand push/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns a non-zero CLI result for the planted push fixture", async () => {
    const root = fixture({
      "feature.ts": 'import { execFile } from "node:child_process";\nexecFile("git", ["push", "origin", "main"]);\n',
    });
    try {
      await expect(runCli(["--check-git-ownership", "--project-root", root], root)).resolves.toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("T-V7-031 unsafe Git operations remain unreachable: an unlisted mutation turns the checker red", () => {
    const root = fixture({
      "bootstrap.ts": 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["init"]);\n',
    });
    try {
      expect(checkGitOwnership(root).problems.join("\n")).toMatch(/mutating git subcommand init outside/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when no source file was scanned", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-git-ownership-empty-"));
    try {
      const result = checkGitOwnership(root);
      expect(result.ok).toBe(false);
      expect(result.scannedFiles).toBe(0);
      expect(result.problems).toContain("scanned zero TypeScript files under orchestrator/src; Git ownership cannot be verified");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("exempts only a .test.ts path and still catches a non-test filename containing test", () => {
    const root = fixture({
      "allowed.test.ts": 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["commit", "-m", "fixture"]);\n',
      "contest-helper.ts": 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["commit", "-m", "bad"]);\n',
    });
    try {
      const result = checkGitOwnership(root);
      expect(result.problems.join("\n")).toMatch(/contest-helper\.ts.*mutating git subcommand commit/);
      expect(result.problems.join("\n")).not.toContain("allowed.test.ts");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a dynamic git command in an unapproved production module", () => {
    const root = fixture({
      "dynamic.ts": 'import { execFile } from "node:child_process";\nexport const run = (args: string[]) => execFile("git", args);\n',
    });
    try {
      expect(checkGitOwnership(root).problems.join("\n")).toMatch(/passes a dynamic git command outside/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
