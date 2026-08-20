import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "./knowledgeBase.js";
import { makeItem, sampleKnowledge } from "./sampleKnowledge.js";
import { impactOf, orphans, pathBetween, subgraph } from "./knowledgeGraph.js";

const base = (): KnowledgeBase => new KnowledgeBase(sampleKnowledge());

describe("impactOf", () => {
  it("walks against the arrows: what points at the change is what the change reaches", () => {
    const impact = impactOf(base(), "DB-Shift");
    expect(impact.map((e) => e.item.id)).toEqual(["API-shifts.list", "BE-014", "FE-020"]);
    expect(impact[0]).toMatchObject({ depth: 1, via: "references", from: "DB-Shift" });
    expect(impact[1]).toMatchObject({ depth: 2, via: "implements", from: "API-shifts.list" });
    expect(impact[2]).toMatchObject({ depth: 3, via: "depends-on", from: "BE-014" });
  });

  it("reaches the whole downstream of a design", () => {
    expect(impactOf(base(), "REQ-003").map((e) => e.item.id).sort()).toEqual([
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

  it("returns nothing for a leaf nobody depends on", () => {
    expect(impactOf(base(), "TEST-003")).toEqual([]);
    expect(impactOf(base(), "FE-020")).toEqual([]);
  });

  it("returns [] for an id that is not here, rather than throwing", () => {
    expect(impactOf(base(), "REQ-999")).toEqual([]);
  });

  it("honours maxDepth", () => {
    expect(impactOf(base(), "DB-Shift", { maxDepth: 1 }).map((e) => e.item.id)).toEqual(["API-shifts.list"]);
  });

  it("filters by relation type", () => {
    expect(impactOf(base(), "DES-003", { types: ["implements"] }).map((e) => e.item.id)).toEqual(["BE-014", "FE-020"]);
  });

  it("stopAt reports a kind and then stops expanding through it, so a report stays a list somebody acts on", () => {
    const impact = impactOf(base(), "DB-Shift", { stopAt: ["api"] });
    expect(impact.map((e) => e.item.id)).toEqual(["API-shifts.list"]);
  });

  it("reports each item once, at the shortest depth that reached it", () => {
    const impact = impactOf(base(), "DES-003");
    const ids = impact.map((e) => e.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(impact.find((e) => e.item.id === "BE-014")?.depth).toBe(1);
  });
});

describe("pathBetween", () => {
  it("finds the chain connecting a test to the model behind it, across arrow directions", () => {
    const path = pathBetween(base(), "TEST-003", "DB-Shift");
    expect(path).not.toBeNull();
    expect(path!.map((s) => `${s.from} -${s.type}-> ${s.to}`)).toEqual([
      "TEST-003 -verifies-> REQ-003",
      "REQ-003 -refines-> DES-003",
      "DES-003 -derived-from-> DB-Shift",
    ]);
  });

  it("marks which steps were taken against the arrow — connected is not the same claim as depends on", () => {
    const path = pathBetween(base(), "TEST-003", "DB-Shift")!;
    expect(path.map((s) => s.forward)).toEqual([true, false, false]);
  });

  it("is empty for an item and itself, and null when there is no connection", () => {
    expect(pathBetween(base(), "REQ-003", "REQ-003")).toEqual([]);
    const disconnected = new KnowledgeBase([
      ...sampleKnowledge(),
      makeItem("domain", "DOM-009", { term: "Ledger", definition: "unrelated", aliases: [] }),
    ]);
    expect(pathBetween(disconnected, "REQ-003", "DOM-009")).toBeNull();
  });

  it("returns null when either end is not in the base", () => {
    expect(pathBetween(base(), "REQ-999", "DB-Shift")).toBeNull();
    expect(pathBetween(base(), "DB-Shift", "REQ-999")).toBeNull();
  });

  it("takes the shortest route when there is more than one", () => {
    // BE-014 reaches DES-003 directly and also through API-shifts.list.
    expect(pathBetween(base(), "BE-014", "DES-003")).toHaveLength(1);
  });

  it("does not traverse a dangling relation", () => {
    const kb = new KnowledgeBase([
      makeItem("test", "TEST-009", { levels: ["unit"], automated: false }, { relations: [{ type: "verifies", to: "REQ-404" }] }),
      makeItem("requirement", "REQ-005", { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false }),
    ]);
    expect(pathBetween(kb, "TEST-009", "REQ-005")).toBeNull();
  });
});

describe("subgraph", () => {
  it("keeps only edges with both ends inside the selection", () => {
    const result = subgraph(base(), ["DES-003", "BE-014", "API-shifts.list"]);
    expect(result.items.map((i) => i.id)).toEqual(["DES-003", "API-shifts.list", "BE-014"]);
    expect(result.edges).toEqual([
      { from: "API-shifts.list", type: "derived-from", to: "DES-003" },
      { from: "BE-014", type: "implements", to: "DES-003" },
      { from: "BE-014", type: "implements", to: "API-shifts.list" },
    ]);
  });

  it("ignores ids that are not in the base", () => {
    expect(subgraph(base(), ["REQ-003", "REQ-999"]).items.map((i) => i.id)).toEqual(["REQ-003"]);
  });
});

describe("orphans", () => {
  it("finds items nothing points at and that point at nothing", () => {
    expect(orphans(base()).map((i) => i.id)).toEqual(["DOM-001"]);
  });

  it("does not count an item that is only pointed at", () => {
    expect(orphans(base()).map((i) => i.id)).not.toContain("REQ-003");
  });
});
