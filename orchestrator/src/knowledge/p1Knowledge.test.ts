import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import type { KnowledgeItem } from "./knowledgeModel.js";
import { KnowledgeBase, checkKnowledge } from "./knowledgeBase.js";
import { seedKnowledgeFixture } from "./knowledgeFixture.testSupport.js";
import { RECONCILIATION_VERDICTS, classifyReconciliationItem, reconcileKnowledge, type ReconciliationEvidence } from "./reconcile.js";
import { digestOfSource } from "./sourceDigest.js";
import { defaultProjectRoot } from "../agents/agentContract.js";

const NOW = "2026-08-27T00:00:00.000Z";
const roots: string[] = [];
function tmp(name: string): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); roots.push(root); fs.mkdirSync(path.join(root, ".git")); return root; }
function write(root: string, rel: string, body: string): void { const file = path.join(root, ...rel.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, "utf8"); }
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function requirement(id: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    schema_version: 1, id, kind: "requirement", title: id, body: "keep body", repo: null, module: "m",
    owner: AgentStage.BUSINESS_ANALYST, status: "approved", sensitive: false, version: 7,
    created_at: NOW, updated_at: NOW,
    sources: [{ type: "file", locator: "_docs/module/m/requirement.md", captured_at: NOW, digest: "sha256:old" }],
    relations: [], payload: { acceptance_criteria: ["x"], actors: ["user"], priority: "must", assumption_unconfirmed: false },
    ...extra,
  } as KnowledgeItem;
}

describe("T-V3-09 target-scoped KnowledgeQuery", () => {
  it("keeps globals and the current Target while counting exclusion at the shared query seam", () => {
    const global = requirement("REQ-G", { schema_version: 2, target_ids: [], sources: [{ ...requirement("REQ-G").sources[0]!, origin: { root: "knowledge", target_id: null } }] });
    const a = requirement("REQ-A", { schema_version: 2, target_ids: ["A"], sources: [{ ...requirement("REQ-A").sources[0]!, origin: { root: "target", target_id: "A" } }] });
    const b = requirement("REQ-B", { schema_version: 2, target_ids: ["B"], sources: [{ ...requirement("REQ-B").sources[0]!, origin: { root: "target", target_id: "B" } }] });
    const kb = new KnowledgeBase([global, a, b]);
    expect(kb.query({ module: "m", target_ids: ["A"] }).map((item) => item.id)).toEqual(["REQ-G", "REQ-A"]);
    expect(kb.query({ module: "m" }).map((item) => item.id)).toEqual(["REQ-G", "REQ-A", "REQ-B"]);
  });
});

