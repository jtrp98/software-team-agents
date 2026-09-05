import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GraphifyProvider,
  SubprocessResult,
  parseAffectedLines,
  parseExplainLines,
  parseNodeLines,
} from "./graphifyProvider.js";
import {
  CodeIntelligenceError,
  MalformedResponseError,
  OversizedOutputError,
  ProviderNotInstalledError,
  ProviderTimeoutError,
} from "./provider.js";
import { writeMetadata } from "./freshness.js";

/**
 * Proven against REAL captures from graphifyy v0.9.49
 * (planning/v2/graphify-spike-evidence/ — sb-web-helper). CI never runs the
 * real binary: the transport is a stub returning these fixtures.
 */

const TARGET = { targetId: "t1", rootPath: "C:/src/target", revision: "a".repeat(40) };

const QUERY_FIXTURE = `Graph: cache/graph.json (16724 nodes) | Traversal: BFS depth=2 | Start: ['Permission'] | 608 nodes found

[!] TRUNCATED: showing 3 of 608 nodes (~2000-token budget).

NODE Permission [src=src/app/pages/admin/permission/_stores/permission-management-store.ts loc=L23 community=71]
NODE CrmCaseSettingsApiResponse [src=src/app/pages/support/crm/settings/_api/crm-case-settings-service.ts loc=L91 community=109]
NODE errorResponse() [src=src/helpers/api/response.ts loc=L66 community=2]
... (truncated — more nodes cut by ~2000-token budget)`;

const AFFECTED_FIXTURE = `Affected nodes for sidebar-menu-constant.tsx
Relations: calls, indirect_call, references, imports, imports_from
Depth: 2
- permissions-tab.tsx [imports_from] src/app/pages/admin/permission/_components/permissions-tab.tsx:L5
- PermissionsTab() [calls] src/app/pages/admin/permission/_components/permissions-tab.tsx:L174
- Breadcrumb() [calls] [INFERRED] src/components/breadcrumb/breadcrumb.tsx:L60`;

function ok(stdout: string): SubprocessResult {
  return { code: 0, stdout, stderr: "" };
}

/** Seeds a cache root whose freshness gate answers "fresh" for TARGET. */
function freshCacheRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-adapter-"));
  writeMetadata(root, {
    provider: "graphify",
    tool_version: "0.9.49",
    target_id: TARGET.targetId,
    target_revision: TARGET.revision,
    indexed_revision: TARGET.revision,
    indexed_at: "2026-08-26T00:00:00.000Z",
    code_only: true,
  });
  fs.mkdirSync(path.join(root, TARGET.targetId, TARGET.revision, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(root, TARGET.targetId, TARGET.revision, "graphify-out", "graph.json"), "{}", "utf8");
  return root;
}

describe("parsers — locked to v0.9.49 output shapes", () => {
  it("query output → candidates with file+line+symbol, ranked in tool order", () => {
    const parsed = parseNodeLines(QUERY_FIXTURE);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      location: { file: "src/app/pages/admin/permission/_stores/permission-management-store.ts", line: 23 },
      symbol: "Permission",
      provenance: "extracted",
    });
    expect(parsed[0].score).toBeGreaterThan(parsed[1].score);
    expect(parsed[0].span).toBeUndefined();
    expect(parsed[0].signature).toBeUndefined();
    // banner and truncation lines produce nothing
    expect(parseNodeLines("[!] TRUNCATED: showing 1 of 2 nodes")).toHaveLength(0);
    expect(parseNodeLines("Graph: x | Traversal: BFS depth=2 | Start: ['a'] | 5 nodes found")).toHaveLength(0);
  });

  it("affected/path output → relation-tagged candidates; INFERRED preserved; empty path answer stays empty", () => {
    const parsed = parseAffectedLines(AFFECTED_FIXTURE);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      symbol: "permissions-tab.tsx",
      relation: "imports_from",
      location: { file: "src/app/pages/admin/permission/_components/permissions-tab.tsx", line: 5 },
    });
    expect(parsed[2].provenance).toBe("inferred");
    expect(parseAffectedLines("No directed path found between 'A' and 'B'")).toHaveLength(0);
  });

  it("explain connections split by direction arrow with provenance tag", () => {
    const explain = `Node: StatusModalProps
  ID:        src_components_modal_status_modal_statusmodalprops
  Source:    src/components/modal/status-modal.tsx L10
  Degree:    1

Connections (1):
  <-- status-modal.tsx [contains] [EXTRACTED] src/components/modal/status-modal.tsx:L10
  --> modal-shell.tsx [imports] [EXTRACTED] src/components/modal/modal-shell.tsx:L4`;
    const inbound = parseExplainLines(explain, "inbound");
    const outbound = parseExplainLines(explain, "outbound");
    expect(inbound).toEqual([
      expect.objectContaining({ location: { file: "src/components/modal/status-modal.tsx", line: 10 }, relation: "contains", provenance: "extracted" }),
    ]);
    expect(outbound[0].location.file).toBe("src/components/modal/modal-shell.tsx");
  });
});

