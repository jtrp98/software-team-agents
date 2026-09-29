import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { ALL_STAGES, type DiscoveryStageId } from "./bootstrapModel.js";
import { initBootstrap, runBootstrapStage, type DiscoveryStage } from "./bootstrapRunner.js";
import { readBootstrapState } from "./bootstrapStore.js";
import { validateDiscoveredKnowledge } from "./knowledgeValidation.js";

const NOW = "2026-08-20T09:00:00Z";
const LATER = "2026-08-21T09:00:00Z";
let root: string;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function item(body: string): KnowledgeItem {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION, id: "DES-REPO-ROOT", kind: "architecture",
    title: "Detected component: app", body, repo: null, module: null,
    owner: AgentStage.SYSTEM_ANALYST, status: "draft", sensitive: false, version: 1,
    created_at: NOW, updated_at: NOW,
    sources: [{ type: "file", locator: "package.json", captured_at: NOW, digest: null }],
    relations: [], payload: { feasibility: "unknown", risks: [], component: "app" },
  };
}

function stageYielding(id: DiscoveryStageId, items: KnowledgeItem[]): DiscoveryStage {
  return { id, discover: () => ({ items, sources: [], skipped: items.length === 0 }) };
}

describe("bootstrap discovery without a trusted approval channel", () => {
  it("keeps all discovered items draft when a caller supplies only a person's name", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-knowledge-"));
    initBootstrap(null, root, NOW);
    for (const id of ALL_STAGES) await runBootstrapStage(stageYielding(id, id === "repository" ? [item("first read")] : []), root, NOW);
    expect(() => validateDiscoveredKnowledge("forged person", root, NOW)).toThrow(/trusted human decision record/);
    const state = readBootstrapState(root).state!;
    expect(state.status).toBe("pending_validation");
    expect(state.validated_by).toBeNull();
    expect(loadKnowledge(root).items[0]).toMatchObject({ status: "draft", version: 1 });
  });

  it("re-derives a draft item with one version increment", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-knowledge-"));
    initBootstrap(null, root, NOW);
    await runBootstrapStage(stageYielding("repository", [item("first read")]), root, NOW);
    await runBootstrapStage(stageYielding("repository", [item("second read")]), root, LATER);
    expect(loadKnowledge(root).items[0]).toMatchObject({ status: "draft", version: 2, body: "second read", created_at: NOW, updated_at: LATER });
  });
});
