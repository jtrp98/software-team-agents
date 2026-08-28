import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { CONTEXT_POLICY, type ContextCategory } from "../context/contextSelection.js";
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "./knowledgeModel.js";
import { ALLOWED_OWNERS } from "./ownership.js";
import type { KnowledgeBase, KnowledgeQuery } from "./knowledgeBase.js";
import type { KnowledgeItem } from "./knowledgeModel.js";

/**
 * Role views (T67) — BA sees the Business View, SA the Architecture View, DEV
 * the Technical View, all filtered out of the one knowledge base rather than
 * copied into three.
 *
 * WHY THIS IS DERIVED AND NOT DECLARED
 *
 * There is already a per-role read policy: `CONTEXT_POLICY` (T05), which says
 * which document categories each of the ten roles may read. Writing a second
 * table here — "which kinds may each role see" — would create two permission
 * models that agree today and diverge the first time somebody edits one. So
 * the kind list is *computed*: a role may see the kinds carried by the
 * documents it is already allowed to read.
 *
 * Two things are unioned on top of that, and neither is a new policy:
 *
 *   - **What the role owns.** `CONTEXT_POLICY` lists what a role reads from
 *     *other* agents, so `system-analyst` — which writes `design.md` — does not
 *     appear as a reader of it. Deriving from reads alone would hand the
 *     Architecture View a role that cannot see architecture. The owner table is
 *     `ALLOWED_OWNERS` (T65), already written; "you can see what you own" is
 *     not a permission call anyone would dispute.
 *   - **`decision`, for everyone.** ADRs are project-wide settled calls that
 *     CLAUDE.md has every agent read instead of re-litigating, and no single
 *     document category carries them. Hiding one from a role means that role
 *     re-decides what the project already decided — the exact failure ADRs
 *     exist to prevent.
 */

export type ViewName = "business" | "architecture" | "uxui" | "technical" | "all";

/** Which knowledge kinds a document category carries. `review.md`, `security.md` and code are not knowledge kinds — they are records and artefacts, so they map to nothing. */
export const KINDS_BY_CATEGORY: Record<ContextCategory, KnowledgeKind[]> = {
  [ArtifactType.REQUIREMENTS]: ["requirement", "business-rule", "domain"],
  [ArtifactType.DESIGN]: ["architecture", "api", "db-schema", "domain"],
  [ArtifactType.PLAN]: ["task"],
  [ArtifactType.TEST_PLAN]: ["test"],
  [ArtifactType.QA_REPORT]: [],
  [ArtifactType.SECURITY_REPORT]: [],
  // A handoff only points at authoritative items; it carries no new kind.
  [ArtifactType.HANDOFF]: [],
  // Execution packets are Local Runtime State, not durable knowledge.
  [ArtifactType.EXECUTION_PACKET]: [],
  "backend-code": [],
  "frontend-code": [],
  "devops-docs": [],
  "ux-research": [],
  // The QA evidence package is assembled per round by the orchestrator from
  // artifacts and scope — it carries no knowledge kind of its own.
  "qa-evidence": [],
  // Same reasoning: the knowledge brief is assembled per module by
  // knowledgeBriefAssembly from knowledge/ YAML, not a document with kinds.
  "knowledge-brief": [],
};

/** Everyone sees ADRs — see the note above. */
const ALWAYS_VISIBLE: KnowledgeKind[] = ["decision"];

/**
 * The three views V1.1 names, with the ten roles grouped onto them by what
 * they do rather than by where they sit in the pipeline: whoever decides *what
 * to build* reads business, whoever decides *how* reads architecture, whoever
 * builds or checks the built thing reads technical.
 */
export const VIEW_OF: Record<AgentStage, ViewName> = {
  [AgentStage.BUSINESS_ANALYST]: "business",
  [AgentStage.SYSTEM_ANALYST]: "architecture",
  [AgentStage.PROJECT_MANAGER]: "architecture",
  [AgentStage.TEST_PLANNER]: "architecture",
  [AgentStage.SETUP]: "architecture",
  [AgentStage.UXUI_DESIGNER]: "uxui",
  [AgentStage.BACKEND_ENGINEER]: "technical",
  [AgentStage.FRONTEND_ENGINEER]: "technical",
  [AgentStage.QA_ENGINEER]: "technical",
  [AgentStage.SECURITY]: "technical",
  [AgentStage.DEVOPS]: "technical",
  [AgentStage.HUMAN]: "all",
};

export function viewNameFor(role: AgentStage): ViewName {
  return VIEW_OF[role];
}

/** The kinds a role may see, derived from its context policy. A person sees everything. */
export function kindsFor(role: AgentStage): KnowledgeKind[] {
  if (role === AgentStage.HUMAN) return [...KNOWLEDGE_KINDS];

  const policy = CONTEXT_POLICY[role];
  const visible = new Set<KnowledgeKind>(ALWAYS_VISIBLE);
  for (const category of policy?.reads ?? []) {
    for (const kind of KINDS_BY_CATEGORY[category]) visible.add(kind);
  }
  for (const kind of KNOWLEDGE_KINDS) {
    if (ALLOWED_OWNERS[kind].includes(role)) visible.add(kind);
  }
  // Returned in the canonical kind order, not in policy order, so two roles
  // with the same kinds produce identical lists.
  return KNOWLEDGE_KINDS.filter((k) => visible.has(k));
}

export function canSeeKind(role: AgentStage, kind: KnowledgeKind): boolean {
  return kindsFor(role).includes(kind);
}

export class KnowledgeViewError extends Error {
  constructor(role: AgentStage, kind: KnowledgeKind) {
    super(`${role} does not see ${kind} items — its context policy does not include the documents that carry them`);
    this.name = "KnowledgeViewError";
  }
}

/**
 * One role's slice of the knowledge base.
 *
 * Asking for a kind the role cannot see throws rather than quietly returning
 * fewer results — the same choice `selectContext()` made for documents. A
 * caller that names a category out of policy has a bug, and silently pruning
 * it turns that bug into a wrong answer nobody investigates.
 */
export function viewFor(role: AgentStage, kb: KnowledgeBase, filter: KnowledgeQuery = {}): KnowledgeItem[] {
  const allowed = kindsFor(role);

  if (filter.kinds) {
    for (const kind of filter.kinds) {
      if (!allowed.includes(kind)) throw new KnowledgeViewError(role, kind);
    }
  }

  return kb.query({ ...filter, kinds: filter.kinds ?? allowed });
}
