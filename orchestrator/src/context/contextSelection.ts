import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

/** Doc categories reuse ArtifactType; code/infra areas are not artifacts, so they're added here. */
export type ContextCategory = ArtifactType | "backend-code" | "frontend-code" | "devops-docs" | "ux-research";

export const ALL_CONTEXT_CATEGORIES: ContextCategory[] = [
  ArtifactType.REQUIREMENTS,
  ArtifactType.DESIGN,
  ArtifactType.PLAN,
  ArtifactType.TEST_PLAN,
  ArtifactType.QA_REPORT,
  ArtifactType.SECURITY_REPORT,
  "backend-code",
  "frontend-code",
  "devops-docs",
  "ux-research",
];

export interface ContextPolicy {
  reads: ContextCategory[];
  doesNotRead: ContextCategory[];
}

function policy(reads: ContextCategory[]): ContextPolicy {
  return { reads, doesNotRead: ALL_CONTEXT_CATEGORIES.filter((c) => !reads.includes(c)) };
}

/**
 * What each role is allowed to read, per CLAUDE.md's existing per-agent
 * "Reads" column. backend-engineer's entry matches task-detail.md item 8's
 * own example verbatim: reads requirement/design/plan/backend_code, and
 * explicitly not ux_research/frontend_implementation/devops_docs.
 */
export const CONTEXT_POLICY: Partial<Record<AgentStage, ContextPolicy>> = {
  [AgentStage.SETUP]: policy([ArtifactType.DESIGN]),
  [AgentStage.BUSINESS_ANALYST]: policy([
    ArtifactType.REQUIREMENTS,
    ArtifactType.DESIGN,
    ArtifactType.QA_REPORT,
  ]),
  [AgentStage.SYSTEM_ANALYST]: policy([ArtifactType.REQUIREMENTS, ArtifactType.QA_REPORT]),
  [AgentStage.PROJECT_MANAGER]: policy([ArtifactType.DESIGN, ArtifactType.REQUIREMENTS]),
  [AgentStage.TEST_PLANNER]: policy([ArtifactType.REQUIREMENTS, ArtifactType.DESIGN, ArtifactType.PLAN]),
  [AgentStage.BACKEND_ENGINEER]: policy([
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    ArtifactType.REQUIREMENTS,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "backend-code",
  ]),
  [AgentStage.FRONTEND_ENGINEER]: policy([
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    ArtifactType.REQUIREMENTS,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "frontend-code",
  ]),
  [AgentStage.QA_ENGINEER]: policy([
    ArtifactType.REQUIREMENTS,
    ArtifactType.DESIGN,
    ArtifactType.PLAN,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "backend-code",
    "frontend-code",
  ]),
  [AgentStage.SECURITY]: policy([
    ArtifactType.REQUIREMENTS,
    ArtifactType.DESIGN,
    ArtifactType.QA_REPORT,
    "backend-code",
    "frontend-code",
  ]),
  [AgentStage.DEVOPS]: policy([
    ArtifactType.QA_REPORT,
    ArtifactType.SECURITY_REPORT,
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    "devops-docs",
  ]),
};

export interface ContextItem {
  source: ContextCategory;
  content: string;
}

export class ContextLeakageError extends Error {
  constructor(stage: AgentStage, category: ContextCategory) {
    super(`${stage} is not allowed to read "${category}" — not in its context policy`);
    this.name = "ContextLeakageError";
  }
}

/**
 * Filters an available-content store down to exactly what this role reads.
 * Throws instead of silently dropping if the caller explicitly requests a
 * category the role's policy excludes — that's a bug at the call site, not
 * something to paper over by pruning it quietly.
 */
export function selectContext(
  stage: AgentStage,
  available: Partial<Record<ContextCategory, string>>,
  explicitRequests?: ContextCategory[],
): ContextItem[] {
  const p = CONTEXT_POLICY[stage];
  if (!p) return [];

  // Default request is "everything my policy allows" — leak-checking only
  // bites when a caller explicitly names a category, in or out of policy.
  const requests = explicitRequests ?? p.reads;
  for (const category of requests) {
    if (!p.reads.includes(category)) {
      throw new ContextLeakageError(stage, category);
    }
  }

  return p.reads
    .filter((category) => available[category] !== undefined)
    .map((category) => ({ source: category, content: available[category]! }));
}
