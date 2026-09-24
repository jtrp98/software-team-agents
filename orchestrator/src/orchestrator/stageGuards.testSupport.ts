import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { laneOf } from "../roles/roleLane.js";
import { recordSignoff } from "../roles/roleApproval.js";
import { acknowledge, emptyWorkspace, writeRoleWorkspace } from "../roles/roleWorkspace.js";
import type { StageEntryGuard } from "./stageGuards.js";

/**
 * Test-only stage-entry guard that admits every stage. It exists so a test
 * about something other than the role lanes can construct an `Orchestrator`
 * or `TaskRegistry` (whose `stageEntryGuard` is required, with no default)
 * without a Knowledge fixture. Nothing in production composes it: every
 * production path passes `createRoleLaneStageGuard`.
 */
export const ALLOW_EVERY_STAGE_TEST_GUARD: StageEntryGuard = () => ({ allowed: true });

/** The module `sampleKnowledge()` is authored for. */
export const LANE_FIXTURE_MODULE = "sales-crm";
export const LANE_FIXTURE_NOW = "2026-08-21T10:00:00Z";

/**
 * Writes `sampleKnowledge()` as approved items under `root/knowledge` - for
 * `module` (default: the module it is authored for; any other name re-homes
 * the module-scoped items, so a fixture named for another module can use it).
 */
export function writeApprovedKnowledge(root: string, module: string = LANE_FIXTURE_MODULE): KnowledgeBase {
  const items = sampleKnowledge().map((item) => ({
    ...item,
    status: "approved" as const,
    ...(item.module === LANE_FIXTURE_MODULE ? { module } : {}),
  })) as KnowledgeItem[];
  for (const item of items) writeKnowledgeItem(item, root, { force: true });
  return new KnowledgeBase(items);
}

/** A person's lane sign-off, recorded the way `sta roles signoff` records it. Returns the signed item ids. */
export function signOffLane(root: string, kb: KnowledgeBase, lane: "ba" | "sa", by = "Nok", module: string = LANE_FIXTURE_MODULE): string[] {
  const items = kb.query({ module }).filter((item) => laneOf(item.owner) === lane);
  writeRoleWorkspace(
    recordSignoff(emptyWorkspace(lane, module, LANE_FIXTURE_NOW), { approved: items, approve: true, by, now: LANE_FIXTURE_NOW }),
    root,
  );
  return items.map((item) => item.id);
}

/** A person's acknowledgement, recorded the way `sta roles ack` records it. */
export function acknowledgeLane(root: string, kb: KnowledgeBase, lane: "sa" | "dev", ids: string[], by = "Somchai", module: string = LANE_FIXTURE_MODULE): void {
  writeRoleWorkspace(acknowledge(emptyWorkspace(lane, module, LANE_FIXTURE_NOW), kb, ids, by, LANE_FIXTURE_NOW), root);
}

/**
 * The full human handoff chain a backend task needs: BA signed off and
 * acknowledged by SA, SA signed off and acknowledged by DEV — each a fixture
 * of a person's recorded act, never something production code creates.
 */
export function writeSignedOffHandoffs(root: string, module: string = LANE_FIXTURE_MODULE): KnowledgeBase {
  const kb = writeApprovedKnowledge(root, module);
  acknowledgeLane(root, kb, "sa", signOffLane(root, kb, "ba", "Nok", module), "Somchai", module);
  acknowledgeLane(root, kb, "dev", signOffLane(root, kb, "sa", "Nok", module), "Somchai", module);
  return kb;
}
