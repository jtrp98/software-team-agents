import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { makeItem } from "./sampleKnowledge.js";
import {
  DEFAULT_KNOWLEDGE_POLICY,
  type KnowledgePolicy,
  KnowledgePolicyError,
  POLICY_FILENAME,
  checkKnowledgePolicyFile,
  freshnessThresholdFor,
  loadKnowledgePolicy,
  parseKnowledgePolicy,
  policyFor,
  visibleItemFor,
} from "./knowledgePolicy.js";

const sensitiveModel = makeItem(
  "db-schema",
  "DB-Staff",
  { model: "Staff", fields: [{ name: "nationalId", type: "String", optional: false }], relations: [] },
  { sensitive: true, body: "holds national id numbers", owner: AgentStage.SYSTEM_ANALYST },
);

const ordinary = makeItem("domain", "DOM-001", { term: "Shift", definition: "one working block", aliases: [] });

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-policy-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writePolicy(yaml: string): void {
  fs.writeFileSync(path.join(root, POLICY_FILENAME), yaml, "utf8");
}

describe("loading", () => {
  it("falls back to a permissive built-in when there is no file", () => {
    expect(loadKnowledgePolicy(root)).toEqual(DEFAULT_KNOWLEDGE_POLICY);
    expect(checkKnowledgePolicyFile(root).problems).toEqual([]);
    expect(checkKnowledgePolicyFile(root).notes.join()).toContain("every role sees every field");
  });

  it("reads this repo's own policy file", () => {
    const policy = loadKnowledgePolicy(defaultProjectRoot());
    expect(policy.version).toBe(1);
    expect(policyFor(AgentStage.DEVOPS, policy).sensitive).toBe("redacted");
    expect(policyFor(AgentStage.BACKEND_ENGINEER, policy).sensitive).toBe("full");
  });

  it("rejects an unknown role rather than ignoring the line", () => {
    writePolicy("version: 1\nroles:\n  developer:\n    sensitive: hidden\n");
    expect(() => loadKnowledgePolicy(root)).toThrow(KnowledgePolicyError);
  });

  it("rejects an unknown access level", () => {
    writePolicy("version: 1\nroles:\n  devops:\n    sensitive: partial\n");
    expect(() => loadKnowledgePolicy(root)).toThrow(KnowledgePolicyError);
  });

  it("reports a broken file as a check problem instead of throwing out of the check", () => {
    writePolicy("version: 1\nroles:\n  devops:\n    sensitive: partial\n");
    const result = checkKnowledgePolicyFile(root);
    expect(result.problems.join("\n")).toContain(POLICY_FILENAME);
  });

  it("catches thresholds that would make 'aging' unreachable", () => {
    writePolicy("version: 1\nfreshness:\n  default:\n    aging_after_days: 200\n    stale_after_days: 100\n");
    expect(checkKnowledgePolicyFile(root).problems.join("\n")).toContain("never be reported as merely aging");
  });

  it("notes which roles are restricted, so a surprising redaction is traceable", () => {
    writePolicy("version: 1\nroles:\n  devops:\n    sensitive: redacted\n");
    expect(checkKnowledgePolicyFile(root).notes.join("\n")).toContain("devops");
  });
});

describe("freshness thresholds come from the file, not from code", () => {
  it("uses the per-kind override when there is one", () => {
    const policy = loadKnowledgePolicy(defaultProjectRoot());
    expect(freshnessThresholdFor("db-schema", policy).staleAfterDays).toBe(90);
    expect(freshnessThresholdFor("requirement", policy).staleAfterDays).toBe(180);
    expect(freshnessThresholdFor("decision", policy).staleAfterDays).toBe(730);
  });

  it("falls back to the default for a kind nobody overrode", () => {
    const policy = parseKnowledgePolicy({ version: 1, freshness: { default: { aging_after_days: 10, stale_after_days: 20 } } });
    expect(freshnessThresholdFor("task", policy)).toEqual({ agingAfterDays: 10, staleAfterDays: 20 });
  });
});

describe("visibleItemFor", () => {
  const redactDevops: KnowledgePolicy = parseKnowledgePolicy({
    version: 1,
    roles: { devops: { sensitive: "redacted" }, "project-manager": { sensitive: "hidden" } },
  });

  it("returns everything when nothing is restricted", () => {
    const visible = visibleItemFor(sensitiveModel, AgentStage.BACKEND_ENGINEER, DEFAULT_KNOWLEDGE_POLICY)!;
    expect(visible.body).toBe("holds national id numbers");
    expect(visible.withheld).toEqual([]);
  });

  it("leaves a non-sensitive item alone even for a restricted role", () => {
    const visible = visibleItemFor(ordinary, AgentStage.DEVOPS, redactDevops)!;
    expect(visible.withheld).toEqual([]);
    expect(visible.payload).toEqual({ term: "Shift", definition: "one working block", aliases: [] });
  });

  it("keeps identity and drops contents for a sensitive item", () => {
    const visible = visibleItemFor(sensitiveModel, AgentStage.DEVOPS, redactDevops)!;
    expect(visible.id).toBe("DB-Staff");
    expect(visible.status).toBe("draft");
    expect(visible.body).toBe("");
    expect(visible.payload).toEqual({});
    expect(visible.sources).toEqual([]);
  });

  it("says what it withheld — a filter that edits silently is one an agent implements around", () => {
    const visible = visibleItemFor(sensitiveModel, AgentStage.DEVOPS, redactDevops)!;
    expect(visible.withheld).toEqual(["body", "payload", "sources"]);
  });

  it("hides the item entirely when the policy says hidden", () => {
    expect(visibleItemFor(sensitiveModel, AgentStage.PROJECT_MANAGER, redactDevops)).toBeNull();
  });

  it("never hides an item from its own owner", () => {
    const visible = visibleItemFor(
      { ...sensitiveModel, owner: AgentStage.DEVOPS },
      AgentStage.DEVOPS,
      redactDevops,
    )!;
    expect(visible.withheld).toEqual([]);
    expect(visible.body).toBe("holds national id numbers");
  });

  it("never hides anything from a person", () => {
    expect(visibleItemFor(sensitiveModel, AgentStage.HUMAN, redactDevops)!.withheld).toEqual([]);
  });

  it("hides one payload field when the policy names one", () => {
    const policy = parseKnowledgePolicy({
      version: 1,
      roles: { devops: { hide_fields: ["payload.fields"] } },
    });
    const visible = visibleItemFor(sensitiveModel, AgentStage.DEVOPS, policy)!;
    expect(visible.payload).toEqual({ model: "Staff", relations: [] });
    expect(visible.withheld).toEqual(["payload.fields"]);
  });

  it("applies hide_fields to ordinary items too, not only sensitive ones", () => {
    const policy = parseKnowledgePolicy({ version: 1, roles: { devops: { hide_fields: ["body"] } } });
    expect(visibleItemFor({ ...ordinary, body: "text" }, AgentStage.DEVOPS, policy)!.body).toBe("");
  });

  it("leaves relations visible when contents are redacted — how it connects is not the secret", () => {
    const withRelations = { ...sensitiveModel, relations: [{ type: "derived-from" as const, to: "DES-003" }] };
    expect(visibleItemFor(withRelations, AgentStage.DEVOPS, redactDevops)!.relations).toHaveLength(1);
  });
});
