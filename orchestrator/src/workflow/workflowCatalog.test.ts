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
];

const SIGNAL_OF: Record<string, keyof ClassificationInput> = {
  deploy: "isProductionDeployOrMigration",
  feature: "isNewFeatureModuleOrProject",
  "schema-change": "touchesSchema",
  "business-rule": "touchesBusinessRuleOnly",
  incremental: "isIncrementalFeature",
  bugfix: "isClearBugFix",
  typo: "isTypoOrCopyOnly",
};

describe("the workflow catalog", () => {
  it("defines exactly the eleven workflows the pipeline has", () => {
    expect(catalogWorkflowIds()).toEqual([
      "bugfix",
      "business-rule",
      "deploy",
      "feature",
      "hotfix",
      "incremental",
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
      deploy: 0,
      feature: 1,
      "schema-change": 2,
      "business-rule": 3,
      incremental: 4,
      bugfix: 5,
      typo: 6,
      triage: 99,
    });
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
