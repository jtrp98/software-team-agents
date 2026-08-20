import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import { readBootstrapState } from "../bootstrapStore.js";
import { documentationDiscoveryStage } from "./documentationDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return documentationDiscoveryStage(now).discover(root);
}

function architectureOf(result: DiscoveryResult, id: string): KnowledgeItemOf<"architecture"> {
  const item = result.items.find((i) => i.id === id);
  if (!item || item.kind !== "architecture") throw new Error(`expected an architecture item with id ${id}`);
  return item;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-doc-discovery-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("documentationDiscoveryStage", () => {
  it("reports skipped with a note when there is no README/docs/wiki at all", async () => {
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no README.md");
  });

  it("parses README.md into a title, snippet, and heading outline", async () => {
    write(
      path.join(root, "README.md"),
      [
        "# Sales CRM",
        "",
        "A small internal tool for tracking leads and follow-ups.",
        "",
        "## Installation",
        "",
        "Run npm install.",
        "",
        "## Usage",
        "",
        "Run npm start.",
      ].join("\n"),
    );

    const result = await discover(root);
    const item = architectureOf(result, "DES-DOC-README");
    expect(checkKnowledgeItem(item)).toEqual([]);
    expect(item.title).toBe("Documented: Sales CRM");
    expect(item.body).toContain("A small internal tool for tracking leads and follow-ups.");
    expect(item.body).toContain("Sections: Installation, Usage.");
    expect(item.payload.feasibility).toBe("unknown");
    expect(item.payload.component).toBeNull();
  });

  it("does not report the H1 itself as a section when the doc has no other headings", async () => {
    write(path.join(root, "docs", "guides", "deploy.md"), "# Deploy Guide\n\nHow to deploy.");
    const result = await discover(root);
    const item = architectureOf(result, "DES-DOC-DOCS-GUIDES-DEPLOY");
    expect(item.body).not.toContain("Sections:");
  });

  it("falls back to the relative path as a title when there is no H1", async () => {
    write(path.join(root, "docs", "notes.md"), "Just some notes, no heading at all.");
    const result = await discover(root);
    const item = architectureOf(result, "DES-DOC-DOCS-NOTES");
    expect(item.title).toBe("Documented: docs/notes.md");
  });

  it("walks docs/ and wiki/ recursively, and skips node_modules if nested inside them", async () => {
    write(path.join(root, "docs", "guides", "deploy.md"), "# Deploy Guide\n\nHow to deploy.");
    write(path.join(root, "wiki", "Home.md"), "# Wiki Home\n\nStart here.");
    write(path.join(root, "docs", "node_modules", "junk.md"), "# Should be ignored");

    const result = await discover(root);
    const ids = result.items.map((i) => i.id).sort();
    expect(ids).toEqual(["DES-DOC-DOCS-GUIDES-DEPLOY", "DES-DOC-WIKI-HOME"]);
  });

  it("skips an empty markdown file and notes it, without failing the whole stage", async () => {
    write(path.join(root, "README.md"), "# Real\n\nContent here.");
    write(path.join(root, "docs", "empty.md"), "   \n\n  ");

    const result = await discover(root);
    expect(result.items).toHaveLength(1);
    expect(result.note).toContain("skipped 1 empty file(s)");
    expect(result.note).toContain("docs/empty.md");
  });

  it("registers one source per non-empty doc with a content digest, and truncates a long first paragraph", async () => {
    const long = "x".repeat(500);
    write(path.join(root, "README.md"), `# Long\n\n${long}`);
    const result = await discover(root);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.digest).toMatch(/^sha256:[0-9a-f]{16}$/);
    const item = architectureOf(result, "DES-DOC-README");
    expect(item.body).toContain("…");
    expect(item.body.length).toBeLessThan(long.length);
  });
});

describe("documentationDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/, marks the documentation stage done, and passes --check-knowledge", async () => {
    write(path.join(root, "README.md"), "# Project\n\nWhat this project is.");
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(documentationDiscoveryStage(() => NOW), root, NOW);

    const docStage = state.stages.find((s) => s.id === "documentation")!;
    expect(docStage.status).toBe("done");
    expect(docStage.knowledge_ids).toEqual(["DES-DOC-README"]);

    expect(fs.existsSync(path.join(root, "knowledge", "_project", "architecture", "DES-DOC-README.yaml"))).toBe(true);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);

    const { state: reread } = readBootstrapState(root);
    expect(reread!.status).toBe("discovering"); // other stages still pending
  });

  it("marks the stage skipped (not done) when nothing was found, and still settles it", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(documentationDiscoveryStage(() => NOW), root, NOW);
    expect(state.stages.find((s) => s.id === "documentation")!.status).toBe("skipped");
  });
});
