import { LANE_SIGNOFF_TYPE, type LaneItemRef } from "../gates/laneApproval.js";
import type { RoleLane } from "./roleLane.js";
import type { LaneSignoff, RoleWorkspace } from "./roleWorkspace.js";

/**
 * Each lane's own approval gate — the point where the person in that lane
 * says "this is done, the next lane may start".
 *
 * Human decision 3 (R14B) folds the two questions into one act: "is this
 * requirement binding" (`reviewed -> approved`) is answered by the lane
 * sign-off that covers the item, and "is the BA lane finished with this
 * module" by the same decision. An item's `status: approved` in its file is
 * not an answer to either — `laneDecisions.ts` reads it as `reviewed` unless
 * a current sign-off covers it.
 *
 * Since V13 TASK-028 the answer is a trusted human decision in STA's lane
 * ledger (`laneApproval.ts`), under the lane's own gate type
 * (`LANE_SIGNOFF_TYPE`: `ba-signoff`, `sa-signoff`, `uxui-signoff`,
 * `dev-signoff`) with its own approver list, and the same decision is what
 * makes the covered items binding. `RoleWorkspace.signoffs` is the projection
 * of those decisions; nothing writes a sign-off anywhere else.
 *
 * There is deliberately no `pending` state stored here. A lane whose items
 * are all approved and which has no current sign-off is at stage
 * `awaiting-signoff`, computed from the same two facts every time — storing
 * it as well would be a second source of truth.
 *
 * A sign-off names versions and content digests rather than being a status
 * flag, because otherwise it outlives what it approved: sign off on REQ-003
 * v4, amend it to v5 (or edit it without bumping), and a status-only record
 * would still read "approved". Recording `{id, version, digest}` makes the
 * sign-off go stale by arithmetic the moment its subject changes, and the lane
 * returns to `awaiting-signoff` with the changed ids named.
 */

export type SignoffState =
  /** Nothing has ever been signed off for this lane. */
  | "none"
  /** The last answer was yes, and it still covers exactly what is approved now. */
  | "current"
  /** There is an answer, but what it covered has changed since. */
  | "stale"
  /** The last answer was no, and it still applies to what is there now. */
  | "rejected";

export interface SignoffVerdict {
  state: SignoffState;
  /** The most recent sign-off, whatever its state. Null only when `state` is "none". */
  signoff: LaneSignoff | null;
  /** Ids that moved, appeared or vanished since the sign-off. Empty unless `state` is "stale". */
  changed: string[];
}

/** The lane's most recent answer. Last wins — a lane is legitimately signed off more than once across a module's life. */
export function currentSignoff(workspace: RoleWorkspace): LaneSignoff | null {
  const signoffs = workspace.signoffs ?? [];
  return signoffs.length === 0 ? null : signoffs[signoffs.length - 1];
}

/**
 * Whether the lane's sign-off still stands against what is approved right now.
 *
 * A rejection goes stale the same way an approval does, and that is deliberate:
 * "you rejected v4, here is v5" is a new question, not a standing no. A
 * rejection that survived its subject being fixed would be unrevisitable
 * without an override.
 */
export function signoffVerdict(workspace: RoleWorkspace, current: readonly LaneItemRef[]): SignoffVerdict {
  const signoff = currentSignoff(workspace);
  if (!signoff) return { state: "none", signoff: null, changed: [] };

  const now = new Map(current.map((ref) => [ref.id, `${ref.version}:${ref.digest}`]));
  const then = new Map(signoff.items.map((ref) => [ref.id, `${ref.version}:${ref.digest}`]));

  const changed = [...new Set([...now.keys(), ...then.keys()])]
    .filter((id) => now.get(id) !== then.get(id))
    .sort();

  if (changed.length > 0) return { state: "stale", signoff, changed };
  return { state: signoff.status === "approved" ? "current" : "rejected", signoff, changed: [] };
}

/** One line describing where the gate stands, for `sta roles` and for a handoff message. */
export function describeSignoff(verdict: SignoffVerdict, lane: RoleLane): string {
  switch (verdict.state) {
    case "none":
      return `nobody has signed off the ${lane.toUpperCase()} lane yet (gate: ${LANE_SIGNOFF_TYPE[lane]})`;
    case "current":
      return `signed off by ${verdict.signoff?.by ?? "unknown actor (host does not expose identity)"} on ${verdict.signoff?.at.slice(0, 10)}`;
    case "stale":
      return (
        `the sign-off by ${verdict.signoff?.by ?? "unknown actor (host does not expose identity)"} no longer covers what is approved — ${verdict.changed.join(", ")} ` +
        "changed since, so it has to be looked at again"
      );
    case "rejected":
      return `rejected by ${verdict.signoff?.by ?? "unknown actor (host does not expose identity)"}${verdict.signoff?.note ? `: ${verdict.signoff.note}` : ""}`;
  }
}