describe("GraphifyProvider through the stub transport", () => {
  it("happy path: query parses into capped, deduped candidates", async () => {
    const root = freshCacheRoot();
    try {
      const provider = new GraphifyProvider({ cacheRoot: root, runner: async () => ok(QUERY_FIXTURE) });
      const hits = await provider.findRelevantCode({ target: TARGET, description: "crm permission check" });
      expect(hits).toHaveLength(3);
      expect(hits[0].location.file).toContain("permission-management-store.ts");

      const capped = new GraphifyProvider({ cacheRoot: root, config: { maxCandidates: 2 }, runner: async () => ok(QUERY_FIXTURE) });
      expect(await capped.findRelevantCode({ target: TARGET, description: "anything" })).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("freshness gate runs before any subprocess call — a stale index never reaches the binary", async () => {
    let calls = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-stale-"));
    try {
      writeMetadata(root, {
        provider: "graphify",
        tool_version: "0.9.49",
        target_id: TARGET.targetId,
        target_revision: "b".repeat(40), // indexed a different revision than TARGET's HEAD
        indexed_revision: "b".repeat(40),
        indexed_at: "2026-08-26T00:00:00.000Z",
        code_only: true,
      });
      fs.mkdirSync(path.join(root, TARGET.targetId, "b".repeat(40), "graphify-out"), { recursive: true });
      fs.writeFileSync(path.join(root, TARGET.targetId, "b".repeat(40), "graphify-out", "graph.json"), "{}");
      const provider = new GraphifyProvider({
        cacheRoot: root,
        runner: async () => {
          calls += 1;
          return ok("");
        },
      });
      await expect(provider.getImpact({ target: TARGET, symbol: "x" })).rejects.toBeInstanceOf(CodeIntelligenceError);
      expect(calls).toBe(0);
      const status = await provider.getStatus(TARGET);
      expect(status.status).toBe("stale");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("error mapping: ENOENT → not-installed, timeout flag → timeout, oversized keeps its type", async () => {
    const enoent = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      runner: async () => {
        const error = new Error("spawn graphify ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });
    await expect(enoent.getImpact({ target: TARGET, symbol: "x" })).rejects.toBeInstanceOf(ProviderNotInstalledError);

    const timedOut = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      runner: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }),
    });
    await expect(timedOut.getImpact({ target: TARGET, symbol: "x" })).rejects.toBeInstanceOf(ProviderTimeoutError);

    const oversized = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      // mirrors what spawnRunner does when the byte cap trips mid-stream
      runner: async () => {
        throw new OversizedOutputError("output exceeded cap");
      },
    });
    await expect(oversized.getImpact({ target: TARGET, symbol: "x" })).rejects.toBeInstanceOf(OversizedOutputError);
  });

  it("non-zero exit surfaces only the last stderr line — no dumps in errors (B7)", async () => {
    const failing = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      runner: async () => ({ code: 3, stdout: "", stderr: "line one\nboom: graph missing" }),
    });
    await expect(failing.getImpact({ target: TARGET, symbol: "x" })).rejects.toThrow(/exited 3: boom: graph missing/);
  });

  it("unrecognised non-empty output is malformed — silence would be a lie", async () => {
    const weird = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      runner: async () => ok("totally unexpected banner"),
    });
    await expect(weird.getImpact({ target: TARGET, symbol: "x" })).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it("empty stdout is an honest empty result (resolver falls back on it)", async () => {
    const empty = new GraphifyProvider({ cacheRoot: freshCacheRoot(), runner: async () => ok("") });
    await expect(empty.getImpact({ target: TARGET, symbol: "x" })).resolves.toEqual([]);
  });

  it("undefined config entries never clobber defaults (env-var-miss pattern)", async () => {
    const provider = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      config: { command: undefined, pinnedVersion: undefined },
      runner: async () => {
        return ok("NODE a [src=src/a.ts loc=L1]");
      },
    });
    const hits = await provider.findRelevantCode({ target: TARGET, description: "x" });
    expect(hits).toHaveLength(1);
  });

  it("isAvailable honours the version pin", async () => {
    const pinned = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      config: { pinnedVersion: "v0.9.49" },
      runner: async () => ok("graphifyy v0.9.49\n"),
    });
    await expect(pinned.isAvailable()).resolves.toBe(true);

    const drifted = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      config: { pinnedVersion: "v0.9.49" },
      runner: async () => ok("graphifyy v0.9.50\n"),
    });
    await expect(drifted.isAvailable()).resolves.toBe(false);
  });

  it("impact depth is clamped to the tool's sane range", async () => {
    const seen: string[][] = [];
    const provider = new GraphifyProvider({
      cacheRoot: freshCacheRoot(),
      runner: async (_command, args) => {
        seen.push(args);
        return ok(AFFECTED_FIXTURE);
      },
    });
    await provider.getImpact({ target: TARGET, symbol: "x", depth: 99 });
    expect(seen[0]).toEqual(expect.arrayContaining(["--depth", "5"]));
  });
});
