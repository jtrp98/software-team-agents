import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { loadKnowledge, writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-knowledge-validation-"));
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

  it("advances a draft item discovered by bootstrap all the way to approved, in two writes", async () => {
    await settleAllStages(root, [architectureItem("DES-A")]);

    const summary = validateDiscoveredKnowledge("Nok", root, T2);
    expect(summary.approved).toEqual(["DES-A"]);
    expect(summary.alreadyApproved).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.bootstrapState.status).toBe("ready");
    expect(summary.bootstrapState.validated_by).toBe("Nok");

    const { items } = loadKnowledge(root);
    const item = items.find((i) => i.id === "DES-A")!;
    expect(item.status).toBe("approved");
    expect(item.version).toBe(3); // draft(1) -> reviewed(2) -> approved(3)
  });

  it("leaves an item that is not part of this bootstrap's discovery untouched", async () => {
    await settleAllStages(root, [architectureItem("DES-A")]);
    writeKnowledgeItem(architectureItem("DES-UNRELATED"), root, { force: true });

    validateDiscoveredKnowledge("Nok", root, T2);

    const { items } = loadKnowledge(root);
    expect(items.find((i) => i.id === "DES-A")!.status).toBe("approved");
    expect(items.find((i) => i.id === "DES-UNRELATED")!.status).toBe("draft");
  });

  it("reports an already-approved item separately and does not re-approve it", async () => {
    await settleAllStages(root, [architectureItem("DES-A")]);
    validateDiscoveredKnowledge("Nok", root, T2);

    const second = validateDiscoveredKnowledge("Nok", root, "2026-08-20T11:00:00Z");
    expect(second.approved).toEqual([]);
    expect(second.alreadyApproved).toEqual(["DES-A"]);
  });

  it("reports a discovered item that no longer exists on disk as skipped, not a crash", async () => {
    await settleAllStages(root, [architectureItem("DES-A")]);
    fs.rmSync(path.join(root, "knowledge", "_project", "architecture", "DES-A.yaml"));

    const summary = validateDiscoveredKnowledge("Nok", root, T2);
    expect(summary.skipped).toEqual([{ id: "DES-A", reason: "no longer exists in knowledge/" }]);
    expect(summary.bootstrapState.status).toBe("ready"); // still settles overall bootstrap
  });
});
