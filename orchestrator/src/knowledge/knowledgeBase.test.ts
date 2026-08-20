import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { buildTraceChain } from "../traceability/traceability.js";
import type { KnowledgeItem } from "./knowledgeModel.js";
import { makeItem as make, sampleKnowledge as sampleItems } from "./sampleKnowledge.js";
import { KnowledgeBase } from "./knowledgeBase.js";

function base(): KnowledgeBase {
  return new KnowledgeBase(sampleItems());
}

const ids = (items: KnowledgeItem[]): string[] => items.map((i) => i.id).sort();

describe("get and query", () => {
  it("gets by id and returns null rather than throwing for one that is not here", () => {
    expect(base().get("REQ-003")?.kind).toBe("requirement");
    expect(base().get("REQ-999")).toBeNull();
  });

  it("an empty filter is every item — one entry point for all nine kinds", () => {
    expect(base().query()).toHaveLength(10);
  });

  it("filters by kind, and by several kinds at once", () => {
    expect(ids(base().query({ kinds: ["task"] }))).toEqual(["BE-014", "FE-020"]);
    expect(ids(base().query({ kinds: ["api", "db-schema"] }))).toEqual(["API-shifts.list", "DB-Shift"]);
  });

  it("filters by module, and treats module: null as the project-wide selector", () => {
    expect(base().query({ module: "sales-crm" })).toHaveLength(8);
    expect(ids(base().query({ module: null }))).toEqual(["ADR-003", "DOM-001"]);
  });

  it("filters by owner, status and sensitivity", () => {
    expect(ids(base().query({ owner: AgentStage.BUSINESS_ANALYST }))).toEqual(["REQ-003", "RULE-007"]);
    expect(ids(base().query({ status: "approved" }))).toEqual(["REQ-003"]);
    expect(ids(base().query({ status: ["approved", "draft"] }))).toHaveLength(10);
    expect(ids(base().query({ sensitive: true }))).toEqual(["DB-Shift"]);
  });

  it("filters by text over id, title and body", () => {
    expect(ids(base().query({ text: "shifts" }))).toEqual(["API-shifts.list", "REQ-003", "RULE-007"]);
    expect(base().query({ text: "SHIFTS" })).toHaveLength(3);
  });

  it("combines filters, which is the query that a per-kind split could not answer at all", () => {
    const result = base().query({ kinds: ["task", "api"], module: "sales-crm", text: "" });
    expect(ids(result)).toEqual(["API-shifts.list", "BE-014", "FE-020"]);
  });

  it("returns [] rather than everything when nothing matches", () => {
    expect(base().query({ kinds: ["task"], owner: AgentStage.SECURITY })).toEqual([]);
  });

  // `null` means project-wide; `undefined` has to mean "not filtering on this",
  // or every caller forwarding an optional value gets a silent empty result.
  it("treats an explicitly undefined repo/module as no filter at all", () => {
    const optional: string | undefined = undefined;
    expect(base().query({ module: optional })).toHaveLength(10);
    expect(base().query({ repo: optional })).toHaveLength(10);
    expect(base().query({ module: optional, kinds: ["task"] })).toHaveLength(2);
  });
});

describe("graph", () => {
  it("outgoing follows the edges the item stores", () => {
    expect(ids(base().outgoing("API-shifts.list"))).toEqual(["DB-Shift", "DES-003"]);
    expect(ids(base().outgoing("API-shifts.list", "references"))).toEqual(["DB-Shift"]);
  });

  it("incoming is built here, from the outgoing edges — nothing on disk records it twice", () => {
    expect(ids(base().incoming("REQ-003"))).toEqual(["DES-003", "RULE-007", "TEST-003"]);
    expect(ids(base().incoming("REQ-003", "refines"))).toEqual(["DES-003", "RULE-007"]);
    expect(ids(base().incoming("DES-003", "implements"))).toEqual(["BE-014", "FE-020"]);
  });

  it("skips a dangling target instead of throwing — during discovery, knowledge arrives in batches", () => {
    const items = [
      make("test", "TEST-009", { levels: ["unit"], automated: false }, { relations: [{ type: "verifies", to: "REQ-404" }] }),
    ];
    expect(new KnowledgeBase(items).outgoing("TEST-009")).toEqual([]);
  });

  it("traverse walks one hop by default and further on request", () => {
    const kb = base();
    expect(ids(kb.traverse("REQ-003", { direction: "incoming" }))).toEqual(["DES-003", "RULE-007", "TEST-003"]);
    expect(ids(kb.traverse("REQ-003", { direction: "incoming", maxDepth: 2 }))).toEqual([
      "ADR-003",
      "API-shifts.list",
      "BE-014",
      "DB-Shift",
      "DES-003",
      "FE-020",
      "RULE-007",
      "TEST-003",
    ]);
  });

  it("traverse filters by relation type and respects direction", () => {
    const kb = base();
    expect(ids(kb.traverse("REQ-003", { direction: "incoming", types: ["verifies"] }))).toEqual(["TEST-003"]);
    expect(ids(kb.traverse("REQ-003", { direction: "outgoing", maxDepth: 3 }))).toEqual([]);
    expect(ids(kb.traverse("DES-003", { direction: "both" }))).toEqual([
      "ADR-003",
      "API-shifts.list",
      "BE-014",
      "DB-Shift",
      "FE-020",
      "REQ-003",
    ]);
  });

  it("terminates on a cycle rather than walking it forever", () => {
    const items = [
      make("requirement", "REQ-001", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
        relations: [{ type: "conflicts-with", to: "REQ-002" }],
      }),
      make("requirement", "REQ-002", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }, {
        relations: [{ type: "conflicts-with", to: "REQ-001" }],
      }),
    ];
    expect(ids(new KnowledgeBase(items).traverse("REQ-001", { direction: "both", maxDepth: 10 }))).toEqual(["REQ-002"]);
  });

  it("returns [] for an id that is not here, rather than throwing", () => {
    expect(base().traverse("REQ-999", { direction: "both" })).toEqual([]);
    expect(base().incoming("REQ-999")).toEqual([]);
  });
});

