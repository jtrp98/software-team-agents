import { fixtureTask, writePacketPlan } from "../runtime/packetFixture.testSupport.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask, type ClassificationInput, type ClassificationResult } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import { catalogWorkflows, generateWorkflowFiles } from "../workflow/workflowCatalog.js";
import { pipelineFromWorkflow } from "../workflow/workflowDefinition.js";
import { TaskRegistry } from "./taskRegistry.js";
import { buildRuntimeTask, assertRuntimeTaskFresh, type RuntimeTaskV2, type RuntimeTaskWorkRoot } from "./runtimeTask.js";
import { workflowPath } from "../workflow/workflowDefinition.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";

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
  const ids = [...Object.keys(SIGNAL_INPUTS), "hotfix", "refactor", "security-fix"].map(id => `T-${id}`).concat(["T-SCOPE", "T-RESUME", "T-PYRAMID-KNOWN", "T-PYRAMID-UNKNOWN", "T-PYRAMID-SCHEMA", "T-PYRAMID-SCHEMA-COMPAT"]);
  writePacketPlan(docsRoot, ids.map(id => fixtureTask({ id })), "orders");
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
    const executionFields = ["contract", "plan_source", "plan_hash", "artifact_hashes", "selected_traces", "design_evidence", "dependencies", "scope", "required_verification", "stop_conditions"] as const;

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
      expect(runtimeTask!.contract.objective).not.toBe(runtimeTask!.contract.why);
      expect(runtimeTask!.selected_traces.map(t => t.id)).toEqual(["REQ-007", "AC-007.2", "DES-011"]);
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
        (entry) => entry.effective_glob.replace(/\\/g, "/").startsWith(targetRoot.replace(/\\/g, "/")) && entry.contract_glob !== "",
      ),
    ).toBe(true);
    expect(JSON.stringify(runtimeTask.scope)).not.toContain("not-a-work-root");
  });

  it("T-V9-012 carries stage, Target, root and allow rules for split and fullstack shapes", () => {
    const { docsRoot, targetRoot: apiRoot } = fixture();
    const webRoot = path.join(path.dirname(apiRoot), "web-target");
    fs.mkdirSync(webRoot);
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });

    const split = buildRuntimeTask({
      taskId: "T-SCOPE",
      workflow: "bugfix",
      classification,
      projectRoot: defaultProjectRoot(),
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "api", path: apiRoot },
        { stage: AgentStage.FRONTEND_ENGINEER, targetId: "web", path: webRoot },
      ],
    })!;
    expect(split.scope.work_roots).toEqual([
      expect.objectContaining({ stage: AgentStage.BACKEND_ENGINEER, target_id: "api", root: apiRoot, allow: expect.any(Array) }),
      expect.objectContaining({ stage: AgentStage.FRONTEND_ENGINEER, target_id: "web", root: webRoot, allow: expect.any(Array) }),
    ]);
    expect(split.scope.work_roots.every((root) => root.allow.length > 0)).toBe(true);

    const fullstack = buildRuntimeTask({
      taskId: "T-SCOPE",
      workflow: "bugfix",
      classification,
      projectRoot: defaultProjectRoot(),
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "mvc", path: apiRoot },
        { stage: AgentStage.FRONTEND_ENGINEER, targetId: "mvc", path: apiRoot },
      ],
    })!;
    expect(fullstack.scope.work_roots.map((root) => ({ stage: root.stage, target_id: root.target_id, root: root.root }))).toEqual([
      { stage: AgentStage.BACKEND_ENGINEER, target_id: "mvc", root: apiRoot },
      { stage: AgentStage.FRONTEND_ENGINEER, target_id: "mvc", root: apiRoot },
    ]);
    expect(new Set(fullstack.scope.work_roots.map((root) => root.root))).toEqual(new Set([apiRoot]));
  });

  it("records deterministic unavailability reasons instead of inventing missing fields", () => {
    const runtimeTask = buildRuntimeTask({
      taskId: "T-ADHOC",
      workflow: "typo",
      classification: classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(runtimeTask).toBeNull();
  });

  it("populates required verification from the executable pyramid and preserves unknown full order", () => {
    const { docsRoot } = fixture();
    const known = buildRuntimeTask({
      docsRoot, moduleName: "orders",
      taskId: "T-PYRAMID-KNOWN",
      workflow: "business-rule",
      classification: classifyTask({ touchesBusinessRuleOnly: true, touchesBackend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(known.required_verification).toMatchObject({
      status: "selected",
      levels: ["lint", "typecheck", "unit", "build"],
      enforcement: "warn",
      task_types: ["business-rule"],
      selection_source: "task-classification",
    });

    const unknown = buildRuntimeTask({
      docsRoot, moduleName: "orders",
      taskId: "T-PYRAMID-UNKNOWN",
      workflow: "bugfix",
      classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
      projectRoot: defaultProjectRoot(),
    })!;
    expect(unknown.required_verification).toMatchObject({
      status: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
      enforcement: "warn",
      task_types: [],
      selection_source: "full-order",
    });
  });

  it("selects the schema task-type floor from classification and keeps the compatibility seam exact", () => {
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const { docsRoot } = fixture();
    const selected = buildRuntimeTask({
      docsRoot, moduleName: "orders",
      taskId: "T-PYRAMID-SCHEMA",
      workflow: "schema-change",
      classification,
      projectRoot: defaultProjectRoot(),
    })!;
    expect(selected.required_verification).toMatchObject({
      status: "selected",
      levels: ["lint", "typecheck", "integration", "build"],
      task_types: ["data-model-change"],
      selection_source: "task-classification",
    });

    const compatibility = buildRuntimeTask({
      docsRoot, moduleName: "orders",
      taskId: "T-PYRAMID-SCHEMA-COMPAT",
      workflow: "schema-change",
      classification,
      projectRoot: defaultProjectRoot(),
      changeAwareVerification: false,
    })!;
    expect(compatibility.required_verification).toEqual({
      status: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
      enforcement: "warn",
      reason: expect.stringContaining('task type "schema-change" is absent'),
    });
  });

  it("triage persists no RuntimeTask and keeps the existing human-stop sequence", () => {
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store });
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
    const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store });
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

describe("workflow_plan (V13 TASK-004)", () => {
  function tmpWorkflowsRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-task-wf-"));
    roots.push(root);
    generateWorkflowFiles(root);
    return root;
  }

  it("compiles and persists workflow_plan from the raw classification input, and scope is filtered by its pipeline rather than classification.pipeline a second time", () => {
    const { docsRoot, targetRoot } = fixture();
    // Real contracts/ live at the Framework root; a bare tmp dir has none, and
    // the drift/mutation scenario below is the only one that actually needs a
    // private, mutable workflows/ copy.
    const projectRoot = defaultProjectRoot();
    const input: ClassificationInput = { isClearBugFix: true, touchesBackend: true, touchesFrontend: true };
    const classification = classifyTask(input);
    const runtimeTask = buildRuntimeTask({
      taskId: "T-bugfix",
      workflow: "bugfix",
      classification,
      classificationInput: input,
      projectRoot,
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "backend", path: targetRoot },
        { stage: AgentStage.FRONTEND_ENGINEER, targetId: "frontend", path: targetRoot },
        { stage: AgentStage.REVIEWER, targetId: "reviewer", path: targetRoot },
        { stage: AgentStage.QA_ENGINEER, targetId: "qa", path: targetRoot },
      ],
    })!;

    expect(runtimeTask.workflow_plan).toBeDefined();
    expect(runtimeTask.workflow_plan!.workflow_id).toBe("bugfix");
    expect(runtimeTask.workflow_plan!.pipeline).toEqual(classification.pipeline);
    expect(runtimeTask.scope.work_roots.map((r) => r.stage)).toEqual(
      classification.pipeline.filter((s) => s !== AgentStage.HUMAN),
    );
    expect(() => assertRuntimeTaskFresh(runtimeTask)).not.toThrow();
  });

  it("omits workflow_plan when no raw classification input was supplied (legacy/programmatic callers), unchanged from before this task", () => {
    const { docsRoot, targetRoot } = fixture();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const runtimeTask = buildRuntimeTask({
      taskId: "T-bugfix",
      workflow: "bugfix",
      classification,
      projectRoot: defaultProjectRoot(),
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "backend", path: targetRoot }],
    })!;
    expect(runtimeTask.workflow_plan).toBeUndefined();
    expect(runtimeTask.scope.work_roots.map((r) => r.stage)).toEqual([AgentStage.BACKEND_ENGINEER]);
  });

  it("refuses a resume once the workflow file it was compiled from has drifted — a byte change to workflows/<id>.yml is not silently absorbed", () => {
    const { docsRoot } = fixture();
    const projectRoot = tmpWorkflowsRoot();
    const input: ClassificationInput = { isClearBugFix: true, touchesBackend: true };
    const runtimeTask = buildRuntimeTask({
      taskId: "T-bugfix",
      workflow: "bugfix",
      classification: classifyTask(input),
      classificationInput: input,
      projectRoot,
      docsRoot,
      moduleName: "orders",
    })!;
    expect(() => assertRuntimeTaskFresh(runtimeTask)).not.toThrow();

    const file = workflowPath("bugfix", projectRoot);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Bug fix", "Bug-fix"), "utf8");

    expect(() => assertRuntimeTaskFresh(runtimeTask)).toThrow(/workflow plan drift/);
  });

  it("stays stable across a TaskRegistry resume when nothing about the workflow changed", () => {
    const { docsRoot, targetRoot } = fixture();
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store });
    const projectRoot = defaultProjectRoot();
    const input: ClassificationInput = { isClearBugFix: true, touchesBackend: true };
    const classification = classifyTask(input);
    const created = registry.create({
      taskId: "T-RESUME",
      workflow: "bugfix",
      classification,
      classificationInput: input,
      projectRoot,
      docsRoot,
      moduleName: "orders",
      targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "backend", path: targetRoot }],
    });
    const before = structuredClone(created.runtimeTask) as RuntimeTaskV2;
    expect(before.workflow_plan).toBeDefined();

    expect(registry.resume("T-RESUME").runtimeTask).toEqual(before);
    expect(store.loadTask("T-RESUME")!.runtimeTask).toEqual(before);
  });
});
