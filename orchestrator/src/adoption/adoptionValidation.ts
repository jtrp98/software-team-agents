import * as fs from "node:fs";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { sourcePath } from "../knowledge/sourceRegistry.js";
import type { AdoptionStageId, AdoptionState } from "./adoptionModel.js";
import { adoptionStages, type AdoptionStageResult } from "./adoptionRunner.js";
import { readAdoptionState, stagedContractPath } from "./adoptionStore.js";

/**
 * Migration Validation (T88) — did anything get dropped.
 *
 * HOW THE "BEFORE AND AFTER DIFF" IS ACTUALLY DONE
 *
 * TASKS_V1.md asks to compare before against after. There is no snapshot to
 * compare with, and taking one would only prove that adoption wrote what
 * adoption wrote. What can be compared is stronger: every importer here is a
 * pure function of the legacy files, and no legacy file is ever modified — so
 * re-running the importers *now* reproduces exactly what the material implies,
 * and every id it names must be on disk. Anything missing was dropped between
 * derivation and the file system.
 *
 * That catches the failures that matter and one more besides: a legacy document
 * edited *during* the adoption shows up here as an item the material now implies
 * and disk does not have, which is true and worth stopping for.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * That the import is *correct*. An item can exist, match its source, and still
 * have read the document's meaning wrongly — no mechanical check reads meaning,
 * which is why T81's per-stage approval is a person and this is the evidence put
 * in front of them. The same limit `checkDocStructure` and
 * `check-schema-contract.js` already live with, stated rather than glossed.
 */

export interface StageValidation {
  id: AdoptionStageId;
  /** Item ids the legacy material implies and `knowledge/` does not hold. */
  missingItems: string[];
  /** Items that exist but whose stage record never claimed them — an orphan the state cannot account for. */
  unclaimedItems: string[];
  /** Registered sources the material implies and `knowledge/_sources/` does not hold. */
  missingSources: string[];
  /** Legacy agents converted but not staged. */
  missingContracts: string[];
  /** Reviewed items the material now disagrees with. Not a dropped item — a decision waiting for a person. */
  conflicts: string[];
  /** Items in `knowledge/` that this stage produced and a person has already approved. */
  approvedItems: string[];
  derivedCount: number;
  onDiskCount: number;
}

export interface AdoptionValidationReport {
  ok: boolean;
  stages: StageValidation[];
  problems: string[];
  notes: string[];
  state: AdoptionState | null;
}

function resultsByStage(sourceRoot: string, now: string, docsRoot?: string): Map<AdoptionStageId, AdoptionStageResult> {
  const out = new Map<AdoptionStageId, AdoptionStageResult>();
  for (const stage of adoptionStages()) out.set(stage.id, stage.run(sourceRoot, now, docsRoot));
  return out;
}

/**
 * Re-derives everything from the legacy material and checks it against disk.
 * Read-only: this is evidence for a person, and a check that fixed what it found
 * would be doing the importing again under another name.
 */
export function validateAdoption(
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
  docsRoot?: string,
  sourceRoot: string = projectRoot,
): AdoptionValidationReport {
  const { state, problems: stateProblems } = readAdoptionState(projectRoot);
  const problems: string[] = [...stateProblems.map((p) => `knowledge/_adoption/STATE.yaml: ${p}`)];
  const notes: string[] = [];

  // Said once, not once per stage: a project nobody has adopted would otherwise
  // report four stages' worth of "no record of this running", which reads as
  // four faults rather than one fact.
  if (!state && stateProblems.length === 0) {
    return {
      ok: false,
      stages: [],
      problems: ["adoption has not started — there is nothing to validate"],
      notes: [],
      state: null,
    };
  }

  const load = loadKnowledge(projectRoot);
  problems.push(...load.problems);
  const onDisk = new Map(load.items.map((i) => [i.id, i]));

  const derived = resultsByStage(sourceRoot, now, docsRoot);
  const stages: StageValidation[] = [];

  for (const [id, result] of derived) {
    const record = state?.stages.find((s) => s.id === id);
    const claimed = new Set(record?.knowledge_ids ?? []);
    const conflicts = new Set(record?.conflict_ids ?? []);

    const missingItems: string[] = [];
    const approvedItems: string[] = [];
    for (const item of result.items) {
      if (!onDisk.has(item.id)) {
        // A conflict is not a drop: the item is deliberately absent from this
        // import because a reviewed copy of it already exists, or deliberately
        // untouched. Only an item nobody accounted for is a drop.
        if (!conflicts.has(item.id)) missingItems.push(item.id);
        continue;
      }
      if (onDisk.get(item.id)!.status === "approved") approvedItems.push(item.id);
    }

    const unclaimedItems = result.items
      .filter((i) => onDisk.has(i.id) && record !== undefined && !claimed.has(i.id))
      .map((i) => i.id);

    const missingSources = result.sources.filter((s) => !fs.existsSync(sourcePath(s.id, projectRoot))).map((s) => s.id);
    const missingContracts = (result.contracts ?? [])
      .filter((c) => !fs.existsSync(stagedContractPath(c.name, projectRoot)))
      .map((c) => c.name);

    stages.push({
      id,
      missingItems,
      unclaimedItems,
      missingSources,
      missingContracts,
      conflicts: [...conflicts],
      approvedItems,
      derivedCount: result.items.length,
      onDiskCount: result.items.filter((i) => onDisk.has(i.id)).length,
    });

    if (!record) {
      problems.push(`${id}: the legacy material implies ${result.items.length} item(s) but adoption has no record of this stage running`);
      continue;
    }
    if (record.status === "pending" || record.status === "in_progress") {
      notes.push(`${id}: has not run yet — ${result.items.length} item(s) waiting`);
      continue;
    }
    for (const missing of missingItems) {
      problems.push(`${id}: ${missing} is implied by the legacy material but is not in knowledge/ — it was dropped`);
    }
    for (const unclaimed of unclaimedItems) {
      problems.push(
        `${id}: ${unclaimed} exists in knowledge/ but this stage's record does not list it — the state cannot account for it`,
      );
    }
    for (const missing of missingSources) {
      problems.push(`${id}: source ${missing} was captured but is not in knowledge/_sources/`);
    }
    for (const missing of missingContracts) {
      problems.push(`${id}: legacy agent ${missing} was converted but no staged contract was written`);
    }
    for (const conflict of record.conflict_ids ?? []) {
      notes.push(`${id}: ${conflict} was left as a person had it — the legacy material now says something different`);
    }
  }

  return { ok: problems.length === 0, stages, problems, notes, state };
}
