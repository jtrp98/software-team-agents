import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureEngineeringRetrieval } from "../dist/codeintel/benchmark.js";
import { renderEvidenceBlock } from "../dist/codeintel/resolver.js";
import { AgentStage } from "../dist/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-code-intel-retrieval-"));
const sources = {
  "src/invoice.ts": `${"// invoice context\n".repeat(120)}export function calculateInvoiceTotal() { throw new Error("TODO"); }\n`,
  "src/discount.ts": `${"// unrelated discount context\n".repeat(240)}export function normalizeDiscount(percent: number) { return Math.min(100, Math.max(0, Math.trunc(percent))); }\n`,
  "src/money.ts": `${"// unrelated money context\n".repeat(240)}export function roundCents(value: number) { return Math.round(value); }\n`,
};

const candidates = [
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
];

function renderLegacyEvidenceBlock(items) {
  return [
    "## Code intelligence evidence — target `invoice-fixture` (DISCOVERY ONLY)",
    "",
    "Graphify discovers → Source confirms → Compiler checks → Tests verify.",
    "- Graph result is discovery evidence, not implementation truth.",
    "- You are DEV: open and read each relevant file below BEFORE writing or changing any code.",
    "- If any item below contradicts the real source code, the source code wins — discard the graph claim.",
    "",
    `Candidates (${items.length}, provenance-tagged):`,
    ...items.map((candidate, index) => `${index + 1}. [${candidate.provenance}] ${candidate.location.file}:L${candidate.location.line} — ${candidate.symbol}`),
  ].join("\n");
}

try {
  for (const [file, source] of Object.entries(sources)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source, "utf8");
  }
  const evidenceBlock = renderEvidenceBlock(AgentStage.BACKEND_ENGINEER, "invoice-fixture", candidates);
  const replacement = "return roundCents(subtotalCents * (100 - normalizeDiscount(discountPercent)) / 100);";
  const codeResultOff = sources["src/discount.ts"].includes("Math.trunc") && sources["src/money.ts"].includes("Math.round")
    ? sources["src/invoice.ts"].replace('throw new Error("TODO");', replacement)
    : "insufficient full-file context";
  const codeResultOn = evidenceBlock.includes("Math.trunc") && evidenceBlock.includes("Math.round")
    ? sources["src/invoice.ts"].replace('throw new Error("TODO");', replacement)
    : "insufficient span context";
  const metrics = measureEngineeringRetrieval({
    targetRoot: root,
    candidateFiles: Object.keys(sources),
    editedFiles: ["src/invoice.ts"],
    evidenceBlock,
    codeResultOff,
    codeResultOn,
  });
  process.stdout.write(`${JSON.stringify({
    task: "implement calculateInvoiceTotal using existing normalizeDiscount and roundCents",
    legacyEvidenceBlockBytes: Buffer.byteLength(renderLegacyEvidenceBlock(candidates), "utf8"),
    ...metrics,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
