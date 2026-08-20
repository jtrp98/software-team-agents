import { AgentStage } from "../types.js";
import type {
  DesignArtifact,
  PlanArtifact,
  RequirementsArtifact,
  TestPlanArtifact,
} from "../artifacts/schemas.js";
import type { Adr } from "../decisions/decisionLog.js";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeItem,
  type KnowledgeItemOf,
  type KnowledgeStatus,
  type Relation,
  type SourceRef,
} from "./knowledgeModel.js";

/**
 * Artifacts the pipeline already produces -> knowledge items (T61).
 *
 * WHY THIS IS IN T61 AND NOT LATER
 *
 * Without it, T61 ships a schema with no data in it and no evidence that the
 * model can hold what the pipeline already has. With it, the claim "the shared
 * model mirrors the existing artifacts" is a test rather than an assertion —
 * and it is the seam T75/T83/T84/T85 call when a stage finishes.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No Markdown parsing. Reading `requirement.md` / `design.md` prose back into
 * items is discovery/migration work (V1.2/V1.3) with its own failure modes;
 * this converts the *validated* artifact objects (`artifacts/schemas.ts`), where
 * every field is already typed and present.
 *
 * DANGLING RELATIONS ARE EXPECTED HERE
 *
 * Converting a design without its requirement leaves `DES-x refines REQ-x`
 * pointing at nothing. That is reported by `check()` and not thrown: during
 * discovery knowledge arrives in batches, and a batch that cannot reference
 * what has not landed yet would force the caller to convert everything at once
 * or lose the edges.
 */

export interface ConversionContext {
  /** `_docs/module/<name>`; null for project-wide items. */
  module: string | null;
  repo?: string | null;
  /**
   * ISO date-time for created_at/updated_at/captured_at. Passed in rather than
   * read from the clock: the orchestrator knows the real time, an agent editing
   * a file by hand has to ask the user (CLAUDE.md), and a test needs it fixed.
   */
  now: string;
  /**
   * Use the requirement id the module documents already gave this work
   * (`REQ-003`), instead of one derived from the artifact's taskId. Set it
   * whenever the docs have one — that shared id is what keeps this graph and
   * `traceability.ts` talking about the same requirement.
   */
  requirementId?: string;
  /** Same, for the design/architecture id (`DES-003`). */
  architectureId?: string;
}

/** Trims an artifact taskId down to what an id may contain, so `T 1/a` cannot produce an unloadable filename. */
function idKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "unknown" : cleaned;
}

export function requirementIdFor(context: ConversionContext, taskId: string): string {
  return context.requirementId ?? `REQ-${idKey(taskId)}`;
}

export function architectureIdFor(context: ConversionContext, taskId: string): string {
  return context.architectureId ?? `DES-${idKey(taskId)}`;
}

function agentSource(role: AgentStage, note: string, now: string): SourceRef {
  return { type: "agent", locator: role, captured_at: now, digest: null, note };
}

function envelope(
  context: ConversionContext,
  parts: {
    id: string;
    title: string;
    body: string;
    owner: AgentStage;
    sources: SourceRef[];
    relations?: Relation[];
    status?: KnowledgeStatus;
    sensitive?: boolean;
    module?: string | null;
  },
) {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: parts.id,
    title: parts.title,
    body: parts.body,
    repo: context.repo ?? null,
    module: parts.module === undefined ? context.module : parts.module,
    owner: parts.owner,
    // Everything starts as draft. An artifact passing its own schema means it
    // is well-formed, not that anybody agreed with it — `approved` is a person's
    // word (T65/T103), never a converter's.
    status: parts.status ?? ("draft" as const),
    sensitive: parts.sensitive ?? false,
    version: 1,
    created_at: context.now,
    updated_at: context.now,
    sources: parts.sources,
    relations: parts.relations ?? [],
  };
}

