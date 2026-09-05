import { AgentStage } from "../types.js";
import { type ViewName, viewNameFor } from "../knowledge/roleView.js";

/**
 * The four lanes — BA, SA, UXUI, DEV, each with a person under it —
 * expressed as a grouping of the eleven AgentStages.
 *
 * `uxui-designer` is what turns the UXUI lane from an empty grouping (UX/UI
 * was human-operated before it existed) into a working one, without changing
 * its gate: the person still signs off.
 *
 * The grouping is derived from `roleView.ts`'s `VIEW_OF`, not declared again:
 * `roleView.ts` already groups the roles into three views by what they do —
 * whoever decides *what to build* reads business, whoever decides *how*
 * reads architecture, whoever builds or checks the built thing reads
 * technical. That is the same partition these lanes describe, so a lane *is*
 * a view, and writing a second role→lane table here would be two groupings
 * free to disagree the first time someone edits one. `VIEW_OF` stays the
 * only place the grouping is stated; this file only renames its three
 * values into lane names.
 *
 * The human is not a lane: `AgentStage.HUMAN` maps to view `all`, and a lane
 * of everything is not a lane. A person does not sit beside the three
 * columns — they sit *under* one, acting in it. So a human is identified by
 * name, in a free-text field, at the moment they decide something — no
 * fourth lane, and no identity system.
 */

export const ROLE_LANES = ["ba", "sa", "uxui", "dev"] as const;
export type RoleLane = (typeof ROLE_LANES)[number];

/** The rename, and the only thing this file declares. `all` has no lane — see the note above. */
const LANE_OF_VIEW: Record<Exclude<ViewName, "all">, RoleLane> = {
  business: "ba",
  architecture: "sa",
  uxui: "uxui",
  technical: "dev",
};

/** What a lane is called in a message to a person. The file format uses the lowercase id. */
export const LANE_LABEL: Record<RoleLane, string> = { ba: "BA", sa: "SA", uxui: "UXUI", dev: "DEV" };

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
 * DEV holds five roles including `qa-engineer` and `security`: a lane says
 * who reads and acknowledges together, not who may be chained to.
 * CLAUDE.md's rule that those two are never auto-invoked in any mode is
 * about invocation and is untouched by this file.
 */
export function rolesInLane(lane: RoleLane): AgentStage[] {
  return Object.values(AgentStage).filter((role) => laneOf(role) === lane);
}
