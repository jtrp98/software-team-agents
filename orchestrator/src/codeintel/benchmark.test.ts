import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { measureEngineeringRetrieval, measureNaive, renderBenchmarkMarkdown, runDiscoveryBenchmark, type BenchmarkCase } from "./benchmark.js";
import type { CodeIntelligenceProvider } from "./provider.js";
import { renderEvidenceBlock } from "./resolver.js";

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

describe("T-V3TOK-071 — same-task engineering retrieval benchmark", () => {
  it("reduces full-file opens/context bytes without changing the implementation result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-engineer-ab-"));
    const sources: Record<string, string> = {
      "src/invoice.ts": `${"// invoice context\n".repeat(120)}export function calculateInvoiceTotal() { throw new Error("TODO"); }\n`,
      "src/discount.ts": `${"// unrelated discount context\n".repeat(240)}export function normalizeDiscount(percent: number) { return Math.min(100, Math.max(0, Math.trunc(percent))); }\n`,
      "src/money.ts": `${"// unrelated money context\n".repeat(240)}export function roundCents(value: number) { return Math.round(value); }\n`,
    };
    for (const [file, source] of Object.entries(sources)) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source, "utf8");
    }
    try {
      const evidenceBlock = renderEvidenceBlock(AgentStage.BACKEND_ENGINEER, "invoice-fixture", [
        {
          location: { file: "src/invoice.ts", line: 121 }, symbol: "calculateInvoiceTotal", score: 1, provenance: "extracted",
          signature: "export function calculateInvoiceTotal()",
          span: { startLine: 119, endLine: 121, text: "// invoice context\n// invoice context\nexport function calculateInvoiceTotal() { throw new Error(\"TODO\"); }" },
        },
        {
          location: { file: "src/discount.ts", line: 241 }, symbol: "normalizeDiscount", score: 0.9, provenance: "extracted",
          signature: "export function normalizeDiscount(percent: number)",
          span: { startLine: 241, endLine: 241, text: "export function normalizeDiscount(percent: number) { return Math.min(100, Math.max(0, Math.trunc(percent))); }" },
        },
        {
          location: { file: "src/money.ts", line: 241 }, symbol: "roundCents", score: 0.8, provenance: "extracted",
          signature: "export function roundCents(value: number)",
          span: { startLine: 241, endLine: 241, text: "export function roundCents(value: number) { return Math.round(value); }" },
        },
      ]);
      const replacement = "return roundCents(subtotalCents * (100 - normalizeDiscount(discountPercent)) / 100);";
      const codeResultOff = sources["src/discount.ts"].includes("Math.trunc") && sources["src/money.ts"].includes("Math.round")
        ? sources["src/invoice.ts"].replace('throw new Error("TODO");', replacement)
        : "insufficient full-file context";
      const codeResultOn = evidenceBlock.includes("Math.trunc") && evidenceBlock.includes("Math.round")
        ? sources["src/invoice.ts"].replace('throw new Error("TODO");', replacement)
        : "insufficient span context";
      const result = measureEngineeringRetrieval({
        targetRoot: root,
        candidateFiles: Object.keys(sources),
        editedFiles: ["src/invoice.ts"],
        evidenceBlock,
        codeResultOff,
        codeResultOn,
      });
      expect(result.off.fileOpens).toBe(3);
      expect(result.on.fileOpens).toBe(1);
      expect(result.on.contextBytes).toBeLessThan(result.off.contextBytes);
      expect(result.codeResultEquivalent).toBe(true);
      expect(result.evidenceBlockBytes).toBe(Buffer.byteLength(evidenceBlock, "utf8"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes a changed code result fail equivalence even when reading is lower", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeintel-engineer-quality-"));
    try {
      const result = measureEngineeringRetrieval({
        targetRoot: root,
        candidateFiles: ["a.ts", "b.ts"],
        editedFiles: ["a.ts"],
        evidenceBlock: "bounded evidence",
        codeResultOff: "correct",
        codeResultOn: "different",
      });
      expect(result.codeResultEquivalent).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
