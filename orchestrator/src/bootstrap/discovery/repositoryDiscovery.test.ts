import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import { readBootstrapState } from "../bootstrapStore.js";
import { repositoryDiscoveryStage } from "./repositoryDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

/** discover() is typed to allow a Promise (the shared DiscoveryStage interface); this stage happens to be sync. */
async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return repositoryDiscoveryStage(now).discover(root);
}

function architectureOf(result: DiscoveryResult, id: string): KnowledgeItemOf<"architecture"> {
  const item = result.items.find((i) => i.id === id);
  if (!item || item.kind !== "architecture") throw new Error(`expected an architecture item with id ${id}`);
  return item;
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-repo-discovery-"));

  writeJson(path.join(root, "package.json"), {
    name: "root-app",
    dependencies: { next: "^14.0.0", react: "^18.0.0" },
    devDependencies: { typescript: "^5.0.0" },
    scripts: { test: "vitest" },
  });
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });

  writeJson(path.join(root, "pkgB", "package.json"), {
    name: "api",
    dependencies: { express: "^4.0.0" },
    devDependencies: {},
    scripts: {},
  });

  // Should never be walked into.
  writeJson(path.join(root, "node_modules", "ghost", "package.json"), { name: "ghost" });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("repositoryDiscoveryStage", () => {
  it("finds every real package.json and ignores node_modules", async () => {
    const result = await discover(root);
    expect(result.items).toHaveLength(3); // overview + root + pkgB
    expect(result.sources).toHaveLength(2); // one per manifest, not the overview
  });

  it("produces a schema-valid overview item describing the top-level layout", async () => {
    const result = await discover(root);
    const overview = architectureOf(result, "DES-REPO-OVERVIEW");
    expect(checkKnowledgeItem(overview)).toEqual([]);
    expect(overview.body).toContain("2 package.json manifest");
    expect(overview.body).toContain("pkgB");
    expect(overview.body).toContain("src");
    expect(overview.payload.feasibility).toBe("unknown");
  });

  it("labels frameworks it recognises and leaves risks empty when tests+tsconfig are present", async () => {
    const result = await discover(root);
    const rootItem = architectureOf(result, "DES-REPO-ROOT");
    expect(checkKnowledgeItem(rootItem)).toEqual([]);
    expect(rootItem.payload.component).toBe("root-app");
    expect(rootItem.body).toContain("Next.js");
    expect(rootItem.body).toContain("React");
    expect(rootItem.body).toContain("TypeScript");
    expect(rootItem.payload.risks).toEqual([]);
  });

  it("flags a missing test script as a risk and still records the component without a recognised framework", async () => {
    const result = await discover(root);
    const pkgB = architectureOf(result, "DES-REPO-PKGB");
    expect(checkKnowledgeItem(pkgB)).toEqual([]);
    expect(pkgB.payload.component).toBe("api");
    expect(pkgB.body).toContain("Express");
    expect(pkgB.payload.risks).toContain("no `test` script defined in package.json");
  });

  it("computes a deterministic digest per manifest, so re-running discovery on unchanged files matches", async () => {
    const first = await discover(root, () => NOW);
    const second = await discover(root, () => "2026-09-01T00:00:00Z");
    const digestsFirst = first.sources.map((s) => s.digest).sort();
    const digestsSecond = second.sources.map((s) => s.digest).sort();
    expect(digestsFirst).toEqual(digestsSecond);
  });
});

describe("repositoryDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/, marks the repository stage done, and passes --check-knowledge", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(repositoryDiscoveryStage(() => NOW), root, NOW);

    const repoStage = state.stages.find((s) => s.id === "repository")!;
    expect(repoStage.status).toBe("done");
    expect(repoStage.knowledge_ids).toContain("DES-REPO-ROOT");
    expect(repoStage.knowledge_ids).toContain("DES-REPO-PKGB");

    expect(fs.existsSync(path.join(root, "knowledge", "_project", "architecture", "DES-REPO-ROOT.yaml"))).toBe(true);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);

    const { state: reread } = readBootstrapState(root);
    expect(reread!.status).toBe("discovering"); // other 5 stages are still pending
  });
});
