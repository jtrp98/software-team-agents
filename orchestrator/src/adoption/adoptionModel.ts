import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * Existing-project adoption state model (T81).
 *
 * WHAT THIS IS
 *
 * V1.2 answers "a new project has no knowledge yet" by discovering it from raw
 * material. V1.3 answers a different question: a project that already ran the
 * old pipeline has nine agent definitions, a `plan.md`, a `design.md`, a
 * `CLAUDE.md` and a pile of docs, and TASKS_V1.md's requirement for it is
 * blun— **ของเดิมต้องไม่หาย**. So adoption reads all of that, converts it, and
 * the legacy files stay exactly where they are. Nothing here deletes, moves or
 * rewrites a legacy document; the only thing this flow creates is new files.
 * That is also what makes T89's rollback tractable — there is nothing to
 * restore, only things to remove.
 *
 * WHY NOT REUSE BOOTSTRAP'S STATE
 *
 * `BootstrapState` (T73) tracks six discovery stages and requires every one of
 * them to be settled before a project can be `ready`. Adding four adoption
 * stages to that enum would mean a greenfield project could never finish
 * bootstrap without settling stages that have nothing to adopt, and an adopted
 * project could never finish without running discovery it does not need. Two
 * flows, two files, one shared discipline: status is derived, never set.
 *
 * FIVE STATES, AND WHAT EACH ONE IS WAITING FOR
 *
 *   blocked             T86 found work in flight and nobody has acknowledged it
 *   importing           a stage has not run yet
 *   pending_approval    every stage ran; one that did something is unapproved
 *   pending_validation  every stage is approved; nobody has validated the result
 *   adopted             a person checked the result against the legacy material
 *
 * The `pending_approval` step is T81's "checkpoint ให้ human ยืนยันแต่ละช่วง"
 * with teeth: a stage that produced something needs a name against it before
 * adoption can complete. A `skipped` stage does not — there is nothing for a
 * person to look at, and demanding a signature for "found nothing" teaches
 * people to sign without looking.
 */

export type AdoptionStageId =
  | "legacy-agents" // T82
  | "legacy-docs" // T83
  | "legacy-plan" // T84
  | "legacy-design"; // T85

/**
 * Fixed order, and it is not alphabetical. Docs before plan before design is
 * the order the material refers to itself in: `design.md`'s rows cite the
 * `REQ-NNN`s that live in `requirement.md` (imported by the docs stage), and
 * `plan.md`'s tasks cite the `DES-NNN`s that live in `design.md`. Running them
 * in this order means most relations resolve as they land instead of dangling
 * until the last stage — dangling is tolerated (T61's `check()` reports it
 * without throwing), but tolerated is not the same as intended.
 */
export const ALL_ADOPTION_STAGES: readonly AdoptionStageId[] = [
  "legacy-agents",
  "legacy-docs",
  "legacy-design",
  "legacy-plan",
];

export type AdoptionStageStatus = "pending" | "in_progress" | "done" | "skipped";

export interface AdoptionStageRecord {
  id: AdoptionStageId;
  status: AdoptionStageStatus;
  completed_at: string | null;
  knowledge_ids: string[];
  /** T82 — legacy agent names this stage staged a draft contract for. */
  contract_ids?: string[];
  /** Re-derived with different content, but left alone because a person had already reviewed them. */
  conflict_ids?: string[];
  /** T81's per-segment checkpoint: a person's name, once they have looked at what this stage produced. */
  approved_by: string | null;
  approved_at: string | null;
  note?: string;
}

