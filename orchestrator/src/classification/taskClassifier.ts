import { AgentStage, TaskLevel } from "../types.js";

/**
 * Signals the caller (intake step, or eventually a human/LLM triage step)
 * must supply about an incoming task. Deliberately booleans, not free text —
 * classification must be deterministic, not inferred from prose here.
 */
export interface ClassificationInput {
  /** Copy/wording/style fix only — no logic change. */
  isTypoOrCopyOnly?: boolean;
  /** Bug fix where requirement and schema are already clear (no design question). */
  isClearBugFix?: boolean;
  /** Adds or alters a field/table/relation in the data model. */
  touchesSchema?: boolean;
  /** Changes a business rule/logic, with no schema impact. */
  touchesBusinessRuleOnly?: boolean;
  /** Adds a feature to an existing module where requirements are already understood
   *  well enough to skip a business-analyst interview. */
  isIncrementalFeature?: boolean;
  /** Brand-new feature, module, or project — needs a full requirements interview. */
  isNewFeatureModuleOrProject?: boolean;
  /** An actual production deploy or DB migration. */
  isProductionDeployOrMigration?: boolean;
  /** Touches auth, personal data, payments, file upload, or untrusted external input. */
  touchesSensitiveArea?: boolean;
  touchesBackend?: boolean;
  touchesFrontend?: boolean;
}

export interface ClassificationResult {
  level: TaskLevel;
  pipeline: AgentStage[];
  /** True if a human must explicitly approve before the pipeline can proceed
   *  past a specific point (schema confirmation, production deploy). */
  requiresHumanApproval: boolean;
  /** True if SECURITY must run and plan.md-equivalent gets a 🔒 flag. */
  sensitiveGate: boolean;
  /**
   * The caller's own `touchesSchema` signal, carried through so downstream
   * consumers don't have to re-derive it from pipeline shape (which stopped
   * working once a new-feature task that also touches a schema started with
   * business-analyst instead of system-analyst).
   */
  touchesSchema?: boolean;
  reasons: string[];
}

export type PmMode = "none" | "lightweight" | "full";

/**
 * The existing PM boundary, now named so it cannot be mistaken for a missing
 * planner. Classification is Lightweight PM for every executable task; the
 * Full PM agent/document path is selected exactly when the already-shipped
 * pipeline contains project-manager. UNKNOWN remains human triage and has no
 * RuntimeTask.
 */
export function pmMode(classification: ClassificationResult): PmMode {
  if (classification.level === TaskLevel.UNKNOWN) return "none";
  return classification.pipeline.includes(AgentStage.PROJECT_MANAGER) ? "full" : "lightweight";
}

/**
 * Whether this classification carries a design phase at all (T-UX11). Only
 * these pipelines run uxui-designer: the work is about to decide what gets
 * built, so a UX pass has something to shape. A copy tweak or bug fix relies
 * on the module's existing signed UX artifact instead — the lane gate checks
 * that it is current; it does not demand a fresh round every run.
 */
function includesDesignPhase(input: ClassificationInput): boolean {
  return Boolean(
    input.isNewFeatureModuleOrProject ||
      input.touchesSchema ||
      input.touchesBusinessRuleOnly ||
      input.isIncrementalFeature,
  );
}

function engineerStages(input: ClassificationInput, reasons: string[]): AgentStage[] {
  const stages: AgentStage[] = [];
  // backend-engineer always precedes frontend-engineer within a phase — never parallel.
  if (input.touchesBackend) stages.push(AgentStage.BACKEND_ENGINEER);
  if (input.touchesFrontend) {
    // The UX/UI consultant runs before the frontend engineer it advises
    // (T-UX6) — but only where there is design work to advise on (T-UX11).
    if (includesDesignPhase(input)) {
      stages.push(AgentStage.UXUI_DESIGNER);
    }
    stages.push(AgentStage.FRONTEND_ENGINEER);
  }
  if (stages.length === 0) {
    reasons.push(
      "no engineer stage selected — caller must set touchesBackend and/or touchesFrontend",
    );
  }
  return stages;
}

function withSecurityGate(
  pipeline: AgentStage[],
  input: ClassificationInput,
): { pipeline: AgentStage[]; sensitiveGate: boolean } {
  if (!input.touchesSensitiveArea) {
    return { pipeline, sensitiveGate: false };
  }
  if (pipeline.includes(AgentStage.SECURITY)) {
    return { pipeline, sensitiveGate: true };
  }
  return { pipeline: [...pipeline, AgentStage.SECURITY], sensitiveGate: true };
}

/**
 * Classifies an incoming task and returns the level + pipeline it must run.
 * Every task must pass through this before entering the state machine (item 2) —
 * there is no "unclassified" path forward.
 */
