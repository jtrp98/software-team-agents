import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { listRunDocs, readRunDoc } from "./runDocs.js";

describe("run documents", () => {
  let root: string;
  let moduleName: string;
  let draftId: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-rundocs-"));
    const items = sampleKnowledge().filter((item) => item.module);
    moduleName = items[0].module!;
    for (const item of items.filter((i) => i.module === moduleName)) writeKnowledgeItem(item, root, { force: true });
    draftId = items.find((i) => i.module === moduleName && i.status === "draft")!.id;
    const dir = path.join(root, "_docs", "module", moduleName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\ntext");
    fs.writeFileSync(path.join(dir, "design-archive.md"), "old");
    fs.writeFileSync(path.join(root, "secret.md"), "outside");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists the named items and the module's markdown, never archives", () => {
    const docs = listRunDocs(root, moduleName, [draftId]);
    expect(docs.filter((d) => d.group === "item").map((d) => d.label.split(" — ")[0])).toEqual([draftId]);
    expect(docs.filter((d) => d.group === "doc").map((d) => d.path)).toEqual([`_docs/module/${moduleName}/design.md`]);
  });

  it("without ids lists only items still short of approved", () => {
    const items = listRunDocs(root, moduleName, []).filter((d) => d.group === "item");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((d) => d.status !== "approved")).toBe(true);
  });

  it("reads a module document and an item's body", () => {
    expect(readRunDoc(root, moduleName, `_docs/module/${moduleName}/design.md`)?.markdown).toContain("# Design");
    const item = listRunDocs(root, moduleName, [draftId]).find((d) => d.group === "item")!;
    expect(readRunDoc(root, moduleName, item.path)?.markdown).toContain(`# ${draftId}`);
  });

  it("refuses anything outside the module's document shapes", () => {
    expect(readRunDoc(root, moduleName, "secret.md")).toBeNull();
    expect(readRunDoc(root, moduleName, `_docs/module/${moduleName}/../../../secret.md`)).toBeNull();
    expect(readRunDoc(root, moduleName, `_docs/module/other/design.md`)).toBeNull();
    expect(readRunDoc(root, moduleName, "")).toBeNull();
  });
});
