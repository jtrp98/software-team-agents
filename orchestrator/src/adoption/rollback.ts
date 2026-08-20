import * as fs from "node:fs";
import * as path from "node:path";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { KNOWLEDGE_DIRNAME } from "../knowledge/knowledgeStore.js";
import {
  ADOPTION_DIRNAME,
  AdoptionManifestError,
  adoptionDir,
  readAdoptionManifest,
  type ManifestEntry,
} from "./adoptionStore.js";

/**
 * Migration Rollback (T89) — put the project back exactly as it was.
 *
 * WHAT MAKES THIS TRACTABLE
 *
 * Adoption never deletes, moves or rewrites a legacy file. Everything it does is
 * additive and inside `knowledge/`, and every write went into the manifest with
 * a backup of anything it replaced. So undoing it is: delete what was created,
 * restore what was replaced, then remove adoption's own bookkeeping. There is no
 * reconstruction step, because nothing was destroyed.
 *
 * THE GUARD, AND WHY IT IS NOT PARANOIA
 *
 * This function deletes files from a list in a file. The manifest schema already
 * constrains every path to `knowledge/`, and this checks it again at the moment
 * of deleting rather than trusting that it was checked earlier — because the two
 * checks fail differently. A schema catches a malformed manifest; this catches a
 * *valid* manifest describing a path outside `knowledge/`, which could only
 * arrive by a bug in adoption itself or by somebody editing the file. Neither is
 * a reason to delete project code. An out-of-scope path is refused and reported,
 * and the rest of the rollback still runs — leaving the project half-rolled-back
 * because one line was wrong would be its own kind of damage.
 *
 * PARTIAL ROLLBACK
 *
 * `stage` undoes one stage's writes and leaves the rest, which is what a
 * rejected checkpoint (T81) needs: the stage that got a document's meaning wrong
 * is re-runnable without discarding the three that were right.
 */

export interface RollbackOptions {
  /** Undo only this stage's writes. Omitted = the whole adoption, bookkeeping included. */
  stage?: ManifestEntry["stage"];
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
}

export interface RollbackReport {
  deleted: string[];
  restored: string[];
  /** Recorded but already gone — somebody removed it by hand. Not an error: the end state is the one wanted. */
  alreadyGone: string[];
  /** Paths the manifest named that rollback refused to touch, with why. */
  refused: Array<{ path: string; reason: string }>;
  /** Directories left empty by the removals and pruned. */
  prunedDirs: string[];
  /** True when adoption's own state/manifest/backup tree was removed too (a full rollback only). */
  removedAdoptionDir: boolean;
  dryRun: boolean;
}

/** Inside `knowledge/`, no `..`, not absolute. Checked here as well as in the schema — see the module doc. */
function isSafePath(relative: string): boolean {
  if (path.isAbsolute(relative)) return false;
  const normalised = relative.split(path.sep).join("/");
  if (normalised.split("/").includes("..")) return false;
  return normalised.startsWith(`${KNOWLEDGE_DIRNAME}/`);
}

/** Removes directories left empty by a deletion, stopping at `knowledge/`. */
function pruneEmptyDirs(startDir: string, projectRoot: string, pruned: string[]): void {
  const stopAt = path.join(projectRoot, KNOWLEDGE_DIRNAME);
  let dir = startDir;
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(dir);
    pruned.push(path.relative(projectRoot, dir).split(path.sep).join("/"));
    dir = path.dirname(dir);
  }
}

/**
 * Undoes an adoption. Throws only when the manifest itself cannot be read —
 * everything else is reported, because a rollback that stopped at the first
 * surprise would leave the project in a state neither adopted nor not.
 */
export function rollbackAdoption(
  projectRoot: string = defaultProjectRoot(),
  options: RollbackOptions = {},
): RollbackReport {
  const report: RollbackReport = {
    deleted: [],
    restored: [],
    alreadyGone: [],
    refused: [],
    prunedDirs: [],
    removedAdoptionDir: false,
    dryRun: options.dryRun === true,
  };

  const { manifest, problems } = readAdoptionManifest(projectRoot);
  if (problems.length > 0) throw new AdoptionManifestError(problems);
  if (!manifest) return report;

  const entries = options.stage ? manifest.entries.filter((e) => e.stage === options.stage) : manifest.entries;

  for (const entry of entries) {
    if (!isSafePath(entry.path)) {
      report.refused.push({ path: entry.path, reason: `outside ${KNOWLEDGE_DIRNAME}/ — adoption never writes there, so rollback will not delete there` });
      continue;
    }

    const abs = path.join(projectRoot, ...entry.path.split("/"));

    if (entry.action === "replaced") {
      if (entry.backup === null) {
        report.refused.push({ path: entry.path, reason: "recorded as replaced with no backup — its previous contents are not recoverable" });
        continue;
      }
      const backupAbs = path.join(projectRoot, ...entry.backup.split("/"));
      if (!fs.existsSync(backupAbs)) {
        report.refused.push({ path: entry.path, reason: `its backup (${entry.backup}) is missing, so restoring would guess` });
        continue;
      }
      if (!report.dryRun) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(backupAbs, abs);
      }
      report.restored.push(entry.path);
      continue;
    }

    if (!fs.existsSync(abs)) {
      report.alreadyGone.push(entry.path);
      continue;
    }
    if (!report.dryRun) fs.rmSync(abs);
    report.deleted.push(entry.path);
    if (!report.dryRun) pruneEmptyDirs(path.dirname(abs), projectRoot, report.prunedDirs);
  }

  // A full rollback takes adoption's own footprint with it — TASKS_V1.md's
  // "ไม่เหลือไฟล์ค้าง". A per-stage rollback must not: the state file is how the
  // remaining stages are still tracked.
  if (!options.stage) {
    const dir = adoptionDir(projectRoot);
    if (fs.existsSync(dir)) {
      if (!report.dryRun) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruneEmptyDirs(path.dirname(dir), projectRoot, report.prunedDirs);
      }
      report.removedAdoptionDir = true;
      report.deleted.push(`${KNOWLEDGE_DIRNAME}/${ADOPTION_DIRNAME}/`);
    }

    // `pruneEmptyDirs` stops *at* `knowledge/` — every other caller of it is
    // removing something inside a directory that was already there. Here it is
    // the last step of undoing an adoption, and a project that had no
    // `knowledge/` before should not be left with an empty one afterwards. A
    // project that had its own (this framework's repo has a README in it) is
    // not empty, so this leaves it alone.
    const knowledge = path.join(projectRoot, KNOWLEDGE_DIRNAME);
    if (!report.dryRun && fs.existsSync(knowledge) && fs.readdirSync(knowledge).length === 0) {
      fs.rmdirSync(knowledge);
      report.prunedDirs.push(`${KNOWLEDGE_DIRNAME}/`);
    }
  }

  return report;
}
