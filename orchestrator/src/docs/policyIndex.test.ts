import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PolicyIndexError,
  getPolicySection,
  listPolicySections,
  policyPointerResolves,
} from "./policyIndex.js";

/** This repo is its own fixture for the real-policies cases — the shipped files are the contract. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-policy-index-"));
  fs.mkdirSync(path.join(root, "policies"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "policies", name), body, "utf8");
  }
  return root;
}

describe("listPolicySections", () => {
  it("lists every policy file in this repository", () => {
    const index = listPolicySections(REPO_ROOT);
    expect(index.map((entry) => entry.area).sort()).toEqual([
      "README",
      "agent-boundaries",
      "architecture",
      "coding",
      "documentation",
      "git",
      "security",
    ]);
    for (const entry of index) expect(entry.sections.length).toBeGreaterThan(0);
  });

  it("reports each section's own byte size, and they sum to less than the file", () => {
    const documentation = listPolicySections(REPO_ROOT).find((entry) => entry.area === "documentation")!;
    const sum = documentation.sections.reduce((total, section) => total + section.bytes, 0);
    expect(sum).toBeGreaterThan(0);
    // Strictly less: the preamble before the first `## ` belongs to no section.
    expect(sum).toBeLessThan(documentation.bytes);
  });

  it("does not treat a `## ` inside a fenced block as a heading", () => {
    // policies/documentation.md really does contain fenced `## Scaffold` / `## Modules`
    // / `## sales-crm` samples. A parser that split on those would hand out half a rule.
    const documentation = listPolicySections(REPO_ROOT).find((entry) => entry.area === "documentation")!;
    const headings = documentation.sections.map((section) => section.heading);
    for (const sample of ["Scaffold", "Modules", "sales-crm"]) {
      expect(headings).not.toContain(sample);
    }
  });

  it("does not treat a fenced `## ` as a heading in a synthetic file either", () => {
    const root = fixture({
      "sample.md": "# Sample\n\n## 1. Real\nkeep\n\n```md\n## Fake heading\n```\n\n## 2. Also real\nkeep\n",
    });
    const sections = listPolicySections(root).find((entry) => entry.area === "sample")!.sections;
    expect(sections.map((section) => section.heading)).toEqual(["1. Real", "2. Also real"]);
  });

  it("throws when there is no policies/ directory at all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-policy-empty-"));
    expect(() => listPolicySections(root)).toThrow(PolicyIndexError);
  });
});

describe("getPolicySection", () => {
  it("returns one section, a small fraction of the file it came from", () => {
    const hit = getPolicySection(REPO_ROOT, "documentation", "§10");
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.heading).toMatch(/^10\./);
    expect(hit.text.startsWith("## 10.")).toBe(true);
    // Measured 2026-08-26: §10 is 4,332 B of documentation.md's 28,031 B (15.5%).
    // The planning doc guessed "<10%"; that was never measured against the real
    // section. What matters is that one query replaces the whole-file read, so
    // the assertion pins the real ratio with headroom rather than the guess.
    expect(hit.bytes).toBeLessThan(hit.areaBytes * 0.2);
    expect(hit.areaBytes / hit.bytes).toBeGreaterThan(5);
  });

  it("accepts §10, 10, and a substring of the heading as the same section", () => {
    const forms = ["§10", "10", "Read only the part"].map((query) => getPolicySection(REPO_ROOT, "documentation", query));
    for (const form of forms) expect(form.found).toBe(true);
    const texts = forms.map((form) => (form.found ? form.text : ""));
    expect(new Set(texts).size).toBe(1);
  });

  it("matches a lettered section number like 5c", () => {
    const hit = getPolicySection(REPO_ROOT, "coding", "§5c");
    expect(hit.found).toBe(true);
    if (hit.found) expect(hit.heading).toMatch(/^5c\./);
  });

  it("accepts the area written as documentation, documentation.md, or policies/documentation.md", () => {
    for (const area of ["documentation", "documentation.md", "policies/documentation.md"]) {
      const hit = getPolicySection(REPO_ROOT, area, "§3");
      expect(hit.found, area).toBe(true);
    }
  });

  it("answers a miss with the sections that do exist, rather than an empty error", () => {
    const miss = getPolicySection(REPO_ROOT, "coding", "§99");
    expect(miss.found).toBe(false);
    if (miss.found) return;
    expect(miss.sections.length).toBeGreaterThan(0);
    expect(miss.sections.some((section) => section.number === "5c")).toBe(true);
  });

  it("throws only for an area that does not exist", () => {
    expect(() => getPolicySection(REPO_ROOT, "no-such-area", "§1")).toThrow(PolicyIndexError);
  });

  it("stops a section at the next `## `, not at the end of the file", () => {
    const root = fixture({ "sample.md": "# S\n\n## 1. First\nalpha\n\n## 2. Second\nbeta\n" });
    const hit = getPolicySection(root, "sample", "1");
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.text).toContain("alpha");
    expect(hit.text).not.toContain("beta");
  });
});

describe("policyPointerResolves", () => {
  it("is true for every pointer this repository's policies actually contain", () => {
    expect(policyPointerResolves(REPO_ROOT, "coding", "§5c")).toBe(true);
    expect(policyPointerResolves(REPO_ROOT, "architecture", "§7")).toBe(true);
    expect(policyPointerResolves(REPO_ROOT, "documentation", "§1")).toBe(true);
    expect(policyPointerResolves(REPO_ROOT, "agent-boundaries", "§6a")).toBe(true);
  });

  it("is false for a rotted pointer instead of throwing", () => {
    expect(policyPointerResolves(REPO_ROOT, "coding", "§404")).toBe(false);
    expect(policyPointerResolves(REPO_ROOT, "not-an-area", "§1")).toBe(false);
  });
});
