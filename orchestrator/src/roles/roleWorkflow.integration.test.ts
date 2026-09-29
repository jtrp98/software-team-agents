import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { makeItem } from "../knowledge/sampleKnowledge.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { testHumanVerifier, trustedCredential } from "../gates/humanDecision.testSupport.js";
import { decideLane } from "../orchestrator/stageGuards.testSupport.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { LaneDecisionService, laneItemRefs, laneWorkspaces, loadGovernedKnowledge } from "./laneDecisions.js";
import { BA_WORKFLOW, DEV_WORKFLOW, SA_WORKFLOW, type LaneSpec, roleWorkflowState as roleWorkflowStateOf } from "./roleWorkflow.js";

/**
 * BA -> SA -> DEV integration test.
 *
 * Every other test in `roleWorkflow.test.ts` feeds `roleWorkflowState()` an
 * in-memory `KnowledgeBase` and a hand-built `WorkspaceLookup`. That proves the
 * per-lane logic, but not what this file actually asks: that context and
 * approval survive the trip through the real mechanism a fresh agent context
 * uses to pick up where the previous one left off — files on disk, reloaded
 * from scratch.
 *
 * So this file writes knowledge items with `writeKnowledgeItem()` (the same
 * function every agent calls), records every sign-off and acknowledgement as a
 * trusted decision in the SQLite lane ledger through `LaneDecisionService`
 * (what `sta roles signoff|ack` runs, here with the test-only channel), and
 * never reuses an in-memory object across a "step" — every assertion reopens
 * the state file and reloads the governed Knowledge (V13 TASK-028), the same
 * cold read a brand-new agent run would do. If a step's carry,
 * blocker, or watermark test only passed because a JS reference survived from
 * the previous line, reloading here would have exposed it.
 */
