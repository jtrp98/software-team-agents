import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  ID_PREFIXES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeKind,
  KnowledgeItemError,
  checkKnowledgeItem,
  describeRelationRule,
  isPrefixValidForKind,
  isRelationLegal,
  prefixOf,
  validateKnowledgeItem,
} from "./knowledgeModel.js";

const NOW = "2026-08-20T09:00:00Z";

/** A minimal valid envelope. Every test starts here and breaks exactly one thing. */
function envelope(id: string, kind: KnowledgeKind): Record<string, unknown> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind,
    title: `title for ${id}`,
    body: "",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    sources: [{ type: "file", locator: "_docs/module/sales-crm/design.md#L1-L10", captured_at: NOW, digest: null }],
    relations: [],
  };
}

const PAYLOADS: Record<KnowledgeKind, unknown> = {
  requirement: { acceptance_criteria: ["sees own shifts"], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
  "business-rule": { statement: "a shift may not overlap another", enforcement: "code" },
  domain: { term: "Shift", definition: "one staff member's working block", aliases: ["กะ"] },
  architecture: { feasibility: "feasible", risks: [], component: null },
  api: { method: "GET", path: "/api/shifts", contract_name: "shifts.list", request_shape: null, response_shape: "Shift[]" },
  "db-schema": { model: "Shift", fields: [{ name: "id", type: "String", optional: false }], relations: ["staff Staff"] },
  decision: { adr_status: "accepted", date: "2026-08-01", supersedes: null, superseded_by: null },
  task: {
    agent: AgentStage.BACKEND_ENGINEER,
    phase: 1,
    tag: "backend",
    plan_status: "pending",
    produces: ["shifts.list"],
    consumes: [],
    contract_version: null,
    orchestrator_task_id: "T-1",
  },
  test: { levels: ["api"], automated: false },
  "ux-design": { artifact: "_docs/module/sales-crm/uxui/design.md", refines: ["DES-003"] },
};

const SAMPLE_ID: Record<KnowledgeKind, string> = {
  requirement: "REQ-003",
  "business-rule": "RULE-007",
  domain: "DOM-001",
  architecture: "DES-003",
  api: "API-shifts.list",
  "db-schema": "DB-Shift",
  decision: "ADR-003",
  task: "BE-014",
  test: "TEST-003",
  "ux-design": "UX-003",
};

function item(kind: KnowledgeKind, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...envelope(SAMPLE_ID[kind], kind), payload: PAYLOADS[kind], ...overrides };
}

