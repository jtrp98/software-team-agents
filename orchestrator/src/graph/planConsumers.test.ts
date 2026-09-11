import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { taskGraphFromPlan } from "./taskGraph.js";
import { parseCanonicalPlan, renderCanonicalTasks, type PlanTask } from "../docs/planTask.js";
import { deriveWaves, readinessOf, readWorkPlan } from "../docs/planGraph.js";
import { deriveHandoff } from "../agents/moduleDocs.js";
import { productionQaInputs } from "../qa/productionQaInputs.js";
import { AgentStage, TaskState } from "../types.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { writePacketPlan } from "../runtime/packetFixture.testSupport.js";
import { defaultProjectRoot } from "../agents/agentContract.js";

const base = parseCanonicalPlan(fs.readFileSync(new URL("../docs/fixtures/canonical-plan.md", import.meta.url), "utf8")).tasks[0];
const retrieval = (...refs: string[]) => `Hypothesis: The selected graph boundary is likely relevant; confirm it against current source.\nQuery: Locate definitions and references for the selected claims.\nProvenance: ${refs.join(", ")}`;
function tasks(): PlanTask[] {
  return [base, { ...base, id: "FE-005", owner: AgentStage.FRONTEND_ENGINEER, produces: [], consumes: base.produces, retrievalHints: retrieval("DES-011", ...base.produces) },
    { ...base, id: "BE-006", phase: 2, produces: [], dependsOn: ["FE-005"], retrievalHints: retrieval("DES-011") }];
}

