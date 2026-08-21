import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem, KnowledgeStatus, RequirementPayload, TaskPayload } from "../knowledge/knowledgeModel.js";
import { ALLOWED_OWNERS, canTransition } from "../knowledge/ownership.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { ROLE_LANES, type RoleLane, laneOf } from "./roleLane.js";
import { type RoleWorkspace, emptyWorkspace } from "./roleWorkspace.js";
import { recordSignoff } from "./roleApproval.js";
import {
  BA_WORKFLOW,
  DEV_WORKFLOW,
  LANE_WORKFLOWS,
  SA_WORKFLOW,
  type WorkspaceLookup,
  describeStage,
  ownedKindsOf,
  roleWorkflowState,
  workflowFor,
} from "./roleWorkflow.js";

const NOW = "2026-08-21T10:00:00Z";

/** The BA lane's two items, at whatever status the case needs. */
function withStatus(overrides: Record<string, KnowledgeStatus>, extra: Partial<KnowledgeItem>[] = []): KnowledgeBase {
  const items = sampleKnowledge().map((item) =>
    overrides[item.id] !== undefined ? ({ ...item, status: overrides[item.id] } as KnowledgeItem) : item,
  );
  for (const patch of extra) {
    const i = items.findIndex((item) => item.id === patch.id);
    if (i !== -1) items[i] = { ...items[i], ...patch } as KnowledgeItem;
  }
  return new KnowledgeBase(items);
}

/** No lane has acknowledged or signed off anything. */
const noWatermarks: WorkspaceLookup = (lane) => emptyWorkspace(lane, "sales-crm", NOW);

/** A mutable set of the three lanes' workspaces, so a case can compose an ack and a sign-off. */
function lanes(): { lookup: WorkspaceLookup; ack(lane: RoleLane, seen: Record<string, number>): void; sign(lane: RoleLane, approved: KnowledgeItem[], opts?: { approve?: boolean; by?: string; note?: string }): void } {
  const map = new Map<RoleLane, RoleWorkspace>(ROLE_LANES.map((l) => [l, emptyWorkspace(l, "sales-crm", NOW)]));
  return {
    lookup: (lane) => map.get(lane) as RoleWorkspace,
    ack(lane, seen) {
      map.set(lane, {
        ...(map.get(lane) as RoleWorkspace),
        seen: Object.entries(seen).map(([id, version]) => ({ id, version, at: NOW, by: "Nan" })),
      });
    },
    sign(lane, approved, opts = {}) {
      map.set(
        lane,
        recordSignoff(map.get(lane) as RoleWorkspace, {
          approved,
          approve: opts.approve ?? true,
          by: opts.by ?? "Nan",
          note: opts.note,
          now: NOW,
        }),
      );
    },
  };
}

/** The SA lane has acknowledged exactly these ids at these versions. */
function saAcknowledged(seen: Record<string, number>): WorkspaceLookup {
  const set = lanes();
  set.ack("sa", seen);
  return set.lookup;
}

/** Everything a lane owns is approved AND the lane is signed off — the only way to reach `ready` since T103. */
function signedOff(spec: { lane: RoleLane }, kb: KnowledgeBase, extra: (set: ReturnType<typeof lanes>) => void = () => {}): WorkspaceLookup {
  const set = lanes();
  const approved = kb.query({ module: "sales-crm" }).filter((i) => laneOf(i.owner) === spec.lane && i.status === "approved");
  set.sign(spec.lane, approved);
  extra(set);
  return set.lookup;
}

function baState(kb: KnowledgeBase, workspaces: WorkspaceLookup = noWatermarks) {
  return roleWorkflowState(BA_WORKFLOW, "sales-crm", kb, workspaces);
}