describe("chain", () => {
  it("walks requirement -> architecture -> api/db -> task -> test", () => {
    const chain = base().chain("REQ-003");
    expect(chain.requirement.id).toBe("REQ-003");
    expect(ids(chain.architecture)).toEqual(["DES-003"]);
    expect(ids(chain.apis)).toEqual(["API-shifts.list"]);
    expect(ids(chain.dbModels)).toEqual(["DB-Shift"]);
    expect(ids(chain.tasks)).toEqual(["BE-014", "FE-020"]);
    expect(ids(chain.tests)).toEqual(["TEST-003"]);
  });

  it("refuses to start anywhere but a requirement", () => {
    expect(() => base().chain("DES-003")).toThrow(/is a architecture/);
    expect(() => base().chain("REQ-999")).toThrow(/no knowledge item/);
  });

  it("returns empty buckets for a requirement nothing has been designed for yet", () => {
    const chain = new KnowledgeBase([
      make("requirement", "REQ-050", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }),
    ]).chain("REQ-050");
    expect(chain.architecture).toEqual([]);
    expect(chain.tasks).toEqual([]);
  });

  it("gives the same answer buildTraceChain gives on the same data (T19)", () => {
    // The evidence that this model holds what the pipeline already has, rather
    // than only what is new: the Markdown route and the graph route agree.
    const requirementMd = "## Core Features\n\n- REQ-003 staff see their own shifts\n";
    const designMd = "## Feature-by-Feature Feasibility\n\n| DES-003 | REQ-003 | feasible |\n";
    const planMd = [
      "## Phase 1",
      "| BE-014 | verified | shifts list endpoint (DES-003) |",
      "| FE-020 | pending | shifts page (DES-003) |",
      "- TEST-003 covers REQ-003",
    ].join("\n");

    const trace = buildTraceChain({ requirementMd, designMd, planMd });
    expect(trace).toHaveLength(1);

    const chain = base().chain("REQ-003");
    expect(ids(chain.architecture)).toEqual([...trace[0].design].sort());
    expect(ids(chain.tasks)).toEqual([...trace[0].tasks].sort());
    expect(ids(chain.tests)).toEqual([...trace[0].tests].sort());
  });
});

describe("check", () => {
  it("passes a consistent graph", () => {
    expect(base().check()).toEqual({ ok: true, problems: [] });
  });

  it("reports a relation pointing at nothing", () => {
    const items = [
      make("test", "TEST-009", { levels: ["unit"], automated: false }, { relations: [{ type: "verifies", to: "REQ-404" }] }),
    ];
    const result = new KnowledgeBase(items).check();
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("REQ-404");
  });

  it("reports a relation whose two ends are not a legal pair, and says what would have been", () => {
    const items = [
      ...sampleItems(),
      make("test", "TEST-010", { levels: ["unit"], automated: false }, { relations: [{ type: "implements", to: "DES-003" }] }),
    ];
    const result = new KnowledgeBase(items).check();
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("not a legal pair");
    expect(result.problems.join("\n")).toContain("task -> architecture|api|db-schema|business-rule");
  });

  it("reports an item the file schema would have rejected — items do not always come off disk", () => {
    const bad = make("task", "REQ-500", {
      agent: null,
      phase: null,
      tag: null,
      plan_status: "pending",
      produces: [],
      consumes: [],
      contract_version: null,
      orchestrator_task_id: null,
    });
    const result = new KnowledgeBase([bad]).check();
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("BE- or FE-");
  });

  it("reports an approved item with no source", () => {
    const items = [
      make("domain", "DOM-002", { term: "Roster", definition: "a set of shifts", aliases: [] }, {
        status: "approved",
        sources: [],
      }),
    ];
    expect(new KnowledgeBase(items).check().problems.join("\n")).toContain("names no source");
  });

  it("reports a supersedes cycle — every version claiming to replace another leaves no current one", () => {
    const decision = (id: string, to: string) =>
      make(
        "decision",
        id,
        { adr_status: "accepted", date: "2026-08-01", supersedes: to, superseded_by: null },
        { module: null, relations: [{ type: "supersedes", to }] },
      );
    const result = new KnowledgeBase([decision("ADR-001", "ADR-002"), decision("ADR-002", "ADR-001")]).check();
    expect(result.problems.join("\n")).toContain("supersedes cycle");
  });

  it("carries the loader's problems into the verdict — an item missing because its file broke is not the same as one never written", () => {
    const result = new KnowledgeBase(sampleItems(), ["sales-crm/requirement/REQ-009.yaml: is not valid YAML"]).check();
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("REQ-009.yaml");
  });
});
