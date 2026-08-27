import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";

/**
 * T-V1-13A §8.1 — where the four context classes live in this codebase.
 *
 * The classification is not a fourth data structure; each class is a behaviour
 * that already exists somewhere deterministic. This comment is the index so an
 * auditor finds them all in one place:
 *
 *   MANDATORY — assembled for every run of a stage: role identity and task id
 *     (`buildPrompt`'s header lines), this policy's `reads` categories, and
 *     `_docs/status.md` convention pointers.
 *
 *   TASK_SPECIFIC — module documents sliced to the run: `ContextManager`
 *     scopes by module name, `selectDocContext` slices plan.md to the phases
 *     the run touches (policies/documentation.md §10).
 *
 *   ON_DEMAND — never preloaded; handed over as a pointer instead:
 *     `renderSlicedDocs` names every skipped section with its file path so the
 *     agent reads exactly what turns out to matter. Historical decisions and
 *     prior traces are only reachable through explicit tools (`sta audit`,
 *     `sta qa-metrics`), never through the launch prompt.
 *
 *   FORBIDDEN — everything in `doesNotRead` below: `selectContext` refuses to
 *     return it and throws on an explicit request; write-side equivalents are
 *     `UNIVERSAL_DENY` + per-contract denies (pathPermissions.ts). Secrets are
 *     kept out by `.claude/hooks/block-secret-leak.js` exit checks.
 */

/** Doc categories reuse ArtifactType; code/infra areas are not artifacts, so they're added here. */
export type ContextCategory =
  | ArtifactType
  | "backend-code"
  | "frontend-code"
  | "devops-docs"
  | "ux-research"
  /** QA01/QA04: the bounded evidence package the orchestrator assembles for a qa-engineer round. Not an artifact any stage produces — the wrapper injects it per run. */
  | "qa-evidence"
  /** T-KA5a: compact per-module brief derived from `knowledge/` YAML, assembled by
   *  `knowledgeBriefAssembly` and injected beside the sliced docs. */
  | "knowledge-brief";

export const ALL_CONTEXT_CATEGORIES: ContextCategory[] = [
  ArtifactType.REQUIREMENTS,
  ArtifactType.DESIGN,
  ArtifactType.PLAN,
  ArtifactType.TEST_PLAN,
  ArtifactType.QA_REPORT,
  ArtifactType.SECURITY_REPORT,
  ArtifactType.HANDOFF,
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
  // A handoff is a bounded pointer set, not authority. Every stage may inspect
  // it; selectContext still applies this policy to every referenced source.
  const permitted = [...new Set([...reads, ArtifactType.HANDOFF])];
  return { reads: permitted, doesNotRead: ALL_CONTEXT_CATEGORIES.filter((c) => !permitted.includes(c)) };
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
  // The UX/UI consultant reads what it is designing against: the confirmed
  // requirements and the confirmed design. It does not read code or reports —
  // its recommendations must come from what was decided, not from what happens
  // to be implemented.
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
    // The evidence package (QA04) is the one extra thing QA reads first; it is
    // injected by the optimization wrapper per round, never stored in the
    // artifact store, so selectContext itself yields nothing for it.
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
