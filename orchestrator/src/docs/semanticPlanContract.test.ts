import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLAN_TASK_FIELD_CONSUMERS,
  PlanTaskSchema,
  parseCanonicalPlan,
  renderCanonicalTasks,
} from "./planTask.js";
import { buildRuntimeTask } from "../orchestrator/runtimeTask.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { AgentStage } from "../types.js";
import { contentHash } from "../artifacts/executionPacket.js";

const read = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const plan = read("semantic-plan-cases.md");
const refs = { requirementMd: read("semantic-requirement.md"), designMd: read("semantic-design.md") };

describe("T-V8-008 executable semantic PM contract", () => {
  it("parses independently bounded feature, bug, schema and refactor tasks", () => {
    const parsed = parseCanonicalPlan(plan, refs);
    expect(parsed.problems).toEqual([]);
    expect(parsed.tasks.map(task => task.id)).toEqual([
      "BE-FEATURE-001", "BE-BUG-001", "BE-SCHEMA-001", "BE-REFACTOR-001",
    ]);
    expect(new Set(parsed.tasks.map(task => task.acceptanceCriteria)).size).toBe(4);
    expect(new Set(parsed.tasks.flatMap(task => task.traceability.filter(id => id.startsWith("AC-")))).size).toBe(4);
    for (const task of parsed.tasks) {
      expect(task.objective).not.toBe(task.why);
      expect(task.retrievalHints).toMatch(/Hypothesis:/);
      expect(task.retrievalHints).toMatch(/Query:/);
      expect(task.retrievalHints).toMatch(/Provenance:/);
      for (const ac of task.traceability.filter(id => id.startsWith("AC-"))) {
        expect(task.acceptanceCriteria).toContain(ac);
        expect(task.validationAndEvidence).toContain(ac);
      }
    }
  });

  it("names at least one downstream consumer for every canonical field", () => {
    expect(Object.keys(PLAN_TASK_FIELD_CONSUMERS).sort()).toEqual(Object.keys(PlanTaskSchema.shape).sort());
    for (const consumers of Object.values(PLAN_TASK_FIELD_CONSUMERS)) expect(consumers.length).toBeGreaterThan(0);
  });

  it("compiles PM-authored semantics directly into a v2 packet without task reconstruction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-pm-"));
    const moduleDir = path.join(root, "_docs", "module", "orders");
    const targetRoot = path.join(root, "target");
    const source = "export const exportOrders = 'current';\n";
    fs.mkdirSync(path.join(targetRoot, "src"), { recursive: true });
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(targetRoot, "src", "orders.ts"), source);
    const currentDesign = refs.designMd
      .replaceAll(/path=(?:src\/orders\.ts|prisma\/schema\.prisma)/g, "path=src/orders.ts")
      .replaceAll(/symbol=[^ |]+/g, "symbol=exportOrders")
      .replaceAll("a".repeat(64), contentHash(source));
    fs.writeFileSync(path.join(moduleDir, "requirement.md"), refs.requirementMd);
    fs.writeFileSync(path.join(moduleDir, "design.md"), currentDesign);
    fs.writeFileSync(path.join(moduleDir, "plan.md"), plan);
    const task = buildRuntimeTask({
      taskId: "BE-FEATURE-001", workflow: "feature", projectRoot: defaultProjectRoot(), docsRoot: root,
      moduleName: "orders", classification: classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
      targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "fixture", path: targetRoot }],
    })!;
    expect(task.pm_mode).toBe("full");
    expect(task.contract.objective).toContain("selected order export");
    const allow = task.scope.work_roots[0].allow.map(entry => entry.contract_glob);
    const packet = compileExecutionPacket({
      req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] },
      role: AgentStage.BACKEND_ENGINEER, runtimeTask: task, contractScope: { allow, deny: [] },
      baseRevision: "a".repeat(40),
    });
    expect(packet.contract).toEqual(task.contract);
    expect(packet.design_evidence!.map(ref => ref.claim)).toEqual(["DES-101", "Contract:OrderExport.v1", "DEC-101"]);
  });

  it("rejects copied unrelated acceptance and validation criteria", () => {
    const task = parseCanonicalPlan(plan, refs).tasks[0];
    const copied = renderCanonicalTasks([{ ...task, acceptanceCriteria: `${task.acceptanceCriteria}\nAC-999.1: unrelated`, validationAndEvidence: `${task.validationAndEvidence}\nVerify AC-999.1.` }]);
    expect(parseCanonicalPlan(copied, refs).problems.join("\n")).toContain("unrelated acceptance ID AC-999.1");
  });

  it("rejects a semantic field copied verbatim from another authored authority", () => {
    const task = parseCanonicalPlan(plan, refs).tasks[0];
    const copied = renderCanonicalTasks([{ ...task, acceptanceCriteria: "AC-101.1: Exported orders contain the selected fields." }]);
    expect(parseCanonicalPlan(copied, refs).problems.join("\n")).toContain("repeats normative prose from requirement.md/design.md");
  });

  it("rejects retrieval claims without hypothesis/query/provenance and mismatched high-risk gates", () => {
    const task = parseCanonicalPlan(plan, refs).tasks[0];
    const unsupported = renderCanonicalTasks([{ ...task, retrievalHints: "Modify src/orders.ts." }]);
    expect(parseCanonicalPlan(unsupported, refs).problems.join("\n")).toContain("Hypothesis, Query and Provenance");

    const schema = parseCanonicalPlan(plan, refs).tasks.find(task => task.id === "BE-SCHEMA-001")!;
    const ungated = renderCanonicalTasks([{ ...schema, humanGate: [] }]);
    expect(parseCanonicalPlan(ungated, refs).problems.join("\n")).toContain("requires human gate schema");
  });

  it("keeps blind-review samples aligned with the frozen T-V8-001 planning rubric without fabricated scores", () => {
    const samples = JSON.parse(read("semantic-plan-rubric-samples.json")) as Array<Record<string, unknown>>;
    const dimensions = ["requirementCoverage", "architectureValidity", "taskExecutability", "promptSpecificity", "riskHandling"];
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample).not.toHaveProperty("arm");
      expect(sample).not.toHaveProperty("score");
      expect(sample.status).toBe("unscored-human-review-required");
      expect(Object.keys(sample.dimensions as object)).toEqual(dimensions);
      for (const locator of Object.values(sample.dimensions as Record<string, string>)) expect(locator).toMatch(/^semantic-plan-cases\.md#/);
    }
  });
});

