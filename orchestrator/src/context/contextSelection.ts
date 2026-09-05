import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

/**
 * Four context classes, each a behaviour that lives elsewhere in this codebase
 * (not a data structure of its own):
 *   MANDATORY — always assembled for a stage (buildPrompt header, this policy's
 *     `reads`, status.md pointers).
 *   TASK_SPECIFIC — module docs sliced to the run (ContextManager/selectDocContext).
 *   ON_DEMAND — never preloaded, only pointed to (renderSlicedDocs), so a stage
 *     reads exactly what turns out to matter instead of everything up front.
 *   FORBIDDEN — everything in `doesNotRead`: selectContext throws rather than
 *     silently dropping it; write-side enforcement is UNIVERSAL_DENY + per-contract
 *     denies in pathPermissions.ts, and secrets are blocked separately by
 *     .claude/hooks/block-secret-leak.js.
 */

/** Doc categories reuse ArtifactType; code/infra areas are not artifacts, so they're added here. */
export type ContextCategory =
  | ArtifactType
  | "backend-code"
  | "frontend-code"
  | "devops-docs"
  | "ux-research"
  /** Bounded evidence package the orchestrator injects per qa-engineer round; not an artifact any stage produces. */
  | "qa-evidence"
  /** Compact per-module brief from knowledge/ YAML, assembled by knowledgeBriefAssembly. */
  | "knowledge-brief";

export const ALL_CONTEXT_CATEGORIES: ContextCategory[] = [
  ArtifactType.REQUIREMENTS,
  ArtifactType.DESIGN,
  ArtifactType.PLAN,
  ArtifactType.TEST_PLAN,
  ArtifactType.QA_REPORT,
  ArtifactType.SECURITY_REPORT,
  ArtifactType.HANDOFF,
  // Compiler-to-runtime only; no CONTEXT_POLICY grants it, but it stays in the
  // universe so every role's doesNotRead denies it explicitly.
  ArtifactType.EXECUTION_PACKET,
  "backend-code",
  "frontend-code",
  "devops-docs",
  "ux-research",
  "qa-evidence",
  "knowledge-brief",
];

export interface ContextPolicy {
  reads: ContextCategory[];
  doesNotRead: ContextCategory[];
}

function policy(reads: ContextCategory[]): ContextPolicy {
  // A handoff is a bounded pointer set, not authority — every stage may inspect it.
  const permitted = [...new Set([...reads, ArtifactType.HANDOFF])];
  return { reads: permitted, doesNotRead: ALL_CONTEXT_CATEGORIES.filter((c) => !permitted.includes(c)) };
}

/** What each role is allowed to read, per CLAUDE.md's per-agent "Reads" column. */
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
  // UX/UI reads only confirmed requirements/design, not code or reports — its
  // recommendations must follow what was decided, not what happens to be implemented.
  [AgentStage.UXUI_DESIGNER]: policy([ArtifactType.REQUIREMENTS, ArtifactType.DESIGN]),
  [AgentStage.BACKEND_ENGINEER]: policy([
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    ArtifactType.REQUIREMENTS,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "backend-code",
    "knowledge-brief",
  ]),
  [AgentStage.FRONTEND_ENGINEER]: policy([
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    ArtifactType.REQUIREMENTS,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "frontend-code",
    "knowledge-brief",
  ]),
  [AgentStage.QA_ENGINEER]: policy([
    ArtifactType.REQUIREMENTS,
    ArtifactType.DESIGN,
    ArtifactType.PLAN,
    ArtifactType.TEST_PLAN,
    ArtifactType.QA_REPORT,
    "backend-code",
    "frontend-code",
    // Injected by the optimization wrapper per round, never stored in the artifact
    // store, so selectContext itself yields nothing for it.
    "qa-evidence",
    "knowledge-brief",
  ]),
  [AgentStage.SECURITY]: policy([
    ArtifactType.REQUIREMENTS,
    ArtifactType.DESIGN,
    ArtifactType.QA_REPORT,
    "backend-code",
    "frontend-code",
    "knowledge-brief",
  ]),
  [AgentStage.DEVOPS]: policy([
    ArtifactType.QA_REPORT,
    ArtifactType.SECURITY_REPORT,
    ArtifactType.PLAN,
    ArtifactType.DESIGN,
    "devops-docs",
    "knowledge-brief",
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
