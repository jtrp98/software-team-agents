import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage, TaskLevel } from "../types.js";
import { defaultProjectRoot, loadAgentContract } from "../agents/agentContract.js";
import { classifyTask, testPlannerDecision, type ClassificationInput } from "../classification/taskClassifier.js";
import { contentHash } from "../artifacts/executionPacket.js";
import { STAGE_EVIDENCE_REQUIREMENTS } from "../orchestrator/transitionGuard.js";
import { catalogWorkflows, checkWorkflowFiles, renderWorkflowYaml, workflowPath, workflowsDir } from "./workflowCatalog.js";

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
  when?:
    | "touchesBackend"
    | "touchesFrontend"
    | "touchesSensitiveArea"
    | "touchesSensitiveAreaOrSchema"
    | "always_sensitive"
    | "test_strategy_required";
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
    // Compatibility adapter for pre-V8 generated workflows: an old
    // unconditional test-planner row is interpreted through the new policy,
    // never as authority to restore mandatory calls.
    if (step.agent === AgentStage.TEST_PLANNER && !testPlannerDecision(input).required) continue;
    if (step.when === "touchesBackend" && !input.touchesBackend) continue;
    if (step.when === "touchesFrontend" && !input.touchesFrontend) continue;
    if (step.when === "touchesSensitiveArea" && !input.touchesSensitiveArea) continue;
    if (step.when === "touchesSensitiveAreaOrSchema" && !input.touchesSensitiveArea && !input.touchesSchema) continue;
    if (step.when === "test_strategy_required" && !testPlannerDecision(input).required) continue;
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

/**
 * One task's compiled, versioned pipeline (V13 TASK-004) — the declarative
 * `workflows/<id>.yml` twin of what `classifyTask()` computes directly,
 * cross-checked against it rather than trusted blindly.
 */
export interface CompiledWorkflowPlan {
  workflowId: string;
  /** Absolute path to the `workflows/<id>.yml` this plan was compiled from. */
  workflowSource: string;
  /** sha256 of the workflow's canonical rendered YAML bytes (same convention as `plan_hash`/`artifact_hashes`). */
  workflowDigest: string;
  pipeline: AgentStage[];
  level: TaskLevel;
  requiresHumanApproval: boolean;
}

export class WorkflowPlanMismatchError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly fromWorkflow: AgentStage[],
    public readonly fromClassifier: AgentStage[],
  ) {
    super(
      `compiled workflow plan for "${workflowId}" disagrees with classifyTask() —\n` +
        `  from workflows/${workflowId}.yml: ${fromWorkflow.join(" -> ") || "(empty)"}\n` +
        `  from classifyTask() directly:   ${fromClassifier.join(" -> ") || "(empty)"}\n` +
        "this must never silently diverge; fix the workflow catalog derivation (workflowCatalog.ts) or the classifier",
    );
    this.name = "WorkflowPlanMismatchError";
  }
}

/**
 * Compiles one task's pipeline from the persisted, versioned
 * `workflows/<id>.yml` — reading from disk rather than the in-memory catalog,
 * since the persisted file is the thing being compiled (`loadAllWorkflows`,
 * not `catalogWorkflows()`; the same default `resolveWorkflowId` already
 * used elsewhere before this task).
 *
 * Fails closed: `classifyTask(input).pipeline` is recomputed directly and
 * compared against the declarative reconstruction. Any discrepancy is a bug
 * in the derivation, never a difference to silently prefer one side of.
 */
export function compileWorkflowPlan(
  input: ClassificationInput,
  projectRoot: string = defaultProjectRoot(),
): CompiledWorkflowPlan {
  const workflows = loadAllWorkflows(projectRoot);
  const workflowId = resolveWorkflowId(input, workflows);
  const workflow = workflows[workflowId];
  if (!workflow) throw new WorkflowError(workflowId, [`resolveWorkflowId selected "${workflowId}", which is not among the loaded workflows`]);

  const pipeline = pipelineFromWorkflow(workflow, input);
  const fromClassifier = classifyTask(input).pipeline;
  if (JSON.stringify(pipeline) !== JSON.stringify(fromClassifier)) {
    throw new WorkflowPlanMismatchError(workflowId, pipeline, fromClassifier);
  }

  return {
    workflowId,
    workflowSource: path.resolve(workflowPath(workflowId, projectRoot)),
    workflowDigest: contentHash(renderWorkflowYaml(workflow)),
    pipeline,
    level: workflow.level,
    requiresHumanApproval: workflow.requires_human_approval,
  };
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

/**
 * Representative input matrix a compiled plan can realistically produce: the
 * same shapes {@link deriveSignalWorkflow} (workflowCatalog.ts) probes,
 * plus `touchesSchema` — the axis this task's Part A fix depends on — so a
 * stage this task's compiler can select is exactly what this checker
 * exercises, not a hand-picked subset of it.
 */
const REPRESENTATIVE_PLAN_PROBES: readonly ClassificationInput[] = [
  {},
  { touchesBackend: true },
  { touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true, touchesSensitiveArea: true },
  { touchesBackend: true, touchesFrontend: true, touchesSchema: true },
  { touchesBackend: true, touchesFrontend: true, testStrategyTriggers: ["cross-task"] },
];

export interface WorkflowRoleCoverageResult {
  ok: boolean;
  problems: string[];
}

/**
 * `--check-workflow-roles` (V13 TASK-004 Part C): every non-HUMAN stage a
 * compiled plan can select, across every workflow and the representative
 * input matrix above, must have a loadable `contracts/<stage>.yaml`
 * ("missing role") and an entry in `STAGE_EVIDENCE_REQUIREMENTS`
 * ("missing evidence rule"). Both are closed `Record<AgentStage, …>` maps
 * today, so this mainly guards against the real, checkable drift: a stage's
 * contract file going missing or unreadable on disk.
 *
 * Plan-graph invariants (cycles, unknown owners, missing role/evidence for a
 * `PlanTask`) are `planCompilation.ts`'s job already — this checker is the
 * workflow-catalog half only, and does not duplicate that one.
 */
export function checkWorkflowRoleCoverage(projectRoot: string = defaultProjectRoot()): WorkflowRoleCoverageResult {
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

  const stagesSeen = new Map<AgentStage, string>(); // stage -> one workflow id that selected it, for the message
  for (const workflow of Object.values(workflows)) {
    for (const probe of REPRESENTATIVE_PLAN_PROBES) {
      const input: ClassificationInput =
        workflow.trigger.kind === "signal" && workflow.trigger.signal !== "none"
          ? { ...probe, [workflow.trigger.signal]: true }
          : probe;
      for (const stage of pipelineFromWorkflow(workflow, input)) {
        if (stage === AgentStage.HUMAN) continue;
        if (!stagesSeen.has(stage)) stagesSeen.set(stage, workflow.workflow);
      }
    }
  }

  for (const [stage, exampleWorkflow] of stagesSeen) {
    try {
      loadAgentContract(stage, projectRoot);
    } catch (e) {
      problems.push(
        `${stage} (selected by workflows/${exampleWorkflow}.yml): missing role — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const requirements = STAGE_EVIDENCE_REQUIREMENTS[stage];
    if (!requirements || requirements.length === 0) {
      problems.push(
        `${stage} (selected by workflows/${exampleWorkflow}.yml): missing evidence rule — ` +
          "STAGE_EVIDENCE_REQUIREMENTS (orchestrator/transitionGuard.ts) has no completion requirement for it",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
