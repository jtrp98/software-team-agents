import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { measureNaive, renderBenchmarkMarkdown, runDiscoveryBenchmark, type BenchmarkCase } from "./benchmark.js";
import type { CodeIntelligenceProvider } from "./provider.js";

/**
 * T-GR12 harness — deterministic fixture tree + fake provider; CI never
 * touches a real checkout or the real binary here.
 */

function tempTarget(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-bench-"));
  const files: Record<string, string> = {
    "src/app/pages/support/crm/settings/page.tsx": "x".repeat(4000),
    "src/app/pages/support/crm/case-list.tsx": "x".repeat(2000),
    "src/app/api/v2/support/crm-case/dashboard/dashboard.repository.ts": "x".repeat(8000),
    "src/components/modal/status-modal.tsx": "x".repeat(1000),
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content, "utf8");
  }
  return root;
}

const provider: CodeIntelligenceProvider = {
  isAvailable: async () => true,
  getStatus: async () => ({ status: "fresh", targetRevision: "r", indexedRevision: "r", indexedAt: null }),
  findRelevantCode: async () => [
    { location: { file: "src/app/pages/support/crm/settings/page.tsx" }, score: 1, provenance: "extracted" },
    // same file twice → deduped in measurement
    { location: { file: "src/app/pages/support/crm/settings/page.tsx" }, score: 0.9, provenance: "extracted" },
  ],
  getDependencies: async () => [],
  getDependents: async () => [],
  findPath: async () => [],
  getImpact: async () => [],
};

describe("benchmark harness (T-GR12 tooling)", () => {
  it("naive side counts every code file under the scope with real byte sizes", () => {
    const root = tempTarget();
    try {
      const side = measureNaive(root, ["src/app/pages/support/crm", "src/app/api/v2/support/crm-case"], 5);
      expect(side.filesConsidered).toBe(3);
      expect(side.estTokens).toBe(Math.ceil(14000 / 4));
      expect(side.wallMs).toBe(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("graph side dedupes candidates and sizes only what it names", async () => {
    const root = tempTarget();
    try {
      const row = (
        await runDiscoveryBenchmark(
          [{ id: "c1", description: "crm settings", scopeDirs: ["src"] }],
          { provider, targetRoot: root, targetId: "t", revision: "r".repeat(40) },
        )
      )[0];
      expect(row.graph.filesConsidered).toBe(1);
      expect(row.graph.estTokens).toBe(Math.ceil(4000 / 4));
      // naive swept all four files, graph named one
      expect(row.naive.filesConsidered).toBe(4);
      expect(row.tokenReduction).toBe(3.8);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("markdown report is stable and says what it does NOT measure", async () => {
    const rows = await runDiscoveryBenchmark([{ id: "q1", description: "d", scopeDirs: [] }], {
      provider,
      targetRoot: tempTarget(),
      targetId: "sb-web-helper",
      revision: "a".repeat(40),
    });
    const md = renderBenchmarkMarkdown(rows, { targetId: "sb-web-helper", revision: "a".repeat(40), date: "2026-08-26" });
    expect(md).toContain("| q1 |");
    expect(md).toContain("Discovery-level only");
    expect(md).toContain("local-only (--code-only)");
  });
});
