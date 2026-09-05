import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import {
  WorkflowError,
  WorkflowMismatchError,
  assertWorkflowsMatchClassifier,
  checkAllWorkflows,
  listWorkflowIds,
  loadAllWorkflows,
  loadWorkflow,
  pipelineFromWorkflow,
  resolveWorkflowId,
  workflowPath,
  type WorkflowDefinition,
} from "./workflowDefinition.js";
import { generateWorkflowFiles } from "./workflowCatalog.js";

/** A throwaway project holding exactly what the catalog generates — the green starting point. */
function generatedFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-wf-gen-"));
  generateWorkflowFiles(root);
  return root;
}

/** Writes a throwaway project with a workflows/ folder. */
function fixtureRoot(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-wf-"));
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    // JSON is valid YAML, which is enough to build a fixture without a serializer.
    fs.writeFileSync(path.join(root, "workflows", name), JSON.stringify(body, null, 2), "utf8");
  }
  return root;
}

describe("the shipped workflows", () => {
  it("cover every kind of change the classifier can produce, plus the three chosen by intent", () => {
    const ids = listWorkflowIds();
    for (const expected of [
      "deploy",
      "schema-change",
      "feature",
      "business-rule",
      "incremental",
      "bugfix",
      "typo",
      "triage",
      "refactor",
      "hotfix",
      "security-fix",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("all load and validate against the schema", () => {
    const all = loadAllWorkflows();
    expect(Object.keys(all).sort()).toEqual(listWorkflowIds());
  });

  /** The reason these files are more than documentation: they must match what actually runs. */
  it("describe the same pipelines the classifier really produces", () => {
    const result = checkAllWorkflows();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertWorkflowsMatchClassifier()).not.toThrow();
  });

  it("keeps backend-engineer before frontend-engineer in every workflow that has both", () => {
    for (const workflow of Object.values(loadAllWorkflows())) {
      const agents = workflow.steps.map((s) => s.agent);
      const be = agents.indexOf(AgentStage.BACKEND_ENGINEER);
      const fe = agents.indexOf(AgentStage.FRONTEND_ENGINEER);
      if (be !== -1 && fe !== -1) expect(be, workflow.workflow).toBeLessThan(fe);
    }
  });

  /** A hotfix is the case where skipping verification is most tempting and most expensive. */
  it("does not let the hotfix path skip qa-engineer", () => {
    const hotfix = loadWorkflow("hotfix");
    expect(hotfix.steps.map((s) => s.agent)).toContain(AgentStage.QA_ENGINEER);
  });

  it("gives a schema change a security pass whether or not the caller flagged one", () => {
    const security = loadWorkflow("schema-change").steps.find((s) => s.agent === AgentStage.SECURITY);
    expect(security?.when).toBe("always_sensitive");
  });

  it("never lets the unmatched case pick a level", () => {
    const triage = loadWorkflow("triage");
    expect(triage.level).toBe(TaskLevel.UNKNOWN);
    expect(triage.steps.map((s) => s.agent)).toEqual([AgentStage.HUMAN]);
  });

  it("marks the three intent-based workflows as explicit, since no signal can infer them", () => {
    for (const id of ["refactor", "hotfix", "security-fix"]) {
      expect(loadWorkflow(id).trigger.kind, id).toBe("explicit");
    }
  });
});

describe("resolveWorkflowId", () => {
  const workflows = loadAllWorkflows();

  it("picks the workflow whose signal is set", () => {
    expect(resolveWorkflowId({ isClearBugFix: true }, workflows)).toBe("bugfix");
    expect(resolveWorkflowId({ isNewFeatureModuleOrProject: true }, workflows)).toBe("feature");
    expect(resolveWorkflowId({ isTypoOrCopyOnly: true }, workflows)).toBe("typo");
  });

  /** Precedence is data, not the order of if-statements — a deploy outranks everything. */
  it("resolves competing signals by declared priority", () => {
    expect(
      resolveWorkflowId({ isProductionDeployOrMigration: true, isClearBugFix: true, touchesSchema: true }, workflows),
    ).toBe("deploy");
    expect(resolveWorkflowId({ touchesSchema: true, isClearBugFix: true }, workflows)).toBe("schema-change");
  });

  it("falls back to triage rather than guessing a level", () => {
    expect(resolveWorkflowId({}, workflows)).toBe("triage");
    expect(resolveWorkflowId({ touchesBackend: true }, workflows)).toBe("triage");
  });

  it("agrees with the classifier's own level for the workflow it picks", () => {
    for (const input of [{ isClearBugFix: true }, { touchesSchema: true }, { isNewFeatureModuleOrProject: true }]) {
      const full = { ...input, touchesBackend: true };
      expect(workflows[resolveWorkflowId(full, workflows)].level).toBe(classifyTask(full).level);
    }
  });
});

describe("pipelineFromWorkflow", () => {
  it("includes only the engineer steps the signals asked for", () => {
    const bugfix = loadWorkflow("bugfix");
    expect(pipelineFromWorkflow(bugfix, { touchesBackend: true })).toEqual([
      AgentStage.BACKEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
    expect(pipelineFromWorkflow(bugfix, { touchesFrontend: true })).toEqual([
      // No uxui-designer: a bug fix has no design phase.
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
    ]);
  });

  it("appends security only when the change is flagged sensitive", () => {
    const bugfix = loadWorkflow("bugfix");
    expect(pipelineFromWorkflow(bugfix, { touchesBackend: true })).not.toContain(AgentStage.SECURITY);
    expect(pipelineFromWorkflow(bugfix, { touchesBackend: true, touchesSensitiveArea: true })).toContain(
      AgentStage.SECURITY,
    );
  });

  it("includes an always_sensitive step regardless of the caller's flag", () => {
    expect(pipelineFromWorkflow(loadWorkflow("schema-change"), { touchesBackend: true })).toContain(
      AgentStage.SECURITY,
    );
  });
});

describe("loadWorkflow", () => {
  const valid: WorkflowDefinition = {
    workflow: "sample",
    description: "a sample",
    trigger: { kind: "explicit" },
    level: TaskLevel.SMALL,
    requires_human_approval: false,
    steps: [{ agent: AgentStage.QA_ENGINEER }],
  };

  it("reads a valid file", () => {
    const root = fixtureRoot({ "sample.yml": valid });
    expect(loadWorkflow("sample", root).workflow).toBe("sample");
    expect(workflowPath("sample", root)).toContain("sample.yml");
  });

  it("fails when the file does not exist", () => {
    expect(() => loadWorkflow("ghost", fixtureRoot({}))).toThrow(WorkflowError);
  });

  it("rejects a file whose declared id disagrees with its filename", () => {
    const root = fixtureRoot({ "sample.yml": { ...valid, workflow: "other" } });
    expect(() => loadWorkflow("sample", root)).toThrow(/the filename is the identity/);
  });

  it("rejects an unknown key, so a typo'd field is never silently ignored", () => {
    const root = fixtureRoot({ "sample.yml": { ...valid, stpes: [] } });
    expect(() => loadWorkflow("sample", root)).toThrow(WorkflowError);
  });

  it("rejects a signal trigger that does not say which signal or at what priority", () => {
    const root = fixtureRoot({ "sample.yml": { ...valid, trigger: { kind: "signal" } } });
    expect(() => loadWorkflow("sample", root)).toThrow(WorkflowError);
  });

  it("rejects an agent this pipeline does not have", () => {
    const root = fixtureRoot({ "sample.yml": { ...valid, steps: [{ agent: "architect" }] } });
    expect(() => loadWorkflow("sample", root)).toThrow(WorkflowError);
  });
});

describe("checkAllWorkflows", () => {
  it("reports an empty workflows folder rather than passing quietly", () => {
    const result = checkAllWorkflows(fixtureRoot({}));
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("no workflow files");
  });

  /** Two signals at the same priority makes "which wins" undefined, which is a real bug in the data. */
  it("reports two signal workflows claiming the same priority", () => {
    const base = {
      description: "x",
      level: TaskLevel.SMALL,
      requires_human_approval: false,
      steps: [{ agent: AgentStage.QA_ENGINEER }],
    };
    const root = fixtureRoot({
      "a.yml": { ...base, workflow: "a", trigger: { kind: "signal", signal: "none", priority: 5 } },
      "b.yml": { ...base, workflow: "b", trigger: { kind: "signal", signal: "none", priority: 5 } },
    });
    expect(checkAllWorkflows(root).problems.join()).toContain("priority 5");
  });

  /** The drift this exists to catch: the file says one thing, the code generates another. */
  it("reports a file whose steps no longer match what the catalog renders", () => {
    const root = generatedFixtureRoot();
    // Drop qa-engineer, which the classifier really does include.
    const file = workflowPath("bugfix", root);
    const dropped = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "  - agent: qa-engineer")
      .join("\n");
    fs.writeFileSync(file, dropped, "utf8");

    const problems = checkAllWorkflows(root).problems.join("\n");
    expect(problems).toContain("bugfix");
    expect(problems).toContain("regenerate-renderings");
  });

  it("reports a level that disagrees with the classifier", () => {
    const root = generatedFixtureRoot();
    const file = workflowPath("typo", root);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("level: TRIVIAL", "level: LARGE_CRITICAL"), "utf8");
    expect(checkAllWorkflows(root).problems.join()).toContain("workflows/typo.yml");
  });

  /**
   * The byte check sees changes the semantic comparison it replaced could not:
   * prose is exactly what those four flag probes never looked at, and prose is
   * most of what these files carry.
   */
  it("reports an edited note, which the semantic comparison could not see", () => {
    const root = generatedFixtureRoot();
    const file = workflowPath("schema-change", root);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("a schema change gets a security pass", "security is optional here"),
      "utf8",
    );
    expect(checkAllWorkflows(root).problems.join()).toContain("workflows/schema-change.yml");
  });

  it("reports an orphan workflow file the catalog does not define", () => {
    const root = generatedFixtureRoot();
    fs.writeFileSync(workflowPath("invented", root), "workflow: invented\n", "utf8");
    expect(checkAllWorkflows(root).problems.join()).toContain("orphan workflows/invented.yml");
  });

  it("throws with every problem attached, for a caller that wants to fail hard", () => {
    expect(() => assertWorkflowsMatchClassifier(fixtureRoot({}))).toThrow(WorkflowMismatchError);
  });
});
