import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ContextManager } from "./contextManager.js";
import {
  DEFAULT_LARGE_FILE_POLICY,
  lineWindows,
  markdownOutline,
  renderLargeFileIndex,
  resolveLargeFilePolicy,
  summarizeReadLedger,
  type LargeFilePolicy,
} from "./largeFile.js";
import { sliceModuleDocsWithSavings } from "../runtime/agentRunAssembly.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function moduleRoot(docs: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-large-file-"));
  roots.push(root);
  const dir = path.join(root, "_docs", "module", "sched");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), text, "utf8");
  return root;
}

/**
 * A ~400k-character design.md shaped like a real long-lived one: the three
 * always-read sections, many numbered contract sections with DES ids, and a
 * large Change Log. The needle rule sits deep inside one section.
 */
function hugeDesign(targetChars = 400_000): { text: string; needleLine: number } {
  const lines = ["# Scheduling — Feasibility & Design", "", "Design evidence format: 1", ""];
  lines.push("## Feature-by-Feature Feasibility", "DES-001 REQ-001 feasible", "");
  lines.push("## Risks & Dependencies", "none material", "");
  lines.push("## Unresolved Open Questions", "none", "");
  let n = 2;
  let needleLine = -1;
  while (lines.join("\n").length < targetChars) {
    const id = `DES-${String(n).padStart(3, "0")}`;
    lines.push(`## ${id} — Contract section ${n}`);
    lines.push("### Rules");
    for (let i = 0; i < 40; i++) lines.push(`- ${id} rule ${i}: teachers may not exceed the configured weekly load unless an override is recorded for the term.`);
    if (n === 60) {
      lines.push("- TEACHER-DOUBLE-BOOKING: a teacher is never scheduled in two rooms in the same period — hard constraint.");
      needleLine = lines.length;
    }
    lines.push("");
    n++;
  }
  lines.push("## Change Log", ...Array.from({ length: 50 }, (_, i) => `- 2026-01-${String((i % 28) + 1).padStart(2, "0")} entry ${i}`));
  if (needleLine < 0) throw new Error("fixture never wrote its needle");
  return { text: lines.join("\n"), needleLine };
}

const REQUIREMENT_SMALL = "# Requirement\n\n## Core Features\nREQ-001 schedule classes\n\n## Scope\nMVP\n\n## References\nnone\n\n## Open Questions\nnone\n";

describe("Large File Context Policy — resolution", () => {
  it("defaults, config and env resolve in env > config > default order; the window never exceeds the file threshold", () => {
    expect(resolveLargeFilePolicy(null, {})).toEqual(DEFAULT_LARGE_FILE_POLICY);
    const config = { schema_version: 1 as const, context_budget: { large_file_chars: 50_000, max_read_window_chars: 90_000, max_file_read_share: 0.3 } };
    expect(resolveLargeFilePolicy(config, {})).toEqual({ largeFileChars: 50_000, maxReadWindowChars: 50_000, maxFileReadShare: 0.3 });
    expect(resolveLargeFilePolicy(config, { STA_LARGE_FILE_CHARS: "1234", STA_MAX_READ_WINDOW_CHARS: "100" })).toMatchObject({ largeFileChars: 1234, maxReadWindowChars: 100 });
    expect(resolveLargeFilePolicy(null, { STA_LARGE_FILE_CHARS: "not-a-number" }).largeFileChars).toBe(DEFAULT_LARGE_FILE_POLICY.largeFileChars);
  });
});

