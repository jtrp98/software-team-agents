import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { SourceRef } from "./knowledgeModel.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { makeItem } from "./sampleKnowledge.js";
import { parseKnowledgePolicy } from "./knowledgePolicy.js";
import { digestOfSource, freshnessOf, needsAttention, parseLocator } from "./freshness.js";

const NOW = "2026-08-20T00:00:00Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

function itemWith(sources: SourceRef[], kind: "requirement" | "db-schema" = "requirement") {
  return kind === "requirement"
    ? makeItem(
        "requirement",
        "REQ-003",
        { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
        { sources, owner: AgentStage.BUSINESS_ANALYST },
      )
    : makeItem("db-schema", "DB-Shift", { model: "Shift", fields: [], relations: [] }, { sources });
}

function fileSource(locator: string, digest: string | null, captured = NOW): SourceRef {
  return { type: "file", locator, captured_at: captured, digest };
}

describe("parseLocator", () => {
  it("splits a line range off a path", () => {
    expect(parseLocator("a/b.md#L10-L24")).toEqual({ file: "a/b.md", from: 10, to: 24 });
    expect(parseLocator("a/b.md#L10")).toEqual({ file: "a/b.md", from: 10, to: 10 });
    expect(parseLocator("a/b.md")).toEqual({ file: "a/b.md" });
  });
});

describe("digestOfSource", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-fresh-"));
    fs.writeFileSync(path.join(root, "doc.md"), "one\ntwo\nthree\nfour\n", "utf8");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("hashes the whole file when no range is named", () => {
    expect(digestOfSource("doc.md", root)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("hashes only the named lines, so a change elsewhere is not a change here", () => {
    const before = digestOfSource("doc.md#L1-L2", root);
    fs.writeFileSync(path.join(root, "doc.md"), "one\ntwo\nCHANGED\nfour\n", "utf8");
    expect(digestOfSource("doc.md#L1-L2", root)).toBe(before);
    expect(digestOfSource("doc.md#L3-L4", root)).not.toBe(before);
  });

  it("returns null for material that is not there", () => {
    expect(digestOfSource("gone.md", root)).toBeNull();
  });
});

describe("freshnessOf — age", () => {
  it("is fresh inside the threshold", () => {
    const result = freshnessOf(itemWith([fileSource("doc.md", null, daysAgo(10))]), { now: NOW });
    expect(result.verdict).toBe("fresh");
    expect(result.ageDays).toBe(10);
  });

  it("ages, then goes stale, at the thresholds the policy sets", () => {
    expect(freshnessOf(itemWith([fileSource("doc.md", null, daysAgo(100))]), { now: NOW }).verdict).toBe("aging");
    expect(freshnessOf(itemWith([fileSource("doc.md", null, daysAgo(200))]), { now: NOW }).verdict).toBe("stale");
  });

  it("uses the per-kind threshold, because the code moves under a model faster than under a rule", () => {
    const policy = parseKnowledgePolicy({
      version: 1,
      freshness: {
        default: { aging_after_days: 90, stale_after_days: 180 },
        by_kind: { "db-schema": { aging_after_days: 30, stale_after_days: 90 } },
      },
    });
    const sources = [fileSource("doc.md", null, daysAgo(100))];
    expect(freshnessOf(itemWith(sources, "db-schema"), { now: NOW, policy }).verdict).toBe("stale");
    expect(freshnessOf(itemWith(sources), { now: NOW, policy }).verdict).toBe("aging");
  });

  it("measures from the oldest source — an item is only as current as its weakest input", () => {
    const result = freshnessOf(
      itemWith([fileSource("recent.md", null, daysAgo(2)), fileSource("old.md", null, daysAgo(300))]),
      { now: NOW },
    );
    expect(result.ageDays).toBe(300);
    expect(result.oldestSource?.locator).toBe("old.md");
    expect(result.verdict).toBe("stale");
  });

  it("says unknown rather than fresh when no source carries a usable date", () => {
    const result = freshnessOf(itemWith([{ type: "human", locator: "someone", captured_at: "not-a-date", digest: null }]), {
      now: NOW,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.ageDays).toBeNull();
  });
});

describe("freshnessOf — the material underneath", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-fresh2-"));
    fs.writeFileSync(path.join(root, "doc.md"), "original\n", "utf8");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stays fresh while the digest still matches", () => {
    const digest = digestOfSource("doc.md", root)!;
    const result = freshnessOf(itemWith([fileSource("doc.md", digest, daysAgo(1))]), { now: NOW, projectRoot: root });
    expect(result.verdict).toBe("fresh");
  });

  it("reports a changed source even when the item is young", () => {
    const item = itemWith([fileSource("doc.md", "sha256:stale", daysAgo(1))]);
    const result = freshnessOf(item, { now: NOW, projectRoot: root });
    expect(result.verdict).toBe("source-changed");
    expect(result.changedSources).toEqual(["doc.md"]);
    expect(result.reason).toContain("different text");
  });

  it("reports missing material ahead of everything else", () => {
    const item = itemWith([fileSource("gone.md", "sha256:whatever", daysAgo(1))]);
    expect(freshnessOf(item, { now: NOW, projectRoot: root }).verdict).toBe("source-missing");
  });

  it("outranks age: a stale item whose source moved is reported as moved", () => {
    const item = itemWith([fileSource("doc.md", "sha256:stale", daysAgo(400))]);
    const result = freshnessOf(item, { now: NOW, projectRoot: root });
    expect(result.verdict).toBe("source-changed");
    expect(result.ageDays).toBe(400);
  });

  it("skips digest checking entirely without a projectRoot, rather than calling everything unchanged", () => {
    const item = itemWith([fileSource("doc.md", "sha256:stale", daysAgo(1))]);
    const result = freshnessOf(item, { now: NOW });
    expect(result.verdict).toBe("fresh");
    expect(result.changedSources).toEqual([]);
  });

  it("does not try to hash a person", () => {
    const item = itemWith([{ type: "human", locator: "คุณเอ", captured_at: daysAgo(1), digest: null }]);
    expect(freshnessOf(item, { now: NOW, projectRoot: root }).verdict).toBe("fresh");
  });
});

describe("needsAttention", () => {
  it("leaves out what is fine and puts the worst first", () => {
    const kb = new KnowledgeBase([
      makeItem("domain", "DOM-001", { term: "a", definition: "a", aliases: [] }, { sources: [fileSource("x", null, daysAgo(1))] }),
      makeItem("domain", "DOM-002", { term: "b", definition: "b", aliases: [] }, { sources: [fileSource("x", null, daysAgo(100))] }),
      makeItem("domain", "DOM-003", { term: "c", definition: "c", aliases: [] }, { sources: [fileSource("x", null, daysAgo(300))] }),
    ]);
    expect(needsAttention(kb, { now: NOW }).map((f) => [f.id, f.verdict])).toEqual([
      ["DOM-003", "stale"],
      ["DOM-002", "aging"],
    ]);
  });

  it("orders two of the same verdict by age", () => {
    const kb = new KnowledgeBase([
      makeItem("domain", "DOM-001", { term: "a", definition: "a", aliases: [] }, { sources: [fileSource("x", null, daysAgo(200))] }),
      makeItem("domain", "DOM-002", { term: "b", definition: "b", aliases: [] }, { sources: [fileSource("x", null, daysAgo(400))] }),
    ]);
    expect(needsAttention(kb, { now: NOW }).map((f) => f.id)).toEqual(["DOM-002", "DOM-001"]);
  });
});
