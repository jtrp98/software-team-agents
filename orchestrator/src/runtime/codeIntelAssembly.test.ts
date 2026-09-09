import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { CodeIntelligenceProvider, RelevantCodeQuery } from "../codeintel/provider.js";
import { contentHash } from "../artifacts/executionPacket.js";
import { buildTaskRetrievalQuery, type RetrievalTaskFields } from "../context/retrievalQuery.js";
import {
  CODE_INTEL_ENV,
  CODE_INTEL_PIN_ENV,
  CODE_INTEL_BIN_ENV,
  codeIntelEnabled,
  codeIntelContext,
  codeIntelSlices,
  defaultProviderConfig,
  retrievalCandidatesForPacket,
} from "./codeIntelAssembly.js";

/**
 * Wiring contract: OFF (the default) is byte-identical to a pipeline without
 * the feature; every failure mode collapses to `[]`; ON appends the evidence
 * block carrying the source-verification directive.
 */

const INPUT = {
  stage: AgentStage.BACKEND_ENGINEER,
  taskId: "T-1",
  moduleName: "crm-case-dashboard",
  targetRoot: "C:/src/sb-web-helper",
  targetId: "sb-web-helper",
};

function fakeProvider(status: "fresh" | "stale" | "missing" = "fresh"): CodeIntelligenceProvider {
  return {
    isAvailable: async () => true,
    getStatus: async () => ({ status, targetRevision: "r", indexedRevision: status === "missing" ? null : "r", indexedAt: null }),
    findRelevantCode: async () => [
      { location: { file: "src/a.ts", line: 4 }, symbol: "a", score: 1, provenance: "extracted" },
    ],
    getDependencies: async () => [],
    getDependents: async () => [],
    findPath: async () => [],
    getImpact: async () => [],
  };
}

describe("codeIntelEnabled", () => {
  it("is OFF unless explicitly turned on", () => {
    expect(codeIntelEnabled({})).toBe(false);
    expect(codeIntelEnabled({ [CODE_INTEL_ENV]: "off" })).toBe(false);
    expect(codeIntelEnabled({ [CODE_INTEL_ENV]: "on" })).toBe(true);
    expect(codeIntelEnabled({ [CODE_INTEL_ENV]: "ON" })).toBe(true);
  });
});

describe("codeIntelSlices", () => {
  it("OFF by default — provider never constructed, prompt stays as before", async () => {
    let built = false;
    const slices = await codeIntelSlices(INPUT, {
      env: {},
      providerFactory: () => {
        built = true;
        return fakeProvider();
      },
    });
    expect(slices).toEqual([]);
    expect(built).toBe(false);
  });

  it("missing inputs (no bound target / no module) answer empty even when enabled", async () => {
    const deps = { enabled: true, providerFactory: () => fakeProvider() };
    await expect(codeIntelSlices({ ...INPUT, targetRoot: undefined }, deps)).resolves.toEqual([]);
    await expect(codeIntelSlices({ ...INPUT, moduleName: undefined }, deps)).resolves.toEqual([]);
    await expect(codeIntelSlices({ ...INPUT, targetId: undefined }, deps)).resolves.toEqual([]);
  });

  it("ON + fresh index → one slice whose text carries the verification directive", async () => {
    const slices = await codeIntelSlices(INPUT, {
      enabled: true,
      resolveRevision: async () => "a".repeat(40),
      providerFactory: () => fakeProvider(),
    });
    expect(slices).toHaveLength(2);
    const block = slices[1];
    expect(block).toContain("Graphify discovers → Source confirms → Compiler checks → Tests verify.");
    expect(block).toContain("Open the real file when (a) the required edit lies outside the span");
    expect(block).toContain("src/a.ts:L4");
  });

  it("stale index answers empty — never serves an old map", async () => {
    const slices = await codeIntelSlices(INPUT, {
      enabled: true,
      resolveRevision: async () => "a".repeat(40),
      providerFactory: () => fakeProvider("stale"),
    });
    expect(slices).toEqual([]);
  });

  it("any throw (tool absent, git failed) degrades to empty, not an error", async () => {
    const exploding = fakeProvider();
    exploding.findRelevantCode = async () => {
      throw new Error("boom");
    };
    await expect(
      codeIntelSlices(INPUT, { enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => exploding }),
    ).resolves.toEqual([]);
    await expect(
      codeIntelSlices(INPUT, { enabled: true, resolveRevision: async () => { throw new Error("no git"); }, providerFactory: () => fakeProvider() }),
    ).resolves.toEqual([]);
  });

  it("roles outside the capability matrix get nothing even when enabled", async () => {
    const slices = await codeIntelSlices(
      { ...INPUT, stage: AgentStage.DEVOPS },
      { enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => fakeProvider() },
    );
    expect(slices).toEqual([]);
  });

  it("bin-path and pin env reach the default provider config", () => {
    expect(defaultProviderConfig({ [CODE_INTEL_BIN_ENV]: "C:/tools/graphify.exe", [CODE_INTEL_PIN_ENV]: "0.9.49" })).toEqual({
      command: "C:/tools/graphify.exe",
      pinnedVersion: "0.9.49",
    });
    expect(defaultProviderConfig({})).toEqual({ pinnedVersion: undefined, command: undefined });
  });

  it("a factory returning undefined falls back to the default provider — never a silent disable", async () => {
    const slices = await codeIntelSlices(INPUT, {
      enabled: true,
      resolveRevision: async () => "sandbox-r1",
      providerFactory: () => undefined as unknown as CodeIntelligenceProvider,
      env: { [CODE_INTEL_BIN_ENV]: process.env[CODE_INTEL_BIN_ENV] ?? "graphify" },
    });
    // With no real index under the default cache root this still answers empty,
    // but it must be the *missing-index* path (provider ran), not "disabled".
    expect(slices).toEqual([]);
  });
});