describe("T-V8-003 full-field graph consumers", () => {
  it("reloads the canonical plan for registry graph/readiness and refuses registered edge drift", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-registry-plan-"));
    try {
      const plan = tasks().slice(0, 2), store = new MemoryTaskStore(), registry = new TaskRegistry({ store });
      writePacketPlan(root, plan);
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      for (const task of plan) registry.create({ taskId: task.id, classification, moduleName: "packet-fixture", docsRoot: root, projectRoot: defaultProjectRoot() });
      expect(registry.graph().edges).toEqual(taskGraphFromPlan(plan).edges);
      expect(registry.waitingOn("FE-005")).toEqual(["BE-004"]);
      expect(registry.readyTasks().map(t => t.taskId)).toEqual(["BE-004"]);
      writePacketPlan(root, [plan[0], { ...plan[1], consumes: [], retrievalHints: retrieval("DES-011") }]);
      expect(() => registry.open("FE-005")).toThrow(/graph drift/);
      expect(() => registry.waitingOn("FE-005")).toThrow(/graph drift/);
      expect(() => registry.readyTasks()).toThrow(/graph drift/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves contract/phase edges, precedence, layers, descendants, outputs and input ordering", () => {
    const plan = tasks(), graph = taskGraphFromPlan(plan);
    expect(graph.edges.map(e => [e.from, e.to, e.kind])).toEqual([
      ["FE-005", "BE-006", "declared"], ["BE-004", "FE-005", "contract"], ["BE-004", "BE-006", "phase"],
    ]);
    expect(graph.nodes.get("FE-005")).toMatchObject({ agent: "frontend-engineer", phase: 1, produces: [], consumes: base.produces });
    // T-V8-029 removed `tasksInDerivedWave` with the wave runner; derived layering itself stays,
    // because it is plan-graph information a reader still wants. It selects no execution scope.
    expect([...deriveWaves(plan)]).toEqual([["BE-004", 1], ["FE-005", 2], ["BE-006", 3]]);
    expect(graph.descendantsOf("BE-004")).toEqual(["FE-005", "BE-006"]);
    expect(graph.dependencyOutputsOf("FE-005")[0]).toMatchObject({ taskId: "BE-004", produces: base.produces });
    expect(graph.waitingOn("FE-005", [])).toEqual(["BE-004"]);
    expect(graph.waitingOn("FE-005", ["BE-004"])).toEqual([]);
    expect(graph.waitingOn("BE-006", ["FE-005"])).toEqual(["FE-005", "BE-004"]);
    expect(taskGraphFromPlan(readWorkPlan(renderCanonicalTasks(plan)).tasks).edges).toEqual(graph.edges);
  });

  it("document readiness includes contract edges and blocked ancestors; runtime never trusts a verified cell", () => {
    const plan = tasks();
    expect(readinessOf(plan).ready.map(t => t.id)).toEqual(["BE-004"]);
    plan[0] = { ...plan[0], status: "blocked" };
    expect(readinessOf(plan).stalledByBlocked.map(t => t.id)).toEqual(plan.map(t => t.id));
    plan[0] = { ...plan[0], status: "verified" };
    expect(readinessOf(plan).ready.map(t => t.id)).toEqual(["FE-005"]);
    expect(taskGraphFromPlan(plan).waitingOn("FE-005", [])).toEqual(["BE-004"]);
  });

  it("parser, waves and readiness reject mixed cycles, unknown dependencies and ambiguous producers", () => {
    const badPlans = [
      [{ ...base, dependsOn: ["FE-005"] }, tasks()[1]],
      [{ ...base, dependsOn: ["BE-missing"] }],
      [base, { ...base, id: "BE-duplicate" }],
      [{ ...base, phase: 2 }, { ...tasks()[1], phase: 1 }],
    ];
    for (const plan of badPlans) {
      expect(() => taskGraphFromPlan(plan)).toThrow();
      expect(() => deriveWaves(plan)).toThrow();
      expect(() => readinessOf(plan)).toThrow();
      expect(parseCanonicalPlan(renderCanonicalTasks(plan)).tasks).toEqual([]);
    }
  });

  it("refuses ambiguous unannotated legacy ordering and preserves explicitly independent legacy tasks", () => {
    const legacy = [
      { id: "BE-1", owner: "backend-engineer", phase: 1, dependsOn: [] },
      { id: "FE-1", owner: "frontend-engineer", phase: 1, dependsOn: [] },
    ];
    expect(() => taskGraphFromPlan(legacy)).toThrow(/ambiguous legacy ordering/);
    expect(taskGraphFromPlan(legacy.map(t => ({ ...t, consumes: [] }))).parallelLayers()[0].map(t => t.id)).toEqual(["BE-1", "FE-1"]);
  });

  it("QA impact and PM handoff consume canonical contract edges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-consumers-"));
    try {
      const plan = renderCanonicalTasks(tasks());
      fs.mkdirSync(path.join(root, "_docs/module/example"), { recursive: true });
      fs.writeFileSync(path.join(root, "_docs/module/example/plan.md"), plan);
      const qa = await productionQaInputs({ docsRoot: root, moduleName: "example", taskId: base.id, roots: [] });
      expect(qa.scopeInputs()).toEqual({ affectedTaskIds: ["BE-006", "FE-005"], affectedPhases: [1, 2] });
      const handoff = deriveHandoff(AgentStage.PROJECT_MANAGER, "example", plan, plan, { taskId: base.id });
      expect(handoff.complete).toBe(true);
      expect(handoff.artifact.contract_refs.consumes).toEqual(base.produces);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("registration and open preserve resolved edges and refuse ad-hoc disguise and status-only completion", () => {
    const plan = tasks(), store = new MemoryTaskStore(), registry = new TaskRegistry({ store, planTasks: () => plan });
    const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
    expect(() => registry.create({ taskId: "FE-005", classification })).toThrow(/BE-004/);
    registry.create({ taskId: "BE-004", classification });
    registry.create({ taskId: "FE-005", classification });
    expect(store.loadTask("FE-005")!.dependsOn).toEqual(["BE-004"]);
    plan[0].status = "verified";
    expect(() => registry.open("FE-005")).toThrow(/BE-004/);
    expect(() => registry.create({ taskId: "BE-006", classification, adHoc: true })).toThrow(/known plan/);
    expect(() => registry.create({ taskId: "AD-001", classification })).toThrow(/--ad-hoc/);
    registry.create({ taskId: "AD-001", classification, adHoc: true });
    const first = store.loadTask("BE-004")!;
    store.saveTask({ ...first, machine: { ...first.machine, current: TaskState.DEPLOYED } });
    expect(() => registry.open("FE-005")).not.toThrow();
    expect(registry.graph().edges).toEqual(taskGraphFromPlan(plan).edges);
  });
});
