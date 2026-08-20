import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf, KnowledgeItemError } from "./knowledgeModel.js";
import {
  KnowledgeVersionConflictError,
  PROJECT_WIDE_DIR,
  knowledgeDir,
  loadKnowledge,
  pathFor,
  readKnowledgeFile,
  relativePathFor,
  renderKnowledgeItem,
  writeKnowledgeItem,
} from "./knowledgeStore.js";

const NOW = "2026-08-20T09:00:00Z";

function requirement(
  id: string,
  overrides: Partial<KnowledgeItemOf<"requirement">> = {},
): KnowledgeItemOf<"requirement"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind: "requirement",
    title: `พนักงานดูตารางกะของตัวเองได้ (${id})`,
    body: "staff can see their own shifts",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [
      { type: "file", locator: "_docs/module/sales-crm/requirement.md#L48-L61", captured_at: NOW, digest: "sha256:9f2a" },
    ],
    relations: [],
    payload: { acceptance_criteria: ["เห็นเฉพาะกะของตัวเอง"], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-knowledge-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("where an item lives", () => {
  it("derives the path from the item itself", () => {
    expect(relativePathFor(requirement("REQ-003"))).toBe("sales-crm/requirement/REQ-003.yaml");
    expect(pathFor(requirement("REQ-003"), root)).toBe(
      path.join(root, "knowledge", "sales-crm", "requirement", "REQ-003.yaml"),
    );
  });

  it("files a project-wide item under _project rather than at the top level, so one walk finds everything", () => {
    expect(relativePathFor({ id: "ADR-003", kind: "decision", module: null })).toBe(
      `${PROJECT_WIDE_DIR}/decision/ADR-003.yaml`,
    );
  });
});

describe("round trip", () => {
  it("writes an item and reads back exactly what went in", () => {
    const item = requirement("REQ-003");
    const file = writeKnowledgeItem(item, root);
    expect(fs.existsSync(file)).toBe(true);
    expect(readKnowledgeFile(file)).toEqual(item);
  });

  it("keeps Thai text and the multi-line body intact", () => {
    const item = requirement("REQ-004", { body: "บรรทัดแรก\nบรรทัดที่สอง\n" });
    writeKnowledgeItem(item, root);
    expect(readKnowledgeFile(pathFor(item, root)).body).toBe("บรรทัดแรก\nบรรทัดที่สอง\n");
  });

  it("renders identity first and the prose last — the order a person reads it in", () => {
    const keys = renderKnowledgeItem(requirement("REQ-003"))
      .split("\n")
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.split(":")[0]);
    expect(keys[0]).toBe("schema_version");
    expect(keys[1]).toBe("id");
    expect(keys[keys.length - 1]).toBe("body");
  });

  it("refuses to write an item that would not validate", () => {
    const broken = requirement("BE-003") as unknown as KnowledgeItemOf<"requirement">;
    expect(() => writeKnowledgeItem(broken, root)).toThrow(KnowledgeItemError);
  });
});

