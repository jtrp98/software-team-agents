import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { classifyTask, type ClassificationInput } from "../classification/taskClassifier.js";
import {
  catalogWorkflowIds,
  catalogWorkflows,
  checkWorkflowFiles,
  derivePriorities,
  generateWorkflowFiles,
  renderWorkflowFiles,
} from "./workflowCatalog.js";
import { loadAllWorkflows, pipelineFromWorkflow, resolveWorkflowId } from "./workflowDefinition.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-wfcat-"));
}

const PROBES: ClassificationInput[] = [
  {},
  { touchesBackend: true },
  { touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true, touchesSensitiveArea: true },
  { touchesBackend: true, touchesFrontend: true, testStrategyTriggers: ["cross-task"] },
];

const SIGNAL_OF: Record<string, keyof ClassificationInput> = {
  "plan-task": "isPlanTask",
  deploy: "isProductionDeployOrMigration",
  feature: "isNewFeatureModuleOrProject",
  "schema-change": "touchesSchema",
  "business-rule": "touchesBusinessRuleOnly",
  incremental: "isIncrementalFeature",
  bugfix: "isClearBugFix",
  typo: "isTypoOrCopyOnly",
};

describe("the workflow catalog", () => {
  it("defines exactly the twelve workflows the pipeline has", () => {
    expect(catalogWorkflowIds()).toEqual([
      "bugfix",
      "business-rule",
      "deploy",
      "feature",
      "hotfix",
      "incremental",
      "plan-task",
      "refactor",
      "schema-change",
      "security-fix",
      "triage",
      "typo",
    ]);
  });

  /**
   * The file's pipeline is not *compared to* the classifier's, it *is* the
   * classifier's. This asserts the derivation for every signal workflow
   * across every input the `when:` vocabulary can express.
   */
  it("derives each signal workflow's pipeline from the classifier itself", () => {
    const workflows = catalogWorkflows();
    for (const [id, signal] of Object.entries(SIGNAL_OF)) {
      for (const probe of PROBES) {
        const input: ClassificationInput = { ...probe, [signal]: true };
        const actual = classifyTask(input);
        expect(pipelineFromWorkflow(workflows[id], input), `${id} ${JSON.stringify(probe)}`).toEqual(actual.pipeline);
        expect(workflows[id].level, id).toBe(actual.level);
        expect(workflows[id].requires_human_approval, id).toBe(actual.requiresHumanApproval);
      }
    }
  });

  /**
   * V13 TASK-004: the pre-existing PROBES set never exercised `touchesSchema`,
   * which is how `feature`'s SECURITY step shipped covering only
   * `touchesSensitiveArea` even though `isNewFeatureModuleOrProject` also
   * forces security when the caller flags `touchesSchema` alone. Routed
   * through `resolveWorkflowId` rather than assumed per-signal, because
   * `touchesSchema` combined with a lower-priority signal (e.g.
   * `touchesBusinessRuleOnly`) legitimately reroutes to a different workflow
   * file — that reroute is correct behaviour, not something this test should
   * flag.
   */
  it("agrees with the classifier for every signal combined with touchesSchema, once routed through resolveWorkflowId", () => {
    const workflows = catalogWorkflows();
    const schemaProbes: ClassificationInput[] = [
      { touchesSchema: true },
      { touchesSchema: true, touchesBackend: true },
      { touchesSchema: true, touchesFrontend: true },
      { touchesSchema: true, touchesBackend: true, touchesFrontend: true },
      { touchesSchema: true, touchesBackend: true, touchesSensitiveArea: true },
    ];
    for (const [id, signal] of Object.entries(SIGNAL_OF)) {
      for (const probe of schemaProbes) {
        const input: ClassificationInput = { ...probe, [signal]: true };
        const selectedId = resolveWorkflowId(input, workflows);
        const actual = classifyTask(input);
        expect(
          pipelineFromWorkflow(workflows[selectedId], input),
          `${id} + ${JSON.stringify(probe)} -> ${selectedId}`,
        ).toEqual(actual.pipeline);
      }
    }
  });

  it("derives triage from the classifier's no-signal answer", () => {
    const triage = catalogWorkflows().triage;
    expect(triage.level).toBe(TaskLevel.UNKNOWN);
    expect(triage.requires_human_approval).toBe(true);
    expect(triage.steps.map((s) => s.agent)).toEqual([AgentStage.HUMAN]);
  });

  /**
   * The precedence numbers are read out of the classifier by asking which signal
   * wins when two are set, not restated as a constant somebody maintains. If the
   * if-chain is ever reordered, this test is what says so.
   */
  it("derives the signal precedence from the classifier, matching the documented order", () => {
    expect(Object.fromEntries(derivePriorities())).toEqual({
      "plan-task": 0,
      deploy: 1,
      feature: 2,
      "schema-change": 3,
      "business-rule": 4,
      incremental: 5,
      bugfix: 6,
      typo: 7,
      triage: 99,
    });
  });

  it("routes a plan task to plan-task whatever authored risk it carries (V13 TASK-007)", () => {
    const workflows = catalogWorkflows();
    for (const risk of [{}, { touchesSchema: true }, { touchesSensitiveArea: true }, { isProductionDeployOrMigration: true }]) {
      const input: ClassificationInput = { isPlanTask: true, touchesBackend: true, ...risk };
      expect(resolveWorkflowId(input), JSON.stringify(risk)).toBe("plan-task");
      expect(pipelineFromWorkflow(workflows["plan-task"], input)).toEqual(classifyTask(input).pipeline);
    }
    expect(classifyTask({ isPlanTask: true, touchesBackend: true }).pipeline).toEqual([
      AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER,
    ]);
    expect(classifyTask({ isPlanTask: true, touchesFrontend: true, touchesSchema: true }).pipeline).toEqual([
      AgentStage.FRONTEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY,
    ]);
  });

  it("routes a new feature that also touches the schema to feature, not schema-change", () => {
    expect(resolveWorkflowId({ isNewFeatureModuleOrProject: true, touchesSchema: true })).toBe("feature");
  });

  /**
   * `schema-change` and `security-fix` run security whatever the caller said.
   * `always_sensitive` is how the file says so, and it must survive derivation —
   * it is the semantic the audit specifically warned could go missing.
   */
  it("keeps the forced security pass distinguishable from a conditional one", () => {
    const workflows = catalogWorkflows();
    const forced = (id: string) => workflows[id].steps.find((s) => s.agent === AgentStage.SECURITY)?.when;
    expect(forced("schema-change")).toBe("always_sensitive");
    expect(forced("security-fix")).toBe("always_sensitive");
    expect(forced("bugfix")).toBe("touchesSensitiveArea");
    expect(forced("typo")).toBe("touchesSensitiveArea");
  });

  /** Every note the hand-written files carried, still carried. */
  it("preserves the notes and descriptions the YAML files used to hold alone", () => {
    const workflows = catalogWorkflows();
    const noteFor = (id: string, agent: AgentStage) => workflows[id].steps.find((s) => s.agent === agent)?.note;
    expect(noteFor("deploy", AgentStage.DEVOPS)).toContain("refuses to ship a phase qa-engineer has not accepted");
    expect(noteFor("hotfix", AgentStage.DEVOPS)).toContain("still gated");
    expect(noteFor("schema-change", AgentStage.SECURITY)).toContain(
      "a schema change gets a security pass whether or not the caller flagged one",
    );
    expect(noteFor("triage", AgentStage.HUMAN)).toContain("no forward path exists until a person re-classifies");
    for (const workflow of Object.values(workflows)) {
      expect(workflow.description.length, workflow.workflow).toBeGreaterThan(0);
    }
  });

  it("keeps backend-engineer before frontend-engineer wherever both run", () => {
    for (const workflow of Object.values(catalogWorkflows())) {
      const agents = workflow.steps.map((s) => s.agent);
      const be = agents.indexOf(AgentStage.BACKEND_ENGINEER);
      const fe = agents.indexOf(AgentStage.FRONTEND_ENGINEER);
      if (be !== -1 && fe !== -1) expect(be, workflow.workflow).toBeLessThan(fe);
    }
  });

  it("renders test-planner as a conditional step for every workflow that can run one", () => {
    for (const workflow of Object.values(catalogWorkflows())) {
      const step = workflow.steps.find(candidate => candidate.agent === AgentStage.TEST_PLANNER);
      // A plan task's shared test strategy was decided at plan level (V13 TASK-007): its
      // pipeline is owner, reviewer, QA and a conditional security pass — never test-planner.
      if (workflow.workflow === "triage" || workflow.workflow === "plan-task") expect(step, workflow.workflow).toBeUndefined();
      else expect(step?.when, workflow.workflow).toBe("test_strategy_required");
    }
  });
});

