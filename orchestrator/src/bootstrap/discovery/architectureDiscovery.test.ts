import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import { architectureDiscoveryStage } from "./architectureDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

function mkdirs(root: string, ...dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return architectureDiscoveryStage(now).discover(root);
}

function architectureOf(result: DiscoveryResult, id: string): KnowledgeItemOf<"architecture"> {
  const item = result.items.find((i) => i.id === id);
  if (!item || item.kind !== "architecture") throw new Error(`expected an architecture item with id ${id}`);
  return item;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-arch-discovery-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("architectureDiscoveryStage", () => {
  it("reports skipped when no recognisable layering folders exist anywhere", async () => {
    mkdirs(root, "src", "test");
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no recognisable layering");
  });

  it("detects a layered REST pattern from routes/controllers/services/models", async () => {
    mkdirs(root, "routes", "controllers", "services", "models");
    const result = await discover(root);
    const item = architectureOf(result, "DES-PATTERN-ROOT");
    expect(checkKnowledgeItem(item)).toEqual([]);
    expect(item.body).toContain("Layered (MVC-ish) REST architecture");
    expect(item.body).toContain("routes");
    expect(item.payload.risks).toEqual([]);
  });

  it("detects Next.js App Router from an app/ directory", async () => {
    mkdirs(root, "app");
    const result = await discover(root);
    const item = architectureOf(result, "DES-PATTERN-ROOT");
    expect(item.body).toContain("Next.js App Router");
  });

  it("flags a single matching layer folder as a partial/loose inference with a risk noted", async () => {
    mkdirs(root, "routes");
    const result = await discover(root);
    const item = architectureOf(result, "DES-PATTERN-ROOT");
    expect(item.body).toContain("Partial layering");
    expect(item.payload.risks.length).toBeGreaterThan(0);
  });

  it("infers per component when the repo has more than one package.json", async () => {
    writeJson(path.join(root, "package.json"), { name: "root-app" });
    mkdirs(root, "app");
    writeJson(path.join(root, "backend", "package.json"), { name: "api" });
    mkdirs(root, "backend/routes", "backend/services");

    const result = await discover(root);
    const ids = result.items.map((i) => i.id).sort();
    expect(ids).toEqual(["DES-PATTERN-BACKEND", "DES-PATTERN-ROOT"]);
    expect(architectureOf(result, "DES-PATTERN-BACKEND").payload.component).toBe("api");
  });
});

describe("architectureDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/ and passes --check-knowledge", async () => {
    mkdirs(root, "routes", "controllers");
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(architectureDiscoveryStage(() => NOW), root, NOW);

    const stage = state.stages.find((s) => s.id === "architecture")!;
    expect(stage.status).toBe("done");
    expect(stage.knowledge_ids).toEqual(["DES-PATTERN-ROOT"]);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("marks the stage skipped when nothing is found", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(architectureDiscoveryStage(() => NOW), root, NOW);
    expect(state.stages.find((s) => s.id === "architecture")!.status).toBe("skipped");
  });
});
