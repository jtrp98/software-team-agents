import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem } from "./knowledgeModel.js";
import { pathFor, writeKnowledgeItem } from "./knowledgeStore.js";
import { applyLanding, classifyLanding, emptyLanded, landItem } from "./landing.js";

/**
 * The rule two writers share (bootstrap's discovery, V1.3's adoption) and a
 * third only previews (T87's dry run). The property worth locking is not any
 * one verdict — it is that the preview and the apply are the same decision, so
 * a dry run cannot promise something the apply does not do.
 */

const NOW = "2026-08-20T09:00:00Z";
const LATER = "2026-08-21T09:00:00Z";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "landing-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: "DES-001",
    kind: "architecture",
    title: "A component",
    body: "first read",
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [{ type: "file", locator: "package.json", captured_at: NOW, digest: null }],
    relations: [],
    payload: { feasibility: "unknown", risks: [], component: "app" },
    ...overrides,
  } as KnowledgeItem;
}

describe("classifyLanding", () => {
  it("calls it a create when nothing is on disk, and names the path it would write", () => {
    const root = project();
    const decision = classifyLanding(item(), root, NOW);

    expect(decision.action).toBe("create");
    expect(decision.existingVersion).toBeNull();
    expect(decision.relativePath).toBe("knowledge/_project/architecture/DES-001.yaml");
    expect(decision.next?.version).toBe(1);
    // Classification writes nothing. That is the whole contract of a dry run.
    expect(fs.existsSync(decision.path)).toBe(false);
  });

  it("calls a re-derived draft an update, one version on, keeping the original created_at", () => {
    const root = project();
    writeKnowledgeItem(item(), root);

    const decision = classifyLanding(item({ body: "second read", updated_at: LATER }), root, LATER);

    expect(decision.action).toBe("update");
    expect(decision.existingVersion).toBe(1);
    expect(decision.next?.version).toBe(2);
    expect(decision.next?.created_at).toBe(NOW);
    expect(decision.next?.updated_at).toBe(LATER);
  });

  it("calls it unchanged when the material still says the same thing, whatever the reviewer did to the status", () => {
    const root = project();
    writeKnowledgeItem(item({ status: "approved", version: 3 }), root);

    const decision = classifyLanding(item(), root, LATER);

    expect(decision.action).toBe("unchanged");
    expect(decision.existingVersion).toBe(3);
    expect(decision.next).toBeNull();
  });

  it("calls it a conflict when reviewed knowledge and the material now disagree", () => {
    const root = project();
    writeKnowledgeItem(item({ status: "approved", version: 3 }), root);

    const decision = classifyLanding(item({ body: "the material moved" }), root, LATER);

    expect(decision.action).toBe("conflict");
    expect(decision.next).toBeNull();
  });

  it("treats a file it cannot read as a conflict rather than throwing or overwriting it", () => {
    const root = project();
    const target = pathFor(item(), root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "id: DES-001\nthis is: not a knowledge item\n", "utf8");

    const decision = classifyLanding(item(), root, NOW);

    expect(decision.action).toBe("conflict");
    // Untouched: overwriting a file nobody can read is not a safe default.
    expect(fs.readFileSync(target, "utf8")).toContain("not a knowledge item");
  });
});

describe("applyLanding", () => {
  it("writes exactly what the classification said it would", () => {
    const root = project();
    writeKnowledgeItem(item(), root);
    const decision = classifyLanding(item({ body: "second read" }), root, LATER);

    const written = applyLanding(decision, root);

    expect(written).toBe(decision.path);
    const onDisk = JSON.parse(JSON.stringify(decision.next));
    const reread = fs.readFileSync(decision.path, "utf8");
    expect(reread).toContain("second read");
    expect(reread).toContain(`version: ${onDisk.version}`);
  });

  it("writes nothing for a decision that had nothing to write", () => {
    const root = project();
    writeKnowledgeItem(item({ status: "approved", version: 3 }), root);
    const decision = classifyLanding(item({ body: "the material moved" }), root, LATER);

    expect(applyLanding(decision, root)).toBeNull();
    expect(fs.readFileSync(decision.path, "utf8")).toContain("first read");
  });
});

describe("landItem", () => {
  it("sorts each item into written/unchanged/conflicts and hands back the path it wrote", () => {
    const root = project();
    writeKnowledgeItem(item({ id: "DES-002", status: "approved", version: 3 }), root);
    const landed = emptyLanded();

    const created = landItem(item({ id: "DES-001" }), root, NOW, landed);
    landItem(item({ id: "DES-002" }), root, NOW, landed);
    landItem(item({ id: "DES-002", body: "moved" }), root, NOW, landed);

    expect(landed).toEqual({ written: ["DES-001"], unchanged: ["DES-002"], conflicts: ["DES-002"] });
    expect([created.action, created.relativePath]).toEqual(["create", "knowledge/_project/architecture/DES-001.yaml"]);
  });

  it("agrees with what classifyLanding predicted, item for item", () => {
    const root = project();
    writeKnowledgeItem(item({ id: "DES-002", status: "approved", version: 3 }), root);
    const candidates = [item({ id: "DES-001" }), item({ id: "DES-002", body: "moved" })];

    const predicted = candidates.map((c) => classifyLanding(c, root, NOW).action);
    const landed = emptyLanded();
    const applied = candidates.map((c) => landItem(c, root, NOW, landed).action);

    expect(applied).toEqual(predicted);
  });
});
