import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask, type ClassificationInput, type ClassificationResult } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { catalogWorkflows } from "../workflow/workflowCatalog.js";
import { pipelineFromWorkflow } from "../workflow/workflowDefinition.js";
import { TaskRegistry } from "./taskRegistry.js";
import { buildRuntimeTask, type RuntimeTaskWorkRoot } from "./runtimeTask.js";

const adapterTripwire = vi.hoisted(() => ({ constructions: 0 }));

vi.mock("../runtime/claudeCodeAdapter.js", () => ({
  ClaudeCodeAdapter: class {
    constructor() {
      adapterTripwire.constructions += 1;
      throw new Error("RuntimeTask construction must never construct an adapter");
    }
  },
}));
vi.mock("../runtime/codexAdapter.js", () => ({
  CodexAdapter: class {
    constructor() {
      adapterTripwire.constructions += 1;
      throw new Error("RuntimeTask construction must never construct an adapter");
    }
  },
}));
vi.mock("../runtime/openCodeAdapter.js", () => ({
  OpenCodeAdapter: class {
    constructor() {
      adapterTripwire.constructions += 1;
      throw new Error("RuntimeTask construction must never construct an adapter");
    }
  },
}));

const roots: string[] = [];
afterEach(() => {
  adapterTripwire.constructions = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SIGNAL_INPUTS: Record<string, ClassificationInput> = {
  typo: { isTypoOrCopyOnly: true, touchesBackend: true, touchesFrontend: true },
  bugfix: { isClearBugFix: true, touchesBackend: true, touchesFrontend: true },
  incremental: { isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true },
  "business-rule": { touchesBusinessRuleOnly: true, touchesBackend: true, touchesFrontend: true },
  feature: { isNewFeatureModuleOrProject: true, touchesBackend: true, touchesFrontend: true },
  "schema-change": { touchesSchema: true, touchesBackend: true, touchesFrontend: true },
  deploy: { isProductionDeployOrMigration: true },
};

function classificationFor(workflowId: string): ClassificationResult {
  const signal = SIGNAL_INPUTS[workflowId];
  if (signal) return classifyTask(signal);
  const workflow = catalogWorkflows()[workflowId];
  const explicitInput: ClassificationInput = {
    touchesBackend: true,
    touchesFrontend: true,
    touchesSensitiveArea: workflowId === "security-fix",
  };
  const pipeline = pipelineFromWorkflow(workflow, explicitInput);
  return {
    level: workflow.level,
    pipeline,
    requiresHumanApproval: workflow.requires_human_approval,
    sensitiveGate: pipeline.includes(AgentStage.SECURITY),
    reasons: [`explicit workflow: ${workflowId}`],
  };
}

function fixture(): { docsRoot: string; targetRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-task-"));
  roots.push(base);
  const docsRoot = path.join(base, "knowledge");
  const moduleDir = path.join(docsRoot, "_docs", "module", "orders");
  const targetRoot = path.join(base, "target");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, "requirement.md"),
    "# Orders\n\n## Overview\nOrders.\n\n## Acceptance Criteria\n\n- A user can create an order.\n- Invalid input is rejected.\n",
    "utf8",
  );
  fs.writeFileSync(path.join(moduleDir, "design.md"), "# Design\n\n## Feature-by-Feature Feasibility\nReady.\n", "utf8");
  return { docsRoot, targetRoot };
}

function workRoots(classification: ClassificationResult, targetRoot: string): RuntimeTaskWorkRoot[] {
  return classification.pipeline
    .filter((stage) => stage !== AgentStage.HUMAN)
    .map((stage) => ({ stage, targetId: "orders-target", path: targetRoot }));
}

