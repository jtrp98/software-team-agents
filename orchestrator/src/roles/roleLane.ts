import { AgentStage } from "../types.js";
import { type ViewName, viewNameFor } from "../knowledge/roleView.js";

/**
 * The three lanes of V1.5's diagram (T99) — BA, SA, DEV, each with a person
 * under it — expressed as a grouping of the ten AgentStages.
 *
 * WHY THIS IS DERIVED FROM T67 AND NOT DECLARED
 *
 * `roleView.ts` already groups the ten roles into three views by what they do:
 * whoever decides *what to build* reads business, whoever decides *how* reads
 * architecture, whoever builds or checks the built thing reads technical. That
 * is the same partition V1.5's three columns describe — so a lane *is* a view,
 * and writing a second role→lane table here would be two groupings free to
 * disagree the first time someone edits one. `VIEW_OF` stays the only place the
 * grouping is stated; this file only renames its three values into the words
 * the V1.5 diagram uses.
 *
 * This is also what settles the open question HANDOFF_V1.md §16.5 left for
 * V1.5: `viewNameFor()` had no caller and was pending a use-or-delete
 * decision. It is used, here, as the lane key.
 *
 * WHY THE HUMAN IS NOT A LANE
 *
 * `AgentStage.HUMAN` maps to view `all`, and a lane of everything is not a
 * lane. The person in V1.5's diagram does not sit beside the three columns —
 * they sit *under* one, acting in it. So a human is identified the way T08
 * already identifies one: by name, in a free-text field, at the moment they
 * decide something. No fourth lane, and no identity system.
 */

export const ROLE_LANES = ["ba", "sa", "dev"] as const;
export type RoleLane = (typeof ROLE_LANES)[number];

/** The rename, and the only thing this file declares. `all` has no lane — see the note above. */
const LANE_OF_VIEW: Record<Exclude<ViewName, "all">, RoleLane> = {
  business: "ba",
  architecture: "sa",
  technical: "dev",
};

/** What a lane is called in a message to a person. The file format uses the lowercase id. */
export const LANE_LABEL: Record<RoleLane, string> = { ba: "BA", sa: "SA", dev: "DEV" };

export function isRoleLane(value: string): value is RoleLane {
  return (ROLE_LANES as readonly string[]).includes(value);
}

/** Which lane a role works in, or null for `human` — who works in all of them, one at a time. */
export function laneOf(role: AgentStage): RoleLane | null {
  const view = viewNameFor(role);
  return view === "all" ? null : LANE_OF_VIEW[view];
}

/**
 * Every role in a lane, in the canonical AgentStage order so two callers never
 * get differently-ordered lists for the same lane.
 *
 * DEV holds five roles including `qa-engineer` and `security`, and that is not
 * a change to how they run: a lane says who reads and acknowledges together,
 * not who may be chained to. CLAUDE.md's rule that those two are never
 * auto-invoked in any mode is about invocation and is untouched by this file.
 */
export function rolesInLane(lane: RoleLane): AgentStage[] {
  return Object.values(AgentStage).filter((role) => laneOf(role) === lane);
}