describe("T-V3-10 reconciliation Cases A-E", () => {
  it("implements all nine verdict conditions in isolation", () => {
    const ev = (root: "knowledge" | "target" | "external", state: ReconciliationEvidence["digest_state"], targetId: string | null = null, locator = "x.md"): ReconciliationEvidence => ({
      locator, origin: { root, target_id: targetId }, stored_digest: state === "unhashable" ? null : "sha256:old", current_digest: state === "unchanged" ? "sha256:old" : state === "changed" ? "sha256:new" : null, digest_state: state, reason: state,
    });
    const base = requirement("REQ-X", { schema_version: 2, target_ids: [], sources: [{ ...requirement("REQ-X").sources[0]!, origin: { root: "knowledge", target_id: null } }] });
    const mixed = { ...base, sources: [{ ...base.sources[0]!, origin: { root: "knowledge", target_id: null } }, { ...base.sources[0]!, locator: "target.md", origin: { root: "target", target_id: "a" } }] } as KnowledgeItem;
    const design = { ...base, kind: "api", id: "API-X", sources: [{ ...base.sources[0]!, locator: "_docs/module/m/design.md", origin: { root: "knowledge", target_id: null } }, { ...base.sources[0]!, locator: "api.ts", origin: { root: "target", target_id: "a" } }], payload: { method: "GET", path: "/x", contract_name: null, request_shape: null, response_shape: null } } as KnowledgeItem;
    const classify = (item: KnowledgeItem, evidence: ReconciliationEvidence[], conflict?: string, targets = new Set(["a", "b"])) => classifyReconciliationItem(item, evidence, conflict, targets).verdict;
    expect(classify(mixed, [ev("knowledge", "unchanged"), ev("target", "unchanged", "a")])).toBe("match");
    expect(classify(mixed, [ev("knowledge", "unchanged"), ev("target", "changed", "a")])).toBe("knowledge-stale");
    expect(classify(design, [ev("knowledge", "changed", null, "_docs/module/m/design.md"), ev("target", "unchanged", "a", "api.ts")])).toBe("target-stale");
    expect(classify(base, [ev("knowledge", "changed")])).toBe("pending-requirement");
    expect(classify(design, [ev("knowledge", "unchanged", null, "_docs/module/m/design.md"), ev("target", "changed", "a", "api.ts")])).toBe("implementation-drift");
    expect(classify({ ...mixed, target_ids: ["a"] } as KnowledgeItem, [ev("target", "unchanged", "a")])).toBe("target-specific");
    expect(classify(mixed, [ev("target", "unchanged", "a"), ev("target", "unchanged", "b")])).toBe("global-fact");
    expect(classify(mixed, [ev("knowledge", "unchanged"), ev("target", "unchanged", "a")], "approved items disagree")).toBe("conflict");
    expect(classify(base, [ev("external", "unhashable")])).toBe("unknown");
  });

  function fixture(): { knowledge: string; a: string; b: string } {
    const knowledge = tmp("reconcile-k"); const a = tmp("reconcile-a"); const b = tmp("reconcile-b");
    write(knowledge, "targets.yaml", JSON.stringify({ schema_version: 1, targets: [
      { target_id: "a", name: "A", remote_url: "https://example.com/a.git", status: "active" },
      { target_id: "b", name: "B", remote_url: "https://example.com/b.git", status: "active" },
    ] }));
    write(knowledge, ".workflow/targets.local.yaml", JSON.stringify({ schema_version: 1, targets: { a: { path: a }, b: { path: b } } }));
    write(a, "current.txt", "new target"); write(b, "current.txt", "b target");
    write(knowledge, "desired.txt", "new desired"); write(knowledge, "stable.txt", "stable");
    const source = (root: "knowledge" | "target" | "external", locator: string, targetId: string | null, digest: string | null) => ({ type: "file" as const, locator, captured_at: NOW, digest, origin: { root, target_id: targetId } });
    const aStale = requirement("REQ-A", { schema_version: 2, target_ids: ["a"], sources: [source("target", "current.txt", "a", "sha256:old")] });
    const pending = requirement("REQ-P", { schema_version: 2, target_ids: [], sources: [source("knowledge", "desired.txt", null, "sha256:old")] });
    const specificA = { ...requirement("REQ-SA"), schema_version: 2, target_ids: ["a"], sources: [source("target", "current.txt", "a", digestOfSource("current.txt", a))] } as KnowledgeItem;
    const specificB = { ...requirement("REQ-SB"), schema_version: 2, target_ids: ["b"], sources: [source("target", "current.txt", "b", digestOfSource("current.txt", b))] } as KnowledgeItem;
    const unknown = requirement("REQ-U", { schema_version: 2, target_ids: [], sources: [source("external", "interview", null, null)] });
    const match = { ...requirement("REQ-M"), schema_version: 2, target_ids: [], sources: [source("knowledge", "stable.txt", null, digestOfSource("stable.txt", knowledge)), source("target", "current.txt", "a", digestOfSource("current.txt", a))] } as KnowledgeItem;
    for (const item of [aStale, pending, specificA, specificB, unknown, match]) seedKnowledgeFixture(item, knowledge);
    return { knowledge, a, b };
  }
  it("classifies A-E deterministically, without cross-Target conflicts or writes", () => {
    expect(RECONCILIATION_VERDICTS).toHaveLength(9);
    const { knowledge } = fixture();
    const before = hashTree(knowledge);
    const first = reconcileKnowledge({ knowledgeRoot: knowledge, frameworkRoot: defaultProjectRoot(), targetId: "a", now: NOW });
    const verdict = new Map(first.items.map((item) => [item.id, item.verdict]));
    expect(verdict.get("REQ-A")).toBe("knowledge-stale"); // A
    expect(verdict.get("REQ-P")).toBe("pending-requirement"); // B
    expect(verdict.get("REQ-SA")).toBe("target-specific"); // C
    expect(first.items.some((item) => item.id === "REQ-SB")).toBe(false); // B scope never leaks into A
    const forB = reconcileKnowledge({ knowledgeRoot: knowledge, frameworkRoot: defaultProjectRoot(), targetId: "b", now: NOW });
    expect(forB.items.find((item) => item.id === "REQ-SB")?.verdict).toBe("target-specific"); // C, other Target
    expect(forB.items.some((item) => item.id === "REQ-SA")).toBe(false);
    expect(verdict.get("REQ-U")).toBe("unknown"); // D
    expect(verdict.get("REQ-M")).toBe("match"); // E
    expect(reconcileKnowledge({ knowledgeRoot: knowledge, frameworkRoot: defaultProjectRoot(), targetId: "a", now: NOW })).toEqual(first);
    expect(hashTree(knowledge)).toBe(before);
  });

  it("is exposed under sta knowledge reconcile with stable JSON", async () => {
    const { knowledge } = fixture();
    const before = hashTree(knowledge);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value?: unknown) => { lines.push(String(value)); });
    try {
      const { runCli } = await import("../cli.js");
      expect(await runCli(["knowledge", "reconcile", "--target", "a", "--json", "--project-root", knowledge, "--now", NOW], defaultProjectRoot())).toBe(0);
      const first = lines.join("\n"); lines.length = 0;
      expect(await runCli(["knowledge", "reconcile", "--target", "a", "--json", "--project-root", knowledge, "--now", NOW], defaultProjectRoot())).toBe(0);
      expect(lines.join("\n")).toBe(first);
      expect(JSON.parse(first).target_id).toBe("a");
      expect(hashTree(knowledge)).toBe(before);
    } finally { log.mockRestore(); }
  });
});

function hashTree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue; const abs = path.join(dir, entry.name); if (entry.isDirectory()) walk(abs); else rows.push(`${path.relative(root, abs)}:${fs.readFileSync(abs).toString("base64")}`);
  } };
  walk(root); return rows.join("\n");
}