describe("Case A — a ~400,000-character design.md is never rendered whole", () => {
  it("every role receives a bounded, line-ranged index instead of the document, and the needle's section is locatable", () => {
    const { text, needleLine } = hugeDesign();
    expect(text.length).toBeGreaterThanOrEqual(400_000);
    const root = moduleRoot({ "design.md": text, "requirement.md": REQUIREMENT_SMALL });
    const cm = new ContextManager({ projectRoot: root, moduleName: "sched" });
    for (const stage of [AgentStage.SYSTEM_ANALYST, AgentStage.BUSINESS_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY, AgentStage.DEVOPS]) {
      const design = cm.forStage(stage, [1]).find((selected) => selected.doc === "design")!;
      expect(design.indexed, stage).toBe(true);
      expect(design.fullDocument, stage).toBe(false);
      // Bounded by the number of headings, not by the document: well under 10% of it.
      expect(design.text.length, stage).toBeLessThan(text.length * 0.1);
      expect(design.text).not.toContain("TEACHER-DOUBLE-BOOKING");
      // The section that holds the rule is listed with the exact on-disk line range to read.
      const entry = design.text.split("\n").find((line) => line.includes("## DES-060 — Contract section 60"))!;
      const [, start, end] = /lines (\d+)-(\d+)/.exec(entry)!.map(Number);
      expect(start).toBeLessThanOrEqual(needleLine);
      expect(end).toBeGreaterThanOrEqual(needleLine);
      // ...and that range is a bounded read that really contains the rule.
      const window = text.split("\n").slice(start - 1, end).join("\n");
      expect(window).toContain("TEACHER-DOUBLE-BOOKING");
      expect(window.length).toBeLessThan(DEFAULT_LARGE_FILE_POLICY.maxReadWindowChars);
    }
  });

  it("the system-analyst's owner 'read in full' rule no longer ships 400k chars; always-read sections are rated READ", () => {
    const { text } = hugeDesign();
    const root = moduleRoot({ "design.md": text, "requirement.md": REQUIREMENT_SMALL });
    const sliced = sliceModuleDocsWithSavings(AgentStage.SYSTEM_ANALYST, { projectRoot: root, moduleName: "sched" });
    const rendered = sliced.docs.join("\n");
    expect(rendered.length).toBeLessThan(60_000);
    expect(rendered).toMatch(/\[READ\] ## Feature-by-Feature Feasibility — lines \d+-\d+/);
    expect(rendered).toMatch(/\[READ\] ## Risks & Dependencies/);
    expect(rendered).toMatch(/\[READ\] ## Unresolved Open Questions/);
    expect(sliced.savings.bytesBefore).toBeGreaterThanOrEqual(400_000);
  });
});

describe("Case C — small documents keep today's inline behaviour", () => {
  it("a ~2 KB design.md is sliced and inlined exactly as before, with no index ceremony", () => {
    const small = "# D\n\nDesign evidence format: 1\n\n## Feature-by-Feature Feasibility\nDES-001 ok\n\n## DES-001 — Contract\nrule body\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n";
    const padded = small + "\n" + "x".repeat(2_000 - small.length);
    const root = moduleRoot({ "design.md": padded, "requirement.md": REQUIREMENT_SMALL });
    const design = new ContextManager({ projectRoot: root, moduleName: "sched" }).forStage(AgentStage.SYSTEM_ANALYST).find((s) => s.doc === "design")!;
    expect(design.indexed).toBeUndefined();
    expect(design.text).toBe(padded);
  });
});

describe("Case E — threshold boundary", () => {
  const policy: LargeFilePolicy = { largeFileChars: 10_000, maxReadWindowChars: 4_000, maxFileReadShare: 0.5 };
  function designOf(chars: number): string {
    const head = "# D\n\n## Feature-by-Feature Feasibility\nok\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n\n## Notes\n";
    return head + "y".repeat(chars - head.length);
  }
  it("exactly at the threshold inlines; one character above indexes", () => {
    for (const [chars, indexed] of [[10_000, false], [10_001, true]] as const) {
      const text = designOf(chars);
      expect(text.length).toBe(chars);
      const root = moduleRoot({ "design.md": text });
      const design = new ContextManager({ projectRoot: root, moduleName: "sched", largeFilePolicy: policy }).forStage(AgentStage.SYSTEM_ANALYST).find((s) => s.doc === "design")!;
      expect(design.indexed === true, `chars=${chars}`).toBe(indexed);
      if (!indexed) expect(design.text).toBe(text);
    }
  });

  it("several documents each under the threshold are still capped as one render", () => {
    const text = designOf(9_000);
    const requirement = "# R\n\n## Core Features\nREQ-001 x\n" + "z".repeat(9_000) + "\n\n## Scope\nMVP\n\n## References\nnone\n\n## Open Questions\nnone\n";
    const root = moduleRoot({ "design.md": text, "requirement.md": requirement });
    const selected = new ContextManager({ projectRoot: root, moduleName: "sched", largeFilePolicy: policy }).forStage(AgentStage.SYSTEM_ANALYST);
    const total = selected.reduce((sum, s) => sum + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(policy.largeFileChars);
    expect(selected.some((s) => s.indexed)).toBe(true);
  });
});

describe("Case F — a failed structured lookup never falls back to the whole file", () => {
  it("a large design.md with none of §10's always-read sections (structural fallback) is indexed, not passed whole", () => {
    const body = Array.from({ length: 300 }, (_, i) => `## Topic ${i}\n${"detail ".repeat(60)}`).join("\n\n");
    const root = moduleRoot({ "design.md": `# Unstructured\n\n${body}` });
    const design = new ContextManager({ projectRoot: root, moduleName: "sched" }).forStage(AgentStage.BACKEND_ENGINEER, [1]).find((s) => s.doc === "design")!;
    expect(body.length).toBeGreaterThan(DEFAULT_LARGE_FILE_POLICY.largeFileChars);
    expect(design.fullDocument).toBe(false);
    expect(design.indexed).toBe(true);
    expect(design.reason).toMatch(/none of §10's always-read sections/);
    expect(design.text).toMatch(/## Topic 148 — lines \d+-\d+/);
    // Beyond the index cap the rest is pointed to, never silently dropped.
    expect(design.text).toMatch(/151 more heading\(s\) not listed — Grep `\^## `/);
  });

  it("a HANDOFF reference to a section that does not exist keeps the bounded index rather than widening to the file", () => {
    const { text } = hugeDesign();
    const root = moduleRoot({ "design.md": text, "requirement.md": REQUIREMENT_SMALL });
    const design = new ContextManager({ projectRoot: root, moduleName: "sched" })
      .forStage(AgentStage.BACKEND_ENGINEER, [1], undefined, { design: ["design.md#no-such-section"] })
      .find((s) => s.doc === "design")!;
    expect(design.indexed).toBe(true);
    expect(design.text.length).toBeLessThan(text.length * 0.1);
  });

  it("a Markdown file with no headings at all is indexed by bounded line windows", () => {
    const text = Array.from({ length: 5_000 }, (_, i) => `plain line ${i} ${"w".repeat(30)}`).join("\n");
    const index = renderLargeFileIndex({ filePath: "notes.md", text, policy: DEFAULT_LARGE_FILE_POLICY, reason: "test" });
    expect(index).toMatch(/Line windows of ≤40,000 chars/);
    expect(index.length).toBeLessThan(5_000);
  });
});

describe("Case I — non-Markdown large files get the same protection", () => {
  it("a 1 MB JSON fixture renders as bounded line windows, each within the read window", () => {
    const json = JSON.stringify(Array.from({ length: 12_000 }, (_, i) => ({ id: i, name: `row-${i}`, payload: "p".repeat(50) })), null, 2);
    expect(json.length).toBeGreaterThan(1_000_000);
    const windows = lineWindows(json, DEFAULT_LARGE_FILE_POLICY.maxReadWindowChars);
    expect(windows.every((w) => w.chars <= DEFAULT_LARGE_FILE_POLICY.maxReadWindowChars)).toBe(true);
    expect(windows[windows.length - 1].endLine).toBe(json.split("\n").length);
    const index = renderLargeFileIndex({ filePath: "fixtures/rows.json", text: json, policy: DEFAULT_LARGE_FILE_POLICY, reason: "test" });
    expect(index.length).toBeLessThan(10_000);
    expect(index).not.toContain("row-11999");
  });

  it("a generated TypeScript file is indexed without its body", () => {
    const ts = Array.from({ length: 20_000 }, (_, i) => `export const generated${i} = ${i}; // ${"g".repeat(10)}`).join("\n");
    const index = renderLargeFileIndex({ filePath: "src/generated/api.ts", text: ts, policy: DEFAULT_LARGE_FILE_POLICY, reason: "test" });
    expect(index).toMatch(/src\/generated\/api\.ts/);
    expect(index).not.toContain("generated19999");
  });
});

describe("markdownOutline", () => {
  it("gives 1-based inclusive line ranges, skips fenced headings, and scopes a title to its preamble", () => {
    const text = "# Title\nintro\n## A\na\n```\n## not a heading\n```\n### A.1\nx\n## B\nb";
    const outline = markdownOutline(text);
    expect(outline.map((e) => [e.level, e.heading, e.startLine, e.endLine])).toEqual([
      [1, "Title", 1, 2],
      [2, "A", 3, 9],
      [3, "A.1", 8, 9],
      [2, "B", 10, 11],
    ]);
  });
});

describe("summarizeReadLedger", () => {
  it("counts allowed reads, duplicates and blocks, and tolerates a torn last line", () => {
    const ledger = [
      { tool: "Read", path: "/a/design.md", startLine: 10, endLine: 50, chars: 4_000, fileChars: 400_000, decision: "allow" },
      { tool: "Read", path: "/a/design.md", startLine: 10, endLine: 50, chars: 4_000, fileChars: 400_000, decision: "allow", duplicate: true },
      { tool: "Read", path: "/a/design.md", startLine: 1, endLine: 2000, chars: 270_000, fileChars: 400_000, decision: "block" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n{\"tool\":\"Re";
    expect(summarizeReadLedger(ledger)).toEqual({
      reads: 2, readChars: 8_000, duplicateReads: 1, blockedReads: 1,
      largest: [{ path: "/a/design.md", startLine: 10, endLine: 50, chars: 4_000 }, { path: "/a/design.md", startLine: 10, endLine: 50, chars: 4_000 }],
    });
  });
});

/**
 * Case B — the real-world document that motivated this policy. Machine-local
 * and read-only: skipped wherever the file is absent (CI), never copied into
 * the repository. Override the path with STA_REAL_LARGE_DOC.
 */
const REAL_DOC = process.env.STA_REAL_LARGE_DOC ?? "C:/src/schoolbright-knowledge/_docs/module/timetableai/design.md";
describe.skipIf(!fs.existsSync(REAL_DOC))("Case B — real timetableai design.md (local validation)", () => {
  it("locates one scheduling rule through the index and bounded reads, never loading the document", () => {
    const text = fs.readFileSync(REAL_DOC, "utf8");
    expect(text.length).toBeGreaterThan(DEFAULT_LARGE_FILE_POLICY.largeFileChars);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-real-doc-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "_docs", "module", "timetableai"), { recursive: true });
    fs.copyFileSync(REAL_DOC, path.join(root, "_docs", "module", "timetableai", "design.md"));
    const design = new ContextManager({ projectRoot: root, moduleName: "timetableai" }).forStage(AgentStage.SYSTEM_ANALYST).find((s) => s.doc === "design")!;
    expect(design.indexed).toBe(true);
    expect(design.text.length).toBeLessThan(20_000);
    // Retrieval: the index names the Class Continuity contract (DES-012) with its range.
    const entry = design.text.split("\n").find((line) => /## DES-012 —/.test(line))!;
    const [, start, end] = /lines (\d+)-(\d+)/.exec(entry)!.map(Number);
    const window = text.split(/\r?\n/).slice(start - 1, end).join("\n");
    expect(window).toMatch(/DES-012/);
    expect(window.length).toBeLessThan(DEFAULT_LARGE_FILE_POLICY.maxReadWindowChars);
    expect(design.text.length + window.length).toBeLessThan(text.length * 0.1);
  });
});