describe("version as the concurrency mechanism", () => {
  it("allows rewriting an unchanged item at the same version", () => {
    const item = requirement("REQ-003");
    writeKnowledgeItem(item, root);
    expect(() => writeKnowledgeItem(item, root)).not.toThrow();
  });

  it("refuses a changed item that did not bump", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    expect(() => writeKnowledgeItem(requirement("REQ-003", { title: "changed" }), root)).toThrow(
      KnowledgeVersionConflictError,
    );
  });

  it("accepts a changed item exactly one version ahead", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    const edited = requirement("REQ-003", { title: "changed", version: 2, updated_at: "2026-08-21T09:00:00Z" });
    expect(() => writeKnowledgeItem(edited, root)).not.toThrow();
    expect(readKnowledgeFile(pathFor(edited, root)).version).toBe(2);
  });

  it("refuses a jump of more than one — a skipped version means an edit nobody saw", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    expect(() => writeKnowledgeItem(requirement("REQ-003", { title: "changed", version: 4 }), root)).toThrow(
      KnowledgeVersionConflictError,
    );
  });

  it("refuses a version that goes backwards", () => {
    writeKnowledgeItem(requirement("REQ-003", { version: 3 }), root);
    expect(() => writeKnowledgeItem(requirement("REQ-003", { title: "changed", version: 2 }), root)).toThrow(
      KnowledgeVersionConflictError,
    );
  });

  it("refuses an unchanged item at a different version — nothing changed, so nothing should have bumped", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    expect(() => writeKnowledgeItem(requirement("REQ-003", { version: 2 }), root)).toThrow(
      KnowledgeVersionConflictError,
    );
  });

  it("force skips the check, for seeding a fresh knowledge/ where nothing can be a version behind", () => {
    writeKnowledgeItem(requirement("REQ-003", { version: 5 }), root);
    expect(() => writeKnowledgeItem(requirement("REQ-003", { title: "seeded", version: 1 }), root, { force: true })).not.toThrow();
  });
});

describe("loadKnowledge", () => {
  function writeRaw(relative: string, contents: string): void {
    const file = path.join(knowledgeDir(root), ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }

  it("reports a missing knowledge/ as missing rather than as a problem", () => {
    const result = loadKnowledge(root);
    expect(result).toEqual({ items: [], problems: [], missing: true });
  });

  it("loads every item under every module", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    writeKnowledgeItem(requirement("REQ-004", { module: "attendance" }), root);
    const result = loadKnowledge(root);
    expect(result.problems).toEqual([]);
    expect(result.items.map((i) => i.id).sort()).toEqual(["REQ-003", "REQ-004"]);
  });

  it("names the file when the YAML will not parse", () => {
    writeRaw("sales-crm/requirement/REQ-009.yaml", "id: [unclosed\n");
    const result = loadKnowledge(root);
    expect(result.items).toEqual([]);
    expect(result.problems.join("\n")).toContain("REQ-009.yaml");
    expect(result.problems.join("\n")).toContain("not valid YAML");
  });

  it("calls an unresolved conflict marker what it is, instead of a syntax error", () => {
    const item = renderKnowledgeItem(requirement("REQ-003"));
    writeRaw("sales-crm/requirement/REQ-003.yaml", `${item}<<<<<<< HEAD\nversion: 4\n=======\nversion: 5\n>>>>>>> other\n`);
    const result = loadKnowledge(root);
    expect(result.problems.join("\n")).toContain("conflict marker");
  });

  it("reports a file sitting somewhere other than where its own contents say it belongs", () => {
    writeRaw("attendance/requirement/REQ-003.yaml", renderKnowledgeItem(requirement("REQ-003")));
    const result = loadKnowledge(root);
    expect(result.items).toEqual([]);
    expect(result.problems.join("\n")).toContain("belongs at sales-crm/requirement/REQ-003.yaml");
  });

  it("reports two files claiming one id", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    writeRaw("sales-crm/architecture/REQ-003.yaml", renderKnowledgeItem(requirement("REQ-003")));
    const result = loadKnowledge(root);
    expect(result.problems.join("\n")).toMatch(/already declared by|belongs at/);
  });

  it("keeps loading the good files when one is unusable — one bad file must not hide the other forty", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    writeRaw("sales-crm/requirement/REQ-010.yaml", "not: an item\n");
    const result = loadKnowledge(root);
    expect(result.items.map((i) => i.id)).toEqual(["REQ-003"]);
    expect(result.problems).toHaveLength(1);
  });

  it("ignores files that are not .yaml, so a README in knowledge/ is not a problem", () => {
    writeKnowledgeItem(requirement("REQ-003"), root);
    fs.writeFileSync(path.join(knowledgeDir(root), "README.md"), "# knowledge\n", "utf8");
    expect(loadKnowledge(root).problems).toEqual([]);
  });
});