export function requirementItemFrom(
  artifact: RequirementsArtifact,
  context: ConversionContext,
): KnowledgeItemOf<"requirement"> {
  const body = [
    artifact.businessGoal,
    "",
    `In scope: ${artifact.scope.inScope.join("; ")}`,
    artifact.scope.outScope.length > 0 ? `Out of scope: ${artifact.scope.outScope.join("; ")}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  // References carry their own source; the artifact itself is one more.
  const sources: SourceRef[] = [
    agentSource(AgentStage.BUSINESS_ANALYST, `requirements artifact for ${artifact.taskId}`, context.now),
    ...artifact.references.map((ref) => ({
      type: "human" as const,
      locator: ref.source,
      captured_at: context.now,
      digest: null,
      note: ref.fact,
    })),
  ];

  return {
    ...envelope(context, {
      id: requirementIdFor(context, artifact.taskId),
      title: artifact.title,
      body,
      owner: AgentStage.BUSINESS_ANALYST,
      sources,
    }),
    kind: "requirement",
    payload: {
      acceptance_criteria: artifact.acceptanceCriteria,
      actors: artifact.actors,
      priority: null,
      assumption_unconfirmed: artifact.assumptions.some((a) => !a.confirmed),
    },
  };
}

/**
 * One `architecture` item for the design itself, plus one `db-schema` item per
 * model in the Data Model. Split because they are asked about separately —
 * "is this feasible" is a design question, "what fields does Shift have" is a
 * schema question — and a single blob answers neither well.
 */
export function designItemsFrom(artifact: DesignArtifact, context: ConversionContext): KnowledgeItem[] {
  const architectureId = architectureIdFor(context, artifact.taskId);
  const requirementId = requirementIdFor(context, artifact.taskId);
  const source = agentSource(AgentStage.SYSTEM_ANALYST, `design artifact for ${artifact.taskId}`, context.now);

  const body = [
    artifact.feasibility,
    "",
    "Contract:",
    ...artifact.contract.map((c) => `- ${c}`),
    artifact.openQuestions.length > 0 ? "\nOpen questions:" : "",
    ...artifact.openQuestions.map((q) => `- ${q}`),
  ]
    .filter((line) => line !== "")
    .join("\n");

  const architecture: KnowledgeItemOf<"architecture"> = {
    ...envelope(context, {
      id: architectureId,
      title: `Design for ${artifact.taskId}`,
      body,
      owner: AgentStage.SYSTEM_ANALYST,
      sources: [source],
      relations: [{ type: "refines", to: requirementId }],
    }),
    kind: "architecture",
    payload: {
      // The artifact's feasibility is prose, so the enum here can only be honest
      // about not knowing. A converter guessing "feasible" from free text is how
      // a risk disappears.
      feasibility: artifact.risks.length > 0 ? "feasible-with-risk" : "unknown",
      risks: artifact.risks,
      component: null,
    },
  };

  const models: KnowledgeItem[] = artifact.dataModel.map((model) => ({
    ...envelope(context, {
      id: `DB-${model.model}`,
      title: model.model,
      body: "",
      owner: AgentStage.SYSTEM_ANALYST,
      sources: [source],
      relations: [{ type: "derived-from", to: architectureId }],
    }),
    kind: "db-schema" as const,
    payload: {
      model: model.model,
      // `optional` is not in the artifact's data model, so it is recorded as
      // false rather than invented. design.md remains the contract; this mirrors it.
      fields: model.fields.map((f) => ({ name: f.name, type: f.type, optional: false })),
      relations: [],
    },
  }));

  return [architecture, ...models];
}

function phaseNumber(phaseId: string, phaseName: string, index: number): number {
  const match = /\d+/.exec(phaseId) ?? /\d+/.exec(phaseName);
  return match ? Number(match[0]) : index + 1;
}

/** Plan task ids already follow T19's `BE-`/`FE-` convention; one that does not is prefixed by its tag rather than rejected. */
function taskId(rawId: string, tag: "frontend" | "backend"): string {
  if (/^(BE|FE)-/.test(rawId)) return rawId;
  return `${tag === "backend" ? "BE" : "FE"}-${idKey(rawId)}`;
}

export function planItemsFrom(artifact: PlanArtifact, context: ConversionContext): Array<KnowledgeItemOf<"task">> {
  const architectureId = architectureIdFor(context, artifact.taskId);
  const source = agentSource(AgentStage.PROJECT_MANAGER, `plan artifact for ${artifact.taskId}`, context.now);

  return artifact.phases.flatMap((phase, index) =>
    phase.tasks.map((task) => {
      const agent = task.tag === "backend" ? AgentStage.BACKEND_ENGINEER : AgentStage.FRONTEND_ENGINEER;
      return {
        ...envelope(context, {
          id: taskId(task.id, task.tag),
          title: task.description,
          body: "",
          owner: agent,
          sources: [source],
          relations: [{ type: "implements", to: architectureId }],
          // The phase's security gate is the flag, carried onto every task in it —
          // the gate is a property of the work, and a task read on its own would
          // otherwise look unremarkable.
          sensitive: phase.securityGate,
        }),
        kind: "task" as const,
        payload: {
          agent,
          phase: phaseNumber(phase.id, phase.name, index),
          tag: task.tag,
          // Only qa-engineer ever writes `verified`; the artifact's `done` is
          // that mark already made, so it is carried rather than re-decided.
          plan_status: task.done ? ("verified" as const) : ("pending" as const),
          produces: [],
          consumes: [],
          contract_version: null,
          orchestrator_task_id: artifact.taskId,
        },
      };
    }),
  );
}

export function testPlanItemsFrom(
  artifact: TestPlanArtifact,
  context: ConversionContext,
): Array<KnowledgeItemOf<"test">> {
  const source = agentSource(AgentStage.TEST_PLANNER, `test-plan artifact for ${artifact.taskId}`, context.now);
  const used = new Map<string, number>();

  return artifact.items.map((item) => {
    const base = `TEST-${idKey(item.requirementId.replace(/^REQ-/i, ""))}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;

    return {
      ...envelope(context, {
        id,
        title: `Test strategy for ${item.requirementId}`,
        body: item.rationale,
        owner: AgentStage.TEST_PLANNER,
        sources: [source],
        relations: [{ type: "verifies", to: item.requirementId }],
      }),
      kind: "test" as const,
      payload: {
        levels: item.levels,
        automated: artifact.hasAutomatedTests,
      },
    };
  });
}