describe("knowledge item schema", () => {
  it("accepts a valid item for every one of the nine kinds", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      expect(checkKnowledgeItem(item(kind)), `kind ${kind}`).toEqual([]);
    }
  });

  it("rejects an id whose prefix belongs to another kind", () => {
    const problems = checkKnowledgeItem(item("task", { id: "REQ-014" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('prefix "REQ"');
    expect(problems[0]).toContain("BE- or FE-");
  });

  it("accepts both task prefixes, because the pipeline already tags tasks by side", () => {
    expect(checkKnowledgeItem(item("task", { id: "FE-014" }))).toEqual([]);
    expect(checkKnowledgeItem(item("task", { id: "BE-014" }))).toEqual([]);
  });

  it("rejects an id that does not look like an id at all", () => {
    expect(checkKnowledgeItem(item("requirement", { id: "req 3" }))).not.toEqual([]);
  });

  it("rejects an unknown status", () => {
    const problems = checkKnowledgeItem(item("requirement", { status: "in-review" }));
    expect(problems.join("\n")).toContain("/status");
  });

  it("rejects an owner that is not a pipeline role", () => {
    expect(checkKnowledgeItem(item("requirement", { owner: "developer" }))).not.toEqual([]);
  });

  it("rejects an item with no sources — an unsourced item is an assertion nobody can check", () => {
    const problems = checkKnowledgeItem(item("requirement", { sources: [] }));
    expect(problems.join("\n")).toContain("/sources");
  });

  it("rejects a payload belonging to a different kind", () => {
    const problems = checkKnowledgeItem(item("requirement", { payload: PAYLOADS.test }));
    expect(problems).not.toEqual([]);
    expect(problems.join("\n")).toContain("payload");
  });

  it("rejects an unknown field in the payload rather than dropping it silently", () => {
    const problems = checkKnowledgeItem(
      item("test", { payload: { levels: ["unit"], automated: false, stale_after_days: 30 } }),
    );
    expect(problems.join("\n")).toContain("stale_after_days");
  });

  it("rejects a version below 1 and a non-integer version", () => {
    expect(checkKnowledgeItem(item("requirement", { version: 0 }))).not.toEqual([]);
    expect(checkKnowledgeItem(item("requirement", { version: 1.5 }))).not.toEqual([]);
  });

  it("rejects a timestamp that is not a date-time", () => {
    expect(checkKnowledgeItem(item("requirement", { updated_at: "2026-08-20" }))).not.toEqual([]);
  });

  it("rejects an unknown envelope field", () => {
    expect(checkKnowledgeItem(item("requirement", { stale_after_days: 30 }))).not.toEqual([]);
  });

  it("rejects a relation pointing at the item itself", () => {
    const problems = checkKnowledgeItem(
      item("requirement", { relations: [{ type: "references", to: "REQ-003" }] }),
    );
    expect(problems.join("\n")).toContain("itself");
  });

  it("validateKnowledgeItem throws with every problem listed", () => {
    expect(() => validateKnowledgeItem(item("requirement", { status: "nope", version: 0 }), "REQ-003.yaml")).toThrow(
      KnowledgeItemError,
    );
    try {
      validateKnowledgeItem(item("requirement", { status: "nope", version: 0 }), "REQ-003.yaml");
    } catch (e) {
      expect((e as KnowledgeItemError).issues.length).toBeGreaterThan(1);
      expect((e as KnowledgeItemError).label).toBe("REQ-003.yaml");
    }
  });

  it("validateKnowledgeItem returns the typed item when it is fine", () => {
    const valid = validateKnowledgeItem(item("api"), "API-shifts.list.yaml");
    expect(valid.kind).toBe("api");
    if (valid.kind === "api") expect(valid.payload.contract_name).toBe("shifts.list");
  });
});

describe("id prefixes", () => {
  it("prefixOf takes everything before the first hyphen", () => {
    expect(prefixOf("REQ-003")).toBe("REQ");
    expect(prefixOf("API-shifts/sync")).toBe("API");
    expect(prefixOf("NOHYPHEN")).toBe("NOHYPHEN");
  });

  it("every kind's own sample id matches its prefix rule", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      expect(isPrefixValidForKind(SAMPLE_ID[kind], kind), kind).toBe(true);
    }
  });

  it("no two kinds share a prefix — a prefix has to identify what an id refers to", () => {
    const seen = new Map<string, KnowledgeKind>();
    for (const kind of KNOWLEDGE_KINDS) {
      for (const prefix of ID_PREFIXES[kind]) {
        expect(seen.get(prefix), `${prefix} is used by both ${seen.get(prefix)} and ${kind}`).toBeUndefined();
        seen.set(prefix, kind);
      }
    }
  });
});

describe("relation legality matrix", () => {
  it("allows the pairs the pipeline actually produces", () => {
    expect(isRelationLegal("refines", "architecture", "requirement")).toBe(true);
    expect(isRelationLegal("refines", "business-rule", "requirement")).toBe(true);
    expect(isRelationLegal("refines", "domain", "domain")).toBe(true);
    expect(isRelationLegal("implements", "task", "api")).toBe(true);
    expect(isRelationLegal("implements", "task", "db-schema")).toBe(true);
    expect(isRelationLegal("verifies", "test", "requirement")).toBe(true);
    expect(isRelationLegal("verifies", "test", "task")).toBe(true);
    expect(isRelationLegal("references", "api", "db-schema")).toBe(true);
    expect(isRelationLegal("depends-on", "task", "task")).toBe(true);
    expect(isRelationLegal("constrains", "decision", "api")).toBe(true);
  });

  it("rejects the cross products nobody meant to allow", () => {
    // refines has two rules on purpose: a cross product would let this through.
    expect(isRelationLegal("refines", "architecture", "domain")).toBe(false);
    expect(isRelationLegal("refines", "requirement", "requirement")).toBe(false);
    expect(isRelationLegal("implements", "requirement", "api")).toBe(false);
    expect(isRelationLegal("verifies", "task", "requirement")).toBe(false);
    expect(isRelationLegal("depends-on", "task", "api")).toBe(false);
    expect(isRelationLegal("constrains", "task", "api")).toBe(false);
  });

  it("supersedes and conflicts-with are same-kind only", () => {
    expect(isRelationLegal("supersedes", "decision", "decision")).toBe(true);
    expect(isRelationLegal("supersedes", "decision", "requirement")).toBe(false);
    expect(isRelationLegal("conflicts-with", "requirement", "requirement")).toBe(true);
    expect(isRelationLegal("conflicts-with", "requirement", "task")).toBe(false);
  });

  it("references and derived-from are deliberately open", () => {
    expect(isRelationLegal("references", "test", "domain")).toBe(true);
    expect(isRelationLegal("derived-from", "db-schema", "architecture")).toBe(true);
  });

  it("describeRelationRule says what would have been legal, so a check message is actionable", () => {
    expect(describeRelationRule("implements")).toBe("task -> architecture|api|db-schema|business-rule");
    expect(describeRelationRule("supersedes")).toBe("any -> the same kind");
  });
});

