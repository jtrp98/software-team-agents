import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { pathRulesFor, targetPathRules } from "../agents/pathPermissions.js";
import {
  moduleDocPath,
  readModuleDoc,
} from "../agents/moduleDocs.js";
import { pmMode, ClassificationInputSchema, type ClassificationInput, type ClassificationResult } from "../classification/taskClassifier.js";
import { compileWorkflowPlan, WorkflowPlanMismatchError, type CompiledWorkflowPlan } from "../workflow/workflowDefinition.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { MAX_RETRY } from "../retry/retryPolicy.js";
import { DEFAULT_ESCALATION_POLICY, type Severity } from "../escalation/escalationPolicy.js";
import { FORBIDDEN_COMMANDS } from "../runtime/runtimeGuards.js";
import {
  FULL_RUNTIME_VERIFICATION_LEVELS,
  loadTestPyramid,
  runtimeVerificationFor,
  runtimeVerificationForClassification,
} from "../testing/testPyramid.js";
import { AgentStage, TaskLevel } from "../types.js";
import { isCanonicalPlan, parseCanonicalPlan, planTaskHash, type PlanTask } from "../docs/planTask.js";
import { selectTaskReference } from "../docs/taskReferences.js";
import { parseModuleTargets } from "../docs/moduleTargets.js";
import { designEvidenceForClaims, parseDesignEvidence, DesignEvidenceRefSchema } from "../docs/designEvidence.js";
import { TaskContractSchema, SourceHashSchema, SelectedTraceSchema, DependencySchema, VerificationSchema, Sha256Schema, contentHash, stableHash, taskContractHash } from "../artifacts/executionPacket.js";

const AvailabilitySchema = z.object({
  status: z.enum(["resolved", "unavailable"]),
  reason: z.string().nullable(),
});

const RuntimeTaskScopeRootSchema = z.object({
  stage: z.enum(AgentStage),
  target_id: z.string().min(1),
  root: z.string().min(1),
  /**
   * Absent on every task frozen before V10 TASK-010, and read as such: a task
   * keeps the scope it was compiled with rather than being widened in place by
   * a later release.
   */
  access: z.enum(["read", "write"]).optional(),
  allow: z.array(
    z.object({
      contract_glob: z.string().min(1),
      effective_glob: z.string().min(1),
    }),
  ),
});

export const RuntimeTaskScopeSchema = AvailabilitySchema.extend({ work_roots: z.array(RuntimeTaskScopeRootSchema) });
export type RuntimeTaskScope = z.infer<typeof RuntimeTaskScopeSchema>;

/**
 * One task's compiled pipeline (V13 TASK-004), persisted alongside the
 * RuntimeTask it governs: which `workflows/<id>.yml` was selected, the digest
 * of its exact bytes at compile time, the resulting pipeline, and the
 * classification input that produced it — enough for `assertRuntimeTaskFresh`
 * to recompile the same plan later and refuse a stale one, the same way
 * `plan_hash`/`artifact_hashes` refuse a stale plan.md/requirement.md.
 */
export const WorkflowPlanSchema = z.strictObject({
  workflow_id: z.string().min(1),
  workflow_source: z.string().min(1),
  workflow_digest: Sha256Schema,
  pipeline: z.array(z.enum(AgentStage)),
  classification_input: ClassificationInputSchema,
});
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;

export const PRE_PLAN_STAGES = [AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST, AgentStage.PROJECT_MANAGER] as const;
const WorkflowOriginSchema = z.strictObject({
  intake: z.string().min(1),
  accepted: z.array(z.strictObject({
    stage: z.enum(PRE_PLAN_STAGES), evidence_id: z.string().min(1), source: z.string().min(1), hash: Sha256Schema,
  })).max(3),
  absent_sources: z.array(z.string().min(1)),
});

