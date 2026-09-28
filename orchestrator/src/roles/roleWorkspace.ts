import type { ApprovalType } from "../gates/approval.js";
import type { LaneItemRef } from "../gates/laneApproval.js";
import type { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { type StaleReference, staleReferences } from "../knowledge/knowledgeHistory.js";
import { type RoleLane, laneOf } from "./roleLane.js";

/**
 * The role workspace — where one lane stands in the shared knowledge base, so
 * BA, SA and DEV can work independently against one set of facts instead of
 * three copies of them.
 *
 * Since V13 TASK-028 it is a *projection*, never a file: the watermark (`seen`)
 * and the lane's sign-offs are built by `laneDecisions.ts` from the trusted
 * human decisions in STA's lane ledger, and from nothing else. There is no
 * reader or writer of `knowledge/_roles/**` any more — a file there is not an
 * authority and nothing loads it; `UNIVERSAL_DENY` still keeps every agent out
 * of that path.
 *
 * Everything else a caller wants is derived (`laneView()`): what the lane is
 * drafting, what moved under it since it last looked, what it depends on and
 * has never acknowledged at all. Conflicts are re-detected every run rather
 * than stored, because a stored list keeps escalating things somebody already
 * fixed; only the *decision* is kept.
 *
 * The consequence that matters most: because the inbox is derived from the
 * *reader's* watermark, nothing ever writes into another lane's watermark. BA
 * amending REQ-003 does not notify DEV; DEV notices, because DEV's own
 * acknowledged version of REQ-003 no longer matches.
 */

export const ROLE_WORKSPACE_SCHEMA_VERSION = 2;

/** A trusted decision that the person in this lane has seen version N of item X, with its content digest at that version. */
export interface SeenRef {
  id: string;
  version: number;
  digest: string;
  at: string;
  /** The actor id the trusted channel authenticated (e.g. `github-user:<id>`), never a typed name. */
  by: string;
}

/** One `{id, version, digest}` a sign-off covered. */
export type SignoffItemRef = LaneItemRef;

/** The person in this lane answering their own gate — see `roleApproval.ts` for the rules. */
export interface LaneSignoff {
  type: ApprovalType;
  status: "approved" | "rejected";
  items: SignoffItemRef[];
  at: string;
  /** The actor id the trusted channel authenticated. */
  by: string;
  note: string | null;
  /** The lane-ledger request and channel decision this sign-off is. */
  requestId: string;
  decisionId: string;
}

export interface RoleWorkspace {
  schema_version: number;
  lane: RoleLane;
  module: string | null;
  seen: SeenRef[];
  signoffs: LaneSignoff[];
  updated_at: string;
}

/** A lane with no decision recorded. */
export function emptyWorkspace(lane: RoleLane, module: string | null, now: string): RoleWorkspace {
  return { schema_version: ROLE_WORKSPACE_SCHEMA_VERSION, lane, module, seen: [], signoffs: [], updated_at: now };
}

/**
 * Whether this lane is working from current facts.
 *
 * Only two values, and deliberately not four. The first version of this had
 * `idle`/`drafting`/`awaiting-approval` here too — which is where the lane's own
 * work sits on the draft/reviewed/approved path, and that is
 * `RoleWorkflowStage`'s question (`roleWorkflow.ts`). Two vocabularies
 * answering overlapping questions print as `BA drafting [drafting]` and
 * diverge the first time one is edited, so this one shrank to the half only
 * it can answer: has anything this lane depends on moved since the person in
 * it last looked. `active` and `awaitingApproval` stay below as data — it is
 * the single-word verdict that had two owners.
 */
export type LaneStatus = "up-to-date" | "behind";

export interface LaneView {
  lane: RoleLane;
  module: string | null;
  status: LaneStatus;
  /** Items this lane owns that are still open (`draft` or `reviewed`). Derived — no `active` field is stored. */
  active: string[];
  /** Items this lane owns that only a person can now move on. */
  awaitingApproval: string[];
  /** Cross-lane dependencies whose acknowledged version is no longer current. Feeds change propagation. */
  stale: StaleReference[];
  /** Cross-lane dependencies never acknowledged at all — so an empty `seen` does not read as "nothing to do". */
  unseen: string[];
  /**
   * Acknowledged ids that nothing this lane owns points at. Reported, never
   * auto-removed — and deliberately not called "safe to drop", because there are
   * two ways to get here and only one of them is leftover bookkeeping. The other
   * is a handoff the lane accepted before writing anything that cites it, which
   * is the normal state right after `roles ack`.
   */
  orphanedSeen: string[];
}

/**
 * What this lane depends on: the items its own items point at, that another
 * lane owns.
 *
 * Deliberately narrow. "Which knowledge might matter to DEV" is a question with
 * an expansive answer (`impactOf` sharpens it further), but the answer that
 * is certainly right and cheap is the one the lane has already written down: a
 * task that `implements` an API declares a dependency on that API, in the
 * knowledge graph, by the lane that owns the task. Items this lane owns itself
 * are excluded — a lane does not acknowledge its own work, it does it.
 */
export function dependenciesOf(lane: RoleLane, module: string | null, kb: KnowledgeBase): string[] {
  const owned = kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
  const deps = new Set<string>();

  for (const item of owned) {
    for (const relation of item.relations) {
      const target = kb.get(relation.to);
      if (!target) continue;
      const targetLane = laneOf(target.owner);
      if (targetLane === null || targetLane === lane) continue;
      deps.add(target.id);
    }
  }

  return [...deps].sort();
}

/** Everything about a lane that is computed rather than stored. */
export function laneView(workspace: RoleWorkspace, kb: KnowledgeBase): LaneView {
  const { lane, module } = workspace;

  const owned = kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
  const active = owned.filter((i) => i.status === "draft" || i.status === "reviewed").map((i) => i.id).sort();
  const awaitingApproval = owned.filter((i) => i.status === "reviewed").map((i) => i.id).sort();

  const deps = dependenciesOf(lane, module, kb);
  const depSet = new Set(deps);
  const seenById = new Map(workspace.seen.map((ref) => [ref.id, ref]));

  // Only dependencies are compared. An acknowledgement of something that is no
  // longer a dependency is bookkeeping to tidy, not a change to report.
  const stale = staleReferences(
    deps.filter((id) => seenById.has(id)).map((id) => seenById.get(id) as SeenRef),
    kb.query({}),
  );
  const unseen = deps.filter((id) => !seenById.has(id));
  const orphanedSeen = workspace.seen.filter((ref) => !depSet.has(ref.id)).map((ref) => ref.id).sort();

  const status: LaneStatus = stale.length > 0 || unseen.length > 0 ? "behind" : "up-to-date";

  return { lane, module, status, active, awaitingApproval, stale, unseen, orphanedSeen };
}
