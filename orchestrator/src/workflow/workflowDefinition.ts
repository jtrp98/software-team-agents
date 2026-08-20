import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage, TaskLevel } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { classifyTask, type ClassificationInput, type ClassificationResult } from "../classification/taskClassifier.js";

/**
 * Loads `workflows/<id>.yml` — which agents run, in what order, for one kind of
 * change.
 *
 * Until these files existed the answer lived only inside `taskClassifier.ts`, as
 * a chain of if-statements. That is fine for a program and bad for everything
 * else: "what happens for a hotfix" was a code change, a review, and a release,
 * rather than a file somebody could open and edit.
 *
 * The classifier is still what the orchestrator runs on, exactly as
 * `agentContract.ts` kept `AGENT_REGISTRY` authoritative for the same reason:
 * `classifyTask` is a pure function that several modules call without knowing
 * what a project root is, and making it read files at import time would push
 * that knowledge into all of them. What makes these files real rather than
 * decorative is `checkAllWorkflows()`, which fails when a file and the
 * classifier disagree — so the two cannot drift, and the file can be trusted as
 * a description of what actually happens.
 *
 * Two workflows have no classification signal at all. `refactor`, `hotfix` and
 * `security-fix` are distinguished by *intent*, not by anything observable in
 * the change — a refactor and a bug fix look identical from outside — so they
 * are named explicitly by the caller rather than inferred. Pretending otherwise
 * would mean guessing at a distinction the diff does not contain.
 */

export type WorkflowTrigger =
  | { kind: "signal"; signal: keyof ClassificationInput | "none"; priority: number }
  | { kind: "explicit" };

export interface WorkflowStep {
  agent: AgentStage;
  when?: "touchesBackend" | "touchesFrontend" | "touchesSensitiveArea" | "always_sensitive";
  note?: string;
}

export interface WorkflowDefinition {
  workflow: string;
  description: string;
  trigger: WorkflowTrigger;
  level: TaskLevel;
  requires_human_approval: boolean;
  steps: WorkflowStep[];
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "workflow.schema.json",
);

export function workflowsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "workflows");
}

export function workflowPath(id: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(workflowsDir(projectRoot), `${id}.yml`);
}

