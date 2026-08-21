import { AgentStage } from "../types.js";
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "../knowledge/knowledgeModel.js";
import type { KnowledgeQuery } from "../knowledge/knowledgeBase.js";
import type { KnowledgeContext, RetrievedItem } from "../knowledge/knowledgeContext.js";
import { canSeeKind, viewNameFor } from "../knowledge/roleView.js";
import { LANE_LABEL, type RoleLane, rolesInLane } from "./roleLane.js";

/**
 * Cross-role context sharing (T107) — what one lane may see of another's work,
 * and how.
 *
 * THE RULE, IN ONE SENTENCE
 *
 * A lane sees an item exactly as the role in that lane with the widest view
 * would see it, and never more — and every result says which role granted it.
 *
 * WHY THE UNION AND NOT THE INTERSECTION
 *
 * A lane is a person, and the person in the DEV lane genuinely runs
 * `backend-engineer`, `qa-engineer` and `devops` at different moments in the same
 * afternoon. Whatever any of those roles may put in front of them, they have
 * already seen. An intersection would claim otherwise and would be false: it
 * would hide a requirement's acceptance criteria from the DEV lane because
 * `devops` — a role that ships work rather than implements it — is configured
 * not to need them. `knowledge-policy.yaml`'s own note says why that direction is
 * dangerous: "an engineer who cannot see the acceptance criteria will implement
 * the wrong thing".
 *
 * This is not a widening of T68. Every item a lane gets here is one that some
 * role in that lane is already permitted to retrieve under T67 and T68, through
 * `KnowledgeContext` — the same door, with the same field redaction, reporting
 * the same `withheld` list. What is added is the attribution: `viaRole` names
 * which role's permission was used, so the grant is auditable rather than
 * emergent. A lane can never reach a kind no role in it may see.
 *
 * WHY THIS IS `KnowledgeContext`'S FIRST REAL CALLER
 *
 * HANDOFF_V1.md §11.1 recorded that nothing in production called it — T99 and
 * T100 did not, because they compare *versions*, and a redacted view is the
 * wrong instrument for that. This is the case it was built for: a lane reading
 * another lane's *contents*. Anything here that bypassed it and read
 * `KnowledgeBase` directly would be the leak T69 exists to prevent.
 */

export interface LaneVisibleItem extends RetrievedItem {
  /** Which role in the lane the policy granted this through. The grant is named, not emergent. */
  viaRole: AgentStage;
}

export interface LaneContextResult {
  lane: RoleLane;
  items: LaneVisibleItem[];
  /** Kinds no role in this lane may see. "No API items" and "no API items you may see" stay distinguishable. */
  kindsNotInLane: KnowledgeKind[];
  /** Ids the field policy hid from every role in the lane. Listed, never merely omitted. */
  hidden: string[];
}

/**
 * The kinds a lane may see: the union over its roles, computed through
 * `canSeeKind` rather than restated.
 *
 * This is the decision HANDOFF_V1.md §16.5 left open for V1.5 — `canSeeKind`
 * and `viewFor` had no caller and were pending use-or-delete. `canSeeKind` is
 * used here and in `artifactReview.ts`; `viewNameFor` was already taken by
 * `roleLane.ts` in T99.
 */
export function kindsForLane(lane: RoleLane): KnowledgeKind[] {
  const roles = rolesInLane(lane);
  return KNOWLEDGE_KINDS.filter((kind) => roles.some((role) => canSeeKind(role, kind)));
}

export function laneCanSee(lane: RoleLane, kind: KnowledgeKind): boolean {
  return kindsForLane(lane).includes(kind);
}

/** The view name behind a lane, for a message that has to explain why something is not visible. */
export function viewOfLane(lane: RoleLane): string {
  return viewNameFor(rolesInLane(lane)[0]);
}

/**
 * Everything the lane may see, each item as the least-redacted role in the lane
 * gets it.
 *
 * "Least redacted" is measured by how much was withheld, so an item a lane's
 * owner-role sees in full wins over the same item redacted for a sibling role —
 * which is the correct answer, because the person really can open it as that
 * owner-role.
 */
export function laneContext(lane: RoleLane, context: KnowledgeContext, filter: KnowledgeQuery = {}): LaneContextResult {
  const allowed = kindsForLane(lane);

  if (filter.kinds) {
    for (const kind of filter.kinds) {
      if (!allowed.includes(kind)) {
        throw new Error(
          `no role in the ${LANE_LABEL[lane]} lane sees ${kind} items — asking for them is a bug at the call site, ` +
            "the same way it is for a single role (T67)",
        );
      }
    }
  }

  const best = new Map<string, LaneVisibleItem>();
  const hiddenFromAll = new Map<string, number>();
  const roles = rolesInLane(lane);

  for (const role of roles) {
    const visibleKinds = (filter.kinds ?? allowed).filter((kind) => canSeeKind(role, kind));
    if (visibleKinds.length === 0) continue;

    const result = context.forRole(role).query({ ...filter, kinds: visibleKinds });
    for (const retrieved of result.items) {
      const current = best.get(retrieved.item.id);
      if (!current || retrieved.item.withheld.length < current.item.withheld.length) {
        best.set(retrieved.item.id, { ...retrieved, viaRole: role });
      }
    }
    for (const id of result.hidden) hiddenFromAll.set(id, (hiddenFromAll.get(id) ?? 0) + 1);
  }

  // Hidden from *every* role that could have seen it — hidden from one and
  // visible to another is not hidden from the lane, it is granted via the other.
  const hidden = [...hiddenFromAll.keys()].filter((id) => !best.has(id)).sort();

  return {
    lane,
    items: [...best.values()].sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)),
    kindsNotInLane: KNOWLEDGE_KINDS.filter((kind) => !allowed.includes(kind)),
    hidden,
  };
}

export type LaneRetrieval =
  | { status: "ok"; item: LaneVisibleItem }
  | { status: "not-found" }
  | { status: "withheld"; reason: string };

/**
 * One item, for one lane. Three outcomes kept distinct on purpose, the same way
 * `RoleContext.get` keeps them: it is not here, you may not see it, or here it
 * is. Collapsing the first two is how a lane concludes a rule does not exist
 * when it is merely hidden — and then implements around the gap.
 */
export function laneGet(lane: RoleLane, context: KnowledgeContext, id: string): LaneRetrieval {
  const raw = context.kb.get(id);
  if (!raw) return { status: "not-found" };

  if (!laneCanSee(lane, raw.kind)) {
    return {
      status: "withheld",
      reason: `no role in the ${LANE_LABEL[lane]} lane sees ${raw.kind} items`,
    };
  }

  let best: LaneVisibleItem | null = null;
  for (const role of rolesInLane(lane)) {
    if (!canSeeKind(role, raw.kind)) continue;
    const outcome = context.forRole(role).get(id);
    if (outcome.status !== "ok") continue;
    if (!best || outcome.item.item.withheld.length < best.item.withheld.length) {
      best = { ...outcome.item, viaRole: role };
    }
  }

  if (!best) {
    return {
      status: "withheld",
      reason: `the field policy hides ${id} from every role in the ${LANE_LABEL[lane]} lane`,
    };
  }
  return { status: "ok", item: best };
}
