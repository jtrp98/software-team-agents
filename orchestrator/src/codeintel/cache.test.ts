import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CACHE_ROOT_ENV,
  cacheStats,
  defaultCacheRoot,
  deleteRevision,
  directorySizeBytes,
  pruneCache,
  revisionDir,
} from "./cache.js";

/**
 * T-GR4 acceptance: revision-scoped layout, working prune/retention with a
 * size cap, and — the DoD — nothing this module writes can ever end up inside
 * the Framework package because the default home is the OS cache area.
 */

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-cache-"));
}

function seedRevision(root: string, targetId: string, revision: string, files: Record<string, number>, modifiedAt?: Date): string {
  const dir = revisionDir(root, targetId, revision);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), "x".repeat(size), "utf8");
  }
  if (modifiedAt) fs.utimesSync(dir, modifiedAt, modifiedAt);
  return dir;
}

describe("cache layout", () => {
  it("default root is machine-local (never inside a repo)", () => {
    const original = process.env[CACHE_ROOT_ENV];
    delete process.env[CACHE_ROOT_ENV];
    try {
      if (process.platform === "win32") {
        expect(defaultCacheRoot()).toContain(path.join("software-team-agents", "cache", "code-intelligence"));
      } else {
        expect(defaultCacheRoot().startsWith(os.homedir()) || defaultCacheRoot().startsWith(os.tmpdir())).toBe(true);
      }
    } finally {
      if (original !== undefined) process.env[CACHE_ROOT_ENV] = original;
    }
  });

  it("env override wins (deterministic tests / relocated caches)", () => {
    const original = process.env[CACHE_ROOT_ENV];
    process.env[CACHE_ROOT_ENV] = path.join(os.tmpdir(), "relocated");
    try {
      expect(defaultCacheRoot()).toBe(path.resolve(path.join(os.tmpdir(), "relocated")));
    } finally {
      if (original === undefined) delete process.env[CACHE_ROOT_ENV];
      else process.env[CACHE_ROOT_ENV] = original;
    }
  });

  it("path traversal in ids or revisions is refused", () => {
    expect(() => revisionDir("/root", "../evil", "rev")).toThrow();
    expect(() => revisionDir("/root", "t", "..\\evil")).toThrow();
  });

  it("sizes and stats see every seeded revision", () => {
    const root = tempRoot();
    try {
      seedRevision(root, "t1", "r1", { "graph.json": 100 });
      seedRevision(root, "t1", "r2", { "graph.json": 50 }, new Date(2020, 0, 1));
      expect(directorySizeBytes(revisionDir(root, "t1", "r1"))).toBe(100);
      const stats = cacheStats(root);
      expect(stats.bytes).toBe(150);
      expect(stats.revisions).toHaveLength(2);
      // oldest first — the order pruning consumes
      expect(stats.revisions[0].revision).toBe("r2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prune / retention / deletion", () => {
  it("age-based retention drops only old revisions", () => {
    const root = tempRoot();
    try {
      const now = new Date(2026, 7, 26);
      seedRevision(root, "t1", "old", { f: 10 }, new Date(now.getTime() - 40 * 24 * 3600 * 1000));
      seedRevision(root, "t1", "new", { f: 10 }, now);
      const { removed } = pruneCache(root, { maxAgeDays: 30, now: now.getTime() });
      expect(removed.some((dir) => dir.endsWith("old"))).toBe(true);
      expect(fs.existsSync(revisionDir(root, "t1", "new"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("size cap evicts oldest-first until under budget; rebuild-from-empty still works", () => {
    const root = tempRoot();
    try {
      seedRevision(root, "t1", "big-old", { f: 80 }, new Date(2024, 0, 1));
      seedRevision(root, "t1", "small-new", { f: 30 }, new Date(2026, 0, 1));
      pruneCache(root, { maxTotalBytes: 50 });
      expect(fs.existsSync(revisionDir(root, "t1", "big-old"))).toBe(false);
      expect(fs.existsSync(revisionDir(root, "t1", "small-new"))).toBe(true);

      // rebuild-from-empty semantics: writing again just works, alongside survivors
      seedRevision(root, "t1", "fresh", { f: 5 });
      expect(cacheStats(root).bytes).toBe(35);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explicit revision deletion removes exactly one revision", () => {
    const root = tempRoot();
    try {
      seedRevision(root, "t1", "a", { f: 1 });
      seedRevision(root, "t1", "b", { f: 1 });
      expect(deleteRevision(root, "t1", "a")).toBe(true);
      expect(deleteRevision(root, "t1", "a")).toBe(false);
      expect(fs.existsSync(revisionDir(root, "t1", "b"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
