import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { Adr } from "../decisions/decisionLog.js";
import type {
  DesignArtifact,
  PlanArtifact,
  RequirementsArtifact,
  TestPlanArtifact,
} from "../artifacts/schemas.js";
import { checkKnowledgeItem } from "./knowledgeModel.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { loadKnowledge, writeKnowledgeItem } from "./knowledgeStore.js";
import {
  type ConversionContext,
  decisionItemFrom,
  designItemsFrom,
  itemsFromArtifacts,
  planItemsFrom,
  requirementItemFrom,
  testPlanItemsFrom,
} from "./fromArtifacts.js";

const NOW = "2026-08-20T09:00:00Z";

const context: ConversionContext = {
  module: "sales-crm",
  now: NOW,
  requirementId: "REQ-003",
  architectureId: "DES-003",
};

const requirements: RequirementsArtifact = {
  taskId: "T-1",
  title: "staff see their own shifts",
  businessGoal: "ลดเวลาที่หัวหน้าต้องตอบคำถามเรื่องกะ",
  scope: { inScope: ["ดูกะย้อนหลัง 30 วัน"], outScope: ["แก้กะเอง"] },
  actors: ["staff"],
  acceptanceCriteria: ["เห็นเฉพาะกะของตัวเอง"],
  assumptions: [{ statement: "พนักงาน 200 คน", confirmed: false }],
  references: [{ fact: "ชั่วโมงทำงานสูงสุด 8 ชม./กะ", source: "HR policy 2026" }],
};

const design: DesignArtifact = {
  taskId: "T-1",
  feasibility: "feasible with the existing Shift table",
  dataModel: [{ model: "Shift", fields: [{ name: "id", type: "String" }, { name: "staffId", type: "String" }] }],
  risks: ["timezone handling"],
  openQuestions: [],
  contract: ["a staff member may read only rows where staffId = their own id"],
};

const plan: PlanArtifact = {
  taskId: "T-1",
  phases: [
    {
      id: "phase-1",
      name: "Phase 1: shifts",
      securityGate: true,
      tasks: [
        { id: "BE-014", description: "GET /api/shifts", tag: "backend", done: true },
        { id: "FE-020", description: "shifts page", tag: "frontend", done: false },
      ],
    },
  ],
};

const testPlan: TestPlanArtifact = {
  taskId: "T-1",
  items: [{ requirementId: "REQ-003", levels: ["api", "unit"], rationale: "ownership filter must be exercised" }],
  hasAutomatedTests: false,
};

const adr: Adr = {
  file: "ADR-004-caching.md",
  body: "## Status\naccepted\n",
  frontmatter: { id: "ADR-004", title: "Cache shift lookups", status: "accepted", date: "2026-08-01", supersedes: "ADR-003" },
};

