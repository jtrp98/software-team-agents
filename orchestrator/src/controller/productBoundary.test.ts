import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { LocalWorkspace, WorkspaceWriteDeniedError } from "../runtime/localWorkspace.js";
import { createStaApi, type StaApi } from "./staApi.js";
import { issueAttemptGrant, AttemptGrantRejectedError } from "../governance/attemptGrant.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { verifyChangedFilesScope } from "../runtime/postflight.js";

const SCOPE = {
  write: [],
  deny: [],
  stack: { write: [], deny: [] },
};
const NOW = 1_700_000_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sta-boundary-test-"));
}

describe("Product Repo Write Boundary (V13 TASK-022)", () => {
  describe("Controller direct write prevention", () => {
    it("does not expose any file-writing methods to Controller callers on StaApi", () => {
      const api: StaApi = createStaApi({ store: new MemoryTaskStore() });
      const apiObj = api as unknown as Record<string, unknown>;

      expect(apiObj.writeFile).toBeUndefined();
      expect(apiObj.modifyFile).toBeUndefined();
      expect(apiObj.createFile).toBeUndefined();
      expect(apiObj.deleteFile).toBeUndefined();
      expect(apiObj.runCommand).toBeUndefined();
      expect(apiObj.shell).toBeUndefined();
    });

    it("prevents any direct writes when workspace is configured as read-only", async () => {
      const targetRoot = tmpDir();
      const ws = new LocalWorkspace({ root: targetRoot, readOnly: true });

      await expect(ws.writeFile("src/server.ts", "console.log(1);")).rejects.toThrow(WorkspaceWriteDeniedError);
      await expect(ws.writeFile("src/server.ts", "console.log(1);")).rejects.toThrow(/workspace is read-only/);
    });
  });

  describe("Non-engineer roles denied Product Repo write grant", () => {
    it("denies write grant to Product Repo for Business Analyst", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      expect(() =>
        issueAttemptGrant(store, {
          stateRoot: root,
          taskId: "T-BA",
          stage: AgentStage.BUSINESS_ANALYST,
          role: "business-analyst",
          contractDigest: "a".repeat(64),
          scope: SCOPE,
          workRoots: [{ targetId: "product-repo", path: root, access: "write" }],
          ttlMs: 3_600_000,
          now: NOW,
          random: (size) => Buffer.alloc(size, 1),
        }),
      ).toThrow(AttemptGrantRejectedError);

      expect(() =>
        issueAttemptGrant(store, {
          stateRoot: root,
          taskId: "T-BA",
          stage: AgentStage.BUSINESS_ANALYST,
          role: "business-analyst",
          contractDigest: "a".repeat(64),
          scope: SCOPE,
          workRoots: [{ targetId: "product-repo", path: root, access: "write" }],
          ttlMs: 3_600_000,
          now: NOW,
          random: (size) => Buffer.alloc(size, 1),
        }),
      ).toThrow(/Product write grant is restricted to Engineer attempts/);
    });

    it("denies write grant to Product Repo for System Analyst", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      expect(() =>
        issueAttemptGrant(store, {
          stateRoot: root,
          taskId: "T-SA",
          stage: AgentStage.SYSTEM_ANALYST,
          role: "system-analyst",
          contractDigest: "a".repeat(64),
          scope: SCOPE,
          workRoots: [{ targetId: "product-repo", path: root, access: "write" }],
          ttlMs: 3_600_000,
          now: NOW,
          random: (size) => Buffer.alloc(size, 1),
        }),
      ).toThrow(AttemptGrantRejectedError);
    });

    it("denies write grant to Product Repo for Reviewer", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      expect(() =>
        issueAttemptGrant(store, {
          stateRoot: root,
          taskId: "T-REV",
          stage: AgentStage.REVIEWER,
          role: "reviewer",
          contractDigest: "a".repeat(64),
          scope: SCOPE,
          workRoots: [{ targetId: "product-repo", path: root, access: "write" }],
          ttlMs: 3_600_000,
          now: NOW,
          random: (size) => Buffer.alloc(size, 1),
        }),
      ).toThrow(AttemptGrantRejectedError);
    });

    it("denies write grant to Product Repo for QA Engineer", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      expect(() =>
        issueAttemptGrant(store, {
          stateRoot: root,
          taskId: "T-QA",
          stage: AgentStage.QA_ENGINEER,
          role: "qa-engineer",
          contractDigest: "a".repeat(64),
          scope: SCOPE,
          workRoots: [{ targetId: "product-repo", path: root, access: "write" }],
          ttlMs: 3_600_000,
          now: NOW,
          random: (size) => Buffer.alloc(size, 1),
        }),
      ).toThrow(AttemptGrantRejectedError);
    });

    it("allows read access to Product Repo for Non-engineer roles", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      const grant = issueAttemptGrant(store, {
        stateRoot: root,
        taskId: "T-QA",
        stage: AgentStage.QA_ENGINEER,
        role: "qa-engineer",
        contractDigest: "a".repeat(64),
        scope: SCOPE,
        workRoots: [{ targetId: "product-repo", path: root, access: "read" }],
        ttlMs: 3_600_000,
        now: NOW,
        random: (size) => Buffer.alloc(size, 1),
      });

      expect(grant.token.work_roots).toEqual([
        { targetId: "product-repo", path: root, access: "read" },
      ]);
    });
  });

  describe("Engineer dispatch granted scoped write to Product Repo", () => {
    it("grants write access to Product Repo for Backend Engineer", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      const grant = issueAttemptGrant(store, {
        stateRoot: root,
        taskId: "T-BE",
        stage: AgentStage.BACKEND_ENGINEER,
        role: "backend-engineer",
        contractDigest: "a".repeat(64),
        scope: SCOPE,
        workRoots: [{ targetId: "backend-target", path: root, access: "write" }],
        ttlMs: 3_600_000,
        now: NOW,
        random: (size) => Buffer.alloc(size, 1),
      });

      expect(grant.token.work_roots).toEqual([
        { targetId: "backend-target", path: root, access: "write" },
      ]);
    });

    it("grants write access to Product Repo for Frontend Engineer", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      const grant = issueAttemptGrant(store, {
        stateRoot: root,
        taskId: "T-FE",
        stage: AgentStage.FRONTEND_ENGINEER,
        role: "frontend-engineer",
        contractDigest: "a".repeat(64),
        scope: SCOPE,
        workRoots: [{ targetId: "frontend-target", path: root, access: "write" }],
        ttlMs: 3_600_000,
        now: NOW,
        random: (size) => Buffer.alloc(size, 1),
      });

      expect(grant.token.work_roots).toEqual([
        { targetId: "frontend-target", path: root, access: "write" },
      ]);
    });

    it("grants write access to Product Repo for DevOps", () => {
      const store = new MemoryTaskStore();
      const root = tmpDir();

      const grant = issueAttemptGrant(store, {
        stateRoot: root,
        taskId: "T-DO",
        stage: AgentStage.DEVOPS,
        role: "devops",
        contractDigest: "a".repeat(64),
        scope: SCOPE,
        workRoots: [{ targetId: "deploy-target", path: root, access: "write" }],
        ttlMs: 3_600_000,
        now: NOW,
        random: (size) => Buffer.alloc(size, 1),
      });

      expect(grant.token.work_roots).toEqual([
        { targetId: "deploy-target", path: root, access: "write" },
      ]);
    });
  });

  describe("Out-of-scope diff rejection by postflight", () => {
    it("fails postflight when a read-only root was modified", () => {
      const targetRoot = tmpDir();
      const check = verifyChangedFilesScope({
        role: "qa-engineer",
        roots: [{ targetId: "product-repo", path: targetRoot, access: "read" }],
        changedFiles: ["src/app.ts"],
        rules: { write: ["**/*"], deny: [] },
        fileExists: () => false,
      });

      expect(check.ok).toBe(false);
      expect(check.violations).toHaveLength(1);
      expect(check.violations[0]).toContain('read-only root "product-repo" changed: src/app.ts');
    });

    it("fails postflight on multi-root when a read-only root was modified", () => {
      const targetRoot = tmpDir();
      const knowledgeRoot = tmpDir();
      const check = verifyChangedFilesScope({
        role: "reviewer",
        roots: [
          { targetId: "product-repo", path: targetRoot, access: "read" },
          { targetId: "knowledge", path: knowledgeRoot, access: "read" },
        ],
        changedFiles: ["product-repo:src/app.ts"],
        rules: { write: ["**/*"], deny: [] },
        fileExists: () => false,
      });

      expect(check.ok).toBe(false);
      expect(check.violations).toHaveLength(1);
      expect(check.violations[0]).toContain('read-only root "product-repo" changed: src/app.ts');
    });

    it("fails postflight when an engineer changes a path outside allowed write rules", () => {
      const targetRoot = tmpDir();
      const check = verifyChangedFilesScope({
        role: "backend-engineer",
        roots: [{ targetId: "backend-target", path: targetRoot, access: "write" }],
        changedFiles: [".github/workflows/deploy.yml"],
        rules: { write: ["src/**"], deny: [".github/**"] },
        fileExists: () => false,
      });

      expect(check.ok).toBe(false);
      expect(check.violations.length).toBeGreaterThan(0);
      expect(check.violations[0]).toContain("this role's contract denies .github/**");
    });

    it("passes postflight when engineer modifies files strictly within allowed write scope", () => {
      const targetRoot = tmpDir();
      const check = verifyChangedFilesScope({
        role: "backend-engineer",
        roots: [{ targetId: "backend-target", path: targetRoot, access: "write" }],
        changedFiles: ["src/api/users.ts"],
        rules: { write: ["src/**"], deny: [".git/**", "node_modules/**"] },
        fileExists: () => false,
      });

      expect(check.ok).toBe(true);
      expect(check.violations).toEqual([]);
    });
  });
});
