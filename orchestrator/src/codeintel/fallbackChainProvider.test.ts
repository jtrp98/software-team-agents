import { describe, expect, it } from "vitest";
import { createFallbackChainProvider } from "./fallbackChainProvider.js";
import type { CodeCandidate, CodeIntelligenceProvider, ProviderStatus, TargetRef } from "./provider.js";

const TARGET: TargetRef = { targetId: "t", rootPath: "/x", revision: "r1" };
const CANDIDATE: CodeCandidate = { location: { file: "a.ts", line: 1 }, score: 1, provenance: "extracted" };
const NATIVE_CANDIDATE: CodeCandidate = { location: { file: "b.ts", line: 2 }, score: 1, provenance: "inferred" };

function providerWithStatus(status: ProviderStatus["status"], candidates: CodeCandidate[] = [CANDIDATE]): CodeIntelligenceProvider {
  return {
    isAvailable: async () => status !== "missing",
    getStatus: async () => ({ status, targetRevision: "r1", indexedRevision: status === "missing" ? null : "r1", indexedAt: null }),
    findRelevantCode: async () => candidates,
    getDependencies: async () => candidates,
    getDependents: async () => candidates,
    findPath: async () => candidates,
    getImpact: async () => candidates,
  };
}

function throwingProvider(): CodeIntelligenceProvider {
  return {
    isAvailable: async () => { throw new Error("boom"); },
    getStatus: async () => { throw new Error("boom"); },
    findRelevantCode: async () => { throw new Error("boom"); },
    getDependencies: async () => { throw new Error("boom"); },
    getDependents: async () => { throw new Error("boom"); },
    findPath: async () => { throw new Error("boom"); },
    getImpact: async () => { throw new Error("boom"); },
  };
}

describe("createFallbackChainProvider", () => {
  it("a single provider passes through unchanged", () => {
    const only = providerWithStatus("fresh");
    expect(createFallbackChainProvider([only])).toBe(only);
  });

  it("requires at least one provider", () => {
    expect(() => createFallbackChainProvider([])).toThrow();
  });

  it("uses the first provider when it is fresh — the native baseline is never even asked", async () => {
    let nativeAsked = false;
    const native: CodeIntelligenceProvider = {
      ...providerWithStatus("fresh", [NATIVE_CANDIDATE]),
      getStatus: async (target) => { nativeAsked = true; return providerWithStatus("fresh").getStatus(target); },
    };
    const chain = createFallbackChainProvider([providerWithStatus("fresh", [CANDIDATE]), native]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("fresh");
    expect(nativeAsked).toBe(false);
    await expect(chain.findRelevantCode({ target: TARGET, description: "d" })).resolves.toEqual([CANDIDATE]);
  });

  it("T-V8-023: falls through to the native baseline when the first provider reports missing (no graph exists)", async () => {
    const chain = createFallbackChainProvider([
      providerWithStatus("missing"),
      providerWithStatus("fresh", [NATIVE_CANDIDATE]),
    ]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("fresh");
    await expect(chain.findRelevantCode({ target: TARGET, description: "d" })).resolves.toEqual([NATIVE_CANDIDATE]);
  });

  it("falls through when the first provider throws while asked for status", async () => {
    const chain = createFallbackChainProvider([throwingProvider(), providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    await expect(chain.getStatus(TARGET)).resolves.toEqual(expect.objectContaining({ status: "fresh" }));
  });

  it("does NOT fall through on stale — a stale graph is a hard stop, not a reason to swap evidence sources", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("stale"), providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("stale");
  });

  it("does NOT fall through on error", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("error"), providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("error");
  });

  it("reports missing only when every provider in the chain is missing", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("missing"), providerWithStatus("missing")]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("missing");
  });

  it("isAvailable is true if any provider in the chain is available", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("missing"), providerWithStatus("fresh")]);
    await expect(chain.isAvailable()).resolves.toBe(true);
  });

  it("selection is per-call, not cached — each operation re-asks status for its own target", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("missing"), providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    await expect(chain.getDependencies({ target: TARGET, symbol: "s" })).resolves.toEqual([NATIVE_CANDIDATE]);
    await expect(chain.getDependents({ target: TARGET, symbol: "s" })).resolves.toEqual([NATIVE_CANDIDATE]);
    await expect(chain.findPath({ target: TARGET, from: "a", to: "b" })).resolves.toEqual([NATIVE_CANDIDATE]);
    await expect(chain.getImpact({ target: TARGET, symbol: "s" })).resolves.toEqual([NATIVE_CANDIDATE]);
  });
});
