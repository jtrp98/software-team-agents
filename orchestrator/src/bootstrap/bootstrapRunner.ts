import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { emptyLanded, landItem, type LandedItems } from "../knowledge/landing.js";
import type { SourceRecord } from "../knowledge/sourceRegistry.js";
import { writeSourceRecord } from "../knowledge/sourceRegistry.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { readBootstrapState, writeBootstrapState, BootstrapStateError } from "./bootstrapStore.js";
import { ALL_STAGES, computeStatus, newBootstrapState, type BootstrapState, type DiscoveryStageId } from "./bootstrapModel.js";

/**
 * Runs the bootstrap flow: discovery stage → items written into `knowledge/` →
 * bootstrap state updated → repeat → validation → `ready`.
 *
 * `DiscoveryStage` is the seam discovery stages implement against.
 */

export interface DiscoveryResult {
  items: KnowledgeItem[];
  sources: SourceRecord[];
  /** True when this stage found nothing to do for this project and is done without producing anything — still counts as settled. */
  skipped?: boolean;
  note?: string;
}

export interface DiscoveryStage {
  id: DiscoveryStageId;
  discover(projectRoot: string): DiscoveryResult | Promise<DiscoveryResult>;
}

export class BootstrapNotStartedError extends Error {
  constructor() {
    super("no bootstrap in progress — call initBootstrap() first");
    this.name = "BootstrapNotStartedError";
  }
}

export class UnknownBootstrapStageError extends Error {
  constructor(id: string) {
    super(`"${id}" is not a stage this bootstrap is tracking`);
    this.name = "UnknownBootstrapStageError";
  }
}

export class BootstrapNotSettledError extends Error {
  constructor() {
    super("cannot validate — not every discovery stage is done or skipped yet");
    this.name = "BootstrapNotSettledError";
  }
}

/** Idempotent: an existing state file is returned as-is, never reset — bootstrap starts once per project/module. */
export function initBootstrap(
  module: string | null = null,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): BootstrapState {
  const existing = readBootstrapState(projectRoot);
  if (existing.state) return existing.state;
  const state = newBootstrapState(module, now);
  writeBootstrapState(state, projectRoot);
  return state;
}

function requireState(projectRoot: string): BootstrapState {
  const { state, problems } = readBootstrapState(projectRoot);
  if (problems.length > 0) throw new BootstrapStateError(problems);
  if (!state) throw new BootstrapNotStartedError();
  return state;
}

/**
 * Runs one discovery stage: lands every item and source it produced (through
 * the shared `landing.ts` rule), marks the stage `done`/`skipped` with the
 * item ids it left behind, and persists the recomputed overall status.
 * Each stage's items land in `knowledge/` through the same
 * `writeKnowledgeItem`/`writeSourceRecord` every other writer uses.
 *
 * A stage that lands new material after somebody has validated this bootstrap
 * clears that validation: `ready` means a person reviewed what is there, and
 * there is now something they have not seen.
 */
export async function runBootstrapStage(
  stage: DiscoveryStage,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): Promise<BootstrapState> {
  const state = requireState(projectRoot);
  const record = state.stages.find((s) => s.id === stage.id);
  if (!record) throw new UnknownBootstrapStageError(stage.id);

  const result = await stage.discover(projectRoot);

  for (const source of result.sources) writeSourceRecord(source, projectRoot);
  const landed: LandedItems = emptyLanded();
  for (const item of result.items) landItem(item, projectRoot, now, landed);

  record.status = result.skipped ? "skipped" : "done";
  record.completed_at = now;
  // Everything the stage found, including what it declined to overwrite:
  // validation still has to account for those, and dropping them would hide them.
  record.knowledge_ids = result.items.map((i) => i.id);
  if (landed.conflicts.length > 0) record.conflict_ids = landed.conflicts;
  else delete record.conflict_ids;

  const notes: string[] = [];
  if (result.note !== undefined) notes.push(result.note);
  if (landed.conflicts.length > 0) {
    notes.push(
      `left ${landed.conflicts.length} reviewed item(s) untouched because the material now says something different: ${landed.conflicts.join(", ")}`,
    );
  }
  if (notes.length > 0) record.note = notes.join(" · ");
  else delete record.note;

  if (landed.written.length > 0 && state.validated_by !== null) {
    state.validated_by = null;
    state.validated_at = null;
  }

  state.status = computeStatus(state);
  state.updated_at = now;
  writeBootstrapState(state, projectRoot);
  return state;
}

/**
 * Records that a person reviewed everything discovery produced.
 * Refuses while any stage is still pending/in_progress: approving knowledge
 * that has not finished arriving is not what "Ready" is supposed to mean.
 */
export function recordHumanValidation(
  validatedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): BootstrapState {
  const state = requireState(projectRoot);
  const settled = state.stages.every((s) => s.status === "done" || s.status === "skipped");
  if (!settled) throw new BootstrapNotSettledError();

  state.validated_by = validatedBy;
  state.validated_at = now;
  state.status = computeStatus(state);
  state.updated_at = now;
  writeBootstrapState(state, projectRoot);
  return state;
}

export { ALL_STAGES };