export const RuntimeTaskV2Schema = z.strictObject({
  version: z.literal(2), task_id: z.string().min(1), workflow: z.string().min(1), pm_mode: z.enum(["lightweight", "full"]),
  contract: TaskContractSchema,
  plan_source: z.string().min(1), plan_hash: Sha256Schema,
  artifact_hashes: z.array(SourceHashSchema).min(1), selected_traces: z.array(SelectedTraceSchema),
  workflow_origin: WorkflowOriginSchema.optional(),
  /** Optional only for persisted pre-T-V8-007 rows. New builds require and populate exact evidence. */
  design_evidence: z.array(DesignEvidenceRefSchema).optional(),
  /** Optional only for rows persisted before V13 TASK-004. New builds require and populate it. */
  workflow_plan: WorkflowPlanSchema.optional(),
  dependencies: z.object({ task_ids: z.array(z.string()), outputs: z.array(DependencySchema) }),
  scope: RuntimeTaskScopeSchema,
  required_verification: VerificationSchema,
  stop_conditions: z.array(z.string().min(1)).min(1),
}).superRefine((task, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (task.contract.version === "workflow-1" && (!task.workflow_plan || !task.workflow_origin || task.workflow_origin.accepted.length >= 3)) fail("workflow preparation requires its frozen workflow and incomplete provenance chain");
  if (task.contract.version === 1 && (task.artifact_hashes.length < 2 || task.selected_traces.length === 0)) fail("planned task requires requirement/design hashes and selected traces");
  if (task.workflow_origin) {
    if (task.workflow_origin.accepted.some((entry, index) => entry.stage !== PRE_PLAN_STAGES[index])) fail("workflow predecessor order differs from BA/SA/PM");
    if (task.contract.version === 1 && (task.workflow_origin.accepted.length !== 3 || task.workflow_origin.absent_sources.length)) fail("planned workflow requires all three accepted predecessors");
  }
});
export const RuntimeTaskSchema = RuntimeTaskV2Schema;
export type RuntimeTaskV2 = z.infer<typeof RuntimeTaskV2Schema>;
export type RuntimeTask = RuntimeTaskV2;

/** One already-resolved Target root that a stage may write. */
export interface RuntimeTaskWorkRoot {
  stage: AgentStage;
  targetId: string;
  path: string;
  /**
   * Set only where a three-repo preflight resolved this root from the task's own
   * Target bindings. Left unset by the legacy and `--target-root` paths, whose
   * single-repo status is still an open human decision (V10 D3).
   */
  access?: "read" | "write";
}

/**
 * Whether this stage writes a bound Target checkout — the axis V10 TASK-010
 * scopes on. Read from the frozen task so the guard set and the packet's
 * `scope.allow` cannot reach different answers for the same attempt.
 */
export function stageWritesBoundTarget(task: RuntimeTask | null | undefined, stage: AgentStage): boolean {
  if (!task || !("version" in task) || task.version !== 2) return false;
  return task.scope.work_roots.some((root) => root.stage === stage && root.access === "write");
}

export interface RuntimeTaskBuildInput {
  taskId: string;
  workflow: string;
  classification: ClassificationResult;
  /**
   * The raw signals `classification` was computed from. Optional only for
   * legacy/programmatic callers that never had it to hand; when present,
   * `buildRuntimeTask` compiles and persists `workflow_plan` from it (V13
   * TASK-004) and uses its pipeline — rather than `classification.pipeline`
   * directly — to filter `targetWorkRoots`.
   */
  classificationInput?: ClassificationInput;
  dependsOn?: readonly string[];
  projectRoot: string;
  docsRoot?: string;
  moduleName?: string;
  /** Original Human request for workflow preparation; never substitutes for a PM-authored PlanTask. */
  taskText?: string | { why: string; goal: string };
  targetWorkRoots?: readonly RuntimeTaskWorkRoot[];
  changeAwareVerification?: boolean;
}

function requiredVerification(input: RuntimeTaskBuildInput): RuntimeTask["required_verification"] {
  try {
    const pyramid = loadTestPyramid(input.projectRoot);
    if (input.changeAwareVerification === false) {
      const selection = runtimeVerificationFor(input.workflow, pyramid);
      return {
        status: selection.source === "test-pyramid" ? "selected" : "full-order",
        levels: selection.levels,
        reason: selection.reason,
        enforcement: selection.enforcement,
      };
    }
    const selection = runtimeVerificationForClassification(input.workflow, input.classification, pyramid);
    return {
      status: selection.source === "test-pyramid" ? "selected" : "full-order",
      levels: selection.levels,
      reason: selection.reason,
      enforcement: selection.enforcement,
      task_types: selection.taskTypes,
      selection_source: selection.selectionSource,
    };
  } catch (error) {
    // Embedded/legacy callers can point projectRoot at a Target which predates
    // the Framework policy file. Preserving the historical order is safer than
    // silently selecting nothing, and records exactly why selection fell back.
    return {
      status: "full-order",
      levels: [...FULL_RUNTIME_VERIFICATION_LEVELS],
      reason: `test-pyramid policy unavailable; preserving the historical full deterministic order: ${error instanceof Error ? error.message : String(error)}`,
      enforcement: "enforce",
      task_types: [],
      selection_source: "full-order",
    };
  }
}

