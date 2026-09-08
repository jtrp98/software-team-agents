import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDocumentVerificationHook, withDocumentVerificationDisabled } from "./documentVerificationHook.js";
import { AgentStage } from "../types.js";
import * as docStructure from "../docs/docStructure.js";
import * as planGraph from "../docs/planGraph.js";

vi.mock("../docs/docStructure.js");
vi.mock("../docs/planGraph.js");

describe("DocumentVerificationHook", () => {
  const dummyProjectRoot = "/mock/project";
  
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("structural failure in design.md -> recorded failure attributed to the owning stage", async () => {
    vi.mocked(docStructure.checkDocStructure).mockReturnValue({
      ok: false,
      problems: ["design.md is missing ## Architecture"],
      notes: []
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({
      inner,
      projectRoot: dummyProjectRoot,
      moduleName: "test-module",
      blocking: true,
    });

    const result = await hook.executor({
      taskId: "task-1",
      stage: AgentStage.SYSTEM_ANALYST, context: [],
      
      
    });

    expect(docStructure.checkDocStructure).toHaveBeenCalledWith(dummyProjectRoot);
    expect(planGraph.checkPlanGraphs).not.toHaveBeenCalled();
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("design.md is missing ## Architecture");
    expect(result.outcome.document_gate).toBe("enabled");
    expect(result.postDevVerificationFailed).toBe(true);
  });

  it("plan.md with a cycle / unknown owner / illegal Tier -> recorded plan-graph failure, module-scoped", async () => {
    vi.mocked(docStructure.checkDocStructure).mockReturnValue({
      ok: true,
      problems: [],
      notes: []
    });
    vi.mocked(planGraph.checkPlanGraphs).mockReturnValue({
      ok: false,
      problems: ["cycle in plan.md"],
      notes: []
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({
      inner,
      projectRoot: dummyProjectRoot,
      moduleName: "test-module",
      blocking: true,
    });

    const result = await hook.executor({
      taskId: "task-2",
      stage: AgentStage.PROJECT_MANAGER, context: [],
      
      
    });

    expect(planGraph.checkPlanGraphs).toHaveBeenCalledWith(dummyProjectRoot, "test-module");
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("cycle in plan.md");
  });

  it("stage running before its document exists -> not flagged", async () => {
    vi.mocked(docStructure.checkDocStructure).mockReturnValue({
      ok: true,
      problems: [],
      notes: ["no _docs/module/ yet"]
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({
      inner,
      projectRoot: dummyProjectRoot,
      moduleName: "test-module",
      blocking: true,
    });

    const result = await hook.executor({
      taskId: "task-3",
      stage: AgentStage.BUSINESS_ANALYST, context: [],
      
      
    });

    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.document_gate).toBe("enabled");
  });

  it("checker throws -> stricter outcome with a recorded reason, never a silent pass", async () => {
    vi.mocked(docStructure.checkDocStructure).mockImplementation(() => {
      throw new Error("Something exploded");
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({
      inner,
      projectRoot: dummyProjectRoot,
      moduleName: "test-module",
      blocking: true,
    });

    const result = await hook.executor({
      taskId: "task-4",
      stage: AgentStage.SYSTEM_ANALYST, context: [],
      
      
    });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("Something exploded");
  });

  it("disabled hook sets document_gate to disabled", async () => {
    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = withDocumentVerificationDisabled(inner);
    const result = await hook({
      taskId: "task-5",
      stage: AgentStage.SYSTEM_ANALYST, context: [],
      
      
    });

    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.document_gate).toBe("disabled");
  });
});