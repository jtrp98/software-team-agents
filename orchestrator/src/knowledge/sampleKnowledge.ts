import { AgentStage } from "../types.js";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeEnvelope,
  type KnowledgeItem,
  type KnowledgeItemOf,
  type KnowledgeKind,
  type PayloadByKind,
} from "./knowledgeModel.js";

/**
 * Test support: one module's worth of knowledge, wired the way the pipeline
 * produces it — requirement, the rule and design that refine it, the API and
 * model derived from that design, the two tasks that implement them, the test
 * that verifies the requirement, and a project-wide ADR constraining the
 * design.
 *
 * Shared rather than re-declared per test file: half a dozen suites need a
 * graph with real edges in it, and six hand-built copies would drift until a
 * test passed because its own fixture was wrong.
 */
export function makeItem<K extends KnowledgeKind>(
  kind: K,
  id: string,
  payload: PayloadByKind[K],
  overrides: Partial<KnowledgeEnvelope> = {},
): KnowledgeItemOf<K> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id,
    kind,
    title: id,
    body: "",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: SAMPLE_NOW,
    updated_at: SAMPLE_NOW,
    sources: [{ type: "agent", locator: AgentStage.SYSTEM_ANALYST, captured_at: SAMPLE_NOW, digest: null }],
    relations: [],
    ...overrides,
    payload,
  } as KnowledgeItemOf<K>;
}

export const SAMPLE_NOW = "2026-08-20T09:00:00Z";

export function sampleKnowledge(): KnowledgeItem[] {
  return [
    makeItem(
      "requirement",
      "REQ-003",
      { acceptance_criteria: ["เห็นเฉพาะกะของตัวเอง"], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
      { owner: AgentStage.BUSINESS_ANALYST, status: "approved", title: "staff see their own shifts" },
    ),
    makeItem(
      "business-rule",
      "RULE-007",
      { statement: "a staff member sees only their own shifts", enforcement: "code" },
      {
        owner: AgentStage.BUSINESS_ANALYST,
        title: "a staff member sees only their own shifts",
        relations: [{ type: "refines", to: "REQ-003" }],
      },
    ),
    makeItem("domain", "DOM-001", { term: "Shift", definition: "one working block", aliases: ["กะ"] }, { module: null }),
    makeItem(
      "architecture",
      "DES-003",
      { feasibility: "feasible", risks: [], component: "shift-service" },
      { relations: [{ type: "refines", to: "REQ-003" }] },
    ),
    makeItem(
      "api",
      "API-shifts.list",
      { method: "GET", path: "/api/shifts", contract_name: "shifts.list", request_shape: null, response_shape: "Shift[]" },
      {
        relations: [
          { type: "derived-from", to: "DES-003" },
          { type: "references", to: "DB-Shift" },
        ],
      },
    ),
    makeItem(
      "db-schema",
      "DB-Shift",
      { model: "Shift", fields: [{ name: "id", type: "String", optional: false }], relations: ["staff Staff"] },
      { relations: [{ type: "derived-from", to: "DES-003" }], sensitive: true },
    ),
    makeItem(
      "task",
      "BE-014",
      {
        agent: AgentStage.BACKEND_ENGINEER,
        phase: 1,
        tag: "backend",
        plan_status: "verified",
        produces: ["shifts.list"],
        consumes: [],
        contract_version: 1,
        orchestrator_task_id: "T-1",
      },
      {
        owner: AgentStage.BACKEND_ENGINEER,
        relations: [
          { type: "implements", to: "DES-003" },
          { type: "implements", to: "API-shifts.list" },
        ],
      },
    ),
    makeItem(
      "task",
      "FE-020",
      {
        agent: AgentStage.FRONTEND_ENGINEER,
        phase: 1,
        tag: "frontend",
        plan_status: "pending",
        produces: [],
        consumes: ["shifts.list"],
        contract_version: 1,
        orchestrator_task_id: "T-1",
      },
      {
        owner: AgentStage.FRONTEND_ENGINEER,
        relations: [
          { type: "implements", to: "DES-003" },
          { type: "depends-on", to: "BE-014" },
        ],
      },
    ),
    makeItem(
      "test",
      "TEST-003",
      { levels: ["api"], automated: false },
      { owner: AgentStage.TEST_PLANNER, relations: [{ type: "verifies", to: "REQ-003" }] },
    ),
    makeItem(
      "decision",
      "ADR-003",
      { adr_status: "accepted", date: "2026-08-01", supersedes: null, superseded_by: null },
      { module: null, owner: AgentStage.HUMAN, relations: [{ type: "constrains", to: "DES-003" }] },
    ),
  ];
}