function severityFor(level: TaskLevel): Severity {
  switch (level) {
    case TaskLevel.TRIVIAL:
      return "low";
    case TaskLevel.SMALL:
      return "medium";
    case TaskLevel.MEDIUM:
      return "high";
    default:
      return "critical";
  }
}

function stopConditions(input: RuntimeTaskBuildInput): string[] {
  const severity = severityFor(input.classification.level);
  const escalation = DEFAULT_ESCALATION_POLICY.severity[severity];
  return [
    ...FORBIDDEN_COMMANDS.map((command) => `STOP before state-changing ${command} commands`),
    "STOP after two automatic repair rounds for ordinary work; further repair requires a human decision",
    // T-V8-015: this line used to print the *severity* ceiling under the
    // label "global", which read as one number when it was two. Now that
    // every ordinary severity is bounded at two, the mislabel would have made
    // the packet contradict the line above it. Both numbers are named, and
    // which is which is explicit.
    `Global defensive retry ceiling: ${MAX_RETRY}; the ${severity}-severity automatic ceiling is ${escalation.max_retry}, and neither authorizes additional ordinary repair`,
    ...(escalation.approval ? [`STOP for human approval when ${severity} severity escalates`] : []),
    ...(escalation.stop_pipeline ? [`STOP the pipeline immediately for ${severity} severity`] : []),
    "STOP rather than inventing any unavailable RuntimeTask field",
  ];
}

/**
 * Deterministically materializes the RuntimeTask. This module imports no
 * RuntimeAdapter and exposes no adapter/model dependency by design.
 */
export function buildRuntimeTask(input: RuntimeTaskBuildInput): RuntimeTaskV2 | null {
  const mode = pmMode(input.classification);
  if (mode === "none" || !input.moduleName) return null;
  const docsRoot = input.docsRoot ?? input.projectRoot;
  const planMd = readModuleDoc(docsRoot, input.moduleName, "plan.md");
  if (planMd === null) return buildWorkflowPreparation(input);
  if (!isCanonicalPlan(planMd)) throw new Error(`task ${input.taskId}: plan.md is not current canonical PlanTask format 1`);
  const requirementMd = readModuleDoc(docsRoot, input.moduleName, "requirement.md") ?? "";
  const designMd = readModuleDoc(docsRoot, input.moduleName, "design.md") ?? "";
  const parsed = parseCanonicalPlan(planMd, { requirementMd, designMd });
  if (parsed.problems.length) throw new Error(`task ${input.taskId}: ${parsed.problems.join("; ")}`);
  const task = parsed.tasks.find(t => t.id === input.taskId);
  if (!task) return null;
  const design = parseDesignEvidence(designMd);
  const designClaims = [...task.traceability.filter(id => /^(?:DES|DEC)-/.test(id)), ...task.produces, ...task.consumes];
  const designEvidence = designEvidenceForClaims(design, designClaims);
  const graph = taskGraphFromPlan(parsed.tasks);
  const source = (name: string) => path.resolve(moduleDocPath(docsRoot, input.moduleName!, name));
  const selected = [...new Set([...task.traceability, ...task.produces, ...task.consumes])].map(id => {
    const isDesign = /^(?:DES|DEC)-/.test(id) || id.startsWith("Contract:");
    return selectTaskReference(isDesign ? designMd : requirementMd, id, source(isDesign ? "design.md" : "requirement.md"));
  });
  // V13 TASK-004: the compiled workflow plan (when the raw classification
  // input is available) governs which stages get a work root — not the raw
  // `classification.pipeline` a second time. `compileWorkflowPlan` itself
  // asserts the two agree, so this is a safety/architecture fix, never a
  // behaviour change.
  const workflowPlan: CompiledWorkflowPlan | undefined = input.classificationInput
    ? compileWorkflowPlan(input.classificationInput, input.projectRoot)
    : undefined;
  const pipelineForScope = workflowPlan?.pipeline ?? input.classification.pipeline;
  const workRoots = (input.targetWorkRoots ?? []).filter(root => pipelineForScope.includes(root.stage));
  const verification = requiredVerification(input);
  const { status: _status, ...contract } = task;
  return RuntimeTaskV2Schema.parse({
    version: 2, task_id: task.id, workflow: input.workflow, pm_mode: mode, contract,
    plan_source: source("plan.md"), plan_hash: canonicalPlanHash(parsed.tasks), design_evidence: designEvidence,
    artifact_hashes: [
      { source: source("requirement.md"), hash: contentHash(requirementMd) },
      { source: source("design.md"), hash: contentHash(designMd) },
    ],
    ...(workflowPlan
      ? {
          workflow_plan: {
            workflow_id: workflowPlan.workflowId,
            workflow_source: workflowPlan.workflowSource,
            workflow_digest: workflowPlan.workflowDigest,
            pipeline: workflowPlan.pipeline,
            classification_input: input.classificationInput,
          },
        }
      : {}),
    selected_traces: selected,
    dependencies: { task_ids: graph.dependenciesOf(task.id), outputs: graph.dependencyOutputsOf(task.id).map(d => ({ task_id: d.taskId, produces: d.produces, edges: d.edges.map(e => e.kind) })) },
    scope: scopeFor(input, workRoots),
    required_verification: verification,
    stop_conditions: [...stopConditions(input), ...task.humanGate.map(gate => `STOP for the existing ${gate} human gate; this packet is not approval`)],
  });
}

