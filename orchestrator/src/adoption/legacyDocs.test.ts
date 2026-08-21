import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { checkKnowledgeItem } from "../knowledge/knowledgeModel.js";
import { importLegacyDocs } from "./legacyDocs.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-docs-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const CLAUDE_MD = `# A Project — Agent Pipeline

The rules every agent here follows.

## Rules that hold across every agent
- No git, ever.
- Amend, don't regenerate.

## The pipeline
business-analyst → system-analyst → engineer
`;

const REQUIREMENT_MD = `# Sales CRM — Requirements

## Overview
A CRM.

## Core Features
- **REQ-001** — Staff can create an order for a customer.
- **REQ-002** — Staff can see yesterday's totals.

## Scope
In scope: orders.

## Change Log
2026-08-01: written.
`;

const TEST_PLAN_MD = `# Sales CRM — Test Strategy

**Has automated test framework:** yes — Vitest, per status.md's Scaffold line

## Phase 1: Orders

### REQ-001 — creating an order
- **Levels:** unit, api
- Rejects an order with no line items.

### REQ-002 — daily totals
- **Levels:** unit
- Totals exclude cancelled orders.
`;

describe("importLegacyDocs — the rules documents", () => {
  it("keeps CLAUDE.md's full text, because a rule you must open another file to read is a rule nobody reads", () => {
    const root = project({ "CLAUDE.md": CLAUDE_MD });

    const [item] = importLegacyDocs(root, NOW).items;

    expect(item.id).toBe("DES-RULES-CLAUDE");
    expect(item.title).toBe("A Project — Agent Pipeline");
    expect(item.body).toContain("No git, ever.");
    expect(item.body).toContain("business-analyst → system-analyst → engineer");
  });

  it("imports every policies/*.md the same way", () => {
    const root = project({
      "policies/coding.md": "# Coding\n\nGreen before handoff.\n",
      "policies/git.md": "# Git\n\nNo git, ever.\n",
    });

    const ids = importLegacyDocs(root, NOW).items.map((i) => i.id);

    expect(ids).toEqual(["DES-RULES-POLICIES-CODING", "DES-RULES-POLICIES-GIT"]);
  });
});

describe("importLegacyDocs — free prose", () => {
  it("indexes a README rather than copying it, keeping its title, opening and section list", () => {
    const root = project({
      "README.md": "# The Product\n\nIt does a thing for people who need the thing done.\n\n## Install\nnpm i\n\n## Usage\nRun it.\n",
    });

    const [item] = importLegacyDocs(root, NOW).items;

    expect(item.id).toBe("DES-DOC-README");
    expect(item.body).toContain("It does a thing");
    expect(item.body).toContain("Sections: Install · Usage");
  });

  it("walks docs/ and wiki/ recursively and skips the directories nobody means to import", () => {
    const root = project({
      "docs/architecture/overview.md": "# Overview\n\nHow it hangs together.\n",
      "docs/runbook.md": "# Runbook\n\nWhen it breaks.\n",
      "wiki/onboarding.md": "# Onboarding\n\nDay one.\n",
      "node_modules/some-pkg/README.md": "# Not ours\n\nno.\n",
    });

    const ids = importLegacyDocs(root, NOW).items.map((i) => i.id);

    expect(ids).toEqual(["DES-DOC-DOCS-ARCHITECTURE-OVERVIEW", "DES-DOC-DOCS-RUNBOOK", "DES-DOC-WIKI-ONBOARDING"]);
  });

  it("never guesses a kind from a heading — every prose file is one architecture item that claims no verdict", () => {
    const root = project({ "docs/business-rules.md": "# Business Rules\n\nOrders over 1000 need approval.\n" });

    const [item] = importLegacyDocs(root, NOW).items as [KnowledgeItemOf<"architecture">];

    expect(item.kind).toBe("architecture");
    expect(item.payload).toEqual({ feasibility: "unknown", risks: [], component: null });
  });
});

describe("importLegacyDocs — the module documents it owns", () => {
  it("parses requirement.md's Core Features into real requirement items", () => {
    const root = project({ "_docs/module/sales-crm/requirement.md": REQUIREMENT_MD });

    const items = importLegacyDocs(root, NOW).items as Array<KnowledgeItemOf<"requirement">>;

    expect(items.map((i) => i.id)).toEqual(["REQ-001", "REQ-002"]);
    expect(items[0].kind).toBe("requirement");
    expect(items[0].title).toBe("Staff can create an order for a customer.");
    expect(items[0].owner).toBe(AgentStage.BUSINESS_ANALYST);
    expect(items[0].module).toBe("sales-crm");
  });

  it("marks an imported requirement as unconfirmed, because nobody re-confirmed it during this adoption", () => {
    const root = project({ "_docs/module/sales-crm/requirement.md": REQUIREMENT_MD });

    const [item] = importLegacyDocs(root, NOW).items as Array<KnowledgeItemOf<"requirement">>;

    expect(item.payload.assumption_unconfirmed).toBe(true);
    expect(item.payload.acceptance_criteria).toEqual([]);
  });

  it("parses test-plan.md into test items that verify the requirement they name", () => {
    const root = project({ "_docs/module/sales-crm/test-plan.md": TEST_PLAN_MD });

    const items = importLegacyDocs(root, NOW).items as Array<KnowledgeItemOf<"test">>;

    expect(items.map((i) => i.id)).toEqual(["TEST-001", "TEST-002"]);
    expect(items[0].payload).toEqual({ levels: ["unit", "api"], automated: true });
    expect(items[0].relations).toEqual([{ type: "verifies", to: "REQ-001" }]);
    expect(items[1].payload.levels).toEqual(["unit"]);
  });

  it("reads `Has automated test framework: no` as no", () => {
    const root = project({
      "_docs/module/m/test-plan.md": "**Has automated test framework:** no — nothing scaffolded\n\n### REQ-001 — a thing\n- **Levels:** unit\n",
    });

    const [item] = importLegacyDocs(root, NOW).items as Array<KnowledgeItemOf<"test">>;

    expect(item.payload.automated).toBe(false);
  });

  it("indexes review/security/deploy as prose under their module", () => {
    const root = project({
      "_docs/module/m/review.md": "# Review\n\n## Open Issues\nNone.\n",
      "_docs/module/m/security.md": "# Security\n\n## Summary\nClean.\n",
      "_docs/module/m/deploy.md": "# Deploy\n\nStaging only.\n",
    });

    const items = importLegacyDocs(root, NOW).items;

    expect(items.map((i) => i.id)).toEqual([
      "DES-DOC-DOCS-MODULE-M-REVIEW",
      "DES-DOC-DOCS-MODULE-M-SECURITY",
      "DES-DOC-DOCS-MODULE-M-DEPLOY",
    ]);
    expect(items.every((i) => i.module === "m")).toBe(true);
  });

  it("leaves plan.md and design.md alone — they belong to T84 and T85", () => {
    const root = project({
      "_docs/module/m/plan.md": "## Phase 1: x\n- [ ] BE-001 — a task\n",
      "_docs/module/m/design.md": "## Data Model\nmodel A { id String @id }\n",
      "_docs/module/m/requirement.md": REQUIREMENT_MD,
    });

    const items = importLegacyDocs(root, NOW).items;

    expect(items.map((i) => i.id)).toEqual(["REQ-001", "REQ-002"]);
  });
});

describe("importLegacyDocs — provenance and hygiene", () => {
  it("cites its file with a digest and marks it as a legacy import, on every item", () => {
    const root = project({ "CLAUDE.md": CLAUDE_MD, "_docs/module/m/requirement.md": REQUIREMENT_MD });

    for (const item of importLegacyDocs(root, NOW).items) {
      expect(item.sources).toHaveLength(1);
      expect(item.sources[0].note).toBe("legacy import (T83)");
      expect(item.sources[0].digest).toMatch(/^sha256:/);
      expect(item.status).toBe("draft");
    }
  });

  it("registers one source per file, and every item is schema-valid", () => {
    const root = project({ "CLAUDE.md": CLAUDE_MD, "_docs/module/m/requirement.md": REQUIREMENT_MD });

    const result = importLegacyDocs(root, NOW);

    expect(result.sources.map((s) => s.locator)).toEqual(["CLAUDE.md", "_docs/module/m/requirement.md"]);
    for (const item of result.items) expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("skips an empty file and says it did, rather than importing an empty item", () => {
    const root = project({ "README.md": "   \n\n" });

    const result = importLegacyDocs(root, NOW);

    expect(result.items).toEqual([]);
    expect(result.notes.some((n) => n.includes("README.md is empty"))).toBe(true);
  });

  it("says a requirement.md with no Core Features produced nothing, instead of silence", () => {
    const root = project({ "_docs/module/m/requirement.md": "# Requirements\n\n## Overview\nA thing.\n" });

    const result = importLegacyDocs(root, NOW);

    expect(result.items).toEqual([]);
    expect(result.notes.some((n) => n.includes("produced no item"))).toBe(true);
  });

  it("finds nothing, and says nothing went wrong, in a project with no documents", () => {
    const root = project({ "src/index.ts": "export const x = 1;\n" });

    expect(importLegacyDocs(root, NOW)).toEqual({ items: [], sources: [], notes: [] });
  });

  it("finds a module's review.md under a nested docsRoot, and not at the default one (T113 pilot finding)", () => {
    const root = project({ "_docs/hkt/module/crm/review.md": "# Review\n\nEverything checks out.\n" });

    const nested = importLegacyDocs(root, NOW, path.join(root, "_docs", "hkt"));
    const atDefault = importLegacyDocs(root, NOW);

    expect(nested.items.length).toBeGreaterThan(0);
    expect(nested.sources[0].locator).toBe("_docs/hkt/module/crm/review.md");
    expect(atDefault.items).toEqual([]);
  });
});
