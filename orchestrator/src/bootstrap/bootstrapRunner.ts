import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import type { SourceRecord } from "../knowledge/sourceRegistry.js";
import { writeSourceRecord } from "../knowledge/sourceRegistry.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { readBootstrapState, writeBootstrapState, BootstrapStateError } from "./bootstrapStore.js";
import { ALL_STAGES, computeStatus, newBootstrapState, type BootstrapState, type DiscoveryStageId } from "./bootstrapModel.js";

/**
 * Runs the T73 flow: discovery stage → items written into `knowledge/` →
 * bootstrap state updated → repeat → T80 validation → `ready`.
 *
 * `DiscoveryStage` is the seam T74-T79 implement against. None of them exist
 * yet, so this module and its tests only know the interface, not a single
 * real stage — the same relationship `fromArtifacts.ts` (T61) has to the
 * Markdown parsers T75/T83/T84/T85 will eventually call it from.
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
 * Runs one discovery stage: writes every item and source it produced, marks
 * the stage `done`/`skipped` with the item ids it left behind, and persists
 * the recomputed overall status. Each stage's items land in `knowledge/`
 * through the same `writeKnowledgeItem`/`writeSourceRecord` every other
 * writer uses — bootstrap does not get a second way to write an item.
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
  for (const item of result.items) writeKnowledgeItem(item, projectRoot, { force: true });

  record.status = result.skipped ? "skipped" : "done";
  record.completed_at = now;
  record.knowledge_ids = result.items.map((i) => i.id);
  if (result.note !== undefined) record.note = result.note;

  state.status = computeStatus(state);
  state.updated_at = now;
  writeBootstrapState(state, projectRoot);
  return state;
}

/**
 * T80 — records that a person reviewed everything discovery produced.
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