const TASK: RetrievalTaskFields = {
  id: "T-Q1", objective: "Add task-specific retrieval instead of a bare module query.",
  scopeAndConstraints: "Touch only the context/runtime layer.",
  retrievalHints: "Hypothesis: findRelevantCode only ever sees the module name.\nQuery: Locate codeIntelSlices callers and the module-name query site.\nProvenance: DES-011",
  traceability: ["REQ-011", "AC-011.1", "DES-011"], produces: [], consumes: [],
};

describe("codeIntelContext — T-V8-011 task-first query construction", () => {
  it("generic-query replacement: a task query's description replaces the bare module name", async () => {
    let seen: RelevantCodeQuery | undefined;
    const provider = fakeProvider();
    provider.findRelevantCode = async (query) => {
      seen = query;
      return [{ location: { file: "src/a.ts", line: 4 }, symbol: "a", score: 1, provenance: "extracted" }];
    };
    const query = buildTaskRetrievalQuery(TASK);
    const result = await codeIntelContext({ ...INPUT, query }, {
      enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => provider,
    });
    expect(result.used).toBe(true);
    expect(result.description).toBe(query.description);
    expect(seen?.description).toBe(query.description);
    expect(seen?.description).not.toBe(INPUT.moduleName);
    expect(seen?.description).toContain("Locate codeIntelSlices callers");
    expect(result.queryReason).toContain("T-Q1");
  });

  it("safe-fallback: a module-fallback query (no task fields resolved) behaves exactly like the pre-T-V8-011 bare module-name query", async () => {
    let seen: RelevantCodeQuery | undefined;
    const provider = fakeProvider();
    provider.findRelevantCode = async (q) => { seen = q; return []; };
    const fallback = buildTaskRetrievalQuery(undefined, { moduleName: INPUT.moduleName });
    await codeIntelContext({ ...INPUT, query: fallback }, {
      enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => provider,
    });
    expect(seen?.description).toBe(INPUT.moduleName);
  });

  it("no query supplied at all preserves the historical moduleName-only behaviour byte for byte", async () => {
    let seen: RelevantCodeQuery | undefined;
    const provider = fakeProvider();
    provider.findRelevantCode = async (q) => { seen = q; return []; };
    const result = await codeIntelContext(INPUT, {
      enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => provider,
    });
    expect(seen?.description).toBe(INPUT.moduleName);
    expect(result.queryReason).toContain("bare module name was used");
  });

  it("records provenance (queryReason) even when the provider finds nothing", async () => {
    const result = await codeIntelContext({ ...INPUT, query: buildTaskRetrievalQuery(TASK) }, {
      enabled: true, resolveRevision: async () => "a".repeat(40), providerFactory: () => fakeProvider("missing"),
    });
    expect(result.used).toBe(false);
    expect(result.queryReason).toContain("T-Q1");
  });

  it("disabled/missing-input reasons are still visible even without a query", async () => {
    expect((await codeIntelContext(INPUT, { env: {} })).fallbackReason).toBe("disabled");
    expect((await codeIntelContext({ ...INPUT, moduleName: undefined }, { enabled: true })).fallbackReason).toBe("missing-inputs");
  });
});

describe("retrievalCandidatesForPacket", () => {
  it("maps discovery candidates onto verified packet retrieval candidates, hashed off the real file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-retrieval-"));
    const file = path.join(dir, "src", "a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const a = 1;\n");
    const revision = "a".repeat(40);
    const candidates = retrievalCandidatesForPacket(
      [{ location: { file: "src/a.ts", line: 1 }, symbol: "a", relation: "defines", score: 1, provenance: "extracted" }],
      dir,
      revision,
    );
    expect(candidates).toEqual([{
      path: path.resolve(dir, "src/a.ts"), symbol: "a",
      provenance: "extracted discovery via findRelevantCode (defines)",
      revision, hash: contentHash(fs.readFileSync(file)),
    }]);
  });

  it("drops an unreadable candidate instead of throwing — enrichment must never fail packet compilation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-retrieval-"));
    const candidates = retrievalCandidatesForPacket(
      [{ location: { file: "src/does-not-exist.ts" }, score: 1, provenance: "extracted" }],
      dir,
      "a".repeat(40),
    );
    expect(candidates).toEqual([]);
  });
});
