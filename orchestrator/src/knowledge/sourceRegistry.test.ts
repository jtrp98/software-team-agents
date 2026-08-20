import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ID_PREFIXES, KNOWLEDGE_KINDS, KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "./knowledgeModel.js";
import { loadKnowledge, writeKnowledgeItem } from "./knowledgeStore.js";
import { checkKnowledge } from "./knowledgeBase.js";
import {
  SourceRecordError,
  SourceRegistry,
  type SourceRecord,
  baseLocator,
  crossCheckRegistry,
  loadSourceRegistry,
  sourceIdFor,
  sourcePath,
  writeSourceRecord,
} from "./sourceRegistry.js";

const NOW = "2026-08-20T09:00:00Z";

function source(id: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    type: "file",
    locator: "_docs/module/sales-crm/requirement.md",
    captured_at: NOW,
    captured_by: AgentStage.BUSINESS_ANALYST,
    digest: "sha256:9f2a",
    ...overrides,
  };
}

function requirement(id: string, sourceIds: Array<string | undefined>, locator = "_docs/module/sales-crm/requirement.md#L48-L61"): KnowledgeItemOf<"requirement"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind: "requirement",
    title: id,
    body: "",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: sourceIds.map((source_id) => ({
      type: "file" as const,
      locator,
      captured_at: NOW,
      digest: null,
      ...(source_id ? { source_id } : {}),
    })),
    relations: [],
    payload: { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
  };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-sources-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("source ids", () => {
  it("derives a stable, readable id from a locator", () => {
    expect(sourceIdFor("_docs/module/sales-crm/design.md")).toBe("SRC-_docs-module-sales-crm-design.md");
    expect(sourceIdFor("public.shifts")).toBe("SRC-public.shifts");
  });

  it("treats a line range as a slice of one source, not as another source", () => {
    expect(sourceIdFor("a/b.md#L1-L10")).toBe(sourceIdFor("a/b.md#L90-L99"));
    expect(baseLocator("a/b.md#L1-L10")).toBe("a/b.md");
  });

  it("uses a prefix no knowledge kind uses, so a source id can never read as an item id", () => {
    const itemPrefixes = KNOWLEDGE_KINDS.flatMap((k) => ID_PREFIXES[k]);
    expect(itemPrefixes).not.toContain("SRC");
  });
});

describe("source records on disk", () => {
  it("round-trips a record", () => {
    writeSourceRecord(source("SRC-req-md"), root);
    const result = loadSourceRegistry(root);
    expect(result.problems).toEqual([]);
    expect(result.records).toEqual([source("SRC-req-md")]);
  });

  it("refuses to write a record that would not validate", () => {
    expect(() => writeSourceRecord(source("req-md"), root)).toThrow(SourceRecordError);
    expect(() => writeSourceRecord({ ...source("SRC-x"), captured_by: "developer" as AgentStage }, root)).toThrow(
      SourceRecordError,
    );
  });

  it("reports a missing _sources/ as missing rather than as a problem", () => {
    expect(loadSourceRegistry(root)).toEqual({ records: [], problems: [], missing: true });
  });

  it("reports a file whose name disagrees with the id it declares", () => {
    fs.mkdirSync(path.dirname(sourcePath("SRC-a", root)), { recursive: true });
    fs.writeFileSync(sourcePath("SRC-a", root), `schema_version: 1\nid: SRC-b\ntype: file\nlocator: x\ncaptured_at: "${NOW}"\ncaptured_by: human\ndigest: null\n`, "utf8");
    expect(loadSourceRegistry(root).problems.join("\n")).toContain("belongs at _sources/SRC-b.yaml");
  });

  it("keeps loading when one record is broken", () => {
    writeSourceRecord(source("SRC-good"), root);
    fs.writeFileSync(sourcePath("SRC-bad", root), "id: [unclosed\n", "utf8");
    const result = loadSourceRegistry(root);
    expect(result.records.map((r) => r.id)).toEqual(["SRC-good"]);
    expect(result.problems).toHaveLength(1);
  });

  it("is skipped by the item walk — a source record is not a malformed item", () => {
    writeSourceRecord(source("SRC-req-md"), root);
    writeKnowledgeItem(requirement("REQ-003", [undefined]), root);
    const loaded = loadKnowledge(root);
    expect(loaded.problems).toEqual([]);
    expect(loaded.items.map((i) => i.id)).toEqual(["REQ-003"]);
  });
});

describe("lookup", () => {
  const registry = new SourceRegistry([source("SRC-req-md"), source("SRC-db", { type: "db", locator: "public.shifts" })]);

  it("finds a record by id and by locator, ignoring the line range", () => {
    expect(registry.get("SRC-db")?.type).toBe("db");
    expect(registry.forLocator("_docs/module/sales-crm/requirement.md#L48-L61")?.id).toBe("SRC-req-md");
  });

  it("returns null rather than throwing for material nobody registered", () => {
    expect(registry.get("SRC-nope")).toBeNull();
    expect(registry.forLocator("somewhere/else.md")).toBeNull();
  });
});

describe("cross-check between items and the registry", () => {
  const registry = new SourceRegistry([source("SRC-req-md"), source("SRC-lonely", { locator: "legacy/spec.md" })]);

  it("passes when every cited source resolves", () => {
    const result = crossCheckRegistry([requirement("REQ-003", ["SRC-req-md"])], registry);
    expect(result.problems).toEqual([]);
  });

  it("reports a source_id that resolves to nothing — a claim of provenance nobody can follow", () => {
    const result = crossCheckRegistry([requirement("REQ-003", ["SRC-ghost"])], registry);
    expect(result.problems.join("\n")).toContain("SRC-ghost");
  });

  it("reports a citation whose locator disagrees with the record it names", () => {
    const item = requirement("REQ-003", ["SRC-req-md"], "some/other/file.md");
    expect(crossCheckRegistry([item], registry).problems.join("\n")).toContain("pointing at the wrong material");
  });

  it("lists registered material nothing was derived from — the discovery queue, not an error", () => {
    const result = crossCheckRegistry([requirement("REQ-003", ["SRC-req-md"])], registry);
    expect(result.underived.map((r) => r.id)).toEqual(["SRC-lonely"]);
    expect(result.problems).toEqual([]);
  });

  it("matches a citation to a record by locator even when it names no source_id", () => {
    const result = crossCheckRegistry([requirement("REQ-003", [undefined])], registry);
    expect(result.underived.map((r) => r.id)).toEqual(["SRC-lonely"]);
    expect(result.unregisteredLocators).toEqual([]);
  });

  it("lists cited material nobody registered", () => {
    const item = requirement("REQ-003", [undefined], "legacy/undocumented.md");
    expect(crossCheckRegistry([item], registry).unregisteredLocators).toEqual(["legacy/undocumented.md"]);
  });
});

describe("checkKnowledge with a registry", () => {
  it("fails when an item cites a source the registry does not have", () => {
    writeKnowledgeItem(requirement("REQ-003", ["SRC-ghost"]), root);
    writeSourceRecord(source("SRC-req-md"), root);
    const report = checkKnowledge(root);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("SRC-ghost");
  });

  it("passes with a note when material has been ingested but nothing derived from it yet", () => {
    writeSourceRecord(source("SRC-req-md"), root);
    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.notes.join("\n")).toContain("SRC-req-md");
  });
});
