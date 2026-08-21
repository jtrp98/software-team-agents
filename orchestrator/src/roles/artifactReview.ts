import { AgentStage } from "../types.js";
import type { KnowledgeItem, KnowledgeKind } from "../knowledge/knowledgeModel.js";
import { StatusTransitionError, applyTransition, canTransition } from "../knowledge/ownership.js";
import { canSeeKind } from "../knowledge/roleView.js";
import { laneOf } from "./roleLane.js";

/**
 * The one review flow every lane's artefacts go through (T104), before anything
 * is marked approved.
 *
 * WHAT WAS ALREADY THERE
 *
 * The *rules* were: `ownership.ts` refuses `draft -> approved`, refuses an owner
 * reviewing its own work (T39's principle), and lets only a person approve. What
 * was missing was a way to actually perform a review that applies them — the
 * only way to move an item was to hand-edit its YAML, which bypasses every one
 * of those checks and the version bump with them.
 *
 * SO THIS ADDS THREE THINGS, NOT A NEW STATE MACHINE
 *
 *   1. **One entry point** that applies the transition through `canTransition`,
 *      so the rules cannot be walked around by editing a file.
 *   2. **A reviewer must be able to read the kind.** `canSeeKind` (T67) decides
 *      it. A role whose context policy never puts `db-schema` in front of it
 *      cannot meaningfully review a `db-schema`, and letting it sign one as
 *      reviewed records that a check happened when none did — the same emptiness
 *      T39 objects to in self-review, one step out.
 *   3. **A checklist per kind**, so "reviewed" means the same thing twice. Every
 *      line below is a rule stated somewhere in `policies/` or CLAUDE.md, phrased
 *      as the question a reviewer has to answer; none of them is new policy
 *      invented here.
 *
 * WHY THE REVIEWER'S NAME IS NOT STORED ON THE ITEM
 *
 * It would be a second copy of something git already holds — the same reasoning
 * T63 used to reject a sidecar history file, and the reason `knowledge/` is
 * one-file-per-item in the first place. There is a sharper reason too: items are
 * re-derived by discovery (T74-T79), so an annotation living on the item would
 * be silently wiped by a re-run, and a record that disappears without anybody
 * noticing is worse than no record. A *decision* is stored (T103's sign-off
 * carries `by`); a *transition* is history, and history is git's job.
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

export class ArtifactReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactReviewError";
  }
}

/**
 * Moves an item to `reviewed` on behalf of `reviewer`.
 *
 * Two refusals before the transition is even attempted, both stated here rather
 * than left to `canTransition`, because its message would be right and unhelpful:
 * "cannot go draft -> reviewed" does not tell the caller that the problem is who
 * is asking.
 */
export function reviewItem(item: KnowledgeItem, reviewer: AgentStage, now: string): KnowledgeItem {
  if (reviewer === AgentStage.HUMAN) {
    // A person can do anything (ownership.ts's HUMAN bypass), but doing *this*
    // as "human" loses the one fact a review record carries: which discipline
    // looked at it. Ask for the role they were acting as.
    throw new ArtifactReviewError(
      `name the role ${item.id} was reviewed as, not "human" — a review's whole content is which discipline looked at it`,
    );
  }
  if (!canSeeKind(reviewer, item.kind)) {
    throw new ArtifactReviewError(
      `${reviewer} does not see ${item.kind} items (T67), so it cannot review ${item.id} — marking it reviewed would ` +
        "record a check that did not happen",
    );
  }

  const verdict = canTransition(item, "reviewed", reviewer);
  if (!verdict.allowed) throw new StatusTransitionError(verdict);
  return applyTransition(item, "reviewed", reviewer, now);
}

/**
 * Moves a `reviewed` item to `approved`. Only ever a person: `applyTransition`
 * enforces it, and this wrapper exists so no caller has to remember to pass
 * `AgentStage.HUMAN` — passing anything else here would be the bug.
 */
export function approveItem(item: KnowledgeItem, now: string): KnowledgeItem {
  return applyTransition(item, "approved", AgentStage.HUMAN, now);
}

export interface ReviewerSuggestion {
  role: AgentStage;
  why: string;
}

/**
 * Who could review this item — every role that may see the kind and does not own
 * the item. Returned as a list rather than one answer: T39's rule is "not the
 * owner", not "this specific reviewer", and naming a single one would quietly
 * become a requirement nobody agreed to.
 *
 * The downstream lane is listed first, because it is the one that has to live
 * with the artefact being wrong.
 */
export function reviewersFor(item: KnowledgeItem): ReviewerSuggestion[] {
  const ownerLane = laneOf(item.owner);
  return Object.values(AgentStage)
    .filter((role) => role !== AgentStage.HUMAN && role !== item.owner && canSeeKind(role, item.kind))
    .map((role) => ({
      role,
      why:
        laneOf(role) !== ownerLane
          ? "in a different lane — it is the one that has to live with this being wrong"
          : "same lane, different role",
    }))
    .sort((a, b) => (laneOf(a.role) === ownerLane ? 1 : 0) - (laneOf(b.role) === ownerLane ? 1 : 0));
}
