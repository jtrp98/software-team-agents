import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { pathRulesFor } from "../agents/pathPermissions.js";
import {
  moduleDocPath,
  readModuleDoc,
} from "../agents/moduleDocs.js";
import { pmMode, type ClassificationResult } from "../classification/taskClassifier.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
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
import { designEvidenceForClaims, parseDesignEvidence, DesignEvidenceRefSchema } from "../docs/designEvidence.js";
import { TaskContractSchema, SourceHashSchema, SelectedTraceSchema, DependencySchema, VerificationSchema, Sha256Schema, contentHash, stableHash } from "../artifacts/executionPacket.js";

const AvailabilitySchema = z.object({
  status: z.enum(["resolved", "unavailable"]),
  reason: z.string().nullable(),
});

const RuntimeTaskScopeRootSchema = z.object({
  stage: z.enum(AgentStage),
  target_id: z.string().min(1),
  root: z.string().min(1),
  allow: z.array(
    z.object({
      contract_glob: z.string().min(1),
      effective_glob: z.string().min(1),
    }),
  ),
});

/**
 * The execution-ready task produced by deterministic Lightweight PM logic.
 * It is persisted runtime state, not an authored plan and not a prompt.
 * `expected_changes` is intentionally absent: predicting files would be the
 * only field here that needs model reasoning.
 */
export const LegacyRuntimeTaskSchema = z.object({
  task_id: z.string().min(1),
  workflow: z.string().min(1),
  pm_mode: z.enum(["lightweight", "full"]),
  why: z.string().min(1),
  goal: z.string().min(1),
  source_of_truth: AvailabilitySchema.extend({ paths: z.array(z.string().min(1)) }),
  dependencies: z.object({
    task_ids: z.array(z.string().min(1)),
    plan_readiness: z.enum(["ready", "waiting", "started", "verified", "blocked", "untracked"]),
    waiting_on: z.array(z.string().min(1)),
    reason: z.string().nullable(),
  }),
  scope: AvailabilitySchema.extend({ work_roots: z.array(RuntimeTaskScopeRootSchema) }),
  do_not_touch: z.array(z.string().min(1)).min(1),
  acceptance_criteria: AvailabilitySchema.extend({ items: z.array(z.string().min(1)) }),
  required_verification: z.object({
    // `deferred` remains readable for older persisted state.
    status: z.enum(["selected", "full-order", "deferred"]),
    levels: z.array(z.string()),
    reason: z.string().min(1),
    enforcement: z.enum(["warn", "enforce"]).optional(),
    task_types: z.array(z.string()).optional(),
    selection_source: z.enum(["task-classification", "change-scope", "full-order"]).optional(),
  }),
  evidence_required: z.array(z.string().min(1)).min(1),
  stop_conditions: z.array(z.string().min(1)).min(1),
});
export type LegacyRuntimeTask = z.infer<typeof LegacyRuntimeTaskSchema>;

export const RuntimeTaskV2Schema = z.strictObject({
  version: z.literal(2), task_id: z.string().min(1), workflow: z.string().min(1), pm_mode: z.enum(["lightweight", "full"]),
  contract: TaskContractSchema,
  plan_source: z.string().min(1), plan_hash: Sha256Schema,
  artifact_hashes: z.array(SourceHashSchema).min(2), selected_traces: z.array(SelectedTraceSchema).min(1),
  /** Optional only for persisted pre-T-V8-007 rows. New builds require and populate exact evidence. */
  design_evidence: z.array(DesignEvidenceRefSchema).optional(),
  dependencies: z.object({ task_ids: z.array(z.string()), outputs: z.array(DependencySchema) }),
  scope: LegacyRuntimeTaskSchema.shape.scope,
  required_verification: VerificationSchema,
  stop_conditions: z.array(z.string().min(1)).min(1),
});
export const RuntimeTaskSchema = z.union([RuntimeTaskV2Schema, LegacyRuntimeTaskSchema]);
export type RuntimeTaskV2 = z.infer<typeof RuntimeTaskV2Schema>;
export type RuntimeTask = z.infer<typeof RuntimeTaskSchema>;

/** One already-resolved Target root that a stage may write. */
export interface RuntimeTaskWorkRoot {
  stage: AgentStage;
  targetId: string;
  path: string;
}