describe("T-V8-007/008 role prompt and contract adoption", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const repo = (name: string) => fs.readFileSync(path.join(root, ...name.split("/")), "utf8");

  it("makes SA evidence addressable and confirmation risk-triggered", () => {
    const prompt = repo(".claude/agents/system-analyst.md");
    const contract = repo("contracts/system-analyst.yaml");
    expect(prompt).toContain("Design evidence format: 1");
    expect(prompt).toContain("Graph/LSP output is discovery evidence");
    expect(prompt).toContain("Human confirmation is a hard gate only for schema change");
    expect(prompt).not.toContain("Confirm the Data Model and every contract section");
    expect(contract).toContain("risk_triggered_design_confirmation");
    expect(contract).toContain("addressable_design_evidence");
    expect(contract).not.toContain("human_confirmation_required");
  });

  it("requires complete canonical PM tasks and permits only provenance-bearing retrieval hypotheses", () => {
    const prompt = repo(".claude/agents/project-manager.md");
    const contract = repo("contracts/project-manager.yaml");
    expect(prompt).toContain("Author only canonical `PlanTask format: 1`");
    expect(prompt).toContain("`Hypothesis`, `Query`, `Provenance`");
    expect(prompt).toContain("Tier is optional and belongs to the individual");
    expect(prompt).not.toContain("Never infer source files or impact analysis");
    expect(contract).toContain("canonical_semantic_tasks");
  });
});
