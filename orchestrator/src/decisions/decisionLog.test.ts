import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdrError,
  DecisionLogError,
  assertDecisions,
  checkDecisions,
  listAdrFiles,
  loadAdr,
  loadAllAdrs,
} from "./decisionLog.js";

const VALID_BODY = `## Status
accepted — 2026-08-20

## Context
Some context.

## Decision
Some decision.

## Consequences
Some consequence.
`;

function adrFile(frontmatter: Record<string, string>, body: string = VALID_BODY): string {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

/** Writes a throwaway project with a decisions/ folder. */
function fixtureRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-adr-"));
  fs.mkdirSync(path.join(root, "decisions"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "decisions", name), content, "utf8");
  }
  return root;
}

describe("the shipped decisions/", () => {
  it("lists the ADRs in id order", () => {
    const files = listAdrFiles();
    expect(files).toEqual([
      "ADR-001-database.md",
      "ADR-002-authentication.md",
      "ADR-003-api-versioning.md",
      "ADR-004-v1-contract.md",
      "ADR-005-v2-command-rendering-and-mcp-boundaries.md",
      "ADR-006-code-intelligence-provider.md",
      "ADR-021-shared-agent-preamble.md",
    ]);
  });

  it("all load and validate against the schema", () => {
    const adrs = loadAllAdrs();
    expect(adrs).toHaveLength(7);
    for (const adr of adrs) {
      expect(adr.frontmatter.status).toBe("accepted");
    }
  });

  it("passes --check-decisions", () => {
    const result = checkDecisions();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertDecisions()).not.toThrow();
  });
});

describe("loadAdr", () => {
  it("reads a well-formed ADR", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-004", title: "Cache with Redis", status: "accepted", date: "2026-08-20" }),
    });
    const adr = loadAdr("ADR-004-caching.md", root);
    expect(adr.frontmatter.id).toBe("ADR-004");
    expect(adr.frontmatter.title).toBe("Cache with Redis");
  });

  it("rejects a file with no frontmatter block", () => {
    const root = fixtureRoot({ "ADR-004-caching.md": "# just a heading\n\nno frontmatter here" });
    expect(() => loadAdr("ADR-004-caching.md", root)).toThrow(AdrError);
  });

  it("rejects frontmatter that fails the schema (bad status)", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-004", title: "Cache with Redis", status: "maybe", date: "2026-08-20" }),
    });
    expect(() => loadAdr("ADR-004-caching.md", root)).toThrow(AdrError);
  });

  it("rejects a filename that doesn't match ADR-<NNN>-<slug>.md", () => {
    const root = fixtureRoot({
      "caching-decision.md": adrFile({ id: "ADR-004", title: "Cache with Redis", status: "accepted", date: "2026-08-20" }),
    });
    expect(() => loadAdr("caching-decision.md", root)).toThrow(AdrError);
  });

  it("rejects an id that disagrees with its filename", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-005", title: "Cache with Redis", status: "accepted", date: "2026-08-20" }),
    });
    expect(() => loadAdr("ADR-004-caching.md", root)).toThrow(/filename is the identity/);
  });

  it("rejects a body missing a required section", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile(
        { id: "ADR-004", title: "Cache with Redis", status: "accepted", date: "2026-08-20" },
        "## Status\naccepted\n\n## Context\nsome context\n",
      ),
    });
    expect(() => loadAdr("ADR-004-caching.md", root)).toThrow(/missing required section/);
  });

  it("requires superseded_by when status is superseded", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-004", title: "Cache with Redis", status: "superseded", date: "2026-08-20" }),
    });
    expect(() => loadAdr("ADR-004-caching.md", root)).toThrow(AdrError);
  });
});

describe("checkDecisions", () => {
  it("fails when the directory doesn't exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-adr-empty-"));
    const result = checkDecisions(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/no decisions\/ directory/);
  });

  it("fails when only README.md is present", () => {
    const root = fixtureRoot({ "README.md": "# decisions\n" });
    const result = checkDecisions(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/no ADR files/);
  });

  it("catches a duplicate id across two files", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-004", title: "Cache with Redis", status: "accepted", date: "2026-08-20" }),
      "ADR-004-cdn.md": adrFile({ id: "ADR-004", title: "Use a CDN", status: "accepted", date: "2026-08-20" }),
    });
    const result = checkDecisions(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("declared by more than one file"))).toBe(true);
  });

  it("catches a superseded_by pointing at an id that doesn't exist", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({
        id: "ADR-004",
        title: "Cache with Redis",
        status: "superseded",
        date: "2026-08-20",
        superseded_by: "ADR-099",
      }),
    });
    const result = checkDecisions(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("no ADR with that id exists"))).toBe(true);
  });

  it("catches a one-directional supersede link", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({
        id: "ADR-004",
        title: "Cache with Redis",
        status: "superseded",
        date: "2026-08-20",
        superseded_by: "ADR-005",
      }),
      "ADR-005-caching-v2.md": adrFile({
        id: "ADR-005",
        title: "Cache with Redis, revisited",
        status: "accepted",
        date: "2026-08-21",
        // deliberately omits supersedes: ADR-004
      }),
    });
    const result = checkDecisions(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("does not link back"))).toBe(true);
  });

  it("accepts a correctly linked supersede pair", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({
        id: "ADR-004",
        title: "Cache with Redis",
        status: "superseded",
        date: "2026-08-20",
        superseded_by: "ADR-005",
      }),
      "ADR-005-caching-v2.md": adrFile({
        id: "ADR-005",
        title: "Cache with Redis, revisited",
        status: "accepted",
        date: "2026-08-21",
        supersedes: "ADR-004",
      }),
    });
    const result = checkDecisions(root);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("throws DecisionLogError from assertDecisions on a broken directory", () => {
    const root = fixtureRoot({
      "ADR-004-caching.md": adrFile({ id: "ADR-005", title: "Cache with Redis", status: "accepted", date: "2026-08-20" }),
    });
    expect(() => assertDecisions(root)).toThrow(DecisionLogError);
  });
});