export interface AdoptionPreflight {
  detected_at: string;
  /** Work the legacy project had in flight. A person acknowledges these; adoption does not decide for them. */
  blockers: string[];
  /** What was checked and found clean, so an empty `blockers` reads as "checked" rather than "never ran". */
  notes: string[];
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

export type AdoptionStatus = "blocked" | "importing" | "pending_approval" | "pending_validation" | "adopted";

export interface AdoptionState {
  schema_version: number;
  status: AdoptionStatus;
  preflight: AdoptionPreflight | null;
  stages: AdoptionStageRecord[];
  validated_by: string | null;
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

const SETTLED: readonly AdoptionStageStatus[] = ["done", "skipped"];

function stagesSettled(stages: AdoptionStageRecord[]): boolean {
  return stages.length === ALL_ADOPTION_STAGES.length && stages.every((s) => SETTLED.includes(s.status));
}

/** A stage needs a signature only if it actually did something — see the module doc. */
export function needsApproval(stage: AdoptionStageRecord): boolean {
  return stage.status === "done";
}

export function unapprovedStages(stages: AdoptionStageRecord[]): AdoptionStageRecord[] {
  return stages.filter((s) => needsApproval(s) && s.approved_by === null);
}

/**
 * The only place `adopted` is decided.
 *
 * `blocked` outranks everything, including a full set of approvals: if a person
 * has not acknowledged that the legacy project had a half-finished task in it,
 * then whatever was imported on top of that task was imported over an unknown,
 * and later approvals do not retroactively make that known.
 */
export function computeAdoptionStatus(
  state: Pick<AdoptionState, "preflight" | "stages" | "validated_by" | "validated_at">,
): AdoptionStatus {
  const preflight = state.preflight;
  if (!preflight) return "blocked";
  if (preflight.blockers.length > 0 && !preflight.acknowledged_by) return "blocked";
  if (!stagesSettled(state.stages)) return "importing";
  if (unapprovedStages(state.stages).length > 0) return "pending_approval";
  if (state.validated_by && state.validated_at) return "adopted";
  return "pending_validation";
}

export function newAdoptionState(now: string): AdoptionState {
  const stages: AdoptionStageRecord[] = ALL_ADOPTION_STAGES.map((id) => ({
    id,
    status: "pending",
    completed_at: null,
    knowledge_ids: [],
    approved_by: null,
    approved_at: null,
  }));
  const base = { preflight: null, stages, validated_by: null, validated_at: null };
  return {
    schema_version: 1,
    status: computeAdoptionStatus(base),
    ...base,
    created_at: now,
    updated_at: now,
  };
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "adoption-state.schema.json",
);

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/**
 * Schema validity plus the structural rules a JSON Schema cannot express:
 * stages cover every `ALL_ADOPTION_STAGES` id exactly once, the paired
 * by/at fields are all-or-nothing, and the stored `status` equals what the
 * data derives to (catches a hand-edited file claiming `adopted` early).
 */
export function checkAdoptionState(data: unknown): string[] {
  const validate = validator();
  if (!validate(data)) {
    return (validate.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
    });
  }

  const state = data as AdoptionState;
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const stage of state.stages) {
    if (seen.has(stage.id)) problems.push(`stage "${stage.id}" appears more than once`);
    seen.add(stage.id);
    if ((stage.approved_by !== null) !== (stage.approved_at !== null)) {
      problems.push(`stage "${stage.id}": approved_by and approved_at must be set together, or both null`);
    }
    if (stage.approved_by !== null && stage.status === "pending") {
      problems.push(`stage "${stage.id}" is approved but has not run — an approval is for work somebody could look at`);
    }
  }
  for (const expected of ALL_ADOPTION_STAGES) {
    if (!seen.has(expected)) problems.push(`missing stage "${expected}"`);
  }
  for (const id of seen) {
    if (!(ALL_ADOPTION_STAGES as readonly string[]).includes(id)) problems.push(`unknown stage "${id}"`);
  }

  if ((state.validated_by !== null) !== (state.validated_at !== null)) {
    problems.push("validated_by and validated_at must be set together, or both null");
  }

  const preflight = state.preflight;
  if (preflight && (preflight.acknowledged_by !== null) !== (preflight.acknowledged_at !== null)) {
    problems.push("preflight.acknowledged_by and preflight.acknowledged_at must be set together, or both null");
  }

  const derived = computeAdoptionStatus(state);
  if (derived !== state.status) {
    problems.push(`status is "${state.status}" but the preflight/stages/validation on this file derive "${derived}"`);
  }

  return problems;
}
