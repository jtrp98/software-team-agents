import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot, type AgentContract } from "../agents/agentContract.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { applyLanding, classifyLanding, type LandingAction, type LandingDecision } from "../knowledge/landing.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { sourcePath, writeSourceRecord, type SourceRecord } from "../knowledge/sourceRegistry.js";
import { advanceToApproved } from "../bootstrap/knowledgeValidation.js";
import {
  ALL_ADOPTION_STAGES,
  computeAdoptionStatus,
  needsApproval,
  newAdoptionState,
  unapprovedStages,
  type AdoptionStageId,
  type AdoptionState,
} from "./adoptionModel.js";
import {
  AdoptionStateError,
  backupExisting,
  newAdoptionManifest,
  readAdoptionManifest,
  readAdoptionState,
  recordManifestEntry,
  relativeToRepo,
  stagedContractPath,
  stagedContractsDir,
  writeAdoptionManifest,
  writeAdoptionState,
  type AdoptionManifest,
} from "./adoptionStore.js";
import { scanLegacyAgents, unmappedRecordsFrom, type UnmappedAgentRecord } from "./legacyAgents.js";
import { importLegacyDocs } from "./legacyDocs.js";
import { migrateLegacyDesign } from "./legacyDesign.js";
import { migrateLegacyPlan } from "./legacyPlan.js";
import { detectExistingState, preflightFrom } from "./stateDetection.js";

/**
 * Project Adoption (T81) — the one flow that runs T82-T89 in order, with a
 * checkpoint for a person after every stage.
 *
 * THE ORDER, AND WHY THERE IS A GATE AT EACH END OF IT
 *
 *   detect (T86)   what the legacy project has in flight. Adoption is `blocked`
 *                  until a person acknowledges anything found, because whether
 *                  it is safe to import on top of half-finished work depends on
 *                  things no file records.
 *   plan (T87)     what each stage *would* write, computed with the same
 *                  classifier the apply uses. Never writes. Runnable before
 *                  adoption has even started, which is the point of a dry run.
 *   run (T82-T85)  one stage at a time. Every file it writes goes into the
 *                  manifest, and anything it replaces is backed up first, so
 *                  T89 can undo the whole thing.
 *   approve (T81)  per stage, by name. A stage that did nothing needs none.
 *   validate (T88) the sign-off that makes the project adopted, refused while
 *                  any stage is unapproved.
 *
 * WHY A CHECKPOINT PER STAGE RATHER THAN ONE AT THE END
 *
 * T73's bootstrap asks once, at the end, and that is right for discovery: the
 * six stages read unrelated material, so reviewing them together costs nothing.
 * Adoption's four stages are not independent — `plan.md`'s tasks cite
 * `design.md`'s rows, which cite `requirement.md`'s ids. An import that read one
 * document's meaning wrongly is cheapest to catch before the next stage builds
 * on it, and a single review at the end is a review of four stages' worth of
 * consequences at once.
 *
 * NOTHING LEGACY IS EVER TOUCHED
 *
 * Every writer here targets `knowledge/`. No legacy document is deleted, moved
 * or rewritten by any part of V1.3 — which is both TASKS_V1.md's requirement
 * ("ของเดิม ... ต้องไม่หาย") and what makes rollback a matter of removing files
 * rather than reconstructing them.
 */

export interface AdoptionStageResult {
  items: KnowledgeItem[];
  sources: SourceRecord[];
  /** T82 only: converted legacy agents, staged rather than installed. */
  contracts?: Array<{ name: string; contract: AgentContract; differences: string[] }>;
  /** T82 only: legacy agents this framework has no role for. */
  unmapped?: UnmappedAgentRecord[];
  /** True when the stage found nothing to import — still counts as settled. */
  skipped?: boolean;
  notes: string[];
}

export interface AdoptionStage {
  id: AdoptionStageId;
  /** Reads legacy material from this root. State and generated knowledge are
   * rooted separately by the caller, so an adopted Target is never written. */
  run(sourceRoot: string, now: string, docsRoot?: string): AdoptionStageResult;
}

export class AdoptionNotStartedError extends Error {
  constructor() {
    super("no adoption in progress — call initAdoption() first");
    this.name = "AdoptionNotStartedError";
  }
}