export interface RuntimeTaskBuildInput {
  taskId: string;
  workflow: string;
  classification: ClassificationResult;
  dependsOn?: readonly string[];
  projectRoot: string;
  docsRoot?: string;
  moduleName?: string;
  /** @deprecated Retained at the call boundary only; never used as semantic input. */
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
      enforcement: "warn",
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
    `Global defensive retry ceiling: ${escalation.max_retry} for ${severity} severity; this does not authorize additional ordinary repair`,
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
  if (planMd === null) return null;
  if (!isCanonicalPlan(planMd)) throw new Error(`task ${input.taskId}: legacy plan cannot compile a manual-grade RuntimeTask; use migrateLegacyTaskTable for complete tables or author missing fields using docs/plan-task-v1.md`);
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
  const workRoots = (input.targetWorkRoots ?? []).filter(root => input.classification.pipeline.includes(root.stage));
  const verification = requiredVerification(input);
  const { status: _status, ...contract } = task;
  return RuntimeTaskV2Schema.parse({
    version: 2, task_id: task.id, workflow: input.workflow, pm_mode: mode, contract,
    plan_source: source("plan.md"), plan_hash: canonicalPlanHash(parsed.tasks), design_evidence: designEvidence,
    artifact_hashes: [
      { source: source("requirement.md"), hash: contentHash(requirementMd) },
      { source: source("design.md"), hash: contentHash(designMd) },
    ],
    selected_traces: selected,
    dependencies: { task_ids: graph.dependenciesOf(task.id), outputs: graph.dependencyOutputsOf(task.id).map(d => ({ task_id: d.taskId, produces: d.produces, edges: d.edges.map(e => e.kind) })) },
    scope: { status: workRoots.length ? "resolved" : "unavailable", reason: workRoots.length ? null : "no stage work root was resolved", work_roots: workRoots.map(root => ({
      stage: root.stage, target_id: root.targetId, root: path.resolve(root.path),
      allow: pathRulesFor(root.stage, input.projectRoot, root.path).write.map(glob => ({ contract_glob: glob, effective_glob: path.resolve(root.path, ...glob.split("/")) })),
    })) },
    required_verification: verification,
    stop_conditions: [...stopConditions(input), ...task.humanGate.map(gate => `STOP for the existing ${gate} human gate; this packet is not approval`)],
  });
}

export function canonicalPlanHash(tasks: readonly PlanTask[]): string { return stableHash(tasks.map(planTaskHash)); }

/** Refuse stale authored inputs before allocating or sending a new packet. */
export function assertRuntimeTaskFresh(task: RuntimeTaskV2): void {
  for (const artifact of task.artifact_hashes) if (contentHash(fs.readFileSync(artifact.source)) !== artifact.hash) throw new Error(`artifact hash drift: ${artifact.source}; recompile in a new attempt`);
  const parsed = parseCanonicalPlan(fs.readFileSync(task.plan_source, "utf8"));
  if (parsed.problems.length || canonicalPlanHash(parsed.tasks) !== task.plan_hash) throw new Error(`plan hash drift: ${task.plan_source}; recompile in a new attempt`);
  const canonical = parsed.tasks.find(t => t.id === task.task_id);
  if (!canonical || planTaskHash(canonical) !== planTaskHash({ ...task.contract, status: "pending" })) throw new Error("task contract differs from the canonical source; recompile");
  const graph = taskGraphFromPlan(parsed.tasks);
  const outputs = graph.dependencyOutputsOf(task.task_id).map(d => ({ task_id: d.taskId, produces: d.produces, edges: d.edges.map(e => e.kind) }));
  if (stableHash(outputs) !== stableHash(task.dependencies.outputs) || stableHash(graph.dependenciesOf(task.task_id)) !== stableHash(task.dependencies.task_ids)) throw new Error("dependency graph drift; recompile");
  for (const ref of task.selected_traces) {
    const source = ref.source.slice(0, ref.source.lastIndexOf("#"));
    if (!task.artifact_hashes.some(a => a.source === source) || stableHash(selectTaskReference(fs.readFileSync(source, "utf8"), ref.id, source)) !== stableHash(ref)) throw new Error(`selected reference drift: ${ref.id}`);
  }
}
