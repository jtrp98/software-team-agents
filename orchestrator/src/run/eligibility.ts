import * as path from "node:path";
import type { ClassificationInput } from "../classification/taskClassifier.js";
import { deriveWaves, type WorkPlanTask } from "../docs/planGraph.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import { ApprovalType, type ApprovalRecord } from "../gates/approval.js";
import type { DeterministicCheckId } from "../qa/deterministic.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { requiredCapabilitiesFor } from "../runtime/runtimeRouting.js";
import { RUNTIME_SUPPORT, type RuntimeId } from "../runtime/runtimeSupport.js";
import { AgentStage } from "../types.js";
import type { BusinessInputEvidence } from "../gates/businessInput.js";

export type EligibilityClause = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";

export interface AutoEligibilityClassification extends Pick<
  ClassificationInput,
  "touchesSchema" | "isProductionDeployOrMigration" | "touchesSensitiveArea"
> {
  pipeline: readonly AgentStage[];
  /** Persisted ClassificationResult guards; registration never has to reconstruct intake flags. */
  requiresHumanApproval?: boolean;
  sensitiveGate?: boolean;
  level?: string;
}

/** PM-owned plan facts. No environment observation belongs in this shape. */
export interface StaticEligibilityIntent {
  task: Pick<WorkPlanTask, "id" | "owner" | "status" | "dependsOn">;
  planTasks: readonly WorkPlanTask[];
}

/** Orchestrator-owned observations, resolved anew for this invocation. */
export interface LiveEligibilityContext {
  classification: AutoEligibilityClassification | null;
  /** Trusted persisted intake for deciding whether a BA stage still needs interaction. */
  businessInput: BusinessInputEvidence | null;
  checkpointedTaskIds: ReadonlySet<string>;
  approvals: readonly Pick<ApprovalRecord, "type" | "required" | "status">[] | null;
  runtimeId: string | null;
  runtimeCapabilities: ReadonlySet<RuntimeCapability> | null;
  writableTargetRoots: readonly string[] | null;
  executableVerificationChecks: readonly DeterministicCheckId[] | null;
  repositoryState: "clean-ordinary" | "not-clean-ordinary" | null;
}

export interface EligibilityFailure {
  clause: EligibilityClause;
  reason: string;
}

export interface AutoEligibilityDecision {
  eligible: boolean;
  action: "RUN" | "HALT";
  failures: EligibilityFailure[];
}

