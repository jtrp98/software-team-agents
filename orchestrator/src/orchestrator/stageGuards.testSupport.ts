import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import type { LaneAction, LaneApprovalRecord } from "../gates/laneApproval.js";
import { testHumanVerifier, trustedCredential } from "../gates/humanDecision.testSupport.js";
import { LaneDecisionService } from "../roles/laneDecisions.js";
import type { RoleLane } from "../roles/roleLane.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import type { TaskStore } from "../store/taskStore.js";
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
 * Writes `sampleKnowledge()` under `root/knowledge` with `status: approved` in
 * every file - for `module` (default: the module it is authored for; any other
 * name re-homes the module-scoped items). Since V13 TASK-028 that word in a
 * file grants nothing: STA reads these items as `reviewed` until a lane
 * sign-off decision covers them.
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

/** Where a fixture's lane decisions go: an open task store, or the SQLite state file a CLI invocation will open. */
export type LaneLedgerFixture = TaskStore | string;

async function withLedger<T>(ledger: LaneLedgerFixture, fn: (store: TaskStore) => Promise<T>): Promise<T> {
  if (typeof ledger !== "string") return fn(ledger);
  const store = new SqliteTaskStore(ledger);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * A person's lane decision, recorded the way `sta roles signoff|ack` records
 * it: STA opens the request over the current items, and the test-only trusted
 * channel (`testHumanVerifier`) attests the answer. Every ledger check
 * (pending, scope, replay, stale) runs exactly as in production.
 */
export async function decideLane(
  ledger: LaneLedgerFixture,
  knowledgeRoot: string,
  module: string,
  lane: RoleLane,
  action: LaneAction,
  options: { ids?: readonly string[]; approved?: boolean; actorId?: string } = {},
): Promise<LaneApprovalRecord> {
  return withLedger(ledger, async (store) => {
    const service = new LaneDecisionService({ store, verifier: testHumanVerifier() });
    const request = service.request(knowledgeRoot, module, lane, action, options.ids);
    const { record } = await service.submit({
      requestId: request.requestId,
      approved: options.approved ?? true,
      credential: trustedCredential(options.actorId === undefined ? {} : { actorId: options.actorId }),
    });
    return record;
  });
}

/** A person's lane sign-off through the test channel. Returns the signed item ids. */
export async function signOffLane(
  knowledgeRoot: string,
  lane: RoleLane,
  module: string = LANE_FIXTURE_MODULE,
  ledger: LaneLedgerFixture = defaultStateDbPath(knowledgeRoot),
): Promise<string[]> {
  const record = await decideLane(ledger, knowledgeRoot, module, lane, "signoff");
  return record.scope.items.map((item) => item.id);
}

/** A person's acknowledgement through the test channel. */
export async function acknowledgeLane(
  knowledgeRoot: string,
  lane: RoleLane,
  ids: readonly string[],
  module: string = LANE_FIXTURE_MODULE,
  ledger: LaneLedgerFixture = defaultStateDbPath(knowledgeRoot),
): Promise<void> {
  await decideLane(ledger, knowledgeRoot, module, lane, "ack", { ids });
}

/**
 * The full human handoff chain a backend task needs: BA signed off and
 * acknowledged by SA, SA signed off and acknowledged by DEV — each a trusted
 * decision in the lane ledger, never a file. `ledger` defaults to the state
 * file under `knowledgeRoot`; pass the store (or state file) the engine under
 * test actually reads.
 */
export async function writeSignedOffHandoffs(
  knowledgeRoot: string,
  module: string = LANE_FIXTURE_MODULE,
  ledger: LaneLedgerFixture = defaultStateDbPath(knowledgeRoot),
): Promise<KnowledgeBase> {
  const kb = writeApprovedKnowledge(knowledgeRoot, module);
  await acknowledgeLane(knowledgeRoot, "sa", await signOffLane(knowledgeRoot, "ba", module, ledger), module, ledger);
  await acknowledgeLane(knowledgeRoot, "dev", await signOffLane(knowledgeRoot, "sa", module, ledger), module, ledger);
  return kb;
}