describe("the BA lane workflow (T100)", () => {
  it("is intake when the module has no requirement at all", () => {
    const kb = new KnowledgeBase(sampleKnowledge().filter((i) => i.kind !== "requirement"));
    const state = baState(kb);
    expect(state.stage).toBe("intake");
    expect(state.nextAction.actor).toBe("human");
    expect(state.nextAction.agent).toBe(AgentStage.BUSINESS_ANALYST);
    expect(state.nextAction.what).toMatch(/a requirement is never inferred/);
  });

  /** REQ-003 is approved in the fixture, RULE-007 is draft. */
  it("is drafting while anything it owns is still draft", () => {
    const state = baState(new KnowledgeBase(sampleKnowledge()));
    expect(state.stage).toBe("drafting");
    expect(state.draft).toEqual(["RULE-007"]);
    expect(state.nextAction.actor).toBe("agent");
    expect(state.nextAction.what).toMatch(/somebody other than the owner reviews them/);
  });

  it("hands the next move to a person once everything is reviewed", () => {
    const state = baState(withStatus({ "RULE-007": "reviewed" }));
    expect(state.stage).toBe("awaiting-approval");
    expect(state.reviewed).toEqual(["RULE-007"]);
    expect(state.nextAction.actor).toBe("human");
  });

  /** The rule this whole version exists to hold: an agent never gets to be the actor at this point. */
  it("never names an agent as the actor for the approval step", () => {
    for (const status of ["draft", "reviewed", "approved"] as KnowledgeStatus[]) {
      const state = baState(withStatus({ "RULE-007": status }));
      if (state.stage === "awaiting-approval" || state.stage === "ready" || state.stage === "intake") {
        expect(state.nextAction.actor).toBe("human");
      }
    }
  });

  it("waits for its own sign-off even after every item is approved", () => {
    const state = baState(withStatus({ "RULE-007": "approved" }));
    expect(state.stage).toBe("awaiting-signoff");
    expect(state.nextAction.actor).toBe("human");
    expect(state.nextAction.what).toMatch(/sta roles signoff ba --by <name>/);
  });

  it("is ready, and says how to record the handoff, once approved and signed off", () => {
    const kb = withStatus({ "RULE-007": "approved" });
    const state = baState(kb, signedOff(BA_WORKFLOW, kb));
    expect(state.stage).toBe("ready");
    expect(state.approved).toEqual(["REQ-003", "RULE-007"]);
    expect(state.handoff.to).toBe("sa");
    expect(state.handoff.blockers).toEqual([]);
    expect(state.nextAction.what).toMatch(/sta roles ack sa REQ-003,RULE-007 --by <name>/);
  });

  it("blocks the handoff on anything not yet approved, and says why", () => {
    const state = baState(new KnowledgeBase(sampleKnowledge()));
    expect(state.handoff.blockers).toEqual([
      "RULE-007 is not approved — the next lane must not build on knowledge nobody accepted as binding",
    ]);
  });
});

describe("the BA lane's own two checks", () => {
  it("blocks an approved requirement with no acceptance criteria", () => {
    const kb = withStatus(
      { "RULE-007": "approved" },
      [{ id: "REQ-003", payload: { ...(sampleKnowledge()[0].payload as RequirementPayload), acceptance_criteria: [] } }],
    );
    const state = baState(kb);
    expect(state.stage).toBe("blocked");
    expect(state.handoff.blockers.join(" ")).toMatch(/REQ-003 is approved with no acceptance criteria/);
    expect(state.nextAction.actor).toBe("human");
  });

  /**
   * The distinction that matters most in this file. CLAUDE.md requires an
   * unsourced fact to be flagged; if the flag blocked the handoff, the way to
   * make progress would be to stop flagging.
   */
  it("carries an unconfirmed assumption instead of blocking on it", () => {
    const kb = withStatus(
      { "RULE-007": "approved" },
      [
        {
          id: "REQ-003",
          payload: { ...(sampleKnowledge()[0].payload as RequirementPayload), assumption_unconfirmed: true },
        },
      ],
    );
    const state = baState(kb, signedOff(BA_WORKFLOW, kb));
    expect(state.stage).toBe("ready");
    expect(state.handoff.blockers).toEqual([]);
    expect(state.handoff.carries.join(" ")).toMatch(/REQ-003 rests on an unconfirmed assumption/);
    // And it travels with the handoff instruction, rather than sitting in a field nobody prints.
    expect(state.nextAction.what).toMatch(/It carries: REQ-003 rests on an unconfirmed assumption/);
  });
});