describe("knowledge item schema v2 — target association (T141/T148)", () => {
  const v2Sources = [
    { type: "file", locator: "_docs/module/sales-crm/design.md#L1-L10", captured_at: NOW, digest: null, origin: { root: "knowledge", target_id: null } },
  ];

  it("accepts a v2 item with target_ids and origin-carrying sources", () => {
    expect(checkKnowledgeItem(item("requirement", { schema_version: 2, target_ids: ["frontend", "backend"], sources: v2Sources }))).toEqual([]);
  });

  it("requires target_ids once an item is v2", () => {
    const problems = checkKnowledgeItem(item("requirement", { schema_version: 2, sources: v2Sources }));
    expect(problems).toContain("schema v2 requires target_ids");
  });

  it("still accepts a v1 item without target_ids — the envelope generation is opt-in per item", () => {
    expect(checkKnowledgeItem(item("requirement"))).toEqual([]);
  });

  it("rejects more than two target_ids (V1 permits at most two)", () => {
    const problems = checkKnowledgeItem(
      item("requirement", { schema_version: 2, target_ids: ["frontend", "backend", "shared"], sources: v2Sources }),
    );
    expect(problems.some((p) => p.includes("target_ids"))).toBe(true);
  });

  it("rejects duplicate target_ids", () => {
    const problems = checkKnowledgeItem(
      item("requirement", { schema_version: 2, target_ids: ["backend", "backend"], sources: v2Sources }),
    );
    expect(problems.some((p) => p.includes("target_ids"))).toBe(true);
  });

  it("requires origin on every source once an item is v2", () => {
    const problems = checkKnowledgeItem(item("requirement", { schema_version: 2, target_ids: ["backend"] }));
    expect(problems).toContain('source "_docs/module/sales-crm/design.md#L1-L10" requires origin in schema v2');
  });

  it("rejects a target-origin source that names no target_id", () => {
    const problems = checkKnowledgeItem(
      item("requirement", {
        schema_version: 2,
        target_ids: ["backend"],
        sources: [{ ...v2Sources[0], origin: { root: "target", target_id: null } }],
      }),
    );
    expect(problems.join(" ")).toMatch(/target origin without target_id/);
  });

  it("rejects a non-target source that carries a target_id anyway", () => {
    const problems = checkKnowledgeItem(
      item("requirement", {
        schema_version: 2,
        target_ids: ["backend"],
        sources: [{ ...v2Sources[0], origin: { root: "knowledge", target_id: "backend" } }],
      }),
    );
    expect(problems.join(" ")).toMatch(/non-target origin/);
  });

  it("keeps the legacy task payload optional while target_ids owns routing", () => {
    expect(checkKnowledgeItem(item("task", { schema_version: 2, target_ids: ["backend"], sources: v2Sources }))).toEqual([]);
    expect(checkKnowledgeItem(
      item("task", {
        schema_version: 2,
        target_ids: ["backend"],
        sources: v2Sources,
        payload: { ...(PAYLOADS.task as Record<string, unknown>), target_id: "backend" },
      }),
    )).toEqual([]);
  });

  it("a v2 document-only task (tag null) needs no payload.target_id", () => {
    const problems = checkKnowledgeItem(
      item("task", {
        schema_version: 2,
        target_ids: ["backend"],
        sources: v2Sources,
        payload: { ...(PAYLOADS.task as Record<string, unknown>), tag: null },
      }),
    );
    expect(problems).toEqual([]);
  });
});