describe("T114: BA -> SA -> DEV integration (real files, fresh reload at every step)", () => {
  let root: string;
  const MODULE = "acc-integration";
  const NOW = "2026-08-22T09:00:00Z";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-role-workflow-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Cold read of the lane ledger and governed Knowledge — reopened every call, like a fresh agent context. */
  function governed<T>(fn: (g: ReturnType<typeof loadGovernedKnowledge>) => T): T {
    const store = new SqliteTaskStore(defaultStateDbPath(root));
    try {
      return fn(loadGovernedKnowledge(root, store));
    } finally {
      store.close();
    }
  }

  function kb(): KnowledgeBase {
    return governed((g) => g.kb);
  }

  function roleWorkflowState(spec: LaneSpec) {
    return governed((g) =>
      roleWorkflowStateOf(spec, MODULE, g.kb, laneWorkspaces(g.recordsFor, g.root, MODULE, NOW), (items: KnowledgeItem[]) => laneItemRefs(items, g.root)),
    );
  }

  function decide(lane: "ba" | "sa" | "dev", action: "signoff" | "ack", options: Parameters<typeof decideLane>[5] = {}) {
    return decideLane(defaultStateDbPath(root), root, MODULE, lane, action, options);
  }

  it("carries context (unconfirmed assumption, design risk) and approval end to end without loss", async () => {
    // ---------- BA: draft a requirement carrying an unconfirmed assumption ----------
    const req = makeItem(
      "requirement",
      "REQ-101",
      {
        acceptance_criteria: ["พนักงานเห็นกะของตัวเองย้อนหลัง 30 วัน"],
        actors: ["staff"],
        priority: "must",
        assumption_unconfirmed: true,
      },
      {
        owner: AgentStage.BUSINESS_ANALYST,
        module: MODULE,
        status: "draft",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    );
    writeKnowledgeItem(req, root);

    expect(roleWorkflowState(BA_WORKFLOW).stage).toBe("drafting");

    writeKnowledgeItem({ ...req, status: "reviewed", version: 2 }, root);
    expect(roleWorkflowState(BA_WORKFLOW).stage).toBe(
      "awaiting-signoff",
    );

    writeKnowledgeItem({ ...req, status: "approved", version: 3 }, root);
    let baState = roleWorkflowState(BA_WORKFLOW);
    // The file says approved; STA does not: only the lane sign-off decision makes it binding.
    expect(KnowledgeBase.load(root).get("REQ-101")?.status).toBe("approved");
    expect(kb().get("REQ-101")?.status).toBe("reviewed");
    expect(baState.stage).toBe("awaiting-signoff");
    // The assumption travels rather than blocking (CLAUDE.md's rule, roleWorkflow.ts's module note).
    // Nothing blocks but the sign-off itself: the unsigned item is not binding yet.
    expect(baState.handoff.blockers).toEqual([expect.stringMatching(/^REQ-101 is not approved/)]);
    expect(baState.handoff.carries.some((c) => c.includes("REQ-101") && c.includes("unconfirmed assumption"))).toBe(
      true,
    );

    // ---------- BA signs the lane off — a persisted trusted decision, not a mock ----------
    await decide("ba", "signoff");
    expect(kb().get("REQ-101")?.status).toBe("approved");

    baState = roleWorkflowState(BA_WORKFLOW);
    expect(baState.stage).toBe("ready");
    expect(baState.handoff.acknowledgedByTarget).toBe(false); // SA has not read the file yet
    const carriedToSA = baState.handoff.carries;
    const handedOffIds = baState.handoff.items;

    // ---------- SA acknowledges the handoff (a second, separate decision) ----------
    await decide("sa", "ack", { ids: handedOffIds });

    baState = roleWorkflowState(BA_WORKFLOW);
    expect(baState.stage).toBe("ready");
    expect(baState.handoff.acknowledgedByTarget).toBe(true);
    // The carry named in the handoff before SA acknowledged is still named after — acknowledging does not consume it.
    expect(baState.handoff.carries).toEqual(carriedToSA);

    // ---------- SA: draft architecture (feasible-with-risk) + api referencing REQ-101 ----------
    const design = makeItem(
      "architecture",
      "DES-101",
      { feasibility: "feasible-with-risk", risks: ["ต้องแยก cache ต่อ tenant ไม่งั้นข้อมูลข้ามกัน"], component: "shift-svc" },
      {
        owner: AgentStage.SYSTEM_ANALYST,
        module: MODULE,
        status: "draft",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
        relations: [{ type: "refines", to: "REQ-101" }],
      },
    );
    const api = makeItem(
      "api",
      "API-shifts.mine",
      { method: "GET", path: "/api/shifts/mine", contract_name: "shifts.mine", request_shape: null, response_shape: "Shift[]" },
      {
        owner: AgentStage.SYSTEM_ANALYST,
        module: MODULE,
        status: "draft",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
        relations: [{ type: "derived-from", to: "DES-101" }],
      },
    );
    writeKnowledgeItem(design, root);
    writeKnowledgeItem(api, root);

    expect(roleWorkflowState(SA_WORKFLOW).stage).toBe("drafting");

    for (const item of [design, api]) writeKnowledgeItem({ ...item, status: "reviewed", version: 2 }, root);
    expect(roleWorkflowState(SA_WORKFLOW).stage).toBe(
      "awaiting-signoff",
    );

    for (const item of [design, api]) writeKnowledgeItem({ ...item, status: "approved", version: 3 }, root);
    let saState = roleWorkflowState(SA_WORKFLOW);
    expect(saState.stage).toBe("awaiting-signoff");
    // Only the pending sign-off blocks: contract_name is set, feasibility is not not-feasible/unknown.
    expect(saState.handoff.blockers.every((b) => / is not approved — /.test(b))).toBe(true);
    expect(saState.handoff.carries.some((c) => c.includes("DES-101") && c.includes("feasible with risk"))).toBe(true);
    expect(saState.handoff.carries.some((c) => c.includes("ต้องแยก cache"))).toBe(true);

    // ---------- SA signs off ----------
    await decide("sa", "signoff");

    saState = roleWorkflowState(SA_WORKFLOW);
    expect(saState.stage).toBe("ready");
    const carriedToDEV = saState.handoff.carries;
    const saHandedOffIds = saState.handoff.items;

    // ---------- DEV acknowledges SA's handoff ----------
    await decide("dev", "ack", { ids: saHandedOffIds });
    saState = roleWorkflowState(SA_WORKFLOW);
    expect(saState.handoff.acknowledgedByTarget).toBe(true);
    expect(saState.handoff.carries).toEqual(carriedToDEV); // still travels — nothing dropped it on ack

    // ---------- DEV: draft a backend task implementing the design/api ----------
    const task = makeItem(
      "task",
      "BE-201",
      {
        agent: AgentStage.BACKEND_ENGINEER,
        phase: 1,
        tag: "backend",
        plan_status: "pending",
        produces: ["shifts.mine"],
        consumes: [],
        contract_version: 1,
        orchestrator_task_id: null,
      },
      {
        owner: AgentStage.BACKEND_ENGINEER,
        module: MODULE,
        status: "draft",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
        relations: [
          { type: "implements", to: "DES-101" },
          { type: "implements", to: "API-shifts.mine" },
        ],
      },
    );
    writeKnowledgeItem(task, root);

    expect(roleWorkflowState(DEV_WORKFLOW).stage).toBe("drafting");

    writeKnowledgeItem({ ...task, status: "reviewed", version: 2 }, root);
    expect(roleWorkflowState(DEV_WORKFLOW).stage).toBe(
      "awaiting-signoff",
    );

    // Approved once qa-engineer has verified it and it is joined to the state machine —
    // otherwise it would only be *carried*, per DEV_WORKFLOW.carries().
    writeKnowledgeItem(
      {
        ...task,
        status: "approved",
        version: 3,
        payload: { ...task.payload, plan_status: "verified", orchestrator_task_id: "T-9" },
      },
      root,
    );

    let devState = roleWorkflowState(DEV_WORKFLOW);
    expect(devState.stage).toBe("awaiting-signoff");
    expect(devState.handoff.to).toBeNull(); // DEV is the last lane — nowhere further for context to go
    expect(devState.handoff.blockers).toEqual([expect.stringMatching(/^BE-201 is not approved/)]);
    expect(devState.handoff.carries).toEqual([]); // verified + joined: nothing left to carry

    // ---------- DEV signs the lane off — under its own dev-signoff gate ----------
    await decide("dev", "signoff");

    devState = roleWorkflowState(DEV_WORKFLOW);
    expect(devState.stage).toBe("ready");

    // ---------- Whole-chain sanity: every lane, read cold one more time, agrees on the final shape ----------
    const finalKb = kb();
    expect(finalKb.get("REQ-101")?.status).toBe("approved");
    expect(finalKb.get("DES-101")?.status).toBe("approved");
    expect(finalKb.get("BE-201")?.status).toBe("approved");
    expect(roleWorkflowState(BA_WORKFLOW).stage).toBe("ready");
    expect(roleWorkflowState(SA_WORKFLOW).stage).toBe("ready");
    expect(roleWorkflowState(DEV_WORKFLOW).stage).toBe("ready");
  });

  it("a rejected sign-off stops the lane and does not silently re-ask (T08/T103)", async () => {
    const req = makeItem(
      "requirement",
      "REQ-102",
      { acceptance_criteria: ["..."], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
      {
        owner: AgentStage.BUSINESS_ANALYST,
        module: MODULE,
        status: "approved",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    );
    writeKnowledgeItem(req, root, { force: true });

    const store = new SqliteTaskStore(defaultStateDbPath(root));
    try {
      const service = new LaneDecisionService({ store, verifier: testHumanVerifier() });
      const request = service.request(root, MODULE, "ba", "signoff");
      await service.submit({ requestId: request.requestId, approved: false, note: "priority ผิด ต้องเป็น should", credential: trustedCredential() });
    } finally {
      store.close();
    }

    const state = roleWorkflowState(BA_WORKFLOW);
    expect(state.stage).toBe("rejected");
    expect(state.nextAction.actor).toBe("human");
    expect(state.nextAction.what).toContain("priority ผิด");

    // Reloading fresh does not turn a "no" back into a pending question.
    const reloaded = roleWorkflowState(BA_WORKFLOW);
    expect(reloaded.stage).toBe("rejected");
  });

  it("a design an engineer cannot legally decide (feasibility unknown) blocks the SA->DEV handoff on disk", () => {
    writeKnowledgeItem(
      makeItem(
        "requirement",
        "REQ-103",
        { acceptance_criteria: ["..."], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
        { owner: AgentStage.BUSINESS_ANALYST, module: MODULE, status: "approved", version: 1, created_at: NOW, updated_at: NOW },
      ),
      root,
      { force: true },
    );
    writeKnowledgeItem(
      makeItem(
        "architecture",
        "DES-102",
        { feasibility: "unknown", risks: [], component: null },
        {
          owner: AgentStage.SYSTEM_ANALYST,
          module: MODULE,
          status: "approved",
          version: 1,
          created_at: NOW,
          updated_at: NOW,
          relations: [{ type: "refines", to: "REQ-103" }],
        },
      ),
      root,
      { force: true },
    );

    const state = roleWorkflowState(SA_WORKFLOW);
    expect(state.stage).toBe("blocked");
    expect(state.handoff.blockers.some((b) => b.includes("DES-102") && b.includes("not an engineer's call"))).toBe(
      true,
    );
  });
});