describe("the handoff is the T99 watermark, not a new mechanism", () => {
  const approved = withStatus({ "RULE-007": "approved" });

  it("is not acknowledged until SA has recorded these exact versions", () => {
    expect(baState(approved).handoff.acknowledgedByTarget).toBe(false);
    expect(baState(approved, saAcknowledged({ "REQ-003": 1 })).handoff.acknowledgedByTarget).toBe(false);
    expect(baState(approved, saAcknowledged({ "REQ-003": 1, "RULE-007": 1 })).handoff.acknowledgedByTarget).toBe(true);
  });

  /** BA amending after the handoff must un-acknowledge it, or SA is working from a version nobody re-read. */
  it("stops being acknowledged when BA amends an already-handed-off item", () => {
    const amended = new KnowledgeBase(
      approved.items.map((i) => (i.id === "REQ-003" ? { ...i, version: 2 } : i)) as KnowledgeItem[],
    );
    const state = roleWorkflowState(
      BA_WORKFLOW,
      "sales-crm",
      amended,
      signedOff(BA_WORKFLOW, amended, (set) => set.ack("sa", { "REQ-003": 1, "RULE-007": 1 })),
    );
    expect(state.handoff.acknowledgedByTarget).toBe(false);
    expect(state.nextAction.what).toMatch(/hand off to SA/);
  });

  it("says the lane is done once SA has caught up", () => {
    const state = baState(
      approved,
      signedOff(BA_WORKFLOW, approved, (set) => set.ack("sa", { "REQ-003": 1, "RULE-007": 1 })),
    );
    expect(state.nextAction.what).toMatch(/SA has acknowledged REQ-003, RULE-007 — this lane is done for now/);
  });

  it("is never acknowledged when the lane has approved nothing", () => {
    const nothing = new KnowledgeBase(sampleKnowledge().filter((i) => i.status !== "approved"));
    expect(baState(nothing, saAcknowledged({ "REQ-003": 1 })).handoff.acknowledgedByTarget).toBe(false);
  });
});

describe("it reads and never writes", () => {
  it("does not mutate the watermark it was handed", () => {
    const ws = emptyWorkspace("sa", "sales-crm", NOW);
    const before = JSON.stringify(ws);
    roleWorkflowState(BA_WORKFLOW, "sales-crm", withStatus({ "RULE-007": "approved" }), () => ws);
    expect(JSON.stringify(ws)).toBe(before);
  });

  it("does not mutate the knowledge base", () => {
    const kb = new KnowledgeBase(sampleKnowledge());
    const before = JSON.stringify(kb.items);
    baState(kb);
    expect(JSON.stringify(kb.items)).toBe(before);
  });
});

