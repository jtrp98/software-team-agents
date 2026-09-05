import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeFreshness,
  getStatus,
  assertQueryAllowed,
  readMetadata,
  writeMetadata,
} from "./freshness.js";
import { IndexError, MissingIndexError, StaleIndexError } from "./provider.js";

const REV = "a".repeat(40);

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-fresh-"));
}

function seed(root: string, revision: string, opts: { graph?: boolean; metadata?: Record<string, unknown> | null } = {}) {
  if (opts.metadata !== null) {
    writeMetadata(root, {
      provider: "graphify",
      tool_version: "0.9.49",
      target_id: "t1",
      target_revision: revision,
      indexed_revision: revision,
      indexed_at: "2026-08-26T00:00:00.000Z",
      code_only: true,
      ...(opts.metadata ?? {}),
    });
  }
  if (opts.graph !== false) {
    const graph = path.join(root, "t1", revision, "graphify-out");
    fs.mkdirSync(graph, { recursive: true });
    fs.writeFileSync(path.join(graph, "graph.json"), "{}", "utf8");
  }
}

describe("computeFreshness — the four statuses (T-GR3)", () => {
  it("fresh: sidecar and graph exist, revisions match", () => {
    expect(
      computeFreshness({
        metadata: { provider: "graphify", tool_version: "v", target_id: "t1", target_revision: REV, indexed_revision: REV, indexed_at: "now", code_only: true },
        graphExists: true,
        currentRevision: REV,
      }),
    ).toBe("fresh");
  });

  it("stale: index built from a different revision must never pass as fresh", () => {
    expect(
      computeFreshness({
        metadata: { provider: "graphify", tool_version: "v", target_id: "t1", target_revision: REV, indexed_revision: REV, indexed_at: "now", code_only: true },
        graphExists: true,
        currentRevision: "b".repeat(40),
      }),
    ).toBe("stale");
  });

  it("missing: no sidecar or no graph file both mean missing", () => {
    const metadata = { provider: "graphify", tool_version: "v", target_id: "t1", target_revision: REV, indexed_revision: REV, indexed_at: "now", code_only: true };
    expect(computeFreshness({ metadata: null, graphExists: true, currentRevision: REV })).toBe("missing");
    expect(computeFreshness({ metadata, graphExists: false, currentRevision: REV })).toBe("missing");
    expect(computeFreshness({ metadata, graphExists: false, currentRevision: "b".repeat(40) })).toBe("missing");
  });

  it("error: a sidecar that contradicts itself is invalid, not stale", () => {
    expect(
      computeFreshness({
        metadata: { provider: "graphify", tool_version: "v", target_id: "t1", target_revision: REV, indexed_revision: "c".repeat(40), indexed_at: "now", code_only: true },
        graphExists: true,
        currentRevision: REV,
      }),
    ).toBe("error");
  });
});

describe("the query gate", () => {
  it("fresh passes; every other status throws its typed error", () => {
    const base = { targetRevision: REV, indexedRevision: REV, indexedAt: null };
    expect(() => assertQueryAllowed({ ...base, status: "fresh" })).not.toThrow();
    expect(() => assertQueryAllowed({ ...base, status: "stale" })).toThrow(StaleIndexError);
    expect(() => assertQueryAllowed({ ...base, status: "missing" })).toThrow(MissingIndexError);
    expect(() => assertQueryAllowed({ ...base, status: "error" })).toThrow(IndexError);
  });
});

describe("metadata round-trip on disk", () => {
  it("reads back what was written; unreadable/absent files are missing, not crashes", () => {
    const root = tempRoot();
    try {
      expect(readMetadata(root, "t1", REV)).toBeNull();
      seed(root, REV);
      const metadata = readMetadata(root, "t1", REV);
      expect(metadata?.indexed_revision).toBe(REV);
      expect(metadata?.provider).toBe("graphify");
      // A truncated/corrupt sidecar degrades to missing so queries fall back.
      fs.writeFileSync(path.join(root, "t1", REV, "graphify-metadata.yaml"), "{ not: [valid", "utf8");
      expect(readMetadata(root, "t1", REV)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("getStatus reports the verdict plus what it knows about the index", () => {
    const root = tempRoot();
    try {
      seed(root, REV);
      const fresh = getStatus(root, "t1", REV);
      expect(fresh.status).toBe("fresh");
      expect(fresh.indexedRevision).toBe(REV);

      // checkout moved to a new revision with no index for it yet — but an
      // index for the OLD revision exists: that is precisely "stale", and the
      // report says which revision the map actually describes.
      const other = "b".repeat(40);
      fs.mkdirSync(path.join(root, "t1", other, "graphify-out"), { recursive: true });
      const stale = getStatus(root, "t1", other);
      expect(stale.status).toBe("stale");
      expect(stale.indexedRevision).toBe(REV);

      // a graph without its sidecar is not evidence of anything
      seed(root, other, { metadata: null });
      expect(getStatus(root, "t1", other).status).toBe("stale");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