export function classifyTask(input: ClassificationInput): ClassificationResult {
  const reasons: string[] = [];

  if (input.isProductionDeployOrMigration) {
    reasons.push(
      "production deploy/migration — always LARGE_CRITICAL, always requires human approval before devops runs",
    );
    return {
      level: TaskLevel.LARGE_CRITICAL,
      pipeline: [AgentStage.DEVOPS],
      requiresHumanApproval: true,
      sensitiveGate: Boolean(input.touchesSensitiveArea),
      reasons,
    };
  }

  if (input.isNewFeatureModuleOrProject) {
    // A brand-new feature/module/project wins over the schema signal, no matter
    // how the caller ordered the flags: the most common large task shape is
    // "new feature that needs new tables", and it must get the full requirements
    // interview (BA first), not silently degrade into the schema-only pipeline
    // that skips business-analyst and project-manager. The schema obligations
    // themselves — human confirmation before code is written against the model,
    // a security pass — still apply on top.
    const schemaAlso = Boolean(input.touchesSchema);
    reasons.push("new feature/module/project — needs full requirements interview, no stage skipped");
    if (schemaAlso) {
      reasons.push(
        "also touches data model — requirements interview comes first, then the same human schema confirmation as any schema change",
      );
    }
    const base = [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.PROJECT_MANAGER,
      AgentStage.TEST_PLANNER,
      ...engineerStages(input, reasons),
      AgentStage.QA_ENGINEER,
    ];
    const { pipeline, sensitiveGate } = withSecurityGate(base, {
      ...input,
      // A schema-touching feature gets the security pass whether or not the
      // caller flagged a sensitive area — same rule as a pure schema change.
      touchesSensitiveArea: input.touchesSensitiveArea || schemaAlso,
    });
    return {
      level: TaskLevel.LARGE_CRITICAL,
      pipeline,
      requiresHumanApproval: true,
      sensitiveGate,
      touchesSchema: schemaAlso,
      reasons,
    };
  }

  if (input.touchesSchema) {
    reasons.push(
      "touches data model — always routes through system-analyst, schema confirmation always requires human approval",
    );
    const base = [
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      ...engineerStages(input, reasons),
      AgentStage.QA_ENGINEER,
    ];
    const { pipeline, sensitiveGate } = withSecurityGate(base, {
      ...input,
      touchesSensitiveArea: true, // schema changes always get a security pass, per LARGE_CRITICAL example
    });
    return {
      level: TaskLevel.LARGE_CRITICAL,
      pipeline,
      requiresHumanApproval: true,
      sensitiveGate,
      touchesSchema: true,
      reasons,
    };
  }

  if (input.touchesBusinessRuleOnly) {
    reasons.push("business rule change, no schema impact — BA and SA amend, project-manager skipped");
    const base = [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      ...engineerStages(input, reasons),
      AgentStage.QA_ENGINEER,
    ];
    const { pipeline, sensitiveGate } = withSecurityGate(base, input);
    return {
      level: TaskLevel.MEDIUM,
      pipeline,
      requiresHumanApproval: false,
      sensitiveGate,
      reasons,
    };
  }

  if (input.isIncrementalFeature) {
    reasons.push("incremental feature on existing module — business-analyst and project-manager skipped");
    const base = [
      AgentStage.SYSTEM_ANALYST,
      AgentStage.TEST_PLANNER,
      ...engineerStages(input, reasons),
      AgentStage.QA_ENGINEER,
    ];
    const { pipeline, sensitiveGate } = withSecurityGate(base, input);
    return {
      level: TaskLevel.MEDIUM,
      pipeline,
      requiresHumanApproval: false,
      sensitiveGate,
      reasons,
    };
  }

  if (input.isClearBugFix) {
    reasons.push("bug fix, requirement and schema already clear — BA/SA/PM all skipped");
    const base = [...engineerStages(input, reasons), AgentStage.QA_ENGINEER];
    const { pipeline, sensitiveGate } = withSecurityGate(base, input);
    return {
      level: TaskLevel.SMALL,
      pipeline,
      requiresHumanApproval: false,
      sensitiveGate,
      reasons,
    };
  }

  if (input.isTypoOrCopyOnly) {
    reasons.push("copy/styling only — engineer only, no QA stage");
    const base = engineerStages(input, reasons);
    const { pipeline, sensitiveGate } = withSecurityGate(base, input);
    return {
      level: TaskLevel.TRIVIAL,
      pipeline,
      requiresHumanApproval: false,
      sensitiveGate,
      reasons,
    };
  }

  reasons.push(
    "no classification signal matched — do not guess; escalate to a human for triage instead of defaulting a level",
  );
  return {
    level: TaskLevel.UNKNOWN,
    pipeline: [AgentStage.HUMAN],
    requiresHumanApproval: true,
    sensitiveGate: Boolean(input.touchesSensitiveArea),
    reasons,
  };
}