describe("requirements artifact", () => {
  it("becomes one requirement item, owned by the analyst that produced it", () => {
    const item = requirementItemFrom(requirements, context);
    expect(item.id).toBe("REQ-003");
    expect(item.kind).toBe("requirement");
    expect(item.owner).toBe(AgentStage.BUSINESS_ANALYST);
    expect(item.module).toBe("sales-crm");
    expect(item.payload.acceptance_criteria).toEqual(["เห็นเฉพาะกะของตัวเอง"]);
    expect(item.payload.actors).toEqual(["staff"]);
    expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("derives an id from the taskId when the documents have not given it one", () => {
    expect(requirementItemFrom(requirements, { module: "sales-crm", now: NOW }).id).toBe("REQ-T-1");
  });

  it("carries an unconfirmed assumption through as a flag, not as a fact", () => {
    expect(requirementItemFrom(requirements, context).payload.assumption_unconfirmed).toBe(true);
    const confirmed = { ...requirements, assumptions: [{ statement: "พนักงาน 200 คน", confirmed: true }] };
    expect(requirementItemFrom(confirmed, context).payload.assumption_unconfirmed).toBe(false);
  });

  it("keeps each reference's own source rather than crediting them all to the agent", () => {
    const item = requirementItemFrom(requirements, context);
    expect(item.sources).toHaveLength(2);
    expect(item.sources[0]).toMatchObject({ type: "agent", locator: AgentStage.BUSINESS_ANALYST });
    expect(item.sources[1]).toMatchObject({ type: "human", locator: "HR policy 2026" });
  });

  it("starts as draft — a well-formed artifact is not an approved one", () => {
    expect(requirementItemFrom(requirements, context).status).toBe("draft");
  });
});

describe("design artifact", () => {
  it("becomes an architecture item that refines the requirement, plus one item per model", () => {
    const items = designItemsFrom(design, context);
    expect(items.map((i) => i.id)).toEqual(["DES-003", "DB-Shift"]);
    expect(items[0].relations).toEqual([{ type: "refines", to: "REQ-003" }]);
    expect(items[1].relations).toEqual([{ type: "derived-from", to: "DES-003" }]);
    for (const item of items) expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("records the risks it was given and does not upgrade itself to plainly feasible", () => {
    const [architecture] = designItemsFrom(design, context);
    expect(architecture.kind).toBe("architecture");
    if (architecture.kind === "architecture") {
      expect(architecture.payload.risks).toEqual(["timezone handling"]);
      expect(architecture.payload.feasibility).toBe("feasible-with-risk");
    }
  });

  it("carries the fields of each model", () => {
    const model = designItemsFrom(design, context)[1];
    expect(model.kind).toBe("db-schema");
    if (model.kind === "db-schema") {
      expect(model.payload.model).toBe("Shift");
      expect(model.payload.fields).toEqual([
        { name: "id", type: "String", optional: false },
        { name: "staffId", type: "String", optional: false },
      ]);
    }
  });
});

describe("plan artifact", () => {
  it("becomes one task item per plan task, implementing the design", () => {
    const items = planItemsFrom(plan, context);
    expect(items.map((i) => i.id)).toEqual(["BE-014", "FE-020"]);
    expect(items[0].relations).toEqual([{ type: "implements", to: "DES-003" }]);
    for (const item of items) expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("carries the phase number, the tag, the owning engineer and the orchestrator's task id", () => {
    const [backend, frontend] = planItemsFrom(plan, context);
    expect(backend.payload).toMatchObject({
      agent: AgentStage.BACKEND_ENGINEER,
      phase: 1,
      tag: "backend",
      orchestrator_task_id: "T-1",
    });
    expect(frontend.owner).toBe(AgentStage.FRONTEND_ENGINEER);
  });

  it("carries qa-engineer's mark rather than re-deciding it", () => {
    const [backend, frontend] = planItemsFrom(plan, context);
    expect(backend.payload.plan_status).toBe("verified");
    expect(frontend.payload.plan_status).toBe("pending");
  });

  it("puts the phase's security gate on every task in it", () => {
    expect(planItemsFrom(plan, context).every((i) => i.sensitive)).toBe(true);
    const open = { ...plan, phases: [{ ...plan.phases[0], securityGate: false }] };
    expect(planItemsFrom(open, context).every((i) => !i.sensitive)).toBe(true);
  });

  it("prefixes a task id that does not follow the BE-/FE- convention instead of writing an unloadable item", () => {
    const odd: PlanArtifact = {
      taskId: "T-1",
      phases: [
        { id: "phase-2", name: "Phase 2", securityGate: false, tasks: [{ id: "007", description: "x", tag: "backend", done: false }] },
      ],
    };
    const [item] = planItemsFrom(odd, context);
    expect(item.id).toBe("BE-007");
    expect(item.payload.phase).toBe(2);
    expect(checkKnowledgeItem(item)).toEqual([]);
  });
});

describe("test-plan artifact", () => {
  it("becomes one test item per entry, verifying the requirement it names", () => {
    const [item] = testPlanItemsFrom(testPlan, context);
    expect(item.id).toBe("TEST-003");
    expect(item.relations).toEqual([{ type: "verifies", to: "REQ-003" }]);
    expect(item.payload).toEqual({ levels: ["api", "unit"], automated: false });
    expect(item.owner).toBe(AgentStage.TEST_PLANNER);
    expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("does not let two entries for one requirement collide on an id", () => {
    const twice: TestPlanArtifact = { ...testPlan, items: [testPlan.items[0], { ...testPlan.items[0], rationale: "second" }] };
    expect(testPlanItemsFrom(twice, context).map((i) => i.id)).toEqual(["TEST-003", "TEST-003-2"]);
  });
});

describe("ADR", () => {
  it("becomes a project-wide decision item whatever module the context names", () => {
    const item = decisionItemFrom(adr, context);
    expect(item.id).toBe("ADR-004");
    expect(item.module).toBeNull();
    expect(item.owner).toBe(AgentStage.HUMAN);
    expect(item.sources[0]).toMatchObject({ type: "file", locator: "decisions/ADR-004-caching.md" });
    expect(checkKnowledgeItem(item)).toEqual([]);
  });

  it("maps the ADR's own status onto the knowledge status", () => {
    expect(decisionItemFrom(adr, context).status).toBe("approved");
    const proposed = { ...adr, frontmatter: { ...adr.frontmatter, status: "proposed" as const } };
    expect(decisionItemFrom(proposed, context).status).toBe("draft");
    const superseded = { ...adr, frontmatter: { ...adr.frontmatter, status: "superseded" as const } };
    expect(decisionItemFrom(superseded, context).status).toBe("deprecated");
  });

  it("keeps the supersedes link as a relation as well as a payload field", () => {
    const item = decisionItemFrom(adr, context);
    expect(item.relations).toEqual([{ type: "supersedes", to: "ADR-003" }]);
    expect(item.payload.supersedes).toBe("ADR-003");
  });
});

describe("a whole bundle", () => {
  const bundle = { requirements, design, plan, testPlan };

  it("produces a graph that checks clean, which is the evidence the model holds what the pipeline already has", () => {
    const items = itemsFromArtifacts(bundle, context);
    expect(items.map((i) => i.id)).toEqual(["REQ-003", "DES-003", "DB-Shift", "BE-014", "FE-020", "TEST-003"]);
    expect(new KnowledgeBase(items).check()).toEqual({ ok: true, problems: [] });
  });

  it("reconstructs the requirement -> design -> task -> test chain", () => {
    const chain = new KnowledgeBase(itemsFromArtifacts(bundle, context)).chain("REQ-003");
    expect(chain.architecture.map((i) => i.id)).toEqual(["DES-003"]);
    expect(chain.dbModels.map((i) => i.id)).toEqual(["DB-Shift"]);
    expect(chain.tasks.map((i) => i.id)).toEqual(["BE-014", "FE-020"]);
    expect(chain.tests.map((i) => i.id)).toEqual(["TEST-003"]);
  });

  it("reports the dangling edge, and does not throw, when a batch arrives without what it references", () => {
    const result = new KnowledgeBase(itemsFromArtifacts({ design }, context)).check();
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("REQ-003");
  });

  describe("written to disk", () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-knowledge-artifacts-"));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("round-trips through knowledge/ and still checks clean", () => {
      const items = itemsFromArtifacts({ ...bundle, adrs: [adr] }, context);
      for (const item of items) writeKnowledgeItem(item, root);

      const loaded = loadKnowledge(root);
      expect(loaded.problems).toEqual([]);
      expect(loaded.items).toHaveLength(items.length);
      // ADR-004 supersedes ADR-003, which was not part of this batch.
      expect(new KnowledgeBase(loaded.items).check().problems).toEqual([
        "ADR-004: supersedes -> \"ADR-003\", which is not a knowledge item here",
      ]);
      expect(fs.existsSync(path.join(root, "knowledge", "_project", "decision", "ADR-004.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(root, "knowledge", "sales-crm", "task", "BE-014.yaml"))).toBe(true);
    });
  });
});