function scopeFor(input: RuntimeTaskBuildInput, workRoots: readonly RuntimeTaskWorkRoot[]): RuntimeTaskScope {
  return { status: workRoots.length ? "resolved" : "unavailable", reason: workRoots.length ? null : "no stage work root was resolved", work_roots: workRoots.map(root => ({
      stage: root.stage, target_id: root.targetId, root: path.resolve(root.path),
      ...(root.access ? { access: root.access } : {}),
      allow: (root.access === "write" ? targetPathRules(root.stage, input.projectRoot) : pathRulesFor(root.stage, input.projectRoot, root.path))
        .write.map(glob => ({ contract_glob: glob, effective_glob: path.resolve(root.path, ...glob.split("/")) })),
    })) };
}

function preparationHash(task: Pick<RuntimeTask, "contract" | "workflow_plan" | "workflow_origin" | "artifact_hashes">): string {
  return stableHash({ contract: task.contract, workflow: task.workflow_plan, origin: task.workflow_origin, inputs: task.artifact_hashes });
}

function buildWorkflowPreparation(input: RuntimeTaskBuildInput): RuntimeTask | null {
  if (!input.classificationInput?.isNewFeatureModuleOrProject || !input.moduleName) return null;
  const workflow = compileWorkflowPlan(input.classificationInput, input.projectRoot);
  if (stableHash(workflow.pipeline.slice(0, 3)) !== stableHash(PRE_PLAN_STAGES)) throw new Error("new-feature preparation requires the canonical BA/SA/PM prefix");
  const docsRoot = input.docsRoot ?? input.projectRoot;
  const source = (name: string) => path.resolve(moduleDocPath(docsRoot, input.moduleName!, name));
  const requirement = readModuleDoc(docsRoot, input.moduleName, "requirement.md");
  if (!requirement?.trim()) throw new Error("workflow preparation requires the initial Human-authored requirement.md");
  // CLI intake deliberately uses the existing Human-authored document (option B).
  // Keep an exact source/hash pointer, never fabricate PM semantics or copy a whole document into the packet.
  const intake = (typeof input.taskText === "string" ? input.taskText.trim() : input.taskText ? `${input.taskText.why}\n${input.taskText.goal}` : "") ||
    `Human-authored input: ${source("requirement.md")} (SHA-256 ${contentHash(requirement)}).`;
  const artifact_hashes = ["requirement.md", "design.md"].filter(name => fs.existsSync(source(name))).map(name => ({ source: source(name), hash: contentHash(fs.readFileSync(source(name))) }));
  const workflow_origin = { intake, accepted: [], absent_sources: ["design.md", "plan.md"].map(source).filter(file => !fs.existsSync(file)) };
  const contract = {
    version: "workflow-1", id: input.taskId, phase: null, title: `Prepare ${input.moduleName}`, owner: AgentStage.BUSINESS_ANALYST,
    objective: intake, why: "Execute the selected workflow's requirement, design and planning stages before implementation.",
    dependsOn: [...(input.dependsOn ?? [])], traceability: [], produces: [], consumes: [], risk: ["business"], humanGate: ["business", "schema"],
    scopeAndConstraints: "Each stage may amend only the document granted by its authoritative role contract. No implementation is authorized before STA accepts the PM plan.",
    retrievalHints: `Read the Human-authored input at ${source("requirement.md")} and verified predecessor documents in this module.`,
    doNotModify: "Do not edit Product code, runtime state, approvals or another role's document.",
    acceptanceCriteria: "Persist role-owned requirement, design and canonical PM plan through STA's governed attempts, preserving Human gates.",
    validationAndEvidence: "STA verifies packet identity, document bytes, role ownership, provenance and document validation before advancing.",
    compatibility: "One canonical workflow; a preparation contract never substitutes for an implementation PlanTask.",
  };
  const workflow_plan = { workflow_id: workflow.workflowId, workflow_source: workflow.workflowSource, workflow_digest: workflow.workflowDigest, pipeline: workflow.pipeline, classification_input: input.classificationInput };
  const task = RuntimeTaskV2Schema.parse({ version: 2, task_id: input.taskId, workflow: input.workflow, pm_mode: pmMode(input.classification), contract,
    plan_source: source("plan.md"), plan_hash: "0".repeat(64), artifact_hashes, selected_traces: [], design_evidence: [], workflow_plan, workflow_origin,
    dependencies: { task_ids: [...(input.dependsOn ?? [])], outputs: [] },
    scope: scopeFor(input, (input.targetWorkRoots ?? []).filter(root => workflow.pipeline.includes(root.stage))),
    required_verification: requiredVerification(input), stop_conditions: stopConditions(input),
  });
  return { ...task, plan_hash: preparationHash(task) };
}