const ADR_STATUS_TO_KNOWLEDGE: Record<Adr["frontmatter"]["status"], KnowledgeStatus> = {
  proposed: "draft",
  accepted: "approved",
  superseded: "deprecated",
  rejected: "deprecated",
};

/** ADRs are project-wide by definition, so they ignore the context's module rather than being filed under one. */
export function decisionItemFrom(adr: Adr, context: ConversionContext): KnowledgeItemOf<"decision"> {
  const { frontmatter } = adr;
  return {
    ...envelope(context, {
      id: frontmatter.id,
      title: frontmatter.title,
      body: adr.body,
      owner: AgentStage.HUMAN,
      module: null,
      status: ADR_STATUS_TO_KNOWLEDGE[frontmatter.status],
      sources: [
        { type: "file", locator: `decisions/${adr.file}`, captured_at: context.now, digest: null },
      ],
      relations: frontmatter.supersedes ? [{ type: "supersedes", to: frontmatter.supersedes }] : [],
    }),
    kind: "decision",
    payload: {
      adr_status: frontmatter.status,
      date: frontmatter.date,
      supersedes: frontmatter.supersedes ?? null,
      superseded_by: frontmatter.superseded_by ?? null,
    },
  };
}

export interface ArtifactBundle {
  requirements?: RequirementsArtifact;
  design?: DesignArtifact;
  plan?: PlanArtifact;
  testPlan?: TestPlanArtifact;
  adrs?: Adr[];
}

/** Everything a bundle contains, in pipeline order, so a caller writing them out gets requirements before the things that refine them. */
export function itemsFromArtifacts(bundle: ArtifactBundle, context: ConversionContext): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  if (bundle.requirements) items.push(requirementItemFrom(bundle.requirements, context));
  if (bundle.design) items.push(...designItemsFrom(bundle.design, context));
  if (bundle.plan) items.push(...planItemsFrom(bundle.plan, context));
  if (bundle.testPlan) items.push(...testPlanItemsFrom(bundle.testPlan, context));
  for (const adr of bundle.adrs ?? []) items.push(decisionItemFrom(adr, context));
  return items;
}
