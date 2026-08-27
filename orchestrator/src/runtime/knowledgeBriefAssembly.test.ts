import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { knowledgeBriefFor, renderKnowledgeBrief } from "./knowledgeBriefAssembly.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";

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

  it("surfaces compact freshness markers, reasons only for changed/unavailable, and stays within the byte cap", () => {
    const fresh = { id: "DES-001", verdict: "fresh" as const, ageDays: 0, oldestSource: null, changedSources: [], missingSources: [], reason: "read today" };
    const changed = { id: "API-001", verdict: "changed" as const, ageDays: 1, oldestSource: null, changedSources: ["api.md"], missingSources: [], reason: "changed since it was read: api.md" };
    const parts = renderKnowledgeBrief([
      { ...item("architecture", "DES-001"), freshness: fresh },
      { ...item("api", "API-001"), freshness: changed },
    ], AgentStage.QA_ENGINEER, { moduleName: "sb-compass", visibleKinds: ALL, cap: 16_384 });
    const text = parts.join("\n");
    expect(text).toContain("[fresh]");
    expect(text).toContain("[changed]");
    expect(text).toContain("freshness: changed since it was read: api.md");
    expect(text).not.toContain("freshness: read today");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16_384);
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

describe("T-V3-09/T-V3-11 assembled retrieval", () => {
  function root(prefix: string): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    fs.mkdirSync(path.join(value, ".git"));
    return value;
  }
  function req(id: string, targetIds: string[], source: KnowledgeItem["sources"]): KnowledgeItem {
    return {
      schema_version: 2, target_ids: targetIds, id, kind: "requirement", title: id, body: "body", repo: null, module: "sb-compass",
      owner: AgentStage.BUSINESS_ANALYST, status: "approved", sensitive: false, version: 1, created_at: NOW, updated_at: NOW,
      sources: source, relations: [], payload: { acceptance_criteria: ["works"], actors: ["user"], priority: "must", assumption_unconfirmed: false },
    };
  }
  it("excludes another Target, keeps globals, reports the count, and fails open by name when resolution fails", () => {
    const knowledge = root("brief-k"); const targetA = root("brief-a"); const targetB = root("brief-b"); const unmapped = root("brief-unmapped");
    try {
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), JSON.stringify({ schema_version: 1, targets: [
        { target_id: "node-app", name: "Node", remote_url: "https://example.com/node.git", status: "active" },
        { target_id: "dotnet-app", name: "Dotnet", remote_url: "https://example.com/dotnet.git", status: "active" },
      ] }));
      fs.mkdirSync(path.join(knowledge, ".workflow"), { recursive: true });
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), JSON.stringify({ schema_version: 1, targets: { "node-app": { path: targetA }, "dotnet-app": { path: targetB } } }));
      fs.writeFileSync(path.join(knowledge, "global.md"), "global", "utf8");
      fs.writeFileSync(path.join(targetA, "fact.md"), "node", "utf8");
      fs.writeFileSync(path.join(targetB, "fact.md"), "dotnet", "utf8");
      const source = (locator: string, origin: "knowledge" | "target", targetId: string | null, digestRoot: string) => [{ type: "file" as const, locator, captured_at: NOW, digest: digestOfSource(locator, digestRoot), origin: { root: origin, target_id: targetId } }];
      writeKnowledgeItem(req("REQ-GLOBAL", [], source("global.md", "knowledge", null, knowledge)), knowledge, { force: true });
      writeKnowledgeItem(req("REQ-NODE", ["node-app"], source("fact.md", "target", "node-app", targetA)), knowledge, { force: true });
      writeKnowledgeItem(req("REQ-DOTNET", ["dotnet-app"], source("fact.md", "target", "dotnet-app", targetB)), knowledge, { force: true });
      const scoped = knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: targetA, knowledgeRoot: knowledge, targetRoot: targetA, moduleName: "sb-compass", now: NOW }).join("\n");
      expect(scoped).toContain("REQ-GLOBAL"); expect(scoped).toContain("REQ-NODE"); expect(scoped).not.toContain("REQ-DOTNET");
      expect(scoped).toContain("Scope-excluded: 1");
      const fallback = knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: unmapped, knowledgeRoot: knowledge, targetRoot: unmapped, moduleName: "sb-compass", now: NOW }).join("\n");
      expect(fallback).toContain("legacy unscoped fallback"); expect(fallback).toContain("REQ-NODE"); expect(fallback).toContain("REQ-DOTNET");
      const noFreshness = knowledgeBriefFor(AgentStage.BACKEND_ENGINEER, { projectRoot: targetA, knowledgeRoot: knowledge, targetRoot: targetA, moduleName: "sb-compass", now: NOW, freshnessResolver: () => { throw new Error("fixture failure"); } }).join("\n");
      expect(noFreshness).not.toContain("[fresh]"); expect(noFreshness).toContain("REQ-NODE");
    } finally {
      for (const value of [knowledge, targetA, targetB, unmapped]) fs.rmSync(value, { recursive: true, force: true });
    }
  });
});