export class AdoptionBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super(
      `adoption is blocked until somebody acknowledges what the project has in flight:\n- ${blockers.join("\n- ")}\n` +
        "call acknowledgePreflight(<name>) once a person has decided it is safe to import over this.",
    );
    this.name = "AdoptionBlockedError";
  }
}

export class UnknownAdoptionStageError extends Error {
  constructor(id: string) {
    super(`"${id}" is not a stage this adoption is tracking`);
    this.name = "UnknownAdoptionStageError";
  }
}

export class AdoptionNotApprovedError extends Error {
  constructor(public readonly stages: string[]) {
    super(
      `cannot validate — these stages have run but nobody has approved them: ${stages.join(", ")}. ` +
        "T81's checkpoint is per stage, so each one needs a name against it first.",
    );
    this.name = "AdoptionNotApprovedError";
  }
}

export class AdoptionNotSettledError extends Error {
  constructor(public readonly stages: string[]) {
    super(`cannot validate — these stages have not run yet: ${stages.join(", ")}`);
    this.name = "AdoptionNotSettledError";
  }
}

/** The four import stages, in the order `ALL_ADOPTION_STAGES` fixes. */
export function adoptionStages(): AdoptionStage[] {
  return [
    {
      id: "legacy-agents",
      run: (projectRoot) => {
        const scan = scanLegacyAgents(projectRoot);
        const contracts = scan.conversions
          .filter((c): c is typeof c & { contract: AgentContract } => c.contract !== null)
          .map((c) => ({ name: c.definition.name, contract: c.contract, differences: c.differences }));
        const unmapped = unmappedRecordsFrom(scan);
        const notes: string[] = [];
        if (scan.conversions.length === 0) notes.push("no `.claude/agents/*.md` found — nothing to convert");
        for (const file of scan.unreadable) notes.push(`${file} has no frontmatter block — skipped`);
        for (const c of contracts) {
          for (const difference of c.differences) notes.push(`${c.name}: ${difference}`);
        }
        for (const u of unmapped) notes.push(`${u.name}: ${u.note}`);
        return {
          items: [],
          sources: [],
          contracts,
          unmapped,
          skipped: contracts.length === 0 && unmapped.length === 0,
          notes,
        };
      },
    },
    {
      id: "legacy-docs",
      run: (projectRoot, now, docsRoot) => {
        const result = importLegacyDocs(projectRoot, now, docsRoot);
        return { ...result, skipped: result.items.length === 0 };
      },
    },
    {
      id: "legacy-design",
      run: (projectRoot, now, docsRoot) => {
        const result = migrateLegacyDesign(projectRoot, now, docsRoot);
        return { ...result, skipped: result.items.length === 0 };
      },
    },
    {
      id: "legacy-plan",
      run: (projectRoot, now, docsRoot) => {
        const result = migrateLegacyPlan(projectRoot, now, docsRoot);
        return { ...result, skipped: result.items.length === 0 };
      },
    },
  ];
}

export function adoptionStage(id: AdoptionStageId): AdoptionStage {
  const found = adoptionStages().find((s) => s.id === id);
  if (!found) throw new UnknownAdoptionStageError(id);
  return found;
}

/**
 * Starts an adoption, running T86's detection as part of it.
 *
 * Detection is not optional and not a separate call a caller could forget: the
 * state derives `blocked` from a null preflight, so an adoption that skipped it
 * could never reach `importing`. Idempotent — an existing state is returned
 * as-is rather than reset, and re-running detection would overwrite an
 * acknowledgement somebody already gave.
 */
export function initAdoption(
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
  docsRoot?: string,
  sourceRoot: string = projectRoot,
): AdoptionState {
  const existing = readAdoptionState(projectRoot);
  if (existing.problems.length > 0) throw new AdoptionStateError(existing.problems);
  if (existing.state) return existing.state;

  const state = newAdoptionState(now);
  state.preflight = preflightFrom(detectExistingState(sourceRoot, docsRoot), now);
  state.status = computeAdoptionStatus(state);
  writeAdoptionState(state, projectRoot);
  return state;
}

