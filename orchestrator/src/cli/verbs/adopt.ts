/**
 * `adopt` (T81, wired to the CLI as part of T113's pilot — the library existed
 * since V1.3 but nothing exposed it to a person before this).
 *
 * `plan` is deliberately the sub-command with no state requirement and no
 * writes at all: it is meant to be runnable as the very first thing anyone
 * does against a real legacy project, before `start` even creates
 * `knowledge/_adoption/state.json`. Every other sub-command requires the state
 * `initAdoption()` created, and reports the same "no adoption in progress" a
 * person would get from calling the library directly rather than a CLI-only
 * error shape.
 */
export async function runAdoptVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const sourceRoot = flagValue(rest, "--source-root") ?? projectRoot;
  if (sourceRoot !== projectRoot) {
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new CliUsageError(`adopt: Knowledge root is not an existing directory: ${projectRoot}`);
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new CliUsageError(`adopt: legacy source root is not an existing directory: ${sourceRoot}`);
    const knowledgeCanonical = fs.realpathSync.native(projectRoot);
    const sourceCanonical = fs.realpathSync.native(sourceRoot);
    if (knowledgeCanonical === sourceCanonical || knowledgeCanonical.startsWith(`${sourceCanonical}${path.sep}`) || sourceCanonical.startsWith(`${knowledgeCanonical}${path.sep}`)) {
      throw new CliUsageError("adopt: --source-root must be separate from the Knowledge root; refusing a source/destination overlap");
    }
  }
  // T113 pilot finding: not every real adoption target has its own `_docs/`
  // right at the repo root — a monorepo or a per-client subtree may nest it.
  // Repo-relative so a person types the same thing they'd see in a listing
  // (`--docs-root _docs/hkt`), resolved against `sourceRoot` so a three-repo
  // adoption reads the Target while writing only to the Knowledge root.
  // every other path this CLI reports already is. No state persists this
  // across invocations (same as `--project-root` itself) — pass it on every
  // `adopt` call for this project, `plan` included.
  const docsRootFlag = flagValue(rest, "--docs-root");
  const docsRoot = docsRootFlag !== undefined ? path.join(sourceRoot, docsRootFlag) : undefined;
  const args = positionalArgs(rest);
  const now = new Date().toISOString();
  const SUB_COMMANDS = ["plan", "status", "start", "ack", "run", "approve", "validate"];
  const sub = args[0];
  if (sub === undefined || !SUB_COMMANDS.includes(sub)) {
    throw new CliUsageError(`adopt: a sub-command is required — one of ${SUB_COMMANDS.join(", ")}`);
  }

  if (sub === "plan") {
    const plan = planAdoption(projectRoot, now, docsRoot, sourceRoot);
    if (plan.preflight.blockers.length > 0) {
      console.log(`[orchestrator] preflight found work in flight — this would block \`adopt start\` until acknowledged:`);
      for (const b of plan.preflight.blockers) console.log(`  ! ${b}`);
    }
    for (const stage of plan.stages) {
      console.log(`\n${stage.id}${stage.skipped ? " (nothing to import)" : ""}`);
      for (const w of stage.writes) console.log(`  ${w.action.padEnd(9)} ${w.path}  (${w.subject})`);
      for (const c of stage.conflicts) console.log(`  ! conflict: ${c} — already reviewed, legacy material now disagrees`);
      for (const n of stage.notes) console.log(`  · ${n}`);
    }
    console.log(
      `\n[orchestrator] plan: ${plan.totals.create} to create, ${plan.totals.update} to update, ` +
        `${plan.totals.unchanged} unchanged, ${plan.totals.conflict} conflict(s). Nothing was written — this is a dry run (T87).`,
    );
    return 0;
  }

  try {
    if (sub === "status") {
      const { state, problems } = readAdoptionState(projectRoot);
      if (problems.length > 0) {
        for (const p of problems) console.error(`[orchestrator] ${p}`);
        return 1;
      }
      if (!state) {
        console.log("[orchestrator] no adoption in progress — run `adopt plan` first, then `adopt start`.");
        return 0;
      }
      console.log(`[orchestrator] status: ${state.status}`);
      for (const s of state.stages) {
        console.log(`  ${s.id.padEnd(14)} ${s.status}${s.approved_by ? ` (approved by ${s.approved_by})` : ""}`);
      }
      return 0;
    }

    if (sub === "start") {
      const state = initAdoption(projectRoot, now, docsRoot, sourceRoot);
      console.log(`[orchestrator] adoption started — status: ${state.status}`);
      if (state.preflight && state.preflight.blockers.length > 0) {
        console.log("  blocked on:");
        for (const b of state.preflight.blockers) console.log(`  ! ${b}`);
        console.log('  run `adopt ack --by <name>` once a person has decided it is safe to import over this.');
      }
      return 0;
    }

    if (sub === "ack") {
      const by = flagValue(rest, "--by");
      if (!by) throw new CliUsageError("adopt ack: --by <name> is required");
      const state = acknowledgePreflight(by, projectRoot, now);
      console.log(`[orchestrator] preflight acknowledged by ${by} — status: ${state.status}`);
      return 0;
    }

    if (sub === "run") {
      const stageId = args[1];
      if (!stageId || !(ALL_ADOPTION_STAGES as readonly string[]).includes(stageId)) {
        throw new CliUsageError(`adopt run: a stage id is required — one of ${ALL_ADOPTION_STAGES.join(", ")}`);
      }
      const state = runAdoptionStage(stageId as AdoptionStageId, projectRoot, now, docsRoot, sourceRoot);
      const record = state.stages.find((s) => s.id === stageId)!;
      console.log(
        `[orchestrator] ${stageId}: ${record.status}${record.note ? ` — ${record.note}` : ""} — status: ${state.status}`,
      );
      return 0;
    }

    if (sub === "approve") {
      const stageId = args[1];
      const by = flagValue(rest, "--by");
      if (!stageId || !(ALL_ADOPTION_STAGES as readonly string[]).includes(stageId)) {
        throw new CliUsageError(`adopt approve: a stage id is required — one of ${ALL_ADOPTION_STAGES.join(", ")}`);
      }
      if (!by) throw new CliUsageError("adopt approve: --by <name> is required");
      const state = approveAdoptionStage(stageId as AdoptionStageId, by, projectRoot, now);
      console.log(`[orchestrator] ${stageId} approved by ${by} — status: ${state.status}`);
      return 0;
    }

    // validate
    const by = flagValue(rest, "--by");
    if (!by) throw new CliUsageError("adopt validate: --by <name> is required");
    const report = validateAdoption(projectRoot, now, docsRoot, sourceRoot);
    if (!report.ok) {
      console.error("[orchestrator] adoption validation failed:");
      for (const problem of report.problems) console.error(`  ! ${problem}`);
      return 1;
    }
    const state = recordAdoptionValidation(by, projectRoot, now);
    console.log(`[orchestrator] adoption validated by ${by} — status: ${state.status}`);
    return 0;
  } catch (e) {
    if (e instanceof AdoptionBlockedError) {
      console.error("[orchestrator] adoption is blocked:");
      for (const b of e.blockers) console.error(`  ! ${b}`);
      console.error('  run `adopt ack --by <name>` once a person has decided it is safe to import over this.');
      return 1;
    }
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
import * as fs from "node:fs";
import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import {
  acknowledgePreflight,
  AdoptionBlockedError,
  ALL_ADOPTION_STAGES,
  approveAdoptionStage,
  initAdoption,
  planAdoption,
  recordAdoptionValidation,
  runAdoptionStage,
} from "../../adoption/adoptionRunner.js";
import { readAdoptionState } from "../../adoption/adoptionStore.js";
import { validateAdoption } from "../../adoption/adoptionValidation.js";
import type { AdoptionStageId } from "../../adoption/adoptionModel.js";
import { flagValue, positionalArgs } from "../support.js";
