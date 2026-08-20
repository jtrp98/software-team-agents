import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { ALL_STAGES, type DiscoveryStageId } from "./bootstrapModel.js";
import { initBootstrap, runBootstrapStage, type DiscoveryStage } from "./bootstrapRunner.js";
import { readBootstrapState } from "./bootstrapStore.js";
import { validateDiscoveredKnowledge } from "./knowledgeValidation.js";

/**
 * Discovery must never quietly undo a person's review.
 *
 * The bug this locks down: every item used to be written with `force: true`,
 * which skips T61's version check, so a second discovery pass reset an
 * `approved` item at version 3 back to `draft` at version 1 — while the
 * bootstrap state still said `ready` and still named the person who had
 * validated it. Nothing reported it.
 */

const NOW = "2026-08-20T09:00:00Z";
const LATER = "2026-08-21T09:00:00Z";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-knowledge-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function item(body: string): KnowledgeItem {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: "DES-REPO-ROOT",
    kind: "architecture",
    title: "Detected component: app",
    body,
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
  };
}

/** A stage that yields whatever it is told, so the test controls what "re-discovery found" means. */
function stageYielding(id: DiscoveryStageId, items: KnowledgeItem[]): DiscoveryStage {
  return { id, discover: () => ({ items, sources: [], skipped: items.length === 0 }) };
}

async function settleAll(root: string, first: KnowledgeItem): Promise<void> {
  initBootstrap(null, root, NOW);
  for (const id of ALL_STAGES) {
    await runBootstrapStage(stageYielding(id, id === "repository" ? [first] : []), root, NOW);
  }
}

function statusOf(root: string, id: string): { status: string; version: number } {
  const found = loadKnowledge(root).items.find((i) => i.id === id)!;
  return { status: found.status, version: found.version };
}

describe("re-running a stage over reviewed knowledge", () => {
  it("leaves an approved item exactly as the person left it", async () => {
    const root = project();
    await settleAll(root, item("discovered"));
    validateDiscoveredKnowledge("Jaturapat", root, NOW);
    expect(statusOf(root, "DES-REPO-ROOT")).toEqual({ status: "approved", version: 3 });

    await runBootstrapStage(stageYielding("repository", [item("discovered again, differently")]), root, LATER);

    expect(statusOf(root, "DES-REPO-ROOT")).toEqual({ status: "approved", version: 3 });
  });

  it("records the disagreement instead of resolving it, and --check-knowledge blocks on it", async () => {
    const root = project();
    await settleAll(root, item("discovered"));
    validateDiscoveredKnowledge("Jaturapat", root, NOW);

    await runBootstrapStage(stageYielding("repository", [item("the material moved")]), root, LATER);

    const stage = readBootstrapState(root).state!.stages.find((s) => s.id === "repository")!;
    expect(stage.conflict_ids).toEqual(["DES-REPO-ROOT"]);
    expect(stage.note).toContain("left 1 reviewed item(s) untouched");

    const report = checkKnowledge(root);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes("DES-REPO-ROOT") && p.includes("past `draft`"))).toBe(true);
  });

  it("says nothing at all when re-discovery agrees with what was approved", async () => {
    const root = project();
    await settleAll(root, item("discovered"));
    validateDiscoveredKnowledge("Jaturapat", root, NOW);

    await runBootstrapStage(stageYielding("repository", [item("discovered")]), root, LATER);

    const state = readBootstrapState(root).state!;
    const stage = state.stages.find((s) => s.id === "repository")!;
    expect(stage.conflict_ids).toBeUndefined();
    expect(statusOf(root, "DES-REPO-ROOT")).toEqual({ status: "approved", version: 3 });
    // Agreement is not new material, so the validation still stands.
    expect(state.status).toBe("ready");
    expect(state.validated_by).toBe("Jaturapat");
    expect(checkKnowledge(root).ok).toBe(true);
  });

  it("still re-derives a draft item, one version on", async () => {
    const root = project();
    initBootstrap(null, root, NOW);
    await runBootstrapStage(stageYielding("repository", [item("first read")]), root, NOW);
    expect(statusOf(root, "DES-REPO-ROOT")).toEqual({ status: "draft", version: 1 });

    await runBootstrapStage(stageYielding("repository", [item("second read")]), root, LATER);

    expect(statusOf(root, "DES-REPO-ROOT")).toEqual({ status: "draft", version: 2 });
    const written = loadKnowledge(root).items.find((i) => i.id === "DES-REPO-ROOT")!;
    expect(written.body).toBe("second read");
    // The item was created on the first pass, and that is when it was created.
    expect(written.created_at).toBe(NOW);
    expect(written.updated_at).toBe(LATER);
  });

  it("clears a validation once new material lands that nobody has seen", async () => {
    const root = project();
    await settleAll(root, item("discovered"));
    validateDiscoveredKnowledge("Jaturapat", root, NOW);
    expect(readBootstrapState(root).state!.status).toBe("ready");

    // A brand-new item from a later pass — not a rewrite of the approved one.
    const extra: KnowledgeItem = { ...item("a component nobody has reviewed"), id: "DES-REPO-API" };
    await runBootstrapStage(stageYielding("repository", [extra]), root, LATER);

    const state = readBootstrapState(root).state!;
    expect(state.status).toBe("pending_validation");
    expect(state.validated_by).toBeNull();
    expect(state.validated_at).toBeNull();
  });
});