function requireState(projectRoot: string): AdoptionState {
  const { state, problems } = readAdoptionState(projectRoot);
  if (problems.length > 0) throw new AdoptionStateError(problems);
  if (!state) throw new AdoptionNotStartedError();
  return state;
}

/** T86's gate: a person, by name, saying the blockers are safe to import over. */
export function acknowledgePreflight(
  acknowledgedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): AdoptionState {
  const state = requireState(projectRoot);
  if (!state.preflight) throw new AdoptionNotStartedError();
  state.preflight.acknowledged_by = acknowledgedBy;
  state.preflight.acknowledged_at = now;
  state.status = computeAdoptionStatus(state);
  state.updated_at = now;
  writeAdoptionState(state, projectRoot);
  return state;
}

export interface PlannedWrite {
  /** Repo-relative path. */
  path: string;
  /** For a knowledge item: what `landing.ts` would do with it. For a staged file: create or replace. */
  action: LandingAction;
  /** Item id, agent name, or source id — whatever identifies the thing being written. */
  subject: string;
}

export interface PlannedStage {
  id: AdoptionStageId;
  writes: PlannedWrite[];
  /** Items a person has already reviewed that the material now disagrees with — T66's question, surfaced before anything is written. */
  conflicts: string[];
  skipped: boolean;
  notes: string[];
}

export interface AdoptionPlan {
  stages: PlannedStage[];
  /** T86's findings, so a dry run also answers "is this project even in a state to be adopted". */
  preflight: { blockers: string[]; notes: string[] };
  totals: { create: number; update: number; unchanged: number; conflict: number };
}

function plannedFileWrite(absPath: string, projectRoot: string, subject: string): PlannedWrite {
  return {
    path: relativeToRepo(absPath, projectRoot),
    action: fs.existsSync(absPath) ? "update" : "create",
    subject,
  };
}

/**
 * Migration Dry Run (T87) — everything an apply would do, with nothing written.
 *
 * Every knowledge item's verdict comes from `classifyLanding`, the same function
 * `runAdoptionStage` calls to decide what to write. That is the whole design of
 * this function: a dry run that computed its own answer would be a preview that
 * can be wrong, and a preview that can be wrong is worse than none — it is the
 * thing somebody approves instead of looking.
 */
export function planAdoption(
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
  docsRoot?: string,
  sourceRoot: string = projectRoot,
): AdoptionPlan {
  const totals = { create: 0, update: 0, unchanged: 0, conflict: 0 };
  const stages: PlannedStage[] = [];

  for (const stage of adoptionStages()) {
    const result = stage.run(sourceRoot, now, docsRoot);
    const writes: PlannedWrite[] = [];
    const conflicts: string[] = [];

    for (const item of result.items) {
      const decision = classifyLanding(item, projectRoot, now);
      totals[decision.action] += 1;
      if (decision.action === "conflict") conflicts.push(item.id);
      // `unchanged` is reported as a write with that action rather than dropped:
      // "adoption found this and it already agrees" is information, and a plan
      // that only listed changes could not be checked for completeness.
      writes.push({ path: decision.relativePath, action: decision.action, subject: item.id });
    }

    for (const source of result.sources) {
      writes.push(plannedFileWrite(sourcePath(source.id, projectRoot), projectRoot, source.id));
    }
    for (const contract of result.contracts ?? []) {
      writes.push(plannedFileWrite(stagedContractPath(contract.name, projectRoot), projectRoot, contract.name));
    }
    if ((result.unmapped ?? []).length > 0) {
      writes.push(plannedFileWrite(path.join(stagedContractsDir(projectRoot), "UNMAPPED.yaml"), projectRoot, "unmapped agents"));
    }

    stages.push({ id: stage.id, writes, conflicts, skipped: result.skipped === true, notes: result.notes });
  }

  const detected = detectExistingState(sourceRoot, docsRoot);
  return { stages, preflight: { blockers: detected.blockers, notes: detected.notes }, totals };
}

interface TrackedWrite {
  manifest: AdoptionManifest;
  stage: AdoptionStageId;
  projectRoot: string;
  now: string;
}

