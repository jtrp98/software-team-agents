import { AgentStage } from "../types.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

/**
 * Which role a *kind* of problem belongs to (T38).
 *
 * THE DIRECTION THIS RUNS IN, AND WHY IT MATTERS
 *
 * `failureClassifier.ts` already holds a map called `CATEGORY_BY_OWNER`, and at
 * a glance this looks like its mirror. It is the opposite direction, and the
 * difference is the whole point of T38: that map answers "the document named
 * backend-engineer, so what kind of failure is this?", while this one answers
 * "the document says this is a contract problem, so who should get it?".
 *
 * The first direction needs a role to have been named. When `review.md` names
 * one, that is the strongest signal there is — a person looked at the code and
 * decided — and nothing here second-guesses it. But a row that states the
 * *type* of problem and no role used to be worth nothing at all: it fell into
 * "names no agent", which stops the task for a human. That is the right answer
 * for a row that says nothing useful, and the wrong one for a row that says
 * "contract gap" in as many words.
 *
 * WHAT THIS IS STILL NOT ALLOWED TO DO
 *
 * Guess. It maps a *stated* category to a destination; it never reads prose and
 * decides what category something feels like. `failureClassifier.ts`'s own rule
 * stands unchanged — a wrong owner costs two fresh-context agent runs and fixes
 * the wrong thing, so an unstated category still stops for a person. This only
 * removes the case where the answer was written down and nobody was reading it.
 */

export type FailureCategory = StructuredFailure["category"];

/**
 * TASKS.md T38's table, as data: implementation → Backend, contract → SA,
 * requirement → BA, infrastructure → DevOps, test → QA.
 *
 * Each entry is a preference order, not a single answer, because the pipeline a
 * task actually has decides which of them exists. "implementation" lists backend
 * first per `policies/agent-boundaries.md` §6a (the frontend builds against what the backend
 * actually shipped, so backend-first is the pipeline's own ordering), and the
 * affected ids override that whenever they name a side.
 *
 * `unknown` maps to nothing on purpose. It is the category `failureClassifier.ts`
 * produces when a document names no owner, and giving it a destination would
 * turn "nobody knows" into a confident wrong answer.
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
 * `TEST-NNN` is deliberately absent: T19's convention makes it a test *item*,
 * which says what the failure is about and not whose it is — `test-planner`
 * chose the level and `qa-engineer` ran it, and a test id cannot tell those two
 * apart. Mapping it anyway would be the guess this module exists to avoid.
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
