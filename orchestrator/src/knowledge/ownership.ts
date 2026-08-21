import { AgentStage } from "../types.js";
import type { KnowledgeItem, KnowledgeKind, KnowledgeStatus } from "./knowledgeModel.js";
import type { KnowledgeBase } from "./knowledgeBase.js";

/**
 * Ownership and status (T65).
 *
 * `owner` and `status` were fields from T61 with nobody reading them beyond a
 * query filter. This is what reads them: who may move an item to which status,
 * and which roles may own which kind at all.
 *
 * TWO RULES CARRIED IN FROM ELSEWHERE, NOT INVENTED HERE
 *
 *   1. Nobody reviews their own work. T39 established this for the pipeline
 *      (`reviewSeparation.ts`), and a knowledge item is the same situation: an
 *      owner marking their own item `reviewed` records that nothing happened.
 *   2. Only a person approves. `approved` means downstream work may rely on it,
 *      and CLAUDE.md's five always-human points exist precisely because that
 *      kind of commitment is not an agent's to make. An agent proposes; a
 *      person accepts.
 *
 * WHY draft -> approved IS NOT A TRANSITION
 *
 * It is the shortcut that makes review optional, and an optional review is one
 * that stops happening under time pressure. Reaching `approved` requires having
 * passed through `reviewed`, so the record shows two people were involved.
 */

export interface TransitionVerdict {
  allowed: boolean;
  /** Why, in one line — shown to whoever tried. A refusal that does not say what would work costs another attempt. */
  reason: string;
}

/** Roles that may own an item of each kind, from CLAUDE.md's ownership table. `human` may own anything. */
export const ALLOWED_OWNERS: Record<KnowledgeKind, AgentStage[]> = {
  requirement: [AgentStage.BUSINESS_ANALYST],
  "business-rule": [AgentStage.BUSINESS_ANALYST],
  domain: [AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST],
  architecture: [AgentStage.SYSTEM_ANALYST],
  api: [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER],
  "db-schema": [AgentStage.SYSTEM_ANALYST],
  decision: [],
  task: [AgentStage.PROJECT_MANAGER, AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER],
  test: [AgentStage.TEST_PLANNER, AgentStage.QA_ENGINEER],
  "ux-design": [AgentStage.HUMAN],
};

export function mayOwn(kind: KnowledgeKind, role: AgentStage): boolean {
  return role === AgentStage.HUMAN || ALLOWED_OWNERS[kind].includes(role);
}

interface TransitionRule {
  to: KnowledgeStatus;
  /** Who may make it. "owner" = the item's own owner; "not-owner" = anyone but; "human" = a person only; "anyone" = any role. */
  by: "owner" | "not-owner" | "human" | "anyone";
  why: string;
}

const TRANSITIONS: Record<KnowledgeStatus, TransitionRule[]> = {
  draft: [
    { to: "reviewed", by: "not-owner", why: "somebody other than the owner has read it" },
    { to: "deprecated", by: "owner", why: "the owner withdrew it before anyone relied on it" },
  ],
  reviewed: [
    { to: "approved", by: "human", why: "a person accepted it as binding" },
    { to: "draft", by: "anyone", why: "the review sent it back" },
    { to: "deprecated", by: "owner", why: "the owner withdrew it" },
  ],
  approved: [
    { to: "draft", by: "owner", why: "reopened for amendment — it stops being binding while it is being changed" },
    { to: "deprecated", by: "owner", why: "superseded or withdrawn" },
  ],
  deprecated: [{ to: "draft", by: "owner", why: "revived" }],
};

function actorSatisfies(rule: TransitionRule, item: KnowledgeItem, actor: AgentStage): boolean {
  // A person can always act. Every rule below exists to constrain agents, not
  // to stop the person the escalation path leads to.
  if (actor === AgentStage.HUMAN) return true;
  switch (rule.by) {
    case "anyone":
      return true;
    case "owner":
      return actor === item.owner;
    case "not-owner":
      return actor !== item.owner;
    case "human":
      return false;
  }
}

/** Whether `actor` may move `item` to `to`, and why not when they may not. */
export function canTransition(item: KnowledgeItem, to: KnowledgeStatus, actor: AgentStage): TransitionVerdict {
  if (item.status === to) {
    return { allowed: false, reason: `${item.id} is already ${to}` };
  }

  const rule = TRANSITIONS[item.status].find((r) => r.to === to);
  if (!rule) {
    const possible = TRANSITIONS[item.status].map((r) => r.to);
    return {
      allowed: false,
      reason:
        `${item.id} cannot go ${item.status} -> ${to}` +
        (possible.length > 0 ? ` (from ${item.status} it can only go to ${possible.join(", ")})` : ""),
    };
  }

  if (!actorSatisfies(rule, item, actor)) {
    if (rule.by === "human") {
      return { allowed: false, reason: `only a person may mark ${item.id} ${to} — ${rule.why}` };
    }
    if (rule.by === "not-owner") {
      return {
        allowed: false,
        reason: `${actor} owns ${item.id} and cannot review it — ${rule.why}`,
      };
    }
    return { allowed: false, reason: `only ${item.owner} (or a person) may move ${item.id} to ${to}` };
  }

  return { allowed: true, reason: rule.why };
}

export class StatusTransitionError extends Error {
  constructor(public readonly verdict: TransitionVerdict) {
    super(verdict.reason);
    this.name = "StatusTransitionError";
  }
}

/**
 * The item as it is after the transition. Bumps `version`, because status is
 * content: an item that became binding is a different item from the draft it
 * was, and `writeKnowledgeItem` would reject a changed item that did not bump.
 */
export function applyTransition(
  item: KnowledgeItem,
  to: KnowledgeStatus,
  actor: AgentStage,
  now: string,
): KnowledgeItem {
  const verdict = canTransition(item, to, actor);
  if (!verdict.allowed) throw new StatusTransitionError(verdict);
  return { ...item, status: to, version: item.version + 1, updated_at: now };
}

export interface OwnershipProblem {
  id: string;
  problem: string;
}

/** An item owned by a role that does not do that kind of work — usually a conversion that guessed. */
export function checkOwnership(items: KnowledgeItem[]): OwnershipProblem[] {
  return items
    .filter((item) => !mayOwn(item.kind, item.owner))
    .map((item) => ({
      id: item.id,
      problem:
        `owned by ${item.owner}, which does not own ${item.kind} items` +
        (ALLOWED_OWNERS[item.kind].length > 0
          ? ` (expected ${ALLOWED_OWNERS[item.kind].join(", ")} or human)`
          : " (only a person owns a decision)"),
    }));
}

export interface DeprecatedDependency {
  /** The deprecated item. */
  id: string;
  /** Items that still point at it. */
  dependents: string[];
}

/**
 * Deprecated knowledge that something still relies on. The whole point of
 * keeping a deprecated item rather than deleting it is that something still
 * cites it — so this is not "clean these up", it is the list of citations that
 * need re-pointing before the item can go.
 */
export function deprecatedStillDependedOn(kb: KnowledgeBase): DeprecatedDependency[] {
  return kb
    .query({ status: "deprecated" })
    .map((item) => ({
      id: item.id,
      dependents: kb
        .incoming(item.id)
        // A superseding item pointing back at what it replaced is the record
        // working as intended, not a dependency to clean up.
        .filter((d) => !d.relations.some((r) => r.to === item.id && r.type === "supersedes"))
        .map((d) => d.id),
    }))
    .filter((entry) => entry.dependents.length > 0);
}
