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
  reasons: string[];
}

function engineerStages(input: ClassificationInput, reasons: string[]): AgentStage[] {
  const stages: AgentStage[] = [];
  // backend-engineer always precedes frontend-engineer within a phase — never parallel.
  if (input.touchesBackend) stages.push(AgentStage.BACKEND_ENGINEER);
  if (input.touchesFrontend) stages.push(AgentStage.FRONTEND_ENGINEER);
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

  if (input.touchesSchema) {
    reasons.push(
      "touches data model — always routes through system-analyst, schema confirmation always requires human approval",
    );
    const base = [
      AgentStage.SYSTEM_ANALYST,
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
      reasons,
    };
  }

  if (input.isNewFeatureModuleOrProject) {
    reasons.push("new feature/module/project — needs full requirements interview, no stage skipped");
    const base = [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.PROJECT_MANAGER,
      ...engineerStages(input, reasons),
      AgentStage.QA_ENGINEER,
    ];
    const { pipeline, sensitiveGate } = withSecurityGate(base, input);
    return {
      level: TaskLevel.LARGE_CRITICAL,
      pipeline,
      requiresHumanApproval: false,
      sensitiveGate,
      reasons,
    };
  }

  if (input.touchesBusinessRuleOnly) {
    reasons.push("business rule change, no schema impact — BA and SA amend, project-manager skipped");
    const base = [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
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
    const base = [AgentStage.SYSTEM_ANALYST, ...engineerStages(input, reasons), AgentStage.QA_ENGINEER];
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
