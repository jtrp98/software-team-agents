import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * Project Bootstrap state model (T73).
 *
 * WHAT THIS IS
 *
 * TASKS_V1.md's diagram for V1.2 is a straight line: Discovery (T74-T79) builds
 * Project Knowledge (T61), a human validates it (T80), and the project becomes
 * `Ready`. T73 is that line — the state that tracks where a project sits on it
 * and the rule for when it is allowed to move forward.
 *
 * T74-T79 do not exist yet. This module does not depend on them existing: it
 * defines the stage ids they will fill in (`DiscoveryStageId`) and a status
 * derivation any of them can drive once they do. `bootstrapRunner.ts` is the
 * pluggable seam a stage implementation registers against.
 *
 * STATUS IS DERIVED, NOT SET
 *
 * `computeStatus()` is the only place `ready` gets decided. A stored `status`
 * field that disagreed with the stages/validation that produced it would be
 * exactly the kind of "true" flag T52's plan.md work found already — a value
 * nobody re-derives, so it drifts. `checkBootstrapState()` re-derives it on
 * every read and rejects a file that disagrees with its own data.
 */

export type DiscoveryStageId =
  | "repository" // T74
  | "documentation" // T75
  | "db-schema" // T76
  | "api" // T77
  | "architecture" // T78
  | "human-input"; // T79

/** Fixed order — T73's diagram runs discovery before the human fills gaps it couldn't find. */
export const ALL_STAGES: readonly DiscoveryStageId[] = [
  "repository",
  "documentation",
  "db-schema",
  "api",
  "architecture",
  "human-input",
];

export type StageStatus = "pending" | "in_progress" | "done" | "skipped";

export interface StageRecord {
  id: DiscoveryStageId;
  status: StageStatus;
  completed_at: string | null;
  knowledge_ids: string[];
  /** Re-discovered with different content, but left alone because a person had already reviewed them — see the schema and `runBootstrapStage`. */
  conflict_ids?: string[];
  note?: string;
}

export type BootstrapStatus = "discovering" | "pending_validation" | "ready";

export interface BootstrapState {
  schema_version: number;
  module: string | null;
  status: BootstrapStatus;
  stages: StageRecord[];
  validated_by: string | null;
  validated_at: string | null;
  created_at: string;
  updated_at: string;
}

const STAGE_DONE: readonly StageStatus[] = ["done", "skipped"];

function stagesSettled(stages: StageRecord[]): boolean {
  return stages.length === ALL_STAGES.length && stages.every((s) => STAGE_DONE.includes(s.status));
}

/**
 * `ready` requires both a settled discovery pass and a recorded human
 * validation (T80) — either alone leaves the project not actually ready:
 * discovery with no review is an agent deciding on its own that its guesses
 * were good enough, and a validation timestamp with open stages would be
 * approving knowledge that does not exist yet.
 */
export function computeStatus(state: Pick<BootstrapState, "stages" | "validated_by" | "validated_at">): BootstrapStatus {
  const settled = stagesSettled(state.stages);
  if (settled && state.validated_by && state.validated_at) return "ready";
  if (settled) return "pending_validation";
  return "discovering";
}

export function newBootstrapState(module: string | null, now: string): BootstrapState {
  const stages: StageRecord[] = ALL_STAGES.map((id) => ({
    id,
    status: "pending",
    completed_at: null,
    knowledge_ids: [],
  }));
  return {
    schema_version: 1,
    module,
    status: computeStatus({ stages, validated_by: null, validated_at: null }),
    stages,
    validated_by: null,
    validated_at: null,
    created_at: now,
    updated_at: now,
  };
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "bootstrap-state.schema.json",
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
 * Schema validity plus the structural rules a JSON Schema can't express:
 * stages cover every `ALL_STAGES` id exactly once, validation fields are
 * all-or-nothing, and the stored `status` must equal what the data derives
 * to (catches a hand-edited file claiming `ready` early).
 */
export function checkBootstrapState(data: unknown): string[] {
  const validate = validator();
  if (!validate(data)) {
    return (validate.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
    });
  }

  const state = data as BootstrapState;
  const problems: string[] = [];

  const ids = state.stages.map((s) => s.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`stage "${id}" appears more than once`);
    seen.add(id);
  }
  for (const expected of ALL_STAGES) {
    if (!seen.has(expected)) problems.push(`missing stage "${expected}"`);
  }
  for (const id of seen) {
    if (!(ALL_STAGES as readonly string[]).includes(id)) problems.push(`unknown stage "${id}"`);
  }

  const hasValidatedBy = state.validated_by !== null;
  const hasValidatedAt = state.validated_at !== null;
  if (hasValidatedBy !== hasValidatedAt) {
    problems.push("validated_by and validated_at must be set together, or both null");
  }

  const derived = computeStatus(state);
  if (derived !== state.status) {
    problems.push(`status is "${state.status}" but the stages/validation on this file derive "${derived}"`);
  }

  return problems;
}
