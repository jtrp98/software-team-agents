import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { CONTEXT_POLICY } from "../context/contextSelection.js";
import { KNOWLEDGE_KINDS } from "./knowledgeModel.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { sampleKnowledge } from "./sampleKnowledge.js";
import { KnowledgeViewError, VIEW_OF, canSeeKind, kindsFor, viewFor, viewNameFor } from "./roleView.js";

const kb = new KnowledgeBase(sampleKnowledge());
const ids = (role: AgentStage) => viewFor(role, kb).map((i) => i.id).sort();

describe("kindsFor is derived from the context policy, not declared twice", () => {
  it("gives business-analyst the business view", () => {
    expect(kindsFor(AgentStage.BUSINESS_ANALYST)).toEqual([
      "requirement",
      "business-rule",
      "domain",
      "architecture",
      "api",
      "db-schema",
      "decision",
    ]);
  });

  it("gives an engineer the technical view, tasks and tests included", () => {
    const kinds = kindsFor(AgentStage.BACKEND_ENGINEER);
    expect(kinds).toContain("task");
    expect(kinds).toContain("test");
    expect(kinds).toContain("api");
  });

  it("does not give system-analyst tasks, because it does not read plan.md", () => {
    expect(CONTEXT_POLICY[AgentStage.SYSTEM_ANALYST]!.reads).not.toContain(ArtifactType.PLAN);
    expect(canSeeKind(AgentStage.SYSTEM_ANALYST, "task")).toBe(false);
  });

  it("follows the policy when the policy changes — setup reads only design", () => {
    expect(kindsFor(AgentStage.SETUP)).toEqual(["architecture", "api", "db-schema", "domain", "decision"].sort((a, b) =>
      KNOWLEDGE_KINDS.indexOf(a as never) - KNOWLEDGE_KINDS.indexOf(b as never),
    ));
  });

  it("shows ADRs to everyone — a role that cannot see a decision re-decides it", () => {
    for (const role of Object.values(AgentStage)) {
      expect(canSeeKind(role, "decision"), role).toBe(true);
    }
  });

  it("gives a person everything", () => {
    expect(kindsFor(AgentStage.HUMAN)).toEqual([...KNOWLEDGE_KINDS]);
  });

  it("leaves no role with an empty view", () => {
    for (const role of Object.values(AgentStage)) {
      expect(kindsFor(role).length, role).toBeGreaterThan(0);
    }
  });

  it("returns kinds in one canonical order, so two roles with the same access compare equal", () => {
    expect(kindsFor(AgentStage.BACKEND_ENGINEER)).toEqual(kindsFor(AgentStage.FRONTEND_ENGINEER));
  });
});

describe("view names", () => {
  it("names one of the V1.1 views for every role", () => {
    for (const role of Object.values(AgentStage)) {
      expect(["business", "architecture", "uxui", "technical", "all"]).toContain(viewNameFor(role));
    }
    expect(VIEW_OF[AgentStage.BUSINESS_ANALYST]).toBe("business");
    expect(VIEW_OF[AgentStage.SYSTEM_ANALYST]).toBe("architecture");
    expect(VIEW_OF[AgentStage.UXUI_DESIGNER]).toBe("uxui");
    expect(VIEW_OF[AgentStage.BACKEND_ENGINEER]).toBe("technical");
  });

  it("lets the UX/UI consultant see its own ux-design kind (owner union)", () => {
    expect(canSeeKind(AgentStage.UXUI_DESIGNER, "ux-design")).toBe(true);
    expect(canSeeKind(AgentStage.UXUI_DESIGNER, "requirement")).toBe(true);
    expect(canSeeKind(AgentStage.UXUI_DESIGNER, "task")).toBe(false);
  });
});

describe("viewFor", () => {
  it("filters the one base rather than duplicating it", () => {
    expect(ids(AgentStage.SYSTEM_ANALYST)).toEqual([
      "ADR-003",
      "API-shifts.list",
      "DB-Shift",
      "DES-003",
      "DOM-001",
      "REQ-003",
      "RULE-007",
    ]);
    expect(ids(AgentStage.BACKEND_ENGINEER)).toContain("BE-014");
    expect(ids(AgentStage.SYSTEM_ANALYST)).not.toContain("BE-014");
  });

  it("combines with an ordinary query filter", () => {
    const result = viewFor(AgentStage.BACKEND_ENGINEER, kb, { module: "sales-crm", sensitive: true });
    expect(result.map((i) => i.id)).toEqual(["DB-Shift"]);
  });

  it("throws when a caller asks for a kind the role does not see, instead of quietly returning less", () => {
    expect(() => viewFor(AgentStage.SYSTEM_ANALYST, kb, { kinds: ["task"] })).toThrow(KnowledgeViewError);
  });

  it("allows a narrowing request that stays inside the view", () => {
    expect(viewFor(AgentStage.BACKEND_ENGINEER, kb, { kinds: ["task"] }).map((i) => i.id)).toEqual(["BE-014", "FE-020"]);
  });

  it("gives a person the whole base", () => {
    expect(viewFor(AgentStage.HUMAN, kb)).toHaveLength(kb.items.length);
  });
});
