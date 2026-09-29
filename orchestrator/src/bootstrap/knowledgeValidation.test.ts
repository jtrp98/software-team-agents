import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { ALL_STAGES } from "./bootstrapModel.js";
import { BootstrapNotSettledError, BootstrapNotStartedError, initBootstrap, runBootstrapStage, type DiscoveryStage } from "./bootstrapRunner.js";
import { validateDiscoveredKnowledge } from "./knowledgeValidation.js";

const T1 = "2026-08-20T09:00:00Z";
const T2 = "2026-08-20T10:00:00Z";

function architectureItem(id: string): KnowledgeItemOf<"architecture"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind: "architecture",
    title: id,
    body: "",
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: T1,
    updated_at: T1,
    sources: [{ type: "code", locator: ".", captured_at: T1, digest: null }],
    relations: [],
    payload: { feasibility: "unknown", risks: [], component: null },
  };
}

function stub(id: DiscoveryStage["id"], items: KnowledgeItemOf<"architecture">[] = []): DiscoveryStage {
  return { id, discover: () => ({ items, sources: [], skipped: items.length === 0 }) };
}

async function settleAllStages(root: string, produced: KnowledgeItemOf<"architecture">[] = []): Promise<void> {
  initBootstrap(null, root, T1);
  const [first, ...rest] = ALL_STAGES;
  await runBootstrapStage(stub(first!, produced), root, T1);
  for (const id of rest) await runBootstrapStage(stub(id), root, T1);
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-validation-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("validateDiscoveredKnowledge", () => {
  it("throws BootstrapNotStartedError if bootstrap was never initialised", () => {
    expect(() => validateDiscoveredKnowledge("Nok", root, T2)).toThrow(BootstrapNotStartedError);
  });

  it("throws BootstrapNotSettledError, and touches nothing, while a stage is still open", async () => {
    initBootstrap(null, root, T1);
    await runBootstrapStage(stub("repository", [architectureItem("DES-A")]), root, T1);
    // Every other stage is still pending.
    expect(() => validateDiscoveredKnowledge("Nok", root, T2)).toThrow(BootstrapNotSettledError);

    const { items } = loadKnowledge(root);
    expect(items[0]!.status).toBe("draft");
  });

  it("rejects a free-form name and leaves discovered Knowledge in draft", async () => {
    await settleAllStages(root, [architectureItem("DES-A")]);
    expect(() => validateDiscoveredKnowledge("Nok", root, T2)).toThrow(/trusted human decision record/);
    const { items } = loadKnowledge(root);
    const item = items.find((i) => i.id === "DES-A")!;
    expect(item.status).toBe("draft");
    expect(item.version).toBe(1);
  });
});
