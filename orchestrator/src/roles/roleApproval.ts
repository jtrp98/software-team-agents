import { ApprovalType } from "../gates/approval.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import type { RoleLane } from "./roleLane.js";
import type { LaneSignoff, RoleWorkspace, SignoffItemRef } from "./roleWorkspace.js";

/**
 * Each lane's own approval gate (T103) — the point where the person in that
 * lane says "this is done, the next lane may start".
 *
 * WHY THIS IS NOT THE SAME AS APPROVING AN ITEM
 *
 * `ownership.ts` already makes a *single item* binding: `reviewed -> approved`,
 * a person only. That answers "is this requirement true". It does not answer
 * "is the BA lane finished with this module" — a lane can have every item
 * approved and still be mid-thought, about to add two more. The second question
 * is the one that gates a handoff, and it is the one V1.5's diagram draws as a
 * person under each column.
 *
 * WHY IT REUSES `ApprovalType` INSTEAD OF INVENTING LANE GATE NAMES
 *
 * The gate each lane carries is not a new idea: CLAUDE.md already names five
 * points that always wait for a person, and three of them are exactly one per
 * lane — the requirement interview (BA), the schema confirmation (SA), and the
 * deploy (DEV). `gates/approval.ts` already enumerates all five for the task
 * ledger. A second enum would be two names for one rule.
 *
 * That also closes a gap T100 could only report: `ApprovalType.REQUIREMENT_INTERVIEW`
 * existed in that enum with no edge ever producing it, so the one always-human
 * point CLAUDE.md states most plainly — "business-analyst, any time it runs" —
 * was the only one with nothing enforcing it. It has a gate now.
 *
 * WHY THERE IS NO `pending`
 *
 * The task ledger needs one: it is polled, so "asked and not yet answered" has
 * to be a stored value. Here it is not stored because it is *derived* — a lane
 * whose items are all approved and which has no current sign-off is at stage
 * `awaiting-signoff`, computed from the same two facts every time. Storing it as
 * well would be the second source of truth this whole subsystem avoids.
 *
 * WHY A SIGN-OFF NAMES VERSIONS
 *
 * Because otherwise it is a flag that outlives what it approved. Sign off on
 * REQ-003 v4, amend it to v5, and a status-only record still reads "approved" —
 * which is the T08 failure ("`false` and never-asked were the same value") in a
 * new place. Recording `{id, version}` makes the sign-off go stale by
 * arithmetic the moment its subject changes, and the lane returns to
 * `awaiting-signoff` with the changed ids named.
 */

/** Which of the five always-human points is this lane's gate. */
export const APPROVAL_TYPE_OF_LANE: Record<RoleLane, ApprovalType> = {
  ba: ApprovalType.REQUIREMENT_INTERVIEW,
  sa: ApprovalType.SCHEMA_CONFIRMATION,
  uxui: ApprovalType.UXUI_SIGNOFF,
  dev: ApprovalType.DEPLOY,
};

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

export function itemRefs(items: KnowledgeItem[]): SignoffItemRef[] {
  return items
    .map((item) => ({ id: item.id, version: item.version }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether the lane's sign-off still stands against what is approved right now.
 *
 * A rejection goes stale the same way an approval does, and that is deliberate:
 * "you rejected v4, here is v5" is a new question, not a standing no. A
 * rejection that survived its subject being fixed would be unrevisitable
 * without an override — the mirror of the bug T08 fixed in the other direction.
 */
export function signoffVerdict(workspace: RoleWorkspace, approved: KnowledgeItem[]): SignoffVerdict {
  const signoff = currentSignoff(workspace);
  if (!signoff) return { state: "none", signoff: null, changed: [] };

  const now = new Map(itemRefs(approved).map((ref) => [ref.id, ref.version]));
  const then = new Map(signoff.items.map((ref) => [ref.id, ref.version]));

  const changed = [...new Set([...now.keys(), ...then.keys()])]
    .filter((id) => now.get(id) !== then.get(id))
    .sort();

  if (changed.length > 0) return { state: "stale", signoff, changed };
  return { state: signoff.status === "approved" ? "current" : "rejected", signoff, changed: [] };
}

export class SignoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignoffError";
  }
}

export interface RecordSignoffParams {
  approved: KnowledgeItem[];
  approve: boolean;
  by: string;
  note?: string;
  now: string;
}

/**
 * Appends the person's answer. Never replaces an earlier one — the history is
 * the record of how many times this lane was sent back, which is the thing
 * worth keeping.
 *
 * Refuses an unnamed signer for the same reason `acknowledge()` does: a
 * sign-off with nobody attached is an agent approving on a person's behalf, and
 * this file exists to make that impossible rather than discouraged.
 *
 * Signing off on nothing is refused too. An empty approval reads as "the lane is
 * done" while covering no item at all, so the next amendment would not make it
 * stale and it would stand forever.
 */
export function recordSignoff(
  workspace: RoleWorkspace,
  { approved, approve, by, note, now }: RecordSignoffParams,
): RoleWorkspace {
  if (by.trim() === "") {
    throw new SignoffError(
      "a sign-off needs the name of the person making it — this gate exists precisely so that no agent can pass it",
    );
  }
  if (approved.length === 0) {
    throw new SignoffError(
      "this lane has nothing approved to sign off on — an empty sign-off covers no item, so nothing would ever make it stale",
    );
  }

  const signoff: LaneSignoff = {
    type: APPROVAL_TYPE_OF_LANE[workspace.lane],
    status: approve ? "approved" : "rejected",
    items: itemRefs(approved),
    at: now,
    by,
    note: note ?? null,
  };

  return { ...workspace, signoffs: [...(workspace.signoffs ?? []), signoff], updated_at: now };
}

/** One line describing where the gate stands, for `sta roles` and for a handoff message. */
export function describeSignoff(verdict: SignoffVerdict, lane: RoleLane): string {
  switch (verdict.state) {
    case "none":
      return `nobody has signed off the ${lane.toUpperCase()} lane yet (gate: ${APPROVAL_TYPE_OF_LANE[lane]})`;
    case "current":
      return `signed off by ${verdict.signoff?.by} on ${verdict.signoff?.at.slice(0, 10)}`;
    case "stale":
      return (
        `the sign-off by ${verdict.signoff?.by} no longer covers what is approved — ${verdict.changed.join(", ")} ` +
        "changed since, so it has to be looked at again"
      );
    case "rejected":
      return `rejected by ${verdict.signoff?.by}${verdict.signoff?.note ? `: ${verdict.signoff.note}` : ""}`;
  }
}