describe("the SA lane workflow (T101)", () => {
  function saState(kb: KnowledgeBase, workspaces: WorkspaceLookup = noWatermarks) {
    return roleWorkflowState(SA_WORKFLOW, "sales-crm", kb, workspaces);
  }

  /** Everything SA owns approved: DES-003, API-shifts.list, DB-Shift, DOM (project-wide, excluded), TEST-003. */
  const allApproved = () =>
    withStatus({ "DES-003": "approved", "API-shifts.list": "approved", "DB-Shift": "approved", "TEST-003": "approved" });

  it("is intake when the module has no architecture item", () => {
    const kb = new KnowledgeBase(sampleKnowledge().filter((i) => i.kind !== "architecture"));
    const state = saState(kb);
    expect(state.stage).toBe("intake");
    expect(state.nextAction.agent).toBe(AgentStage.SYSTEM_ANALYST);
    expect(state.nextAction.what).toMatch(/the data model is confirmed with a person/);
  });

  it("is ready and hands off to DEV once its design is approved and signed off", () => {
    const kb = allApproved();
    const state = saState(kb, signedOff(SA_WORKFLOW, kb));
    expect(state.stage).toBe("ready");
    expect(state.handoff.to).toBe("dev");
    expect(state.handoff.blockers).toEqual([]);
  });

  it("blocks a design approved as not-feasible — a verdict is not something to build", () => {
    const kb = withStatus(
      { "DES-003": "approved", "API-shifts.list": "approved", "DB-Shift": "approved", "TEST-003": "approved" },
      [{ id: "DES-003", payload: { feasibility: "not-feasible", risks: [], component: "shift-service" } }],
    );
    expect(saState(kb).handoff.blockers.join(" ")).toMatch(/"not-feasible" — that is a verdict/);
  });

  it("blocks feasibility 'unknown', because deciding it would be the engineer's call", () => {
    const kb = withStatus(
      { "DES-003": "approved", "API-shifts.list": "approved", "DB-Shift": "approved", "TEST-003": "approved" },
      [{ id: "DES-003", payload: { feasibility: "unknown", risks: [], component: null } }],
    );
    expect(saState(kb).handoff.blockers.join(" ")).toMatch(/not an engineer's call to make/);
  });

  /** §6a's ordering is derived from the contract name; with none, the frontend guesses. */
  it("blocks an approved API with no contract_name", () => {
    const kb = withStatus(
      { "DES-003": "approved", "API-shifts.list": "approved", "DB-Shift": "approved", "TEST-003": "approved" },
      [
        {
          id: "API-shifts.list",
          payload: { method: "GET", path: "/api/shifts", contract_name: null, request_shape: null, response_shape: "Shift[]" },
        },
      ],
    );
    expect(saState(kb).handoff.blockers.join(" ")).toMatch(/has no contract_name/);
  });

  it("carries risk to DEV instead of blocking on it", () => {
    const kb = withStatus(
      { "DES-003": "approved", "API-shifts.list": "approved", "DB-Shift": "approved", "TEST-003": "approved" },
      [{ id: "DES-003", payload: { feasibility: "feasible-with-risk", risks: ["timezone handling"], component: null } }],
    );
    const state = saState(kb, signedOff(SA_WORKFLOW, kb));
    expect(state.stage).toBe("ready");
    expect(state.handoff.blockers).toEqual([]);
    expect(state.handoff.carries.join(" ")).toMatch(/feasible with risk/);
    expect(state.handoff.carries.join(" ")).toMatch(/timezone handling/);
  });
});

describe("the DEV lane workflow (T102)", () => {
  function devState(kb: KnowledgeBase, workspaces: WorkspaceLookup = noWatermarks) {
    return roleWorkflowState(DEV_WORKFLOW, "sales-crm", kb, workspaces);
  }

  it("hands off to nobody — it is the last lane", () => {
    const kb = withStatus({ "BE-014": "approved", "FE-020": "approved" });
    const state = devState(kb, signedOff(DEV_WORKFLOW, kb));
    expect(state.handoff.to).toBeNull();
    expect(state.handoff.acknowledgedByTarget).toBe(false);
    expect(state.nextAction.what).toMatch(/hands off to nobody/);
  });

  /** CLAUDE.md §6a, made checkable: FE-020 consumes "shifts.list", which BE-014 produces. */
  it("blocks an approved frontend task whose backend producer is not approved", () => {
    const state = devState(withStatus({ "FE-020": "approved" }));
    expect(state.handoff.blockers.join(" ")).toMatch(
      /FE-020 is approved but BE-014, which produces the contract "shifts.list" it consumes, is draft/,
    );
    expect(state.handoff.blockers.join(" ")).toMatch(/agent-boundaries §6a/);
  });

  it("allows the same pair once the backend is approved too", () => {
    const state = devState(withStatus({ "BE-014": "approved", "FE-020": "approved" }));
    expect(state.handoff.blockers).toEqual([]);
  });

  it("blocks a frontend task consuming a contract nobody produces", () => {
    const kb = withStatus({ "FE-020": "approved", "BE-014": "approved" }, [
      { id: "BE-014", payload: { ...(sampleKnowledge().find((i) => i.id === "BE-014")?.payload as TaskPayload), produces: [] } },
    ]);
    expect(devState(kb).handoff.blockers.join(" ")).toMatch(/no task produces/);
  });

  it("blocks a task that is approved and blocked at the same time", () => {
    const kb = withStatus({ "BE-014": "approved", "FE-020": "approved" }, [
      {
        id: "BE-014",
        payload: { ...(sampleKnowledge().find((i) => i.id === "BE-014")?.payload as TaskPayload), plan_status: "blocked" },
      },
    ]);
    expect(devState(kb).handoff.blockers.join(" ")).toMatch(/approved blocked task is two answers/);
  });

  /** The join to T01–T60 travels rather than blocks: not yet run is a normal state. */
  it("carries a task that is not joined to the orchestrator, and one qa has not verified", () => {
    const state = devState(withStatus({ "BE-014": "approved", "FE-020": "approved" }));
    const carried = state.handoff.carries.join(" ");
    expect(carried).toMatch(/FE-020 is approved as knowledge but its plan Status is "pending"/);
    expect(state.handoff.blockers).toEqual([]);
  });
});

describe("the lane spec table", () => {
  it("has all three lanes", () => {
    expect(workflowFor("ba")).toBe(BA_WORKFLOW);
    expect(workflowFor("sa")).toBe(SA_WORKFLOW);
    expect(workflowFor("dev")).toBe(DEV_WORKFLOW);
    expect(Object.keys(LANE_WORKFLOWS).sort()).toEqual(["ba", "dev", "sa"]);
  });

  it("chains ba -> sa -> dev and stops", () => {
    expect(BA_WORKFLOW.handoffTo).toBe("sa");
    expect(SA_WORKFLOW.handoffTo).toBe("dev");
    expect(DEV_WORKFLOW.handoffTo).toBeNull();
  });

  /**
   * Not reachable from the CLI now that all three lanes are filled, but the table
   * is typed `Partial` and a lane whose workflow went missing has to print that,
   * not print nothing and read as "no work here".
   */
  it("describes a missing workflow rather than rendering blank", () => {
    expect(describeStage(null)).toBe("(no lane workflow defined)");
    expect(describeStage(baState(new KnowledgeBase(sampleKnowledge())))).toBe("drafting");
  });

  it("keeps every declared spec's lane matching its key", () => {
    for (const [lane, spec] of Object.entries(LANE_WORKFLOWS) as [RoleLane, (typeof BA_WORKFLOW)][]) {
      expect(spec.lane).toBe(lane);
      expect(ROLE_LANES).toContain(spec.lane);
    }
  });

  /** The spec's lead agent has to actually be allowed to own the kind the lane is judged on. */
  it("names a lead agent that may own the lane's primary kind", () => {
    for (const spec of Object.values(LANE_WORKFLOWS)) {
      expect(ALLOWED_OWNERS[spec.primaryKind]).toContain(spec.leadAgent);
    }
  });

  it("derives the lane's owned kinds from T65 rather than declaring them again", () => {
    expect(ownedKindsOf("ba")).toEqual(["requirement", "business-rule", "domain"]);
    expect(ownedKindsOf("sa")).toContain("db-schema");
    expect(ownedKindsOf("dev")).toContain("task");
  });
});

describe("the stages match T65's transition table", () => {
  /**
   * The stage names are a reading of `ownership.ts`, not a second state machine.
   * If someone loosens that table — say, allowing an owner to review its own
   * work, or `draft -> approved` — this test is what notices.
   */
  it("still needs a non-owner to review and a person to approve", () => {
    const rule = sampleKnowledge().find((i) => i.id === "RULE-007") as KnowledgeItem;
    expect(canTransition(rule, "reviewed", AgentStage.BUSINESS_ANALYST).allowed).toBe(false);
    expect(canTransition(rule, "reviewed", AgentStage.SYSTEM_ANALYST).allowed).toBe(true);
    expect(canTransition(rule, "approved", AgentStage.SYSTEM_ANALYST).allowed).toBe(false);

    const reviewed = { ...rule, status: "reviewed" as const };
    expect(canTransition(reviewed, "approved", AgentStage.BUSINESS_ANALYST).allowed).toBe(false);
    expect(canTransition(reviewed, "approved", AgentStage.HUMAN).allowed).toBe(true);
  });
});
