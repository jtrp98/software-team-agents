import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { loadAgentContract } from "../agents/agentContract.js";
import {
  extractAcceptanceCriteria,
  moduleDocPath,
  readModuleDoc,
  resolveModule,
} from "../agents/moduleDocs.js";
import { UNIVERSAL_DENY } from "../agents/pathPermissions.js";
import { pmMode, type ClassificationResult } from "../classification/taskClassifier.js";
import { parsePlanTasks, readinessOf } from "../docs/planGraph.js";
import { DEFAULT_ESCALATION_POLICY, type Severity } from "../escalation/escalationPolicy.js";
import { FORBIDDEN_COMMANDS } from "../runtime/runtimeGuards.js";
import { AgentStage, TaskLevel } from "../types.js";

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
 * only REQ-PM-02 field that needs model reasoning.
 */
export const RuntimeTaskSchema = z.object({
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
    status: z.literal("deferred"),
    levels: z.array(z.string()),
    reason: z.string().min(1),
  }),
  evidence_required: z.array(z.string().min(1)).min(1),
  stop_conditions: z.array(z.string().min(1)).min(1),
});
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
  taskText?: string | { why: string; goal: string };
  targetWorkRoots?: readonly RuntimeTaskWorkRoot[];
}

const MODULE_SOURCES = [
  "requirement.md",
  "design.md",
  "plan.md",
  "test-plan.md",
  "review.md",
  "security.md",
  "deploy.md",
] as const;

