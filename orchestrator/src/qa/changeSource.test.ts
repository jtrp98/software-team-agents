import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gitDiffSummary } from "./changeSource.js";

describe("gitDiffSummary", () => {
  it("returns a compact stat rather than source diff content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-diff-summary-"));
    try {
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "sample.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "sample.ts"], { cwd: root });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
      fs.writeFileSync(path.join(root, "sample.ts"), "export const value = 'changed-source-must-not-be-in-summary';\n");
      const summary = await gitDiffSummary(root);
      expect(summary).toContain("sample.ts");
      expect(summary).not.toContain("changed-source-must-not-be-in-summary");
      expect(Buffer.byteLength(summary)).toBeLessThan(2_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
