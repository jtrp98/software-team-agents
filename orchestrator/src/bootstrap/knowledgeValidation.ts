import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { loadKnowledge, writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { applyTransition } from "../knowledge/ownership.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { readBootstrapState, BootstrapStateError } from "./bootstrapStore.js";
import { BootstrapNotSettledError, BootstrapNotStartedError, recordHumanValidation } from "./bootstrapRunner.js";
import type { BootstrapState } from "./bootstrapModel.js";

/**
 * Knowledge Validation — closes the bootstrap flow. Everything discovery wrote
 * is `draft`, owned by whichever stage produced it. This is the step that
 * makes it something the rest of the pipeline may rely on: every item
 * bootstrap's stages produced is walked through the review path
 * (`draft -> reviewed -> approved`, never the shortcut `draft -> approved`)
 * with a person as the actor, and only once that is done does the project's
 * bootstrap status become `ready`.
 *
 * SCOPED TO WHAT BOOTSTRAP ACTUALLY PRODUCED
 *
 * This walks the bootstrap state's `stages[].knowledge_ids`, not `knowledge/` at large: a
 * hand-authored draft unrelated to this bootstrap pass is not this
 * function's business, and silently approving it would be a bigger claim
 * than "a person looked at what discovery found".
 *
 * ONE WRITE PER TRANSITION, NOT PER ITEM
 *
 * `writeKnowledgeItem` requires a changed item's `version` to be exactly one
 * more than what's on disk. An item starting at
 * `draft` needs two transitions to reach `approved`, so it is written twice
 * — once after each transition — rather than once with `version + 2`, which
 * `writeKnowledgeItem` would read as skipping a version and reject.
 */

export interface ValidationSummary {
  /** Item ids this call moved to `approved`. */
  approved: string[];
  /** Item ids already `approved` before this call — nothing to do. */
  alreadyApproved: string[];
  /** Item ids bootstrap discovered but this call could not approve, and why. */
  skipped: Array<{ id: string; reason: string }>;
  bootstrapState: BootstrapState;
}

/**
 * Walks one item through the review path with a person as the actor.
 *
 * Exported because adoption needs the identical step: its per-stage
 * checkpoint is a person looking at what a stage produced, which is what
 * `approved` means. A second implementation of "take this to approved" would be
 * a second opinion about a transition matrix that exists to have exactly one.
 */
export function advanceToApproved(item: KnowledgeItem, now: string, projectRoot: string): KnowledgeItem {
  let current = item;
  if (current.status === "draft") {
    current = applyTransition(current, "reviewed", AgentStage.HUMAN, now);
    writeKnowledgeItem(current, projectRoot);
  }
  if (current.status === "reviewed") {
    current = applyTransition(current, "approved", AgentStage.HUMAN, now);
    writeKnowledgeItem(current, projectRoot);
  }
  return current;
}

/**
 * Reviews and approves every item bootstrap's Discovery stages produced,
 * then records the human validation that moves overall bootstrap status to
 * `ready` (throws `BootstrapNotSettledError`, via `recordHumanValidation`,
 * if a stage is still open — approving what exists does not excuse the
 * stages that have not run yet).
 */
export function validateDiscoveredKnowledge(
  validatedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): ValidationSummary {
  const { state, problems } = readBootstrapState(projectRoot);
  if (problems.length > 0) throw new BootstrapStateError(problems);
  if (!state) throw new BootstrapNotStartedError();
  // Fail before touching anything: approving a partial discovery pass and
  // then finding out `recordHumanValidation` refuses to go `ready` would
  // leave items approved with nothing to show for it.
  if (!state.stages.every((s) => s.status === "done" || s.status === "skipped")) throw new BootstrapNotSettledError();

  const discoveredIds = new Set(state.stages.flatMap((s) => s.knowledge_ids));
  const { items } = loadKnowledge(projectRoot);
  const byId = new Map(items.map((i) => [i.id, i]));

  const approved: string[] = [];
  const alreadyApproved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of discoveredIds) {
    const item = byId.get(id);
    if (!item) {
      skipped.push({ id, reason: "no longer exists in knowledge/" });
      continue;
    }
    if (item.status === "approved") {
      alreadyApproved.push(id);
      continue;
    }
    if (item.status !== "draft" && item.status !== "reviewed") {
      skipped.push({ id, reason: `status is "${item.status}" — validation only advances draft/reviewed items` });
      continue;
    }
    const result = advanceToApproved(item, now, projectRoot);
    if (result.status === "approved") approved.push(id);
    else skipped.push({ id, reason: `left at status "${result.status}"` });
  }

  const bootstrapState = recordHumanValidation(validatedBy, projectRoot, now);
  return { approved, alreadyApproved, skipped, bootstrapState };
}