const ELIGIBLE_OWNERS = new Set<string>([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);

function fail(failures: EligibilityFailure[], clause: EligibilityClause, reason: string): void {
  failures.push({ clause, reason: `Clause ${clause}: ${reason}` });
}

function runtimeSupport(runtimeId: string): { level: string } | null {
  return Object.prototype.hasOwnProperty.call(RUNTIME_SUPPORT, runtimeId)
    ? RUNTIME_SUPPORT[runtimeId as RuntimeId]
    : null;
}

/** Uses graph-derived layering only; an authored Wave cell is never read as authority. */
export function tasksInDerivedWave<T extends WorkPlanTask>(tasks: readonly T[], wave: number): T[] {
  const derived = deriveWaves([...tasks]);
  return tasks.filter((task) => derived.get(task.id) === wave);
}

export function evaluateAutoEligibility(
  intent: StaticEligibilityIntent,
  live: LiveEligibilityContext,
): AutoEligibilityDecision {
  const failures: EligibilityFailure[] = [];
  const { task } = intent;

  if (!ELIGIBLE_OWNERS.has(task.owner)) {
    fail(failures, "A", `owner "${task.owner || "unknown"}" is outside the Target-writing implementation scope`);
  }

  if (task.status !== "pending") {
    fail(failures, "B", `task status is "${task.status}", expected "pending"`);
  }

  try {
    const graph = taskGraphFromPlan(intent.planTasks);
    const blocked = intent.planTasks.filter(t => t.status === "blocked").map(t => t.id);
    const unsatisfied = graph.waitingOn(task.id, live.checkpointedTaskIds, blocked);
    if (unsatisfied.length > 0) fail(failures, "C", `dependencies lack ledger/checkpoint evidence: ${unsatisfied.join(", ")}`);
  } catch (error) { fail(failures, "C", `invalid plan graph: ${String(error)}`); }

  if (!live.classification) {
    fail(failures, "D", "classification could not be loaded");
  } else {
    const sensitiveSignals = [
      ["touchesSchema", live.classification.touchesSchema],
      ["isProductionDeployOrMigration", live.classification.isProductionDeployOrMigration],
      ["touchesSensitiveArea", live.classification.touchesSensitiveArea],
      ["requiresHumanApproval", live.classification.requiresHumanApproval],
      ["sensitiveGate", live.classification.sensitiveGate],
      ["level=LARGE_CRITICAL", live.classification.level === "LARGE_CRITICAL"],
    ].filter(([, enabled]) => enabled === true).map(([name]) => name);
    if (sensitiveSignals.length > 0) {
      fail(failures, "D", `classification sets ${sensitiveSignals.join(", ")}`);
    }
  }

  if (live.approvals === null) {
    fail(failures, "E", "approval ledger could not be loaded");
  } else {
    const knownApprovalTypes = new Set<string>(Object.values(ApprovalType));
    const unanswered = live.approvals.filter((approval) =>
      !knownApprovalTypes.has(approval.type) || (approval.required && approval.status !== "approved"),
    );
    if (unanswered.length > 0) {
      fail(
        failures,
        "E",
        `unanswered or rejected approvals remain: ${unanswered.map((approval) => `${approval.type}:${approval.status}`).join(", ")}`,
      );
    }
  }

  if (!live.classification) {
    fail(failures, "F", "pipeline could not be read because classification is unavailable");
  } else {
    const interactiveStages = live.classification.pipeline.filter((stage) =>
      requiredCapabilitiesFor(stage, false, live.businessInput ?? undefined).includes(
        RuntimeCapability.INTERACTIVE_PROMPTS,
      ),
    );
    if (interactiveStages.length > 0) {
      fail(failures, "F", `pipeline requires interactive prompts in ${interactiveStages.join(", ")}`);
    }
  }

  if (!live.runtimeId) {
    fail(failures, "G", "runtime could not be resolved");
  } else {
    const support = runtimeSupport(live.runtimeId);
    if (!support) {
      fail(failures, "G", `runtime "${live.runtimeId}" has support level "unsupported"`);
    } else if (support.level !== "supported") {
      fail(failures, "G", `runtime "${live.runtimeId}" has support level "${support.level}"; "supported" is required`);
    }
    const ownerStage = task.owner as AgentStage;
    const guardRequirements = requiredCapabilitiesFor(ownerStage, true);
    if (live.runtimeCapabilities === null) {
      fail(failures, "G", "runtime guard capabilities could not be resolved");
    } else {
      const missing = guardRequirements.filter((capability) => !live.runtimeCapabilities!.has(capability));
      if (missing.length > 0) fail(failures, "G", `runtime lacks required guard capabilities: ${missing.join(", ")}`);
    }
  }

  if (live.writableTargetRoots === null) {
    fail(failures, "H", "writable Target root could not be resolved");
  } else {
    const roots = new Set(live.writableTargetRoots.map((root) => path.resolve(root)));
    if (roots.size !== 1) fail(failures, "H", `expected exactly one writable Target root, resolved ${roots.size}`);
  }

  if (live.executableVerificationChecks === null) {
    fail(failures, "I", "deterministic verification could not be resolved");
  } else if (live.executableVerificationChecks.length === 0) {
    fail(failures, "I", "deterministic gate can only return unverified because no check is executable");
  }

  if (live.repositoryState === null) {
    fail(failures, "J", "repository state could not be resolved");
  } else if (live.repositoryState !== "clean-ordinary") {
    fail(failures, "J", "repository is not clean and ordinary");
  }

  return { eligible: failures.length === 0, action: failures.length === 0 ? "RUN" : "HALT", failures };
}

export function renderAutoEligibility(decision: AutoEligibilityDecision): string[] {
  return decision.eligible
    ? ["Eligible for this bounded run invocation."]
    : ["HALT: task is not eligible for unattended execution.", ...decision.failures.map((failure) => `- ${failure.reason}`)];
}
