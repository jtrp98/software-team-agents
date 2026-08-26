import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  CodeCandidate,
  MalformedResponseError,
  ProviderNotInstalledError,
  ProviderTimeoutError,
} from "./provider.js";
import {
  CODE_INTEL_EVENTS,
  FallbackReason,
  rankAndTrim,
  renderEvidenceBlock,
  resolveCodeContext,
  SOURCE_OF_TRUTH_SENTENCE,
} from "./resolver.js";
import { GraphifyProvider } from "./graphifyProvider.js";

/**
 * T-GR5 (resolver flow), T-GR6 (source verification), T-GR10 (capability
 * matrix), T-GR11 (optional provider, default OFF), T-GR13 (audit telemetry).
 */

const TARGET = { targetId: "t1", rootPath: "/repo", revision: "a".repeat(40) };

function candidate(file: string, line?: number, score = 1, provenance: "extracted" | "inferred" = "extracted"): CodeCandidate {
  return { location: { file, line }, symbol: file, score, provenance };
}

function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: async () => true,
    getStatus: async () => ({ status: "fresh" as const, targetRevision: TARGET.revision, indexedRevision: TARGET.revision, indexedAt: null }),
    findRelevantCode: async () => [candidate("src/a.ts", 3)],
    getDependencies: async () => [candidate("src/b.ts", 8)],
    getDependents: async () => [candidate("src/c.ts")],
    findPath: async () => [],
    getImpact: async () => [candidate("src/d.ts", 12)],
    ...overrides,
  };
}

interface RecordedEvent { taskId: string; at: number; type: string; payload: Record<string, unknown> }

function recorder() {
  const events: RecordedEvent[] = [];
  return {
    events,
    store: {
      appendEvent(event: RecordedEvent) {
        events.push(event);
      },
    },
  };
}

