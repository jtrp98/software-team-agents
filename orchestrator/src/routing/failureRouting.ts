import { AgentStage } from "../types.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

/**
 * Which role a *kind* of problem belongs to — the inverse of
 * `failureClassifier.ts`'s `CATEGORY_BY_OWNER` map (that one answers "backend-engineer
 * was named, so what failure kind is this?"; this one answers "category is
 * `contract`, so who gets it?"). A named role in `review.md` always wins — a
 * person decided, and nothing here second-guesses that. This only covers the
 * case where a row states a category but no role.
 *
 * It maps a *stated* category to a destination; it never infers a category
 * from prose. An unstated category still stops for a person — a wrong owner
 * costs two fresh-context agent runs and fixes the wrong thing.
 */

export type FailureCategory = StructuredFailure["category"];

/**
 * Category destination table. Each entry is a preference order, not a single
 * answer — the pipeline a task actually has decides which candidate exists.
 * "implementation" lists backend first per `policies/agent-boundaries.md` §6a
 * (frontend builds against what backend shipped), overridden whenever the
 * affected ids name a side.
 *
 * `unknown` maps to nothing on purpose — `failureClassifier.ts` produces it
 * when a document names no owner, and giving it a destination would turn
 * "nobody knows" into a confident wrong answer.
 */
export const CATEGORY_DESTINATION: Record<FailureCategory, readonly AgentStage[]> = {
  implementation: [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER],
  contract: [AgentStage.SYSTEM_ANALYST],
  requirement: [AgentStage.BUSINESS_ANALYST],
  infrastructure: [AgentStage.DEVOPS, AgentStage.SETUP],
  test: [AgentStage.QA_ENGINEER, AgentStage.TEST_PLANNER],
  unknown: [],
};

/**
 * Id prefixes that name a role unambiguously.
 *
 * `TEST-NNN` is deliberately absent: it names a test item, not an owner —
 * `test-planner` chose the level and `qa-engineer` ran it, and the id can't
 * tell those two apart.
 */
const ID_PREFIX_STAGE: Record<string, AgentStage> = {
  BE: AgentStage.BACKEND_ENGINEER,
  FE: AgentStage.FRONTEND_ENGINEER,
  SA: AgentStage.SYSTEM_ANALYST,
  DES: AgentStage.SYSTEM_ANALYST,
  BA: AgentStage.BUSINESS_ANALYST,
  REQ: AgentStage.BUSINESS_ANALYST,
  QA: AgentStage.QA_ENGINEER,
  DO: AgentStage.DEVOPS,
  SEC: AgentStage.SECURITY,
};

/** How a destination was arrived at — recorded so a routed failure can say why it went where it went. */
export type RoutingBasis =
  /** The affected ids named a side (BE-004 vs FE-010). */
  | "affected-ids"
  /** The category named exactly one possible destination. */
  | "category"
  /** Several were possible; this task's pipeline and the declared preference order settled it. */
  | "pipeline-order"
  /** Nothing here can answer — the caller must escalate rather than pick. */
  | "none";

export interface RoutingDecision {
  stage: AgentStage | null;
  basis: RoutingBasis;
  reason: string;
}

export interface RoutingContext {
  /** This task's stages. When given, a destination outside it is not a destination. */
  pipeline?: readonly AgentStage[];
  /** Task/requirement ids the failure touches, e.g. ["BE-004"]. */
  affected?: readonly string[];
}

/** Every stage the affected ids point at, deduplicated — usually zero or one, and more than one means the ids disagree. */
export function stagesFromAffected(affected: readonly string[] = []): AgentStage[] {
  const stages: AgentStage[] = [];
  for (const id of affected) {
    const prefix = id.split("-")[0]?.toUpperCase();
    const stage = prefix ? ID_PREFIX_STAGE[prefix] : undefined;
    if (stage && !stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

/**
 * Resolves a stated problem category to a stage this task can actually route to.
 *
 * Returns `stage: null` rather than a best guess whenever the answer is not
 * determined: an unknown category, or a category whose destinations are all
 * absent from this pipeline. Both are cases where the caller must stop for a
 * person, and returning something plausible would hide that.
 */
export function routeByCategory(category: FailureCategory, context: RoutingContext = {}): RoutingDecision {
  const declared = CATEGORY_DESTINATION[category] ?? [];
  if (declared.length === 0) {
    return {
      stage: null,
      basis: "none",
      reason: `category "${category}" names no destination — who owns it is a human decision, not something to infer`,
    };
  }

  const { pipeline } = context;
  const candidates = pipeline ? declared.filter((stage) => pipeline.includes(stage)) : [...declared];
  if (candidates.length === 0) {
    return {
      stage: null,
      basis: "none",
      reason:
        `category "${category}" routes to ${declared.join(" or ")}, and this task's pipeline ` +
        `(${(pipeline ?? []).join(" -> ")}) has none of them`,
    };
  }

  // The ids are evidence written in the document, so they outrank the declared
  // preference order — "BE-004" says backend whatever the ordering would prefer.
  const fromIds = stagesFromAffected(context.affected).filter((stage) => candidates.includes(stage));
  if (fromIds.length === 1) {
    return {
      stage: fromIds[0],
      basis: "affected-ids",
      reason: `affected ids (${(context.affected ?? []).join(", ")}) name ${fromIds[0]} within category "${category}"`,
    };
  }

  if (candidates.length === 1) {
    return {
      stage: candidates[0],
      basis: "category",
      reason: `category "${category}" routes to ${candidates[0]}`,
    };
  }

  return {
    stage: candidates[0],
    basis: "pipeline-order",
    reason:
      `category "${category}" could route to ${candidates.join(" or ")}; ` +
      `nothing in the report distinguishes them, so it goes to ${candidates[0]} first ` +
      "(`policies/agent-boundaries.md` §6a: backend before frontend)",
  };
}
