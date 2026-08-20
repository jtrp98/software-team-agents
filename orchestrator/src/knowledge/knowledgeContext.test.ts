import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { SAMPLE_NOW, makeItem, sampleKnowledge } from "./sampleKnowledge.js";
import { SourceRegistry, type SourceRecord } from "./sourceRegistry.js";
import { parseKnowledgePolicy } from "./knowledgePolicy.js";
import { KnowledgeContext } from "./knowledgeContext.js";

const NOW = "2026-08-25T00:00:00Z";

const registry = new SourceRegistry([
  {
    schema_version: 1,
    id: "SRC-design.md",
    type: "file",
    locator: "_docs/module/sales-crm/design.md",
    captured_at: SAMPLE_NOW,
    captured_by: AgentStage.SYSTEM_ANALYST,
    digest: "sha256:abc",
  } satisfies SourceRecord,
]);

const redactPm = parseKnowledgePolicy({
  version: 1,
  roles: { "project-manager": { sensitive: "redacted" }, devops: { sensitive: "hidden" } },
});

function context(policy = redactPm): KnowledgeContext {
  return new KnowledgeContext(new KnowledgeBase(sampleKnowledge()), { now: NOW, policy, registry });
}

describe("permission-aware retrieval (T69)", () => {
  it("never hands out a raw item — everything comes back filtered", () => {
    const result = context().forRole(AgentStage.PROJECT_MANAGER).query();
    for (const retrieved of result.items) {
      expect(retrieved.item).toHaveProperty("withheld");
      expect(retrieved).toHaveProperty("provenance");
      expect(retrieved).toHaveProperty("freshness");
    }
  });

  it("filters by the role's view first", () => {
    const sa = context().forRole(AgentStage.SYSTEM_ANALYST).query();
    expect(sa.items.map((r) => r.item.id)).not.toContain("BE-014");
    expect(sa.kindsNotInView).toContain("task");
  });

  it("says which kinds are outside the view, so 'none' and 'none you may see' differ", () => {
    const devops = context().forRole(AgentStage.DEVOPS).query();
    expect(devops.kindsNotInView).toContain("requirement");
    expect(devops.kindsNotInView).not.toContain("task");
  });

  it("redacts a sensitive item's contents but keeps its identity", () => {
    const pm = context().forRole(AgentStage.PROJECT_MANAGER);
    const outcome = pm.get("DB-Shift");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.item.item.title).toBe("DB-Shift");
    expect(outcome.item.item.payload).toEqual({});
    expect(outcome.item.item.withheld).toEqual(["body", "payload", "sources"]);
  });

  it("lists an item the policy hides entirely instead of dropping it silently", () => {
    const result = context().forRole(AgentStage.DEVOPS).query();
    expect(result.hidden).toEqual(["DB-Shift"]);
    expect(result.items.map((r) => r.item.id)).not.toContain("DB-Shift");
  });

  it("distinguishes not-here from not-for-you", () => {
    const devops = context().forRole(AgentStage.DEVOPS);
    expect(devops.get("REQ-999")).toEqual({ status: "not-found" });
    expect(devops.get("DB-Shift").status).toBe("withheld");
    expect(devops.get("REQ-003").status).toBe("withheld");
  });

  it("throws when a caller asks for a kind outside the role's view", () => {
    expect(() => context().forRole(AgentStage.SYSTEM_ANALYST).query({ kinds: ["task"] })).toThrow(/does not see task/);
  });

  it("gives an item's owner the full thing regardless of the policy", () => {
    const sa = context().forRole(AgentStage.SYSTEM_ANALYST);
    const outcome = sa.get("DB-Shift");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.item.item.withheld).toEqual([]);
  });
});

