import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyChangedFilesScope } from "./postflight.js";

/**
 * V13 TASK-017 — the deterministic post-run scope check STA applies to every
 * write-capable attempt, graded on the executor port's changed-files evidence.
 * These tests are pure/injected: the filesystem behaviours (symlink escape)
 * are forced through the resolveReal seam so they are deterministic on every
 * platform, and one git fixture proves the real-path half end to end.
 */

function tmpGitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

const WRITE_RULES = { write: ["src/**"], deny: [] };

describe("verifyChangedFilesScope", () => {
  it("allows a valid scoped edit inside the granted root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-ok-"));
    try {
      const file = path.join(root, "src", "orders.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {}");
      const result = verifyChangedFilesScope({
        role: "backend-engineer",
        roots: [{ path: root, access: "write" }],
        changedFiles: ["src/orders.ts"],
        rules: WRITE_RULES,
      });
      expect(result).toMatchObject({ ok: true, checked: 1, violations: [] });
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("blocks a changed file no allow pattern covers (deny is the default)", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" }],
      changedFiles: ["docs/notes.md"],
      rules: WRITE_RULES,
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("backend-engineer postflight");
    expect(result.violations[0]).toContain("not covered by this role's write paths");
  });

  it("blocks a file the role's deny list refuses even when a write pattern would cover it", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" }],
      changedFiles: ["src/contracts/backend-engineer.yaml"],
      rules: { write: ["src/**"], deny: ["src/contracts/**"] },
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("this role's contract denies src/contracts/**");
  });

  it("blocks the framework payload and universal floor for every role", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" }],
      changedFiles: ["workflows/feature.yml", ".git/config"],
      rules: { write: ["**"], deny: [] },
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("blocks a textual path escape out of the granted root", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" }],
      changedFiles: ["../outside/secret.txt"],
      rules: { write: ["**"], deny: [] },
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("escapes its granted root");
  });

  it("blocks a symlink whose real path lands outside the root", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" }],
      changedFiles: ["src/link.ts"],
      rules: { write: ["src/**"], deny: [] },
      fileExists: () => true,
      resolveReal: () => "/elsewhere/secret.ts",
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("symlink escape");
  });

  it("blocks a changed file inside a read-only root", () => {
    const result = verifyChangedFilesScope({
      role: "reviewer",
      roots: [{ targetId: "docs-target", path: "/repo", access: "read" }],
      changedFiles: ["docs-target:src/orders.ts"],
      rules: { write: [], deny: [] },
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('read-only root "docs-target"');
  });

  it("grades namespaced files across multiple roots and refuses one it cannot attribute", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [
        { targetId: "api", path: "/repo-api", access: "write" },
        { targetId: "web", path: "/repo-web", access: "write" },
      ],
      changedFiles: ["api:src/orders.ts", "web:src/App.tsx", "src/orders.ts"],
      rules: { write: ["src/**"], deny: [] },
      fileExists: () => false,
    });
    expect(result.checked).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("cannot be attributed to any granted work root");
  });

  it("blocks every file whose namespace names no granted root", () => {
    const result = verifyChangedFilesScope({
      role: "backend-engineer",
      roots: [
        { targetId: "api", path: "/repo-api", access: "write" },
        { targetId: "web", path: "/repo-web", access: "write" },
      ],
      changedFiles: ["unknown-target:src/x.ts"],
      rules: WRITE_RULES,
      fileExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("cannot be attributed");
  });

  it("produces a stable digest for identical grades and a different one for a different grade", () => {
    const input = {
      role: "backend-engineer",
      roots: [{ path: "/repo", access: "write" as const }],
      changedFiles: ["src/orders.ts"],
      rules: WRITE_RULES,
      fileExists: () => false,
    };
    const first = verifyChangedFilesScope(input);
    const second = verifyChangedFilesScope(input);
    expect(first.digest).toBe(second.digest);
    const different = verifyChangedFilesScope({ ...input, changedFiles: ["src/other.ts"] });
    expect(different.digest).not.toBe(first.digest);
  });

  it("proves the real-path containment against a real git checkout (no symlink escape)", () => {
    const root = tmpGitRoot();
    try {
      const file = path.join(root, "src", "orders.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {}");
      const result = verifyChangedFilesScope({
        role: "backend-engineer",
        roots: [{ path: root, access: "write" }],
        changedFiles: ["src/orders.ts"],
        rules: WRITE_RULES,
      });
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
