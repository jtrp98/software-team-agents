import type { LaneRetrieval } from "../roles/laneContext.js";
import { LANE_LABEL, type RoleLane } from "../roles/roleLane.js";

/**
 * The presentation boundary for knowledge retrieval.  Its input is a
 * LaneRetrieval, never a raw KnowledgeItem: callers cannot accidentally render
 * a field before laneGet() and the field policy have had their say.
 */
export interface RenderedKnowledgeRetrieval {
  text: string;
  json: Record<string, unknown>;
}

function withheldFields(outcome: Extract<LaneRetrieval, { status: "ok" }>): string[] {
  return [...new Set([...outcome.item.item.withheld, ...outcome.item.provenance.withheld])].sort();
}

export function renderKnowledgeRetrieval(
  lane: RoleLane,
  id: string,
  outcome: LaneRetrieval,
): RenderedKnowledgeRetrieval {
  if (outcome.status === "not-found") {
    return {
      text: `[orchestrator] no knowledge item with id ${id}`,
      json: { id, status: "not_found" },
    };
  }
  if (outcome.status === "withheld") {
    return {
      text: `[orchestrator] ${id}: withheld — ${outcome.reason}`,
      json: { id, status: "withheld", reason: outcome.reason },
    };
  }

  const { item, viaRole, provenance } = outcome.item;
  const withheld = withheldFields(outcome);
  const value: Record<string, unknown> = {
    id: item.id,
    lane,
    via_role: viaRole,
    title: item.title,
    kind: item.kind,
    status: item.status,
    owner: item.owner,
    citation: provenance.citation,
    withheld_fields: withheld,
  };
  // Do not emit a redacted value (including an empty-string/body or empty
  // object/payload placeholder): absence is what keeps JSON as safe as text.
  if (!withheld.includes("body")) value.body = item.body;
  if (!withheld.includes("payload")) value.payload = item.payload;
  if (!withheld.includes("relations")) value.relations = item.relations;

  const lines = [
    `[orchestrator] ${item.id} as the ${LANE_LABEL[lane]} lane sees it (via ${viaRole}):`,
    `  ${item.title} [${item.kind}, ${item.status}, owned by ${item.owner}]`,
  ];
  if (!withheld.includes("body")) lines.push(`  body: ${item.body}`);
  if (!withheld.includes("payload")) lines.push(`  payload: ${JSON.stringify(item.payload)}`);
  lines.push(`  citation: ${provenance.citation}`);
  if (!withheld.includes("relations")) lines.push(`  relations: ${JSON.stringify(item.relations)}`);
  if (withheld.length > 0) lines.push(`  withheld: ${withheld.join(", ")}`);
  return { text: lines.join("\n"), json: value };
}