describe("generating and checking workflows/", () => {
  it("writes files that load and validate against the schema", () => {
    const root = tmpRoot();
    generateWorkflowFiles(root);
    const loaded = loadAllWorkflows(root);
    expect(Object.keys(loaded).sort()).toEqual(catalogWorkflowIds());
    for (const [id, workflow] of Object.entries(catalogWorkflows())) {
      expect(loaded[id]).toEqual(workflow);
    }
  });

  it("is idempotent — a second generation writes nothing", () => {
    const root = tmpRoot();
    expect(generateWorkflowFiles(root).written.length).toBe(catalogWorkflowIds().length);
    expect(generateWorkflowFiles(root)).toEqual({ written: [], removed: [] });
    expect(checkWorkflowFiles(root)).toEqual({ ok: true, problems: [] });
  });

  it("removes a workflow file the catalog no longer defines", () => {
    const root = tmpRoot();
    generateWorkflowFiles(root);
    fs.writeFileSync(path.join(root, "workflows", "invented.yml"), "workflow: invented\n", "utf8");
    expect(generateWorkflowFiles(root).removed).toEqual(["workflows/invented.yml"]);
    expect(fs.existsSync(path.join(root, "workflows", "invented.yml"))).toBe(false);
  });

  /** A CRLF checkout is already correct; rewriting it every run would leave the tree permanently dirty. */
  it("leaves a CRLF checkout alone", () => {
    const root = tmpRoot();
    generateWorkflowFiles(root);
    for (const [rel, content] of renderWorkflowFiles()) {
      fs.writeFileSync(path.join(root, ...rel.split("/")), content.replace(/\n/g, "\r\n"), "utf8");
    }
    expect(generateWorkflowFiles(root)).toEqual({ written: [], removed: [] });
    expect(checkWorkflowFiles(root).ok).toBe(true);
  });

  it("renders every file with a trailing newline and no trailing whitespace", () => {
    for (const [rel, content] of renderWorkflowFiles()) {
      expect(content.endsWith("\n"), rel).toBe(true);
      expect(/[ \t]+\n/.test(content), rel).toBe(false);
    }
  });
});
