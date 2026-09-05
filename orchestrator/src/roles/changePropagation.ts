import type { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { impactOf } from "../knowledge/knowledgeGraph.js";
import { LANE_LABEL, ROLE_LANES, type RoleLane, laneOf } from "./roleLane.js";
import { type RoleWorkspace, dependenciesOf } from "./roleWorkspace.js";
import { signoffVerdict } from "./roleApproval.js";

/**
 * Change propagation and impact notification, computed rather than delivered:
 * a lane's inbox is derived fresh from that lane's own watermark, so nothing
 * ever writes into another lane's file and there is no send to forget.
 *
 * Beyond a lane's direct dependencies (the acknowledge list — bounded and
 * actionable), this also surfaces:
 *
 *   1. **Transitive reach.** When BA amends REQ-003, DEV points at the API,
 *      not at the requirement, so a direct-only walk leaves DEV uninformed
 *      about the thing that just invalidated its work. `impactOf` walks
 *      against the arrows and finds it, and the notification quotes the
 *      route so it is actionable rather than alarming.
 *   2. **Sign-off invalidation.** A change upstream of a lane's own approved
 *      output is the case where that lane's sign-off stops being true.
 *      `signoffVerdict` already detects it on the lane's own items; this
 *      reports it as a consequence of the change, so the person sees cause
 *      and effect in one place rather than noticing later that the gate
 *      reopened.
 *
 * There is deliberately no push notification (no event, no webhook): a lane
 * that is not running when an event fires would miss it permanently, and a
 * durable pull already covers every case a push would.
 */

export type NotificationReason =
  /** The lane's watermark holds an older version of something it depends on. */
  | "dependency-changed"
  /** The lane depends on it and has never acknowledged any version. */
  | "never-acknowledged"
  /** Something upstream of the lane's own work changed, further away than a direct dependency. */
  | "upstream-changed"
  /** The lane's own sign-off no longer covers what is approved. */
  | "signoff-invalidated";

export interface Notification {
  lane: RoleLane;
  reason: NotificationReason;
  /** The item the lane has to look at. */
  id: string;
  /** Version the lane last acknowledged, when it acknowledged one. */
  acknowledgedVersion: number | null;
  currentVersion: number | null;
  /** How the change reaches this lane: the chain of ids from the change to the lane's own item. Single-element for a direct dependency. */
  via: string[];
  /** One line a person can act on. */
  message: string;
}

function versionOf(kb: KnowledgeBase, id: string): number | null {
  return kb.get(id)?.version ?? null;
}

/**
 * Everything one lane should be told about, derived fresh.
 *
 * Ordered by how close the change is to the lane's own work — a direct
 * dependency that moved is more urgent than something four hops upstream, and a
 * list that mixes them in arbitrary order gets skimmed.
 */
export function notificationsFor(
  lane: RoleLane,
  module: string | null,
  kb: KnowledgeBase,
  workspace: RoleWorkspace,
): Notification[] {
  const notifications: Notification[] = [];
  const seen = new Map(workspace.seen.map((ref) => [ref.id, ref.version]));
  const direct = dependenciesOf(lane, module, kb);
  const reported = new Set<string>();

  // 1. Direct dependencies: the acknowledge list.
  for (const id of direct) {
    const current = versionOf(kb, id);
    const acknowledged = seen.get(id);

    if (acknowledged === undefined) {
      reported.add(id);
      notifications.push({
        lane,
        reason: "never-acknowledged",
        id,
        acknowledgedVersion: null,
        currentVersion: current,
        via: [id],
        message: `${LANE_LABEL[lane]} depends on ${id} and has never acknowledged it`,
      });
    } else if (current !== null && current !== acknowledged) {
      reported.add(id);
      notifications.push({
        lane,
        reason: "dependency-changed",
        id,
        acknowledgedVersion: acknowledged,
        currentVersion: current,
        via: [id],
        message: `${id} moved v${acknowledged} -> v${current} since ${LANE_LABEL[lane]} last acknowledged it`,
      });
    }
  }

  // 2. Upstream of what this lane owns, beyond one hop. The walk starts from each
  //    changed *acknowledged* item and asks what of this lane's own it reaches —
  //    which is the direction `impactOf` goes, against the arrows.
  const ownIds = new Set(
    kb
      .query({ module })
      .filter((item) => laneOf(item.owner) === lane)
      .map((item) => item.id),
  );

  for (const [id, acknowledged] of seen) {
    const current = versionOf(kb, id);
    if (current === null || current === acknowledged) continue;

    for (const entry of impactOf(kb, id, { stopAt: ["decision"] })) {
      if (!ownIds.has(entry.item.id) || reported.has(id) || entry.depth < 2) continue;
      reported.add(id);
      notifications.push({
        lane,
        reason: "upstream-changed",
        id,
        acknowledgedVersion: acknowledged,
        currentVersion: current,
        via: [id, entry.from, entry.item.id],
        message:
          `${id} moved v${acknowledged} -> v${current}, and ${entry.item.id} (owned by ${LANE_LABEL[lane]}) reaches it ` +
          `through ${entry.from} — ${entry.depth} hop(s) away, so it will not show up as a direct dependency`,
      });
      break;
    }
  }

  // 3. This lane's own gate, when the change knocked it over.
  const approved = kb.query({ module }).filter((item) => laneOf(item.owner) === lane && item.status === "approved");
  const verdict = signoffVerdict(workspace, approved);
  if (verdict.state === "stale") {
    for (const id of verdict.changed) {
      notifications.push({
        lane,
        reason: "signoff-invalidated",
        id,
        acknowledgedVersion: verdict.signoff?.items.find((i) => i.id === id)?.version ?? null,
        currentVersion: versionOf(kb, id),
        via: [id],
        message:
          `${id} changed since ${verdict.signoff?.by} signed the ${LANE_LABEL[lane]} lane off — the gate has reopened ` +
          "and the lane needs signing again",
      });
    }
  }

  const order: Record<NotificationReason, number> = {
    "signoff-invalidated": 0,
    "dependency-changed": 1,
    "never-acknowledged": 2,
    "upstream-changed": 3,
  };
  return notifications.sort((a, b) => order[a.reason] - order[b.reason] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface LanePropagation {
  lane: RoleLane;
  notifications: Notification[];
}

/**
 * Every lane's notifications for one module, in lane order.
 *
 * Every lane is asked, always — there is no "affected lanes" shortlist to be
 * wrong about. A lane with nothing to hear returns an empty list, which is a
 * different and visible thing from a lane nobody asked.
 */
export function propagate(
  module: string | null,
  kb: KnowledgeBase,
  workspaces: (lane: RoleLane) => RoleWorkspace,
): LanePropagation[] {
  return ROLE_LANES.map((lane) => ({ lane, notifications: notificationsFor(lane, module, kb, workspaces(lane)) }));
}

/**
 * Which lanes would hear about a specific set of items changing, before the
 * change is made.
 *
 * The question `sta roles impact <id>` answers, and the one an amend should ask
 * first: `impactOf` walks against the arrows from each id and every dependent is
 * attributed to its owner's lane. Unlike `notificationsFor`, this needs no
 * watermark — it is about the graph, not about who has read what.
 */
export function lanesAffectedBy(kb: KnowledgeBase, changedIds: string[]): Map<RoleLane, KnowledgeItem[]> {
  const byLane = new Map<RoleLane, KnowledgeItem[]>();

  for (const id of changedIds) {
    const changed = kb.get(id);
    // The changed item's own lane counts: amending your own approved work is
    // exactly what invalidates your own sign-off.
    const reached = changed ? [changed, ...impactOf(kb, id, { stopAt: ["decision"] }).map((e) => e.item)] : [];

    for (const item of reached) {
      const lane = laneOf(item.owner);
      if (lane === null) continue;
      const list = byLane.get(lane) ?? [];
      if (!list.some((existing) => existing.id === item.id)) list.push(item);
      byLane.set(lane, list);
    }
  }

  for (const list of byLane.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return byLane;
}
