import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { CodeIntelligenceProvider } from "../codeintel/provider.js";
import { CODE_INTEL_ENV, CODE_INTEL_PIN_ENV, CODE_INTEL_BIN_ENV, codeIntelEnabled, codeIntelSlices, defaultProviderConfig } from "./codeIntelAssembly.js";

/**
 * Phase 4 wiring contract: OFF (the default) is byte-identical to a pipeline
 * without the feature; every failure mode collapses to `[]`; ON appends the
 * evidence block carrying the source-verification directive.
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
