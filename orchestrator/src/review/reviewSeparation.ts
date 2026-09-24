import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { Permission } from "../agents/permissions.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { canWritePath, matchesGlob, pathRulesFor, targetPathRules, type PathRules } from "../agents/pathPermissions.js";
import { pipelineFromWorkflow, type WorkflowDefinition } from "../workflow/workflowDefinition.js";
import { catalogWorkflows } from "../workflow/workflowCatalog.js";
import type { ClassificationInput } from "../classification/taskClassifier.js";

/**
 * Creator and reviewer are different agents, always. Today that holds only
 * because the registry happens to be written that way, not because anything
 * enforces it — the risk shows up the moment someone gives `qa-engineer` a
 * `Write` on app code "just to fix the obvious ones", at which point the
 * pipeline's only correctness guarantee quietly becomes an agent marking its
 * own homework. This check makes the arrangement stated and checked instead
 * of merely remembered.
 *
 * Three things checked, and why each is separate:
 *  1. A reviewer must not produce what it reviews (structural, hard failure).
 *  2. A reviewer must not hold WRITE_CODE at all — stronger than (1), since a
 *     reviewer with a general write permission can change the thing it's
 *     about to judge without any artifact appearing anywhere.
 *  3. Whether a *pipeline* leaves produced work with nobody to review it.
 *     Reported, never failed: `workflows/typo.yml` deliberately runs the
 *     engineer alone for a copy fix, and that right-sizing call is the
 *     user's — reporting it keeps the choice visible without overriding it.
 */

/** Which stages' work a reviewer's verdict covers. */
export const REVIEWS: Partial<Record<AgentStage, readonly AgentStage[]>> = {
  // V13 TASK-006: the code review between implementation and QA.
  [AgentStage.REVIEWER]: [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.SETUP],
  [AgentStage.QA_ENGINEER]: [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.SETUP],
  [AgentStage.SECURITY]: [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.SETUP],
};

/** The artifacts that carry a verdict about someone else's work. Only a reviewer may produce one. */
export const VERDICT_ARTIFACTS: readonly ArtifactType[] = [
  ArtifactType.REVIEW_REPORT,
  ArtifactType.QA_REPORT,
  ArtifactType.SECURITY_REPORT,
];

/**
 * The one stage that may issue each verdict. Being *a* reviewer is not enough:
 * QA claiming a review report would be QA marking the reviewer's homework, and
 * the review stage would complete on a verdict its owner never gave.
 */
export const VERDICT_PRODUCER: Readonly<Partial<Record<ArtifactType, AgentStage>>> = {
  [ArtifactType.REVIEW_REPORT]: AgentStage.REVIEWER,
  [ArtifactType.QA_REPORT]: AgentStage.QA_ENGINEER,
  [ArtifactType.SECURITY_REPORT]: AgentStage.SECURITY,
};

/** The module document the reviewer owns; no reviewed stage may write it. */
export const REVIEW_DOC_SAMPLE = "_docs/module/sample-module/review.md";

export const REVIEWER_STAGES: readonly AgentStage[] = Object.keys(REVIEWS) as AgentStage[];

export function isReviewer(stage: AgentStage): boolean {
  return REVIEWER_STAGES.includes(stage);
}

