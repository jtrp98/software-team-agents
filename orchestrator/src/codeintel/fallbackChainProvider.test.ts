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

  it("TASK-016: falls through to the next provider on stale — a stale graph must not leave the machine worse off than no graph at all", async () => {
    let staleQueried = false;
    const stale: CodeIntelligenceProvider = {
      ...providerWithStatus("stale"),
      findRelevantCode: async () => { staleQueried = true; return [CANDIDATE]; },
    };
    const chain = createFallbackChainProvider([stale, providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("fresh");
    expect(status.fallenThrough).toEqual({ status: "stale", indexedRevision: "r1" });
    await expect(chain.findRelevantCode({ target: TARGET, description: "d" })).resolves.toEqual([NATIVE_CANDIDATE]);
    expect(staleQueried).toBe(false);
  });

  it("TASK-016: falls through to the next provider on error, same as stale", async () => {
    const chain = createFallbackChainProvider([providerWithStatus("error"), providerWithStatus("fresh", [NATIVE_CANDIDATE])]);
    const status = await chain.getStatus(TARGET);
    expect(status.status).toBe("fresh");
    expect(status.fallenThrough).toEqual({ status: "error", indexedRevision: "r1" });
    await expect(chain.findRelevantCode({ target: TARGET, description: "d" })).resolves.toEqual([NATIVE_CANDIDATE]);
  });

  it("stale/error on the LAST provider is still a hard stop — nothing left to fall through to", async () => {
    const staleOnly = createFallbackChainProvider([providerWithStatus("missing"), providerWithStatus("stale")]);
    expect((await staleOnly.getStatus(TARGET)).status).toBe("stale");

    const errorOnly = createFallbackChainProvider([providerWithStatus("missing"), providerWithStatus("error")]);
    expect((await errorOnly.getStatus(TARGET)).status).toBe("error");
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
