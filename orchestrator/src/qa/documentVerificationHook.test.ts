import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDocumentVerificationHook } from "./documentVerificationHook.js";
import { AgentStage } from "../types.js";
import * as docStructure from "../docs/docStructure.js";
import * as planGraph from "../docs/planGraph.js";

vi.mock("../docs/docStructure.js");
vi.mock("../docs/planGraph.js");

describe("DocumentVerificationHook", () => {
  let knowledgeRoot: string;
  const moduleName = "test-module";

  beforeEach(() => {
    vi.resetAllMocks();
    knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doc-hook-"));
    // The checks the module mocks answer by default with a clean bill.
    vi.mocked(docStructure.checkOneDoc).mockReturnValue({ ok: true, problems: [] });
    vi.mocked(docStructure.checkDocStructure).mockReturnValue({ ok: true, problems: [], notes: [] });
  });

  afterEach(() => {
    fs.rmSync(knowledgeRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  /** Writes the stage's owned artifact into the fixture's Knowledge root. */
  function writeModuleDoc(file: string, content: string): void {
    const dir = path.join(knowledgeRoot, "_docs", "module", moduleName, path.dirname(file));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(path.join(knowledgeRoot, "_docs", "module", moduleName), file), content, "utf8");
  }

  it("structural failure in design.md -> recorded failure attributed to the owning stage", async () => {
    writeModuleDoc("design.md", "# Design\n");
    vi.mocked(docStructure.checkDocStructure).mockReturnValue({
      ok: false,
      problems: ["design.md is missing ## Architecture"],
      notes: []
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-1", stage: AgentStage.SYSTEM_ANALYST, context: [] });

    expect(docStructure.checkDocStructure).toHaveBeenCalledWith(knowledgeRoot);
    expect(planGraph.checkPlanGraphs).not.toHaveBeenCalled();
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("design.md is missing ## Architecture");
    expect(result.outcome.document_gate).toBe("enabled");
  });

  it("plan.md with a cycle / unknown owner / illegal Tier -> recorded plan-graph failure, module-scoped", async () => {
    // A plan whose tasks name their DES ids keeps the traceability check quiet;
    // the plan-graph problem alone must fail the stage.
    writeModuleDoc("requirement.md", "## Core Features\n- REQ-001 does the thing\n");
    writeModuleDoc("design.md", "## Feature-by-Feature Feasibility\n| REQ-001 | DES-001 | feasible |\n");
    writeModuleDoc("plan.md", "| BE-001 | DES-001 | do the thing | high | pending |\n");
    vi.mocked(planGraph.checkPlanGraphs).mockReturnValue({
      ok: false,
      problems: ["cycle in plan.md"],
      notes: []
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-2", stage: AgentStage.PROJECT_MANAGER, context: [] });

    expect(planGraph.checkPlanGraphs).toHaveBeenCalledWith(knowledgeRoot, moduleName);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("cycle in plan.md");
  });

  it("run reported PASS but the artifact bytes are missing at the Knowledge root -> blocked (wrong root or unwritten doc, V13 TASK-018)", async () => {
    // Nothing is written: a PASS whose deliverable the verifier cannot read
    // at the Knowledge root is exactly what the gate exists to refuse.
    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-3", stage: AgentStage.BUSINESS_ANALYST, context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("required artifact is missing at the Knowledge root");
  });

  it("a document written outside the Knowledge root does not satisfy the gate (wrong root)", async () => {
    // The bytes exist — in a different root. The hook reads the Knowledge root
    // it was given, so the artifact is absent there and the stage is blocked.
    const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doc-hook-wrong-"));
    try {
      const dir = path.join(wrongRoot, "_docs", "module", moduleName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "requirement.md"), "# Requirement\n", "utf8");

      const inner = vi.fn().mockResolvedValue({ outcome: { result: "PASS" } });
      const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
      const result = await hook.executor({ taskId: "task-3b", stage: AgentStage.BUSINESS_ANALYST, context: [] });

      expect(result.outcome.result).toBe("FAIL");
      expect(result.outcome.failure_reason).toContain("required artifact is missing at the Knowledge root");
    } finally {
      fs.rmSync(wrongRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the stage's own artifact failing its schema -> blocked (V13 TASK-018)", async () => {
    writeModuleDoc("requirement.md", "# Requirement\n");
    vi.mocked(docStructure.checkOneDoc).mockReturnValue({
      ok: false,
      problems: [`${moduleName}/requirement.md: requires "hasOverview"`],
    });

    const inner = vi.fn().mockResolvedValue({ outcome: { result: "PASS" } });
    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-4", stage: AgentStage.BUSINESS_ANALYST, context: [] });

    expect(docStructure.checkOneDoc).toHaveBeenCalledWith("requirement", expect.any(String), `${moduleName}/requirement.md`);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('requires "hasOverview"');
  });

  it("designed requirement with no plan task -> traceability gap blocks the PM stage (V13 TASK-018)", async () => {
    writeModuleDoc("requirement.md", "## Core Features\n- REQ-001 does the thing\n");
    writeModuleDoc("design.md", "## Feature-by-Feature Feasibility\n| REQ-001 | DES-001 | feasible |\n");
    // plan.md exists but no task names DES-001 — the chain ends nowhere.
    writeModuleDoc("plan.md", "## Plan Summary\nWork is sequenced below.\n");

    const inner = vi.fn().mockResolvedValue({ outcome: { result: "PASS" } });
    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-5", stage: AgentStage.PROJECT_MANAGER, context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("REQ-001");
    expect(result.outcome.failure_reason).toContain("plan.md has no task for it yet");
  });

  it("a covered chain and existing artifacts pass the gate", async () => {
    writeModuleDoc("requirement.md", "## Core Features\n- REQ-001 does the thing\n");
    writeModuleDoc("design.md", "## Feature-by-Feature Feasibility\n| REQ-001 | DES-001 | feasible |\n");
    writeModuleDoc("plan.md", "| BE-001 | DES-001 | do the thing | high | pending |\n");

    const inner = vi.fn().mockResolvedValue({ outcome: { result: "PASS" } });
    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-6", stage: AgentStage.PROJECT_MANAGER, context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.document_gate).toBe("enabled");
  });

  it("checker throws -> stricter outcome with a recorded reason, never a silent pass", async () => {
    writeModuleDoc("design.md", "# Design\n");
    vi.mocked(docStructure.checkDocStructure).mockImplementation(() => {
      throw new Error("Something exploded");
    });

    const inner = vi.fn().mockResolvedValue({
      outcome: { result: "PASS" }
    });

    const hook = createDocumentVerificationHook({ inner, projectRoot: knowledgeRoot, moduleName });
    const result = await hook.executor({ taskId: "task-7", stage: AgentStage.SYSTEM_ANALYST, context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("Something exploded");
  });
});