describe("provenance (T72)", () => {
  const ctx = context();

  it("says where an item came from and which version this is", () => {
    const provenance = ctx.forRole(AgentStage.SYSTEM_ANALYST).provenance("DES-003")!;
    expect(provenance.id).toBe("DES-003");
    expect(provenance.version).toBe(1);
    expect(provenance.sources).toHaveLength(1);
    expect(provenance.citation).toContain("DES-003 v1");
    expect(provenance.citation).toContain("owned by system-analyst");
  });

  it("resolves a source to its registry record when there is one", () => {
    const item = makeItem(
      "architecture",
      "DES-009",
      { feasibility: "feasible", risks: [], component: null },
      {
        sources: [
          {
            type: "file",
            locator: "_docs/module/sales-crm/design.md#L10-L20",
            captured_at: SAMPLE_NOW,
            digest: "sha256:abc",
            source_id: "SRC-design.md",
          },
        ],
      },
    );
    const local = new KnowledgeContext(new KnowledgeBase([item]), { now: NOW, registry });
    expect(local.provenanceOf(item).sources[0].record?.id).toBe("SRC-design.md");
  });

  it("leaves the record null for material nobody registered, rather than inventing one", () => {
    const provenance = ctx.forRole(AgentStage.SYSTEM_ANALYST).provenance("REQ-003")!;
    expect(provenance.sources[0].record).toBeNull();
  });

  it("names what an item was worked out from", () => {
    const provenance = ctx.forRole(AgentStage.SYSTEM_ANALYST).provenance("API-shifts.list")!;
    expect(provenance.derivedFrom).toEqual(["DES-003", "REQ-003"]);
  });

  it("refuses provenance for something the role may not see — otherwise it is a side channel", () => {
    expect(ctx.forRole(AgentStage.DEVOPS).provenance("DB-Shift")).toBeNull();
    expect(ctx.forRole(AgentStage.DEVOPS).citation("DB-Shift")).toBeNull();
  });

  it("gives a one-line citation an agent can quote", () => {
    expect(ctx.forRole(AgentStage.BUSINESS_ANALYST).citation("REQ-003")).toMatch(/^REQ-003 v1 \[approved, owned by business-analyst\]/);
  });
});

describe("freshness rides along (T71)", () => {
  it("attaches a verdict to every retrieved item", () => {
    const result = context().forRole(AgentStage.BUSINESS_ANALYST).query({ kinds: ["requirement"] });
    expect(result.items[0].freshness.verdict).toBe("fresh");
    expect(result.items[0].freshness.ageDays).toBe(4);
  });

  it("calls an old item stale without the caller having to ask a second question", () => {
    const old = makeItem(
      "requirement",
      "REQ-050",
      { acceptance_criteria: [], actors: [], priority: null, assumption_unconfirmed: false },
      {
        owner: AgentStage.BUSINESS_ANALYST,
        sources: [{ type: "file", locator: "old.md", captured_at: "2025-01-01T00:00:00Z", digest: null }],
      },
    );
    const local = new KnowledgeContext(new KnowledgeBase([old]), { now: NOW });
    const outcome = local.forRole(AgentStage.BUSINESS_ANALYST).get("REQ-050");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.item.freshness.verdict).toBe("stale");
  });
});

describe("chain through the API", () => {
  it("returns the whole chain for a role that sees everything in it", () => {
    const chain = context().forRole(AgentStage.QA_ENGINEER).chain("REQ-003");
    expect(chain.requirement.item.id).toBe("REQ-003");
    expect(chain.tasks.map((t) => t.item.id)).toEqual(["BE-014", "FE-020"]);
    expect(chain.hidden).toEqual([]);
  });

  it("names what it left out rather than returning a quietly shorter chain", () => {
    const chain = context().forRole(AgentStage.BUSINESS_ANALYST).chain("REQ-003");
    expect(chain.tasks).toEqual([]);
    expect(chain.hidden).toEqual(["BE-014", "FE-020", "TEST-003"]);
  });

  it("refuses to build a chain whose head the role cannot see", () => {
    expect(() => context().forRole(AgentStage.DEVOPS).chain("REQ-003")).toThrow(/may not see/);
  });
});

describe("the API is the only door", () => {
  it("exposes no method that returns a raw knowledge item", () => {
    const role = context().forRole(AgentStage.BACKEND_ENGINEER);
    const returned = role.query().items[0].item as unknown as Record<string, unknown>;
    // A VisibleItem, not a KnowledgeItem: it carries `withheld` and never a schema_version.
    expect(returned.withheld).toBeDefined();
    expect(returned.schema_version).toBeUndefined();
  });
});