describe("RuntimeTask deterministic execution contract (T-V3R-010)", () => {
  it("populates all ten execution fields for every workflow class with zero adapter/model construction", () => {
    const { docsRoot, targetRoot } = fixture();
    const workflowIds = [
      "typo",
      "bugfix",
      "incremental",
      "business-rule",
      "feature",
      "schema-change",
      "deploy",
      "hotfix",
      "refactor",
      "security-fix",
    ];
    const executionFields = [
      "why",
      "goal",
      "source_of_truth",
      "dependencies",
      "scope",
      "do_not_touch",
      "acceptance_criteria",
      "required_verification",
      "evidence_required",
      "stop_conditions",
    ] as const;

    const evidence = workflowIds.map((workflow) => {
      const classification = classificationFor(workflow);
      const runtimeTask = buildRuntimeTask({
        taskId: `T-${workflow}`,
        workflow,
        classification,
        projectRoot: defaultProjectRoot(),
        docsRoot,
        moduleName: "orders",
        taskText: { why: `${workflow} is required`, goal: `complete ${workflow}` },
        targetWorkRoots: workRoots(classification, targetRoot),
      });
      expect(runtimeTask).not.toBeNull();
      expect(executionFields.every((field) => runtimeTask![field] !== undefined)).toBe(true);
      expect(runtimeTask!.source_of_truth.status).toBe("resolved");
      expect(runtimeTask!.acceptance_criteria.items).toHaveLength(2);
      expect(runtimeTask!.scope.status).toBe("resolved");
      return { workflow, fields: executionFields.length, model_calls: adapterTripwire.constructions };
    });

    expect(evidence).toEqual(workflowIds.map((workflow) => ({ workflow, fields: 10, model_calls: 0 })));
    expect(adapterTripwire.constructions).toBe(0);
  });

  it("forms scope only from contract globs paired with resolved Target work roots", () => {
    const { docsRoot, targetRoot } = fixture();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
    const absentRoot = path.join(path.dirname(targetRoot), "not-a-work-root");
    const runtimeTask = buildRuntimeTask({
      taskId: "T-SCOPE",
      workflow: "bugfix",
      classification,
      projectRoot: defaultProjectRoot(),
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "backend", path: targetRoot },
        // Not in the classification pipeline; it must contribute no scope.
        { stage: AgentStage.DEVOPS, targetId: "absent", path: absentRoot },
      ],
    })!;

    expect(runtimeTask.scope.work_roots.map((root) => root.stage)).toEqual([AgentStage.BACKEND_ENGINEER]);
    expect(runtimeTask.scope.work_roots[0].allow.length).toBeGreaterThan(0);
    expect(
      runtimeTask.scope.work_roots[0].allow.every(
        (entry) => entry.effective_glob.startsWith(targetRoot.replace(/\\/g, "/")) && entry.contract_glob !== "",
      ),
    ).toBe(true);
    expect(JSON.stringify(runtimeTask.scope)).not.toContain("not-a-work-root");
  });

  it("records deterministic unavailability reasons instead of inventing missing fields", () => {
    const runtimeTask = buildRuntimeTask({
      taskId: "T-ADHOC",
      workflow: "typo",
      classification: classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(runtimeTask.source_of_truth).toMatchObject({ status: "unavailable", paths: [] });
    expect(runtimeTask.acceptance_criteria).toMatchObject({ status: "unavailable", items: [] });
    expect(runtimeTask.scope).toMatchObject({ status: "unavailable", work_roots: [] });
    expect(runtimeTask.stop_conditions.join(" ")).toMatch(/STOP rather than inventing/);
  });

  it("populates required verification from the executable pyramid and preserves unknown full order", () => {
    const known = buildRuntimeTask({
      taskId: "T-PYRAMID-KNOWN",
      workflow: "business-rule",
      classification: classifyTask({ touchesBusinessRuleOnly: true, touchesBackend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(known.required_verification).toMatchObject({
      status: "selected",
      levels: ["lint", "typecheck", "unit", "build"],
      enforcement: "warn",
    });

    const unknown = buildRuntimeTask({
      taskId: "T-PYRAMID-UNKNOWN",
      workflow: "bugfix",
      classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(unknown.required_verification).toMatchObject({
      status: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
      enforcement: "warn",
    });
  });

  it("triage persists no RuntimeTask and keeps the existing human-stop sequence", () => {
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const orchestrator = registry.create({ taskId: "T-TRIAGE", classification: classifyTask({}), workflow: "triage" });

    expect(orchestrator.runtimeTask).toBeNull();
    expect(store.loadTask("T-TRIAGE")!.runtimeTask).toBeNull();
    expect(orchestrator.machine.sequence).toEqual([TaskState.CREATED, TaskState.BLOCKED]);
    expect(orchestrator.classification.level).toBe(TaskLevel.UNKNOWN);
    expect(adapterTripwire.constructions).toBe(0);
  });

  it("survives TaskRegistry resume without being reconstructed", () => {
    const { docsRoot, targetRoot } = fixture();
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ store });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const created = registry.create({
      taskId: "T-RESUME",
      workflow: "bugfix",
      classification,
      projectRoot: defaultProjectRoot(),
      docsRoot,
      moduleName: "orders",
      taskText: "fix order validation",
      targetWorkRoots: workRoots(classification, targetRoot),
    });
    const before = structuredClone(created.runtimeTask);

    expect(registry.resume("T-RESUME").runtimeTask).toEqual(before);
    expect(store.loadTask("T-RESUME")!.runtimeTask).toEqual(before);
  });
});
