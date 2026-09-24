import { AgentStage } from "../types.js";
import type { KnowledgeItem, KnowledgeKind } from "../knowledge/knowledgeModel.js";
import { StatusTransitionError, applyTransition, canTransition } from "../knowledge/ownership.js";

/**
 * The one review flow every lane's artefacts go through before anything is
 * marked approved. The underlying rules live in `ownership.ts`: refuse
 * `draft -> approved` directly, refuse an owner reviewing its own work, and
 * let only a person approve. This module is the single entry point that
 * applies those rules through `canTransition` — hand-editing an item's YAML
 * bypasses every one of those checks and the version bump with them.
 *
 * Both `reviewed` and `approved` are human decisions here: an agent's code
 * review is the `reviewer` pipeline stage, never a Knowledge status set from
 * the CLI. The per-kind checklist exists so "reviewed" means the same thing
 * twice — each line is a rule already stated
 * in `policies/` or CLAUDE.md, phrased as a question, not new policy.
 *
 * The reviewer's name is deliberately not stored on the item: it would be a
 * second copy of something git already holds, and items are re-derived by
 * discovery, so an annotation living on the item would be silently wiped by
 * a re-run. A *decision* is stored (a sign-off carries `by`); a *transition*
 * is history, and history is git's job.
 */

/**
 * What a reviewer confirms before moving an item to `reviewed`. Sourced from the
 * rules that already exist, not invented here — each line names the failure it
 * prevents rather than asking for a general opinion, because "does this look
 * right" is the review that always passes.
 */
export const REVIEW_CHECKLIST: Record<KnowledgeKind, string[]> = {
  requirement: [
    "acceptance criteria are stated, and each one could be checked by somebody who did not write it",
    "every external fact has a source, or is written as an unconfirmed assumption — no number is asserted bare",
    "the actors named are roles this project actually has",
  ],
  "business-rule": [
    "the rule is stated as a condition and an outcome, not as a description of a screen",
    "`enforcement` says where it is actually held — code, policy or manual — and not `unknown`",
    "it refines a requirement that exists, rather than floating free",
  ],
  domain: ["the definition would settle an argument between two people using the word differently", "aliases list what the team really says"],
  architecture: [
    "`feasibility` is a decision, not `unknown` — an engineer must never have to decide whether it can be done",
    "every risk that made this feasible-with-risk is written down, not remembered",
    "it refines a requirement that is approved",
  ],
  api: [
    "`contract_name` is set — the backend-before-frontend ordering (agent-boundaries §6a) is derived from it",
    "the response shape is stated concretely enough that a frontend can derive types from it without guessing",
    "the models it reads are in the data model, at the same names",
  ],
  "db-schema": [
    "every field's type and optionality is stated — design.md's Data Model is the contract and is implemented verbatim",
    "relations name models that exist",
    "nothing here contradicts what schema.prisma already has for this model",
  ],
  decision: [
    "the decision says what was chosen AND what was rejected, so it is not re-litigated",
    "if it supersedes another ADR, that one points back",
  ],
  task: [
    "`produces`/`consumes` name real contracts — that pairing is what orders backend before frontend",
    "the phase and the tag match where this work actually sits in plan.md",
    "`plan_status` is not being used to claim a verification only qa-engineer can make",
  ],
  test: [
    "the levels chosen match test-pyramid.yaml rather than defaulting to whatever is easiest",
    "`automated: false` is stated honestly — an unautomated test is one qa-engineer has to list as unverified behaviour",
  ],
  "ux-design": [
    "the artifact refines approved requirement/design knowledge and is stored under the module uxui directory",
    "a human UX/UI sign-off will be current before frontend work begins",
  ],
};

export function checklistFor(kind: KnowledgeKind): string[] {
  return REVIEW_CHECKLIST[kind];
}

/**
 * Moves an item to `reviewed` — a person's decision (V13 TASK-006).
 *
 * Agent code review is the `reviewer` stage STA dispatches and verifies from
 * its own evidence; a CLI call can never claim it. A manual review of a
 * Knowledge item is therefore recorded as what it is: a human act, through
 * `ownership.ts`'s transition rules, touching only the item — never a task,
 * a stage or any evidence. The person's name is echoed by the CLI, not
 * stored on the item (see the module note above).
 */
export function reviewItem(item: KnowledgeItem, now: string): KnowledgeItem {
  const verdict = canTransition(item, "reviewed", AgentStage.HUMAN);
  if (!verdict.allowed) throw new StatusTransitionError(verdict);
  return applyTransition(item, "reviewed", AgentStage.HUMAN, now);
}

/**
 * Moves a `reviewed` item to `approved`. Only ever a person: `applyTransition`
 * enforces it, and this wrapper exists so no caller has to remember to pass
 * `AgentStage.HUMAN` — passing anything else here would be the bug.
 */
export function approveItem(item: KnowledgeItem, now: string): KnowledgeItem {
  return applyTransition(item, "approved", AgentStage.HUMAN, now);
}