/** Writes a file adoption owns, backing up anything already there so T89 can put it back. */
function writeTracked(absPath: string, content: string, ctx: TrackedWrite): void {
  const existed = fs.existsSync(absPath);
  const backup = existed ? backupExisting(absPath, ctx.projectRoot) : null;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, absPath);
  recordManifestEntry(ctx.manifest, {
    path: relativeToRepo(absPath, ctx.projectRoot),
    action: existed ? "replaced" : "created",
    backup,
    stage: ctx.stage,
    at: ctx.now,
  });
}

/** Records a path some other writer created, taking the backup first when it has to. */
function trackKnowledgeWrite(decision: LandingDecision, ctx: TrackedWrite): void {
  const backup = decision.action === "update" ? backupExisting(decision.path, ctx.projectRoot) : null;
  applyLanding(decision, ctx.projectRoot);
  recordManifestEntry(ctx.manifest, {
    path: decision.relativePath,
    action: decision.action === "update" ? "replaced" : "created",
    backup,
    stage: ctx.stage,
    at: ctx.now,
  });
}

/**
 * Runs one import stage and records everything it wrote.
 *
 * Refuses while adoption is `blocked` — that is T86 doing its job rather than
 * being a report somebody skims. A stage that lands new material after a
 * validation clears that validation, for the same reason T73's bootstrap does:
 * `adopted` means a person checked what is there, and there is now something
 * they have not seen.
 */
export function runAdoptionStage(
  id: AdoptionStageId,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
  docsRoot?: string,
  sourceRoot: string = projectRoot,
): AdoptionState {
  const state = requireState(projectRoot);
  const record = state.stages.find((s) => s.id === id);
  if (!record) throw new UnknownAdoptionStageError(id);
  if (computeAdoptionStatus(state) === "blocked") {
    throw new AdoptionBlockedError(state.preflight?.blockers ?? ["preflight has not run"]);
  }

  const result = adoptionStage(id).run(sourceRoot, now, docsRoot);
  const manifestRead = readAdoptionManifest(projectRoot);
  const manifest = manifestRead.manifest ?? newAdoptionManifest(now);
  const ctx: TrackedWrite = { manifest, stage: id, projectRoot, now };

  const written: string[] = [];
  const conflicts: string[] = [];

  for (const source of result.sources) {
    const target = sourcePath(source.id, projectRoot);
    const existed = fs.existsSync(target);
    const backup = existed ? backupExisting(target, projectRoot) : null;
    writeSourceRecord(source, projectRoot);
    recordManifestEntry(manifest, {
      path: relativeToRepo(target, projectRoot),
      action: existed ? "replaced" : "created",
      backup,
      stage: id,
      at: now,
    });
  }

  for (const item of result.items) {
    const decision = classifyLanding(item, projectRoot, now);
    if (decision.action === "conflict") {
      conflicts.push(item.id);
      continue;
    }
    if (decision.action === "unchanged") continue;
    trackKnowledgeWrite(decision, ctx);
    written.push(item.id);
  }

  for (const staged of result.contracts ?? []) {
    writeTracked(
      stagedContractPath(staged.name, projectRoot),
      stagingHeader(staged.name, staged.differences) + stringifyYaml(staged.contract, { sortMapEntries: false }),
      ctx,
    );
  }
  if ((result.unmapped ?? []).length > 0) {
    writeTracked(
      path.join(stagedContractsDir(projectRoot), "UNMAPPED.yaml"),
      stringifyYaml({ schema_version: 1, captured_at: now, agents: result.unmapped }, { sortMapEntries: false }),
      ctx,
    );
  }

  writeAdoptionManifest(manifest, projectRoot);

  record.status = result.skipped ? "skipped" : "done";
  record.completed_at = now;
  record.knowledge_ids = result.items.map((i) => i.id);
  const contractNames = [...(result.contracts ?? []).map((c) => c.name), ...(result.unmapped ?? []).map((u) => u.name)];
  if (contractNames.length > 0) record.contract_ids = contractNames;
  else delete record.contract_ids;
  if (conflicts.length > 0) record.conflict_ids = conflicts;
  else delete record.conflict_ids;

  const notes = [...result.notes];
  if (conflicts.length > 0) {
    notes.push(
      `left ${conflicts.length} reviewed item(s) untouched because the legacy material now says something different: ${conflicts.join(", ")}`,
    );
  }
  if (notes.length > 0) record.note = notes.join(" · ");
  else delete record.note;

  // New material invalidates both the stage's own approval and the overall
  // validation: whatever was approved before, this is not it.
  if (written.length > 0) {
    record.approved_by = null;
    record.approved_at = null;
    state.validated_by = null;
    state.validated_at = null;
  }

  state.status = computeAdoptionStatus(state);
  state.updated_at = now;
  writeAdoptionState(state, projectRoot);
  return state;
}