export class WorkflowError extends Error {
  constructor(
    public readonly workflow: string,
    public readonly issues: string[],
  ) {
    super(`workflow "${workflow}" is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/** Reads one workflow. Throws rather than returning a partial one — a half-read step list is a wrong pipeline. */
export function loadWorkflow(id: string, projectRoot: string = defaultProjectRoot()): WorkflowDefinition {
  const file = workflowPath(id, projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new WorkflowError(id, [`no workflow file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new WorkflowError(id, [`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new WorkflowError(id, (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`));
  }

  const workflow = parsed as WorkflowDefinition;
  if (workflow.workflow !== id) {
    throw new WorkflowError(id, [
      `declares workflow "${workflow.workflow}" but lives in ${path.basename(file)} — the filename is the identity`,
    ]);
  }
  return workflow;
}

/** Every workflow id present on disk, sorted for a stable listing. */
export function listWorkflowIds(projectRoot: string = defaultProjectRoot()): string[] {
  try {
    return fs
      .readdirSync(workflowsDir(projectRoot))
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

export function loadAllWorkflows(projectRoot: string = defaultProjectRoot()): Record<string, WorkflowDefinition> {
  const out: Record<string, WorkflowDefinition> = {};
  for (const id of listWorkflowIds(projectRoot)) out[id] = loadWorkflow(id, projectRoot);
  return out;
}

/**
 * Which workflow a set of signals selects, by the declared priority rather than
 * by the order of any if-chain. Returns "triage" when nothing matches — never a
 * default guess, because a task nobody classified is a task for a person.
 */
export function resolveWorkflowId(input: ClassificationInput, workflows: Record<string, WorkflowDefinition>): string {
  const candidates = Object.values(workflows)
    .filter((w): w is WorkflowDefinition & { trigger: Extract<WorkflowTrigger, { kind: "signal" }> } =>
      w.trigger.kind === "signal" && w.trigger.signal !== "none")
    .sort((a, b) => a.trigger.priority - b.trigger.priority);

  for (const workflow of candidates) {
    if (input[workflow.trigger.signal as keyof ClassificationInput]) return workflow.workflow;
  }
  return "triage";
}

/** The step list a workflow produces for these signals — the data-driven twin of what classifyTask computes. */
export function pipelineFromWorkflow(workflow: WorkflowDefinition, input: ClassificationInput): AgentStage[] {
  const stages: AgentStage[] = [];
  for (const step of workflow.steps) {
    if (step.when === "touchesBackend" && !input.touchesBackend) continue;
    if (step.when === "touchesFrontend" && !input.touchesFrontend) continue;
    if (step.when === "touchesSensitiveArea" && !input.touchesSensitiveArea) continue;
    // always_sensitive: included regardless of what the caller said.
    if (!stages.includes(step.agent) || step.agent !== AgentStage.SECURITY) stages.push(step.agent);
  }
  return stages;
}

export interface WorkflowCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * Every combination of engineer/sensitivity flags a signal-triggered workflow
 * can see. Small and exhaustive on purpose: the disagreements worth catching are
 * conditional steps, and four cases cover every branch these files can express.
 */
const FLAG_COMBINATIONS: ClassificationInput[] = [
  { touchesBackend: true },
  { touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true, touchesSensitiveArea: true },
];

/**
 * The check `--check-workflows` runs: every file parses, and for each one the
 * pipeline it describes is the pipeline the classifier actually produces.
 *
 * This is what stops the files becoming a stale description of a system that
 * moved on without them — the same job `--check-contracts` does for
 * `contracts/*.yaml`.
 */
export function checkAllWorkflows(projectRoot: string = defaultProjectRoot()): WorkflowCheckResult {
  const problems: string[] = [];

  let workflows: Record<string, WorkflowDefinition>;
  try {
    workflows = loadAllWorkflows(projectRoot);
  } catch (e) {
    return { ok: false, problems: [e instanceof WorkflowError ? e.message : String(e)] };
  }

  if (Object.keys(workflows).length === 0) {
    return { ok: false, problems: [`no workflow files found in ${workflowsDir(projectRoot)}`] };
  }

  const seenPriority = new Map<number, string>();
  for (const workflow of Object.values(workflows)) {
    if (workflow.trigger.kind !== "signal") continue;

    const clash = seenPriority.get(workflow.trigger.priority);
    if (clash) {
      problems.push(
        `${workflow.workflow} and ${clash} both claim priority ${workflow.trigger.priority} — ` +
          "which one wins when both signals are true would be undefined",
      );
    }
    seenPriority.set(workflow.trigger.priority, workflow.workflow);

    if (workflow.trigger.signal === "none") continue;

    for (const flags of FLAG_COMBINATIONS) {
      const input: ClassificationInput = { ...flags, [workflow.trigger.signal]: true };

      // Only compare when this workflow is the one the signals would select —
      // a lower-priority signal in the same input would legitimately win.
      if (resolveWorkflowId(input, workflows) !== workflow.workflow) continue;

      const actual: ClassificationResult = classifyTask(input);
      const declared = pipelineFromWorkflow(workflow, input);
      const flagList = Object.keys(flags).join("+") || "(none)";

      if (declared.join(" -> ") !== actual.pipeline.join(" -> ")) {
        problems.push(
          `${workflow.workflow} [${flagList}]: file says ${declared.join(" -> ") || "(empty)"}, ` +
            `classifier produces ${actual.pipeline.join(" -> ") || "(empty)"}`,
        );
      }
      if (workflow.level !== actual.level) {
        problems.push(`${workflow.workflow} [${flagList}]: file says level ${workflow.level}, classifier says ${actual.level}`);
      }
      if (workflow.requires_human_approval !== actual.requiresHumanApproval) {
        problems.push(
          `${workflow.workflow} [${flagList}]: file says requires_human_approval ` +
            `${workflow.requires_human_approval}, classifier says ${actual.requiresHumanApproval}`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

export class WorkflowMismatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`workflows/ and the classifier disagree:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowMismatchError";
  }
}

export function assertWorkflowsMatchClassifier(projectRoot: string = defaultProjectRoot()): void {
  const result = checkAllWorkflows(projectRoot);
  if (!result.ok) throw new WorkflowMismatchError(result.problems);
}
