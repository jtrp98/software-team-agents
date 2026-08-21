import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { KnowledgeContext } from "../knowledge/knowledgeContext.js";
import { DEFAULT_KNOWLEDGE_POLICY, type KnowledgePolicy } from "../knowledge/knowledgePolicy.js";
import { canSeeKind, kindsFor } from "../knowledge/roleView.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { ROLE_LANES, rolesInLane } from "./roleLane.js";
import { kindsForLane, laneCanSee, laneContext, laneGet } from "./laneContext.js";

const NOW = "2026-08-21T10:00:00Z";

function context(policy: KnowledgePolicy = DEFAULT_KNOWLEDGE_POLICY): KnowledgeContext {
  return new KnowledgeContext(new KnowledgeBase(sampleKnowledge()), { now: NOW, policy });
}

/** The shipped policy: devops and project-manager get a redacted view of anything `sensitive`. */
const shippedPolicy: KnowledgePolicy = {
  ...DEFAULT_KNOWLEDGE_POLICY,
  roles: {
    [AgentStage.DEVOPS]: { sensitive: "redacted" },
    [AgentStage.PROJECT_MANAGER]: { sensitive: "redacted" },
  },
};

describe("kindsForLane (T107)", () => {
  it("is the union over the lane's roles, never more", () => {
    for (const lane of ROLE_LANES) {
      const union = new Set(rolesInLane(lane).flatMap((role) => kindsFor(role)));
      expect(new Set(kindsForLane(lane))).toEqual(union);
    }
  });

  /**
   * The union, not the intersection. The person in the DEV lane really does run
   * backend-engineer, qa-engineer and devops in the same afternoon — an
   * intersection would claim they had never seen a requirement's acceptance
   * criteria because devops does not need them, which is false and is the exact
   * failure knowledge-policy.yaml warns about.
   */
  it("gives DEV the requirement kind, which one of its roles can see even though another cannot", () => {
    expect(laneCanSee("dev", "requirement")).toBe(true);
    expect(rolesInLane("dev").some((r) => canSeeKind(r, "requirement"))).toBe(true);
  });

  it("never grants a kind no role in the lane may see", () => {
    for (const lane of ROLE_LANES) {
      for (const kind of kindsForLane(lane)) {
        expect(rolesInLane(lane).some((role) => canSeeKind(role, kind))).toBe(true);
      }
    }
  });
});

describe("laneContext", () => {
  it("names which role granted each item, so the grant is auditable rather than emergent", () => {
    const result = laneContext("dev", context());
    expect(result.items.length).toBeGreaterThan(0);
    for (const entry of result.items) {
      expect(rolesInLane("dev")).toContain(entry.viaRole);
      expect(canSeeKind(entry.viaRole, entry.item.kind)).toBe(true);
    }
  });

  /**
   * The BA lane reads `design.md` under CONTEXT_POLICY, so it does see
   * `db-schema` — the kinds actually outside it are `task` and `test`, which
   * live in `plan.md`/`test-plan.md`. Asserted against `kindsForLane` rather
   * than against a guess, so this test cannot drift from the policy it checks.
   */
  it("throws on a kind outside the lane, rather than quietly returning less", () => {
    expect(laneCanSee("ba", "task")).toBe(false);
    expect(() => laneContext("ba", context(), { kinds: ["task"] })).toThrow(/no role in the BA lane sees task/);
  });

  it("reports the kinds outside the lane, so absent and withheld stay distinguishable", () => {
    expect(laneContext("ba", context()).kindsNotInLane).toEqual(["task", "test", "ux-design"]);
  });

  /**
   * DB-Shift is `sensitive` in the fixture. devops would get it redacted; the
   * backend engineer would not. The lane sees the least-redacted version,
   * because the person really can open it as that role.
   */
  it("gives the lane the least-redacted view any of its roles has", () => {
    const result = laneContext("dev", context(shippedPolicy));
    const shift = result.items.find((i) => i.item.id === "DB-Shift");
    expect(shift?.item.withheld).toEqual([]);
    expect(shift?.viaRole).not.toBe(AgentStage.DEVOPS);
  });

  it("is still a redaction, not a bypass — a lane whose only reader is redacted stays redacted", () => {
    // project-manager is the sa lane's redacted role; system-analyst owns DB-Shift
    // and an owner always sees its own work in full, so check the redaction survives
    // for a role that is neither.
    const asDevops = context(shippedPolicy).forRole(AgentStage.DEVOPS).get("DB-Shift");
    expect(asDevops.status).toBe("ok");
    if (asDevops.status === "ok") expect(asDevops.item.item.withheld).toContain("body");
  });

  it("carries provenance and freshness through, the same as a single role's retrieval", () => {
    const entry = laneContext("sa", context()).items[0];
    expect(entry.provenance.citation).toContain(entry.item.id);
    expect(entry.freshness.verdict).toBeDefined();
  });
});

describe("laneGet", () => {
  it("keeps not-found and withheld distinct — collapsing them is how a lane implements around a gap", () => {
    expect(laneGet("ba", context(), "REQ-999").status).toBe("not-found");

    const withheld = laneGet("ba", context(), "BE-014");
    expect(withheld.status).toBe("withheld");
    if (withheld.status === "withheld") expect(withheld.reason).toMatch(/no role in the BA lane sees task/);
  });

  it("returns the item with the role that granted it", () => {
    const outcome = laneGet("dev", context(), "REQ-003");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.item.item.id).toBe("REQ-003");
      expect(rolesInLane("dev")).toContain(outcome.item.viaRole);
    }
  });

  /** The T107 case named in TASKS_V1.md: DEV needs some of BA's business rules. */
  it("lets DEV read a business rule BA owns", () => {
    const outcome = laneGet("dev", context(), "RULE-007");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.item.item.owner).toBe(AgentStage.BUSINESS_ANALYST);
  });
});
