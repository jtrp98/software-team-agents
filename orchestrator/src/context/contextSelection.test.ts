import { describe, expect, it } from "vitest";
import {
  CONTEXT_POLICY,
  ContextLeakageError,
  selectContext,
} from "./contextSelection.js";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

describe("CONTEXT_POLICY", () => {
  it("matches task-detail.md's backend-engineer example exactly", () => {
    const p = CONTEXT_POLICY[AgentStage.BACKEND_ENGINEER]!;
    expect(p.reads).toEqual(
      expect.arrayContaining([
        ArtifactType.REQUIREMENTS,
        ArtifactType.DESIGN,
        ArtifactType.PLAN,
        "backend-code",
      ]),
    );
    expect(p.doesNotRead).toEqual(
      expect.arrayContaining(["ux-research", "frontend-code", "devops-docs"]),
    );
  });

  it("every role's reads and doesNotRead partition all categories with no overlap", () => {
    for (const p of Object.values(CONTEXT_POLICY)) {
      const overlap = p!.reads.filter((c) => p!.doesNotRead.includes(c));
      expect(overlap).toEqual([]);
    }
  });

  it("knowledge-brief is readable by every dev-side role (T-KA5a)", () => {
    for (const stage of [
      AgentStage.QA_ENGINEER,
      AgentStage.BACKEND_ENGINEER,
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.SECURITY,
      AgentStage.DEVOPS,
    ]) {
      expect(CONTEXT_POLICY[stage]!.reads).toContain("knowledge-brief");
    }
  });

  it("knowledge-brief stays forbidden for the BA-lane roles — they sit inside the Knowledge repo already", () => {
    for (const stage of [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.PROJECT_MANAGER,
      AgentStage.TEST_PLANNER,
      AgentStage.UXUI_DESIGNER,
    ]) {
      expect(() => selectContext(stage, { "knowledge-brief": "brief" }, ["knowledge-brief"])).toThrow(
        ContextLeakageError,
      );
    }
  });
});

describe("selectContext", () => {
  const store = {
    [ArtifactType.REQUIREMENTS]: "req content",
    [ArtifactType.DESIGN]: "design content",
    [ArtifactType.PLAN]: "plan content",
    "backend-code": "backend code",
    "frontend-code": "frontend code",
    "devops-docs": "devops content",
  };

  it("backend-engineer gets requirement/design/plan/backend-code, nothing else", () => {
    const ctx = selectContext(AgentStage.BACKEND_ENGINEER, store, [
      ArtifactType.REQUIREMENTS,
      ArtifactType.DESIGN,
      ArtifactType.PLAN,
      "backend-code",
    ]);
    const sources = ctx.map((c) => c.source).sort();
    expect(sources).toEqual([ArtifactType.DESIGN, ArtifactType.PLAN, ArtifactType.REQUIREMENTS, "backend-code"].sort());
    expect(ctx.some((c) => c.source === "frontend-code")).toBe(false);
  });

  it("throws ContextLeakageError when backend-engineer is asked to read frontend-code", () => {
    expect(() =>
      selectContext(AgentStage.BACKEND_ENGINEER, store, ["frontend-code"]),
    ).toThrow(ContextLeakageError);
  });

  it("throws when devops is asked to read frontend-code (devops only reads devops-docs + reports)", () => {
    expect(() => selectContext(AgentStage.DEVOPS, store, ["frontend-code"])).toThrow(
      ContextLeakageError,
    );
  });

  it("frontend-engineer's default (no explicit request) never includes backend-code", () => {
    const ctx = selectContext(AgentStage.FRONTEND_ENGINEER, store);
    expect(ctx.some((c) => c.source === "backend-code")).toBe(false);
    expect(ctx.some((c) => c.source === "frontend-code")).toBe(true);
  });
});
