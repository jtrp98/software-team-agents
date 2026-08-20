import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKnowledgeItem, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import { checkKnowledge } from "../../knowledge/knowledgeBase.js";
import type { DiscoveryResult } from "../bootstrapRunner.js";
import { initBootstrap, runBootstrapStage } from "../bootstrapRunner.js";
import {
  HumanInputError,
  humanInputDiscoveryStage,
  humanInputPath,
} from "./humanInputDiscovery.js";

const NOW = "2026-08-20T09:00:00Z";

function writeInput(root: string, content: string): void {
  const filePath = humanInputPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function discover(root: string, now: () => string = () => NOW): Promise<DiscoveryResult> {
  return humanInputDiscoveryStage(now).discover(root);
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-human-input-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("humanInputDiscoveryStage", () => {
  it("reports skipped when no input file exists yet", async () => {
    const result = await discover(root);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("nothing for a person to have filled in");
  });

  it("reports skipped when the file exists but has no entries", async () => {
    writeInput(root, "schema_version: 1\nentries: []\n");
    const result = await discover(root);
    expect(result.skipped).toBe(true);
    expect(result.note).toContain("no entries yet");
  });

  it("converts a business-rule entry into a schema-valid item", async () => {
    writeInput(
      root,
      [
        "schema_version: 1",
        "entries:",
        "  - kind: business-rule",
        "    statement: Refunds over $500 require manager approval",
        "    enforcement: manual",
        "    author: Nok",
      ].join("\n"),
    );

    const result = await discover(root);
    expect(result.items).toHaveLength(1);
    const item = result.items[0] as KnowledgeItemOf<"business-rule">;
    expect(item.kind).toBe("business-rule");
    expect(checkKnowledgeItem(item)).toEqual([]);
    expect(item.payload.statement).toBe("Refunds over $500 require manager approval");
    expect(item.payload.enforcement).toBe("manual");
    expect(item.sources[0]!.type).toBe("human");
    expect(item.sources[0]!.locator).toBe("Nok");
    expect(item.sources[0]!.digest).toBeNull();
  });

  it("converts a domain entry into a schema-valid item, with a stable id from the term", async () => {
    writeInput(
      root,
      [
        "schema_version: 1",
        "entries:",
        "  - kind: domain",
        "    term: Lead",
        "    definition: A prospective customer who has not yet signed a contract",
        "    aliases: [prospect]",
        "    author: Nok",
      ].join("\n"),
    );

    const result = await discover(root);
    const item = result.items[0] as KnowledgeItemOf<"domain">;
    expect(item.id).toBe("DOM-LEAD");
    expect(checkKnowledgeItem(item)).toEqual([]);
    expect(item.payload.term).toBe("Lead");
    expect(item.payload.aliases).toEqual(["prospect"]);
  });

  it("throws HumanInputError on a schema violation instead of silently skipping it", async () => {
    writeInput(root, ["schema_version: 1", "entries:", "  - kind: business-rule", "    statement: missing enforcement/author"].join("\n"));
    await expect(discover(root)).rejects.toThrow(HumanInputError);
  });

  it("throws HumanInputError on invalid YAML", async () => {
    writeInput(root, "entries: [unterminated");
    await expect(discover(root)).rejects.toThrow(HumanInputError);
  });

  // `DOM-<TERM>` is derived from the term, so two entries for one term are one
  // id, one file, and one surviving definition. Nothing downstream can report
  // the disagreement — T66 groups items, and a collision leaves one item — so
  // the refusal has to happen here, where the person who can fix it is looking.
  it("refuses two entries defining the same term rather than letting one overwrite the other", async () => {
    writeInput(
      root,
      [
        "schema_version: 1",
        "entries:",
        "  - kind: domain",
        "    term: Lead",
        "    definition: someone who asked for a quote",
        "    author: Ann",
        "  - kind: domain",
        "    term: lead",
        "    definition: someone we decided to call",
        "    author: Bee",
      ].join("\n"),
    );
    await expect(discover(root)).rejects.toThrow(/two entries define the term "lead"/);
  });

  it("refuses a duplicated business rule statement too", async () => {
    const entry = ["  - kind: business-rule", "    statement: refunds over 500 need a manager", "    enforcement: manual", "    author: Ann"];
    writeInput(root, ["schema_version: 1", "entries:", ...entry, ...entry].join("\n"));
    await expect(discover(root)).rejects.toThrow(/same business rule statement/);
  });

  it("mixes business-rule and domain entries in one file", async () => {
    writeInput(
      root,
      [
        "schema_version: 1",
        "entries:",
        "  - kind: business-rule",
        "    statement: A",
        "    enforcement: code",
        "    author: Nok",
        "  - kind: domain",
        "    term: B",
        "    definition: B means B",
        "    author: Nok",
      ].join("\n"),
    );
    const result = await discover(root);
    expect(result.items.map((i) => i.kind).sort()).toEqual(["business-rule", "domain"]);
    expect(result.sources).toHaveLength(2);
  });
});

describe("humanInputDiscoveryStage through the bootstrap runner", () => {
  it("writes items into knowledge/ and passes --check-knowledge", async () => {
    writeInput(
      root,
      ["schema_version: 1", "entries:", "  - kind: domain", "    term: Lead", "    definition: def", "    author: Nok"].join("\n"),
    );
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(humanInputDiscoveryStage(() => NOW), root, NOW);

    const stage = state.stages.find((s) => s.id === "human-input")!;
    expect(stage.status).toBe("done");
    expect(stage.knowledge_ids).toEqual(["DOM-LEAD"]);
    expect(fs.existsSync(path.join(root, "knowledge", "_project", "domain", "DOM-LEAD.yaml"))).toBe(true);

    const report = checkKnowledge(root);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("marks the stage skipped when there is no input file", async () => {
    initBootstrap(null, root, NOW);
    const state = await runBootstrapStage(humanInputDiscoveryStage(() => NOW), root, NOW);
    expect(state.stages.find((s) => s.id === "human-input")!.status).toBe("skipped");
  });
});
