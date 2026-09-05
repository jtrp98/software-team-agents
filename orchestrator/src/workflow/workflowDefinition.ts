import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage, TaskLevel } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { ClassificationInput } from "../classification/taskClassifier.js";
import { catalogWorkflows, checkWorkflowFiles, workflowPath, workflowsDir } from "./workflowCatalog.js";

export { workflowPath, workflowsDir };

/**
 * Loads `workflows/<id>.yml` — which agents run, in what order, for one kind of
 * change.
 *
 * These files are **generated** (ADR-007): `classification/taskClassifier.ts`
 * is the authored behaviour, `workflow/workflowCatalog.ts` is the authored
 * prose, `scripts/regenerate-renderings.mjs` writes the files, and
 * `checkAllWorkflows()` byte-checks them — the same arrangement
 * `--check-bindings` uses for `.codex/`, `.opencode/` and `.agents/skills`.
 *
 * What this module owns is *reading* one: a target project's copy is
 * validated against `schemas/workflow.schema.json` on the way in rather than
 * trusted blindly.
 *
 * `refactor`, `hotfix` and `security-fix` have no classification signal —
 * they are distinguished by *intent*, not by anything observable in the
 * change, so they are named explicitly by the caller rather than inferred.
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
 * Which workflow a set of signals selects, by the derived priority rather than
 * by the order of any if-chain. Returns "triage" when nothing matches — never a
 * default guess, because a task nobody classified is a task for a person.
 *
 * Defaults to the catalog so a caller that only wants the name of the pipeline
 * it is about to run (`sta run`'s opening line) does not need a project root.
 */
export function resolveWorkflowId(
  input: ClassificationInput,
  workflows: Record<string, WorkflowDefinition> = catalogWorkflows(),
): string {
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
 * The check `--check-workflows` runs, in two halves.
 *
 * First, deterministic: every committed `workflows/<id>.yml` is
 * byte-identical to what the catalog renders from the classifier today, with
 * no orphans — strictly stronger than the semantic comparison it replaced,
 * which only probed four flag combinations and could not see a description,
 * note or priority drift.
 *
 * Second, it re-reads the files through the Ajv schema. Byte equality already
 * implies it here, but a generated file that violates its own schema should
 * fail this check rather than the next run.
 */
export function checkAllWorkflows(projectRoot: string = defaultProjectRoot()): WorkflowCheckResult {
  const fileCheck = checkWorkflowFiles(projectRoot);
  const problems = [...fileCheck.problems];

  let workflows: Record<string, WorkflowDefinition>;
  try {
    workflows = loadAllWorkflows(projectRoot);
  } catch (e) {
    return { ok: false, problems: [...problems, e instanceof WorkflowError ? e.message : String(e)] };
  }

  if (Object.keys(workflows).length === 0) {
    return { ok: false, problems: [...problems, `no workflow files found in ${workflowsDir(projectRoot)}`] };
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
