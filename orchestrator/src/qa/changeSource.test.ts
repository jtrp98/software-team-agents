import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { captureChangeSetFingerprint, gitDiffSummary, verifyChangeSetFingerprint } from "./changeSource.js";

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

describe("T-V4-CAST-006 diff-bound verification", () => {
  function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-verification-fingerprint-"));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    fs.writeFileSync(path.join(root, "sample.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "sample.ts"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
    return root;
  }

  it("keeps a verdict valid when neither a camp switch nor source changed", async () => {
    const root = fixture();
    try {
      const fingerprint = await captureChangeSetFingerprint(root);
      // A camp/runtime switch has no source side effect and is deliberately
      // absent from this API's inputs.
      await expect(verifyChangeSetFingerprint(root, fingerprint)).resolves.toEqual({ legacy: false, unverifiedFiles: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a file changed after the verdict unverified, including a human edit", async () => {
    const root = fixture();
    try {
      const fingerprint = await captureChangeSetFingerprint(root);
      fs.writeFileSync(path.join(root, "sample.ts"), "export const value = 2; // human edit\n");
      await expect(verifyChangeSetFingerprint(root, fingerprint)).resolves.toEqual({ legacy: false, unverifiedFiles: ["sample.ts"] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy verdict behaviour when no fingerprint was recorded", async () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "sample.ts"), "export const value = 2;\n");
      await expect(verifyChangeSetFingerprint(root, null)).resolves.toEqual({ legacy: true, unverifiedFiles: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