export function canonicalPlanHash(tasks: readonly PlanTask[]): string { return stableHash(tasks.map(planTaskHash)); }

/** Refuse stale authored inputs before allocating or sending a new packet. */
export function assertRuntimeTaskFresh(task: RuntimeTaskV2): void {
  assertTaskInputsFresh(task);
  assertWorkflowFresh(task);
}

function assertTaskInputsFresh(task: RuntimeTaskV2, permittedOutput?: string): void {
  if (task.workflow_origin?.absent_sources.some(source => source !== permittedOutput && fs.existsSync(source))) throw new Error("unexpected workflow document appeared outside an accepted role attempt");
  if (task.contract.version === "workflow-1") {
    if (task.plan_hash !== preparationHash(task)) throw new Error("workflow preparation identity drift");
    for (const artifact of task.artifact_hashes) if (artifact.source !== permittedOutput && contentHash(fs.readFileSync(artifact.source)) !== artifact.hash) throw new Error(`artifact hash drift: ${artifact.source}`);
    return;
  }
  for (const artifact of task.artifact_hashes) if (contentHash(fs.readFileSync(artifact.source)) !== artifact.hash) throw new Error(`artifact hash drift: ${artifact.source}; recompile in a new attempt`);
  const parsed = parseCanonicalPlan(fs.readFileSync(task.plan_source, "utf8"));
  if (parsed.problems.length || canonicalPlanHash(parsed.tasks) !== task.plan_hash) throw new Error(`plan hash drift: ${task.plan_source}; recompile in a new attempt`);
  const canonical = parsed.tasks.find(t => t.id === task.task_id);
  if (!canonical || planTaskHash(canonical) !== taskContractHash(task.contract)) throw new Error("task contract differs from the canonical source; recompile");
  const graph = taskGraphFromPlan(parsed.tasks);
  const outputs = graph.dependencyOutputsOf(task.task_id).map(d => ({ task_id: d.taskId, produces: d.produces, edges: d.edges.map(e => e.kind) }));
  if (stableHash(outputs) !== stableHash(task.dependencies.outputs) || stableHash(graph.dependenciesOf(task.task_id)) !== stableHash(task.dependencies.task_ids)) throw new Error("dependency graph drift; recompile");
  for (const ref of task.selected_traces) {
    const source = ref.source.slice(0, ref.source.lastIndexOf("#"));
    if (!task.artifact_hashes.some(a => a.source === source) || stableHash(selectTaskReference(fs.readFileSync(source, "utf8"), ref.id, source)) !== stableHash(ref)) throw new Error(`selected reference drift: ${ref.id}`);
  }
}

