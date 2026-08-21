import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { VIEW_OF } from "../knowledge/roleView.js";
import { LANE_LABEL, ROLE_LANES, type RoleLane, isRoleLane, laneOf, rolesInLane } from "./roleLane.js";

describe("laneOf (T99)", () => {
  it("puts each of the ten roles in exactly one lane", () => {
    const stages = Object.values(AgentStage).filter((s) => s !== AgentStage.HUMAN);
    for (const stage of stages) {
      expect(ROLE_LANES).toContain(laneOf(stage) as RoleLane);
    }
    expect(stages).toHaveLength(10);
  });

  it("gives the human no lane — a lane of everything is not a lane", () => {
    expect(laneOf(AgentStage.HUMAN)).toBeNull();
  });

  it("matches V1.5's three columns", () => {
    expect(laneOf(AgentStage.BUSINESS_ANALYST)).toBe("ba");
    expect(laneOf(AgentStage.SYSTEM_ANALYST)).toBe("sa");
    expect(laneOf(AgentStage.BACKEND_ENGINEER)).toBe("dev");
  });

  /**
   * The lane grouping is derived from T67's VIEW_OF rather than declared again.
   * If someone adds a role to VIEW_OF and forgets this file, the lane must still
   * be answerable — which it is, because there is nothing here to forget.
   */
  it("stays a rename of VIEW_OF, not a second grouping", () => {
    for (const [role, view] of Object.entries(VIEW_OF) as [AgentStage, string][]) {
      const lane = laneOf(role);
      if (view === "all") expect(lane).toBeNull();
      else expect(lane).not.toBeNull();
    }
  });
});

describe("rolesInLane", () => {
  it("keeps test-planner with the architecture lane, where its view already put it", () => {
    expect(rolesInLane("sa")).toContain(AgentStage.TEST_PLANNER);
  });

  /** A lane says who reads together, not who may be chained to — CLAUDE.md's never-auto-chain rule is untouched. */
  it("keeps qa-engineer and security in the dev lane", () => {
    expect(rolesInLane("dev")).toEqual([
      AgentStage.BACKEND_ENGINEER,
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
      AgentStage.SECURITY,
      AgentStage.DEVOPS,
    ]);
  });

  it("covers every non-human role exactly once across the three lanes", () => {
    const all = ROLE_LANES.flatMap((lane) => rolesInLane(lane));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10);
    expect(all).not.toContain(AgentStage.HUMAN);
  });
});

describe("isRoleLane", () => {
  it("rejects a view name — the lane ids are ba/sa/dev, not business/architecture/technical", () => {
    expect(isRoleLane("business")).toBe(false);
    expect(isRoleLane("ba")).toBe(true);
  });

  it("labels every lane", () => {
    for (const lane of ROLE_LANES) expect(LANE_LABEL[lane]).toMatch(/^[A-Z]+$/);
  });
});
