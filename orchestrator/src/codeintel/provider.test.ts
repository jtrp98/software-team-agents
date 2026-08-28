import { describe, expect, it } from "vitest";
import {
  CodeCandidate,
  CodeIntelligenceProvider,
  FreshnessStatus,
  ProviderStatus,
} from "./provider.js";

/**
 * T-GR1 acceptance: the interface is usable by ANY provider implementation
 * with zero knowledge of the tool behind it, every candidate is located and
 * provenance-tagged, and a throwing provider is a normal, catchable outcome —
 * the contract the resolver's fallback relies on.
 */

const CANDIDATE: CodeCandidate = {
  location: { file: "src/a.ts", line: 3 },
  symbol: "a",
  score: 1,
  provenance: "extracted",
};

function fakeProvider(overrides: Partial<CodeIntelligenceProvider> = {}): CodeIntelligenceProvider {
  return {
    isAvailable: async () => true,
    getStatus: async () => ({ status: "fresh", targetRevision: "r1", indexedRevision: "r1", indexedAt: null }),
    findRelevantCode: async () => [CANDIDATE],
    getDependencies: async () => [CANDIDATE],
    getDependents: async () => [CANDIDATE],
    findPath: async () => [],
    getImpact: async () => [CANDIDATE],
    ...overrides,
  };
}

describe("CodeIntelligenceProvider contract (T-GR1)", () => {
  it("accepts a full fake implementation with no tool-specific types", async () => {
    const provider = fakeProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
    const status = await provider.getStatus({ targetId: "t", rootPath: "/x", revision: "r1" });
    expect(status.status).toBe("fresh");
    expect(status).toEqual<ProviderStatus>({
      status: "fresh",
      targetRevision: "r1",
      indexedRevision: "r1",
      indexedAt: null,
    });
  });

  it("every candidate exposes source location plus provenance", () => {
    expect(CANDIDATE.location.file).toBe("src/a.ts");
    expect(CANDIDATE.location.line).toBe(3);
    expect(["extracted", "inferred"]).toContain(CANDIDATE.provenance);
  });

  it("a throwing provider surfaces its error to callers — fallback is the caller's move", async () => {
    const broken = fakeProvider({
      findRelevantCode: async () => {
        throw new Error("tool exploded");
      },
      getStatus: async () => ({ status: "missing", targetRevision: "r1", indexedRevision: null, indexedAt: null }),
    });
    await expect(broken.findRelevantCode({ target: { targetId: "t", rootPath: "/x", revision: "r" }, description: "d" })).rejects.toThrow("tool exploded");
    const status = await broken.getStatus({ targetId: "t", rootPath: "/x", revision: "r1" });
    expect(["missing", "stale", "error"]).toContain<FreshnessStatus>(status.status);
  });

  it("inferred provenance survives the DTO boundary unchanged", async () => {
    const inferred = fakeProvider({
      getImpact: async () => [{ ...CANDIDATE, provenance: "inferred", relation: "indirect_call" }],
    });
    const hits = await inferred.getImpact({ target: { targetId: "t", rootPath: "/x", revision: "r" }, symbol: "x" });
    expect(hits[0].provenance).toBe("inferred");
  });
});