/** Every stage whose work is covered by at least one reviewer. */
export function reviewedStages(): AgentStage[] {
  const stages: AgentStage[] = [];
  for (const covered of Object.values(REVIEWS)) {
    for (const stage of covered ?? []) if (!stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

/** Which reviewers cover a given producing stage, within a pipeline that has them. */
export function reviewersFor(stage: AgentStage, pipeline?: readonly AgentStage[]): AgentStage[] {
  return REVIEWER_STAGES.filter(
    (reviewer) => (REVIEWS[reviewer] ?? []).includes(stage) && (!pipeline || pipeline.includes(reviewer)),
  );
}

export class WrongVerdictProducerError extends Error {
  constructor(public readonly stage: AgentStage, public readonly artifactType: ArtifactType, public readonly owner: AgentStage) {
    super(`${stage} may not produce ${artifactType}: only ${owner} issues that verdict`);
    this.name = "WrongVerdictProducerError";
  }
}

export class SelfReviewError extends Error {
  constructor(public readonly stage: AgentStage, public readonly artifactType: ArtifactType) {
    super(
      `${stage} may not produce ${artifactType}: a verdict has to come from a role that did not do the work ` +
        "(no agent reviews its own work)",
    );
    this.name = "SelfReviewError";
  }
}

/**
 * The runtime half: a verdict is only accepted from a reviewer role.
 *
 * Overlaps with the registry's `outputs` table by design. That table says what
 * each role happens to produce; this says *why* only some roles may produce a
 * verdict, and it keeps holding if someone edits the table. A rule that is only
 * true because of a lookup elsewhere is one edit away from not being a rule.
 */
export function assertIndependentVerdict(stage: AgentStage, artifactType: ArtifactType): void {
  // A handoff is a machine-derived reference index for the stage's own output,
  // not a judgment of that output. Keep this exception narrow: verdict
  // artifacts below still require an independent reviewer.
  if (artifactType === ArtifactType.HANDOFF) return;
  if (!VERDICT_ARTIFACTS.includes(artifactType)) return;
  if (!isReviewer(stage)) throw new SelfReviewError(stage, artifactType);
  const owner = VERDICT_PRODUCER[artifactType];
  if (owner !== undefined && owner !== stage) throw new WrongVerdictProducerError(stage, artifactType, owner);
}

/** A concrete repo-relative path a glob matches — `*` and `**` filled in — so two rule sets can be compared by `canWritePath`. */
export function sampleGlobPath(glob: string): string {
  const sample = glob
    .replace(/\\/g, "/")
    .replace(/\*\*/g, "sample-dir/sample-file")
    .replace(/\*/g, "sample");
  return sample;
}

/**
 * The contract half of creator/reviewer separation (V13 TASK-006), read from
 * the loaded `contracts/*.yaml` rather than the registry: the reviewer's write
 * globs must not reach any path a reviewed stage may write, and no reviewed
 * stage may write the reviewer's review.md — whether in the Knowledge
 * workspace (`pathRulesFor`) or a bound Target checkout (`targetPathRules`).
 */
export function checkReviewerContractSeparation(projectRoot: string): string[] {
  const problems: string[] = [];
  const reviewer = AgentStage.REVIEWER;
  let reviewerRules: PathRules;
  try {
    reviewerRules = pathRulesFor(reviewer, projectRoot);
  } catch (e) {
    return [`${reviewer}: contract could not be loaded (${(e as Error).message})`];
  }
  const reviewerSamples = [...reviewerRules.write.map(sampleGlobPath), REVIEW_DOC_SAMPLE];
  for (const reviewed of REVIEWS[reviewer] ?? []) {
    let ruleSets: Array<{ label: string; rules: PathRules }>;
    try {
      ruleSets = [
        { label: "workspace", rules: pathRulesFor(reviewed, projectRoot) },
        { label: "Target", rules: targetPathRules(reviewed, projectRoot) },
      ];
    } catch (e) {
      problems.push(`${reviewed}: contract could not be loaded (${(e as Error).message})`);
      continue;
    }
    for (const { label, rules } of ruleSets) {
      for (const sample of reviewerSamples) {
        if (canWritePath(rules, sample).allowed) {
          problems.push(
            `${reviewed} may write ${sample} (${label} rules) — a path the reviewer owns; ` +
              "the stage under review could rewrite its own review",
          );
        }
      }
    }
    for (const glob of ruleSets[0].rules.write) {
      const sample = sampleGlobPath(glob);
      if (!matchesGlob(glob, sample)) continue;
      if (canWritePath(reviewerRules, sample).allowed) {
        problems.push(
          `${reviewer} may write ${sample}, which ${reviewed} writes (${glob}) — ` +
            "a reviewer that can change the work it judges is not independent of it",
        );
      }
    }
  }
  return problems;
}

export interface ReviewCoverage {
  /** Producing stages in this pipeline that a reviewer in the same pipeline covers. */
  covered: AgentStage[];
  /** Producing stages whose work nothing in this pipeline reviews. */
  unreviewed: AgentStage[];
}

/**
 * Which of a pipeline's producing stages actually get reviewed by something in
 * the same pipeline.
 *
 * A planning answer, not a verdict: a pipeline with `unreviewed` entries is not
 * automatically wrong (see the typo workflow), it is a pipeline where the work
 * ships on the word of whoever wrote it, and that should be a decision somebody
 * made rather than a gap nobody noticed.
 */
export function reviewCoverage(pipeline: readonly AgentStage[]): ReviewCoverage {
  const covered: AgentStage[] = [];
  const unreviewed: AgentStage[] = [];
  for (const stage of pipeline) {
    if (!reviewedStages().includes(stage)) continue; // not a stage anyone reviews (an analyst, devops)
    (reviewersFor(stage, pipeline).length > 0 ? covered : unreviewed).push(stage);
  }
  return { covered, unreviewed };
}

/**
 * The input combinations a workflow is probed with.
 *
 * Asking with every `when:` switched on hides the answer: `workflows/typo.yml`
 * gains a `security` step (a reviewer) once `touchesSensitiveArea` is set, so
 * a fully-on probe would report it covered even though the ordinary,
 * non-sensitive copy fix it exists for has no reviewer at all. What matters is
 * whether *some* real input leaves work unreviewed, so these walk the
 * plausible shapes and report the worst.
 */
const COVERAGE_PROBES: ClassificationInput[] = [
  { touchesBackend: true },
  { touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true },
  { touchesBackend: true, touchesFrontend: true, touchesSensitiveArea: true },
];

function describeProbe(probe: ClassificationInput): string {
  const on = Object.keys(probe).filter((k) => probe[k as keyof ClassificationInput]);
  return on.length > 0 ? on.join(" + ") : "no flags";
}

/** The probe that leaves the most work unreviewed, or null when every probe is covered. */
function worstCoverage(
  workflow: WorkflowDefinition,
): { probe: ClassificationInput; unreviewed: AgentStage[] } | null {
  let worst: { probe: ClassificationInput; unreviewed: AgentStage[] } | null = null;
  for (const probe of COVERAGE_PROBES) {
    const { unreviewed } = reviewCoverage(pipelineFromWorkflow(workflow, probe));
    if (unreviewed.length === 0) continue;
    if (!worst || unreviewed.length > worst.unreviewed.length) worst = { probe, unreviewed };
  }
  return worst;
}

export interface ReviewSeparationResult {
  ok: boolean;
  /** Violations of the structural rule — these fail. */
  problems: string[];
  /** Pipelines that ship unreviewed work. Reported, never failed: right-sizing is the user's call. */
  notes: string[];
}

/**
 * The check `--check-review-separation` runs.
 *
 * Reads the workflow catalog as well as the registry: "is the creator
 * separate from the reviewer?" is only half the question when asked of the
 * roster alone — the other half is whether the pipeline a given kind of
 * change actually runs contains a reviewer at all.
 *
 * `projectRoot` is where `contracts/*.yaml` are loaded for the reviewer's
 * contract-level check (`checkReviewerContractSeparation`); the registry and
 * classifier halves are derived from code.
 */
export function checkReviewSeparation(projectRoot: string = defaultProjectRoot()): ReviewSeparationResult {
  const problems: string[] = [];
  const notes: string[] = [];

  for (const reviewer of REVIEWER_STAGES) {
    const entry = AGENT_REGISTRY[reviewer];
    const reviews = REVIEWS[reviewer] ?? [];

    for (const reviewed of reviews) {
      if (reviewed === reviewer) {
        problems.push(`${reviewer} is listed as reviewing itself — a verdict on your own work is not a review`);
        continue;
      }
      const producedByReviewed = AGENT_REGISTRY[reviewed].outputs;
      const overlap = entry.outputs.filter((output) => producedByReviewed.includes(output));
      if (overlap.length > 0) {
        problems.push(
          `${reviewer} reviews ${reviewed} but also produces ${overlap.join(", ")} — ` +
            "it would be judging work it can write itself",
        );
      }
    }

    if (entry.permissions.includes(Permission.WRITE_CODE)) {
      problems.push(
        `${reviewer} holds ${Permission.WRITE_CODE} — a reviewer that can change the code it is about to judge ` +
          "is not an independent one, whatever its declared outputs say",
      );
    }
  }

  // Every verdict artifact must have exactly one role that can issue it, and that role must be a reviewer.
  for (const artifact of VERDICT_ARTIFACTS) {
    const producers = Object.values(AGENT_REGISTRY).filter((a) => a.outputs.includes(artifact));
    const nonReviewers = producers.filter((a) => !isReviewer(a.name));
    if (nonReviewers.length > 0) {
      problems.push(
        `${artifact} can be produced by ${nonReviewers.map((a) => a.name).join(", ")}, which review nothing — ` +
          "a verdict has to come from a role that did not do the work",
      );
    }
    if (producers.length === 0) {
      problems.push(`nothing in the roster can produce ${artifact} — the verdict it carries would never be issued`);
    }
  }

  problems.push(...checkReviewerContractSeparation(projectRoot));

  // The pipelines each kind of change actually runs, read from the workflow
  // catalog rather than by parsing `workflows/*.yml` (ADR-007).
  // Those files are generated from this same catalog, so parsing them would ask
  // the question one indirection away from the answer — and would make this
  // check depend on a project root having been synced.
  let workflows: Record<string, WorkflowDefinition>;
  try {
    workflows = catalogWorkflows();
  } catch (e) {
    problems.push(`could not derive the workflow catalog: ${(e as Error).message}`);
    return { ok: false, problems, notes };
  }

  for (const [id, workflow] of Object.entries(workflows)) {
    const worst = worstCoverage(workflow);
    if (worst) {
      notes.push(
        `workflow "${id}" can run ${worst.unreviewed.join(", ")} with no reviewer stage in the same pipeline ` +
          `(for ${describeProbe(worst.probe)}) — that work ships on the word of whoever wrote it. ` +
          workflow.description,
      );
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

export class ReviewSeparationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`creator/reviewer separation is broken:\n- ${problems.join("\n- ")}`);
    this.name = "ReviewSeparationError";
  }
}

export function assertReviewSeparation(projectRoot: string = defaultProjectRoot()): void {
  const result = checkReviewSeparation(projectRoot);
  if (!result.ok) throw new ReviewSeparationError(result.problems);
}