function normalized(value: string): string {
  return value.replace(/\\/g, "/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function taskText(input: RuntimeTaskBuildInput): { why: string; goal: string } {
  if (typeof input.taskText === "string" && input.taskText.trim() !== "") {
    return { why: input.taskText.trim(), goal: input.taskText.trim() };
  }
  if (input.taskText && typeof input.taskText !== "string") {
    const why = input.taskText.why.trim();
    const goal = input.taskText.goal.trim();
    if (why !== "" && goal !== "") return { why, goal };
  }
  // Existing callers supplied only a task id before RuntimeTask existed. The
  // id is preserved as deterministic text instead of changing their CLI shape.
  return { why: input.taskId, goal: input.taskId };
}

function sourceOfTruth(input: RuntimeTaskBuildInput): RuntimeTask["source_of_truth"] {
  const docsRoot = input.docsRoot ?? input.projectRoot;
  const resolution = resolveModule(docsRoot, input.moduleName);
  if (resolution.status !== "one") {
    const reason =
      resolution.status === "many"
        ? `module is ambiguous (${resolution.candidates.join(", ")})`
        : input.moduleName
          ? `module "${input.moduleName}" has no requirement.md or design.md`
          : "no module document set is available";
    return { status: "unavailable", paths: [], reason };
  }
  const paths = MODULE_SOURCES.map((filename) => moduleDocPath(docsRoot, resolution.module, filename))
    .filter((file) => fs.existsSync(file))
    .map((file) => normalized(path.resolve(file)));
  return paths.length > 0
    ? { status: "resolved", paths, reason: null }
    : { status: "unavailable", paths: [], reason: `module "${resolution.module}" has no readable source documents` };
}

function dependencyFacts(input: RuntimeTaskBuildInput): RuntimeTask["dependencies"] {
  const declared = [...(input.dependsOn ?? [])];
  const docsRoot = input.docsRoot ?? input.projectRoot;
  if (!input.moduleName) {
    return {
      task_ids: unique(declared),
      plan_readiness: "untracked",
      waiting_on: [],
      reason: "no module was supplied, so plan.md readiness is unavailable",
    };
  }
  const planMd = readModuleDoc(docsRoot, input.moduleName, "plan.md");
  if (planMd === null) {
    return {
      task_ids: unique(declared),
      plan_readiness: "untracked",
      waiting_on: [],
      reason: "module has no plan.md; runtime dependencies remain authoritative",
    };
  }
  const parsed = parsePlanTasks(planMd);
  const row = parsed.tasks.find((task) => task.id === input.taskId);
  if (!row) {
    return {
      task_ids: unique(declared),
      plan_readiness: "untracked",
      waiting_on: [],
      reason: "task is not a plan.md row; runtime dependencies remain authoritative",
    };
  }
  const readiness = readinessOf(parsed.tasks);
  const waiting = readiness.waiting.find((entry) => entry.task.id === input.taskId)?.waitingOn ?? [];
  const planReadiness: RuntimeTask["dependencies"]["plan_readiness"] = readiness.ready.some((task) => task.id === input.taskId)
    ? "ready"
    : readiness.started.some((task) => task.id === input.taskId)
      ? "started"
      : readiness.done.some((task) => task.id === input.taskId)
        ? "verified"
        : readiness.stalledByBlocked.some((task) => task.id === input.taskId)
          ? "blocked"
          : "waiting";
  return {
    task_ids: unique([...declared, ...row.dependsOn]),
    plan_readiness: planReadiness,
    waiting_on: unique(waiting),
    reason: parsed.problems.length > 0 ? `plan parser reported: ${parsed.problems.join("; ")}` : null,
  };
}

function scopeFor(input: RuntimeTaskBuildInput): RuntimeTask["scope"] {
  const pipeline = new Set(input.classification.pipeline);
  const workRoots = (input.targetWorkRoots ?? []).filter((root) => pipeline.has(root.stage));
  const scoped = workRoots.map((root) => {
    const contract = loadAgentContract(root.stage, input.projectRoot);
    const absoluteRoot = normalized(path.resolve(root.path));
    return {
      stage: root.stage,
      target_id: root.targetId,
      root: absoluteRoot,
      // This is the literal intersection: no effective glob exists without
      // both a contract grant and a resolved Target work root.
      allow: contract.permissions.write.map((contractGlob) => ({
        contract_glob: contractGlob,
        effective_glob: normalized(path.resolve(root.path, ...contractGlob.split("/"))),
      })),
    };
  });
  return scoped.length > 0
    ? { status: "resolved", work_roots: scoped, reason: null }
    : {
        status: "unavailable",
        work_roots: [],
        reason: "no writable Target work root was resolved; no contract glob was promoted into effective scope",
      };
}

function doNotTouch(input: RuntimeTaskBuildInput): string[] {
  const roleDenies = input.classification.pipeline
    .filter((stage) => stage !== AgentStage.HUMAN)
    .flatMap((stage) => loadAgentContract(stage, input.projectRoot).permissions.deny);
  return unique([...UNIVERSAL_DENY, ...roleDenies]);
}

function acceptanceCriteria(input: RuntimeTaskBuildInput): RuntimeTask["acceptance_criteria"] {
  const docsRoot = input.docsRoot ?? input.projectRoot;
  if (!input.moduleName) {
    return { status: "unavailable", items: [], reason: "no module was supplied, so requirement.md is unavailable" };
  }
  const requirementMd = readModuleDoc(docsRoot, input.moduleName, "requirement.md");
  if (requirementMd === null) {
    return { status: "unavailable", items: [], reason: "module has no requirement.md" };
  }
  const items = extractAcceptanceCriteria(requirementMd);
  return items.length > 0
    ? { status: "resolved", items, reason: null }
    : {
        status: "unavailable",
        items: [],
        reason: "requirement.md contains no deterministic Acceptance Criteria section or column",
      };
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
    `STOP after ${escalation.max_retry} automatic retry round(s) for ${severity} severity`,
    ...(escalation.approval ? [`STOP for human approval when ${severity} severity escalates`] : []),
    ...(escalation.stop_pipeline ? [`STOP the pipeline immediately for ${severity} severity`] : []),
    "STOP rather than inventing any unavailable RuntimeTask field",
  ];
}

/**
 * Deterministically materializes the RuntimeTask. This module imports no
 * RuntimeAdapter and exposes no adapter/model dependency by design.
 */
export function buildRuntimeTask(input: RuntimeTaskBuildInput): RuntimeTask | null {
  const mode = pmMode(input.classification);
  if (mode === "none") return null;
  const text = taskText(input);
  return RuntimeTaskSchema.parse({
    task_id: input.taskId,
    workflow: input.workflow,
    pm_mode: mode,
    why: text.why,
    goal: text.goal,
    source_of_truth: sourceOfTruth(input),
    dependencies: dependencyFacts(input),
    scope: scopeFor(input),
    do_not_touch: doNotTouch(input),
    acceptance_criteria: acceptanceCriteria(input),
    required_verification: {
      status: "deferred",
      levels: [],
      reason: "T-V3R-050 will select test-pyramid levels; Phase 1 must not invent them",
    },
    evidence_required: ["record the result of every selected required_verification level"],
    stop_conditions: stopConditions(input),
  });
}
