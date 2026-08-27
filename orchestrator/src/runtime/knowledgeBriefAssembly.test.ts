import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { knowledgeBriefFor, renderKnowledgeBrief } from "./knowledgeBriefAssembly.js";

const NOW = "2026-08-26T00:00:00Z";

function item(kind: string, id: string, overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    schema_version: 2,
    id,
    kind,
    title: `title of ${id}`,
    body: "",
    repo: null,
    module: "sb-compass",
    owner: "backend-engineer",
    status: "approved",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [],
    relations: [],
    payload: {},
    ...overrides,
  } as unknown as KnowledgeItem;
}

describe("renderKnowledgeBrief", () => {
  const ALL = new Set(["task", "db-schema", "api", "architecture", "requirement"]);

  it("renders nothing when the module has no visible items — no noise for an empty store", () => {
    expect(renderKnowledgeBrief([], AgentStage.QA_ENGINEER, { moduleName: "sb-compass" })).toEqual([]);
    expect(
      renderKnowledgeBrief([item("task", "BE-001")], AgentStage.QA_ENGINEER, {
        moduleName: "some-other-module",
        visibleKinds: ALL,
      }),
    ).toEqual([]);
  });

  it("groups by kind, marks status, and caps a kind with a how-to-see-more note", () => {
    const items = [
      ...Array.from({ length: 45 }, (_, i) => item("task", `BE-${String(i + 1).padStart(3, "0")}`)),
      item("db-schema", "DB-Shift"),
    ];
    const parts = renderKnowledgeBrief(items, AgentStage.QA_ENGINEER, {
      moduleName: "sb-compass",
      visibleKinds: ALL,
    });
    expect(parts).toContain("### task (45)");
    expect(parts.filter((l) => l.startsWith("- BE-")).length).toBe(40);
    expect(parts.join("\n")).toContain("_+5 more task items");
    expect(parts).toContain("### db-schema (1)");
    expect(parts).toContain("- DB-Shift ✅ title of DB-Shift");
  });

  it("names the kinds a stage's view excludes instead of dropping them silently", () => {
    const parts = renderKnowledgeBrief(
      [item("task", "BE-001"), item("ux-design", "UX-001")],
      AgentStage.QA_ENGINEER,
      { moduleName: "sb-compass", visibleKinds: new Set(["task"]) },
    );
    expect(parts.join("\n")).not.toContain("ux-design");
    expect(parts.join("\n")).not.toContain("UX-001 ✕");
  });

  it("caps long titles so one verbose row cannot bloat the brief", () => {
    const long = "x".repeat(300);
    const parts = renderKnowledgeBrief([item("api", "API-1", { title: long })], AgentStage.QA_ENGINEER, {
      moduleName: "sb-compass",
      visibleKinds: ALL,
    });
    const line = parts.find((l) => l.startsWith("- API-1"))!;
    expect(line.length).toBeLessThan(140);
    expect(line.endsWith("…")).toBe(true);
  });

  it("uses roleView when no visibleKinds override is given — ux-design is not QA's kind", () => {
    const parts = renderKnowledgeBrief(
      [item("ux-design", "UX-001"), item("db-schema", "DB-1")],
      AgentStage.QA_ENGINEER,
      { moduleName: "sb-compass" },
    );
    const joined = parts.join("\n");
    if (parts.length > 0) {
      expect(joined).not.toContain("- UX-001");
    }
  });

  it("expands a bounded body only for an explicitly referenced visible item", () => {
    const parts = renderKnowledgeBrief(
      [item("architecture", "DES-001", { body: "referenced architecture body" }), item("api", "API-001", { body: "unreferenced API body" })],
      AgentStage.QA_ENGINEER,
      { moduleName: "sb-compass", visibleKinds: ALL, referencedIds: ["DES-001"] },
    );
    const joined = parts.join("\n");
    expect(joined).toContain("referenced architecture body");
    expect(joined).not.toContain("unreferenced API body");
  });

  it("does not expand a body the field policy withheld", () => {
    const redacted = { ...item("architecture", "DES-001", { body: "withheld architecture body" }), withheld: ["body"] };
    const parts = renderKnowledgeBrief(
      [redacted],
      AgentStage.QA_ENGINEER,
      { moduleName: "sb-compass", visibleKinds: ALL, referencedIds: ["DES-001"] },
    );
    expect(parts.join("\n")).not.toContain("withheld architecture body");
    expect(parts.join("\n")).toContain("withheld: body");
  });

  it("drops optional body expansions before index lines when the total cap is reached", () => {
    const parts = renderKnowledgeBrief(
      [item("architecture", "DES-001", { body: `body that must be removed first ${"x".repeat(400)}` }), item("api", "API-001")],
      AgentStage.QA_ENGINEER,
      { moduleName: "sb-compass", visibleKinds: ALL, referencedIds: ["DES-001"], cap: 260 },
    );
    const joined = parts.join("\n");
    expect(joined).toContain("DES-001");
    expect(joined).toContain("API-001");
    expect(joined).not.toContain("body that must be removed first");
  });

  it("keeps the established fail-soft empty brief posture when policy loading fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-brief-fail-"));
    try {
      fs.writeFileSync(path.join(root, "knowledge-policy.yaml"), "not: a valid policy\n", "utf8");
      expect(knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: root, moduleName: "sb-compass" })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