describe("T-GR11 — optional provider, default OFF", () => {
  it("disabled (the default): nothing runs, result says so, pipeline proceeds as before", async () => {
    let called = 0;
    const result = await resolveCodeContext(
      { provider: fakeProvider({ getStatus: () => { called += 1; throw new Error("must not run"); } }) as never, enabled: false },
      { role: AgentStage.BACKEND_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
    );
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toBe("disabled");
    expect(result.evidenceBlock).toBe("");
    expect(called).toBe(0);
  });

  it("no provider configured behaves exactly like disabled", async () => {
    const result = await resolveCodeContext({}, { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" });
    expect(result.used).toBe(false);
    expect(result.fallbackReason).toBe("disabled");
  });

  it("every failure mode maps onto fallback instead of throwing — workflow never crashes", async () => {
    const cases: Array<[unknown, FallbackReason]> = [
      [new ProviderNotInstalledError("nope"), "not-installed"],
      [new ProviderTimeoutError("slow"), "timeout"],
      [new MalformedResponseError("junk"), "malformed"],
      [new Error("mystery"), "provider-error"],
    ];
    for (const [thrown, reason] of cases) {
      const result = await resolveCodeContext(
        { enabled: true, provider: fakeProvider({ getImpact: async () => { throw thrown; } }) as never },
        { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
      );
      expect(result.used).toBe(false);
      expect(result.fallbackReason).toBe(reason);
    }
  });

  it("empty and fully-filtered results fall back too", async () => {
    const empty = await resolveCodeContext(
      { enabled: true, provider: fakeProvider({ getImpact: async () => [] }) as never },
      { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
    );
    expect(empty.fallbackReason).toBe("empty-result");

    const outside = await resolveCodeContext(
      { enabled: true, provider: fakeProvider({ getImpact: async () => [candidate("../outside.ts")] }) as never },
      { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
    );
    expect(outside.fallbackReason).toBe("no-allowed-candidates");
  });

  it("stale / missing / error indexes refuse before any query runs", async () => {
    for (const status of ["stale", "missing", "error"] as const) {
      let queried = 0;
      const result = await resolveCodeContext(
        {
          enabled: true,
          provider: fakeProvider({
            getStatus: async () => ({ status, targetRevision: TARGET.revision, indexedRevision: null, indexedAt: null }),
            getImpact: () => {
              queried += 1;
              return Promise.resolve([]);
            },
          }) as never,
        },
        { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
      );
      expect(result.used).toBe(false);
      expect(queried).toBe(0);
    }
  });
});

describe("T-GR10 — capability matrix + audit on denial", () => {
  it("SA / engineers / QA may query every operation", async () => {
    for (const role of [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER]) {
      const result = await resolveCodeContext(
        { enabled: true, provider: fakeProvider() as never },
        { role, operation: "findRelevantCode", target: TARGET, description: "d" },
      );
      expect(result.used).toBe(true);
    }
  });

  it("any other role is denied with an audit entry — even with the feature enabled", async () => {
    const { events, store } = recorder();
    for (const role of [AgentStage.BUSINESS_ANALYST, AgentStage.PROJECT_MANAGER, AgentStage.DEVOPS, AgentStage.SECURITY, AgentStage.SETUP]) {
      events.length = 0;
      const result = await resolveCodeContext(
        { enabled: true, provider: fakeProvider() as never, store },
        { role, operation: "findRelevantCode", target: TARGET, description: "d", taskId: "T-1" },
      );
      expect(result.used).toBe(false);
      expect(result.fallbackReason).toBe("capability-denied");
      expect(events.map((e) => e.type)).toContain(CODE_INTEL_EVENTS.DENIED);
    }
  });

  it("denied without a task still answers safely (no trail to write to)", async () => {
    const result = await resolveCodeContext(
      { enabled: true, provider: fakeProvider() as never },
      { role: AgentStage.DEVOPS, operation: "getImpact", target: TARGET, symbol: "x" },
    );
    expect(result.used).toBe(false);
  });
});

describe("T-GR5 — rank, top-N, dedupe, permission filter", () => {
  it("sorts by score, dedupes by location, trims to top-N", () => {
    const ranked = rankAndTrim(
      [candidate("a.ts", 1, 0.2), candidate("b.ts", 1, 0.9), candidate("b.ts", 1, 0.8), candidate("c.ts", 1, 0.5)],
      2,
    );
    expect(ranked.map((r) => r.location.file)).toEqual(["b.ts", "c.ts"]);
  });

  it("drops candidates pointing outside the allowed roots — B6 has no exceptions", async () => {
    const provider = fakeProvider({
      getImpact: async () => [
        candidate("src/inside.ts", 1),
        candidate("../../etc/passwd", 1),
        candidate(".git/config", 1),
        candidate("node_modules/x/index.js", 1),
        candidate("C:/other-repo/src/file.ts", 1),
      ],
    });
    const result = await resolveCodeContext(
      { enabled: true, provider: provider as never, allowedRoots: [TARGET.rootPath] },
      { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x" },
    );
    expect(result.used).toBe(true);
    expect(result.candidates.map((c) => c.location.file)).toEqual(["src/inside.ts"]);
  });
});

describe("T-GR6 — source verification guardrail", () => {
  it("evidence block carries the principle sentence and the graph-is-not-truth rule", async () => {
    const result = await resolveCodeContext(
      { enabled: true, provider: fakeProvider() as never },
      { role: AgentStage.BACKEND_ENGINEER, operation: "getDependencies", target: TARGET, symbol: "x" },
    );
    expect(result.evidenceBlock).toContain(SOURCE_OF_TRUTH_SENTENCE);
    expect(result.evidenceBlock).toContain("discovery evidence, not implementation truth");
    expect(result.evidenceBlock).toContain("[extracted] src/b.ts:L8");
  });

  it("each role gets its own concrete verify-before-acting rule", async () => {
    const dev = renderEvidenceBlock(AgentStage.BACKEND_ENGINEER, "t", [candidate("src/a.ts", 1)]);
    const sa = renderEvidenceBlock(AgentStage.SYSTEM_ANALYST, "t", [candidate("src/a.ts", 1)]);
    const qa = renderEvidenceBlock(AgentStage.QA_ENGINEER, "t", [candidate("src/a.ts", 1)]);
    expect(dev).toMatch(/read each relevant file.*BEFORE writing/i);
    expect(sa).toMatch(/cross-check.*requirement\/design documents AND the actual source/i);
    // The QA rule must make it impossible to read the block as a verdict source.
    expect(qa).toMatch(/verify each finding against real source files and test results BEFORE any verdict/i);
    expect(qa).toMatch(/NEVER decides pass\/fail/i);
    expect(renderEvidenceBlock(AgentStage.FRONTEND_ENGINEER, "t", [])).toMatch(/DEV:/);
  });

  it("provenance travels into the rendered block so inferred guesses are visible as guesses", () => {
    const block = renderEvidenceBlock(AgentStage.QA_ENGINEER, "t", [candidate("src/a.ts", 4, 1, "inferred")]);
    expect(block).toContain("[inferred]");
  });
});

describe("T-GR13 — telemetry via the audit trail", () => {
  it("query → hit records both events with metadata only", async () => {
    const { events, store } = recorder();
    await resolveCodeContext(
      { enabled: true, provider: fakeProvider() as never, store },
      { role: AgentStage.SYSTEM_ANALYST, operation: "getImpact", target: TARGET, symbol: "x", taskId: "T-42" },
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual([CODE_INTEL_EVENTS.QUERY, CODE_INTEL_EVENTS.HIT]);
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toMatch(/src\/d\.ts content|function body/i);
      expect(Object.values(event.payload).join(" ")).not.toContain("export ");
    }
    expect(events[0].taskId).toBe("T-42");
  });

  it("fallbacks and staleness land in the trail with their reason", async () => {
    const { events, store } = recorder();
    await resolveCodeContext(
      { enabled: true, provider: fakeProvider({ getImpact: async () => [] }) as never, store },
      { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x", taskId: "T-42" },
    );
    expect(events.some((e) => e.type === CODE_INTEL_EVENTS.FALLBACK && e.payload.reason === "empty-result")).toBe(true);

    events.length = 0;
    await resolveCodeContext(
      {
        enabled: true,
        store,
        provider: fakeProvider({ getStatus: async () => ({ status: "stale", targetRevision: TARGET.revision, indexedRevision: "old", indexedAt: null }) }) as never,
      },
      { role: AgentStage.QA_ENGINEER, operation: "getImpact", target: TARGET, symbol: "x", taskId: "T-42" },
    );
    expect(events.map((e) => e.type)).toContain(CODE_INTEL_EVENTS.STALE);
  });
});

describe("wiring sanity — the real adapter satisfies the resolver's needs", () => {
  it("GraphifyProvider is assignable to the provider seam", () => {
    const provider: import("./provider.js").CodeIntelligenceProvider = new GraphifyProvider({ cacheRoot: "/cache" });
    expect(typeof provider.getImpact).toBe("function");
  });
});