function assertWorkflowFresh(task: RuntimeTask): void {
  if (task.workflow_plan) {
    // `workflow_source` is always `<projectRoot>/workflows/<id>.yml`
    // (workflowPath's own shape) — recovering `projectRoot` from it re-verifies
    // against the same root the plan was compiled against, not a fresh guess.
    const projectRoot = path.dirname(path.dirname(task.workflow_plan.workflow_source));
    let fresh: CompiledWorkflowPlan;
    try {
      fresh = compileWorkflowPlan(task.workflow_plan.classification_input, projectRoot);
    } catch (error) {
      const detail = error instanceof WorkflowPlanMismatchError ? error.message : (error instanceof Error ? error.message : String(error));
      throw new Error(`workflow plan drift: ${detail}; recompile explicitly in a new attempt`);
    }
    if (
      fresh.workflowId !== task.workflow_plan.workflow_id ||
      fresh.workflowDigest !== task.workflow_plan.workflow_digest ||
      stableHash(fresh.pipeline) !== stableHash(task.workflow_plan.pipeline)
    ) {
      throw new Error(
        `workflow plan drift: workflows/${task.workflow_plan.workflow_id}.yml (or its selection) no longer matches the ` +
          "compiled plan this task was frozen with; recompile explicitly in a new attempt",
      );
    }
  }
}

/** Called only after STA accepts this attempt's changed, validated owned document.
 * Other inputs remain frozen; the transition is committed with its evidence. */
export function acceptWorkflowDocument(task: RuntimeTask, stage: AgentStage, output: { source: string; hash: string; evidence_id: string }, classification: ClassificationResult): RuntimeTask {
  if (task.contract.version !== "workflow-1" || !task.workflow_origin || !task.workflow_plan) return task;
  const expectedStage = PRE_PLAN_STAGES[task.workflow_origin.accepted.length];
  const expectedSource = path.resolve(path.dirname(task.plan_source), ["requirement.md", "design.md", "plan.md"][task.workflow_origin.accepted.length]);
  if (stage !== expectedStage || output.source !== expectedSource || contentHash(fs.readFileSync(expectedSource)) !== output.hash) throw new Error("workflow output differs from the assigned predecessor stage/source/hash");
  assertWorkflowFresh(task);
  assertTaskInputsFresh(task, expectedSource);
  if (stage === AgentStage.SYSTEM_ANALYST) {
    const declared = parseModuleTargets(fs.readFileSync(expectedSource, "utf8"));
    const bound = new Set(task.scope.work_roots.map(root => root.target_id));
    if (declared.problems.length || declared.duplicates.length || [...bound].some(id => !declared.ids.includes(id))) {
      throw new Error("SA design must declare the frozen Target bindings with valid ## Targets before planning or implementation");
    }
  }
  const origin = { ...task.workflow_origin, accepted: [...task.workflow_origin.accepted, { stage: expectedStage, ...output }], absent_sources: task.workflow_origin.absent_sources.filter(source => source !== expectedSource) };
  if (stage === AgentStage.PROJECT_MANAGER) {
    const compiled = buildRuntimeTask({ taskId: task.task_id, workflow: task.workflow, classification,
      classificationInput: task.workflow_plan.classification_input, projectRoot: path.dirname(path.dirname(task.workflow_plan.workflow_source)),
      docsRoot: path.resolve(path.dirname(task.plan_source), "..", "..", ".."), moduleName: path.basename(path.dirname(task.plan_source)),
      targetWorkRoots: task.scope.work_roots.map(root => ({ stage: root.stage, targetId: root.target_id, path: root.root, access: root.access })),
    });
    if (!compiled || compiled.contract.version !== 1) throw new Error("PM output must contain this task's canonical PlanTask before implementation");
    if (stableHash(compiled.dependencies.task_ids) !== stableHash(task.dependencies.task_ids)) throw new Error("PM plan changes registered dependencies; explicit task graph intake is required");
    if (stableHash(compiled.scope) !== stableHash(task.scope)) throw new Error("PM plan cannot change the frozen work roots or grants");
    return RuntimeTaskV2Schema.parse({ ...compiled, workflow_origin: origin });
  }
  const artifact_hashes = [...task.artifact_hashes.filter(entry => entry.source !== expectedSource), { source: expectedSource, hash: output.hash }].sort((a, b) => a.source.localeCompare(b.source));
  const next = { ...task, artifact_hashes, workflow_origin: origin };
  return RuntimeTaskV2Schema.parse({ ...next, plan_hash: preparationHash(next) });
}
