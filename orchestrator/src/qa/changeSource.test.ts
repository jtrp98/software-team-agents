import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureChangeSetFingerprint,
  collectQaChangedFiles,
  gitDiffSummary,
  verifyChangeSetFingerprint,
  type QaWorkRoot,
} from "./changeSource.js";

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

describe("diff-bound verification", () => {
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

describe("multi-target change collection and fingerprinting (T-V9-014 / R-2)", () => {
  function createRepo(name: string, fileContent: string): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sta-multi-target-${name}-`));
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.ts"), fileContent);
    execFileSync("git", ["add", "src/index.ts"], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: root });
    return {
      root,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  it("dual verification (1): 2 Targets with identical relative path produce distinct rows with own hashes", async () => {
    const api = createRepo("api", "export const api = 1;\n");
    const web = createRepo("web", "export const web = 2;\n");
    try {
      fs.writeFileSync(path.join(api.root, "src", "index.ts"), "export const api = 'changed-api';\n");
      fs.writeFileSync(path.join(web.root, "src", "index.ts"), "export const web = 'changed-web';\n");

      const roots: QaWorkRoot[] = [
        { targetId: "api", path: api.root },
        { targetId: "web", path: web.root },
      ];

      const collected = await collectQaChangedFiles(roots);
      expect(collected.files).toEqual(["api:src/index.ts", "web:src/index.ts"]);
      expect(collected.failedTargets).toEqual([]);

      const fingerprint = await captureChangeSetFingerprint(roots);
      expect(Object.keys(fingerprint.files).sort()).toEqual(["api:src/index.ts", "web:src/index.ts"]);
      expect(fingerprint.files["api:src/index.ts"]).not.toEqual(fingerprint.files["web:src/index.ts"]);

      // Verify diff-bound check detects edit in one target
      fs.writeFileSync(path.join(api.root, "src", "index.ts"), "export const api = 'changed-again';\n");
      const check = await verifyChangeSetFingerprint(roots, fingerprint);
      expect(check.unverifiedFiles).toEqual(["api:src/index.ts"]);
    } finally {
      api.cleanup();
      web.cleanup();
    }
  });

  it("dual verification (2): solo task produces byte-identical unprefixed scope and fingerprint", async () => {
    const api = createRepo("api", "export const api = 1;\n");
    try {
      fs.writeFileSync(path.join(api.root, "src", "index.ts"), "export const api = 'changed';\n");

      // Solo task with targetId provided
      const soloRoots: QaWorkRoot[] = [{ targetId: "api", path: api.root }];
      const collected = await collectQaChangedFiles(soloRoots);
      expect(collected.files).toEqual(["src/index.ts"]);

      const fingerprintFromRoots = await captureChangeSetFingerprint(soloRoots);
      const fingerprintFromPath = await captureChangeSetFingerprint(api.root);

      expect(JSON.stringify(fingerprintFromRoots)).toEqual(JSON.stringify(fingerprintFromPath));
      expect(fingerprintFromRoots.files["src/index.ts"]).toBeDefined();
      expect(Object.keys(fingerprintFromRoots.files)).toEqual(["src/index.ts"]);
    } finally {
      api.cleanup();
    }
  });

  it("reports failed targets when git inspection fails instead of dropping them silently", async () => {
    const api = createRepo("api", "export const api = 1;\n");
    try {
      fs.writeFileSync(path.join(api.root, "src", "index.ts"), "export const api = 'changed';\n");

      const roots: QaWorkRoot[] = [
        { targetId: "api", path: api.root },
        { targetId: "broken-target", path: path.join(os.tmpdir(), "nonexistent-dir-for-test-r2") },
      ];

      const collected = await collectQaChangedFiles(roots);
      expect(collected.files).toEqual(["api:src/index.ts"]);
      expect(collected.failedTargets).toEqual(["broken-target"]);
    } finally {
      api.cleanup();
    }
  });
});