/** The comment block a staged contract carries, so nobody mistakes a proposal for an installed contract. */
function stagingHeader(name: string, differences: string[]): string {
  const lines = [
    `# Converted from a legacy .claude/agents/${name}.md by adoption (T82).`,
    "#",
    "# STAGED, NOT INSTALLED. Nothing reads this file. Installing it means copying it",
    `# to contracts/${name}.yaml deliberately, after reading it — and note that`,
    "# --check-contracts compares contracts/ against the orchestrator's registry, so a",
    "# difference below is a difference that check will report once installed.",
  ];
  if (differences.length > 0) {
    lines.push("#", "# How the legacy agent differs from this framework's role of the same name:");
    for (const difference of differences) lines.push(`#   - ${difference}`);
  } else {
    lines.push("#", "# No behavioural difference found against this framework's role of the same name.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * T81's per-stage checkpoint, and the step that makes the imported knowledge
 * something the rest of the pipeline may rely on.
 *
 * A person approving a stage *is* the review of that stage's items, so each one
 * is walked `draft -> reviewed -> approved` through T65's real transition path,
 * with the same function T80 uses for discovered knowledge. Two consequences
 * worth naming: nothing reaches `approved` without a name against it, and from
 * then on `landing.ts` protects those items — a later re-run of the stage that
 * reads the legacy document differently is recorded as a conflict instead of
 * quietly reverting what somebody signed off.
 *
 * A stage that did nothing needs no approval, and asking for one teaches people
 * to sign without looking.
 */
export function approveAdoptionStage(
  id: AdoptionStageId,
  approvedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): AdoptionState {
  const state = requireState(projectRoot);
  const record = state.stages.find((s) => s.id === id);
  if (!record) throw new UnknownAdoptionStageError(id);
  if (record.status === "pending" || record.status === "in_progress") {
    throw new AdoptionNotSettledError([id]);
  }

  const onDisk = new Map(loadKnowledge(projectRoot).items.map((i) => [i.id, i]));
  for (const itemId of record.knowledge_ids) {
    const item = onDisk.get(itemId);
    // An id the stage claims but disk does not have is left to T88 to report:
    // this function's job is the approval, and failing it here would make a
    // reporting problem block the checkpoint.
    if (!item || item.status === "approved" || item.status === "deprecated") continue;
    advanceToApproved(item, now, projectRoot);
  }

  record.approved_by = approvedBy;
  record.approved_at = now;
  state.status = computeAdoptionStatus(state);
  state.updated_at = now;
  writeAdoptionState(state, projectRoot);
  return state;
}

/**
 * The sign-off that makes a project `adopted`. Refuses while a stage is
 * unfinished or unapproved — and fails before touching the file, so a refused
 * validation leaves nothing half-recorded.
 */
export function recordAdoptionValidation(
  validatedBy: string,
  projectRoot: string = defaultProjectRoot(),
  now: string = new Date().toISOString(),
): AdoptionState {
  const state = requireState(projectRoot);
  const unfinished = state.stages.filter((s) => s.status === "pending" || s.status === "in_progress").map((s) => s.id);
  if (unfinished.length > 0) throw new AdoptionNotSettledError(unfinished);
  const unapproved = unapprovedStages(state.stages).map((s) => s.id);
  if (unapproved.length > 0) throw new AdoptionNotApprovedError(unapproved);

  state.validated_by = validatedBy;
  state.validated_at = now;
  state.status = computeAdoptionStatus(state);
  state.updated_at = now;
  writeAdoptionState(state, projectRoot);
  return state;
}

export { ALL_ADOPTION_STAGES, needsApproval };
