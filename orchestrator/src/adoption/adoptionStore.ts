import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import { checkAdoptionState, type AdoptionStageId, type AdoptionState } from "./adoptionModel.js";

/**
 * Read/write for everything under `knowledge/_adoption/` (T81, T89).
 *
 *   STATE.yaml            where this adoption has got to
 *   MANIFEST.yaml         every file it created or replaced, for rollback
 *   contracts/<name>.yaml T82's converted legacy agents, staged for review
 *   backup/<path>         a copy of anything it replaced
 *
 * Reserved directory, same reasoning as `_sources`/`_conflicts`/`_bootstrap`:
 * the knowledge item walk skips it, because a folder of process state and a
 * folder of items look identical from the outside. `RESERVED_DIRS` in
 * knowledgeStore.ts is where that is registered.
 *
 * WHY THE STAGED CONTRACTS ARE NOT IN `contracts/`
 *
 * T82 converts a legacy agent definition into this framework's Agent Contract
 * shape (T03). Writing the result straight into `contracts/` would do one of
 * two bad things: overwrite this framework's own contract for a role of the
 * same name, or add a contract for a role the orchestrator's registry has never
 * heard of — which turns `--check-contracts` red and makes adopting a project
 * look like breaking the framework. So conversions land here, where a person can
 * read them and decide, and the install is a separate deliberate act.
 */

export const ADOPTION_DIRNAME = "_adoption";
export const ADOPTION_STATE_FILENAME = "STATE.yaml";
export const ADOPTION_MANIFEST_FILENAME = "MANIFEST.yaml";
export const STAGED_CONTRACTS_DIRNAME = "contracts";
export const BACKUP_DIRNAME = "backup";

export function adoptionDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(knowledgeDir(projectRoot), ADOPTION_DIRNAME);
}

export function adoptionStatePath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(adoptionDir(projectRoot), ADOPTION_STATE_FILENAME);
}

export function adoptionManifestPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(adoptionDir(projectRoot), ADOPTION_MANIFEST_FILENAME);
}

export function stagedContractsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(adoptionDir(projectRoot), STAGED_CONTRACTS_DIRNAME);
}

export function stagedContractPath(agentName: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(stagedContractsDir(projectRoot), `${agentName}.yaml`);
}

export function backupDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(adoptionDir(projectRoot), BACKUP_DIRNAME);
}

/** Repo-relative, forward-slashed — the form the manifest and every report quote. */
export function relativeToRepo(absPath: string, projectRoot: string): string {
  return path.relative(projectRoot, absPath).split(path.sep).join("/");
}

export class AdoptionStateError extends Error {
  constructor(public readonly issues: string[]) {
    super(`knowledge/${ADOPTION_DIRNAME}/${ADOPTION_STATE_FILENAME} is not a usable adoption state:\n- ${issues.join("\n- ")}`);
    this.name = "AdoptionStateError";
  }
}

export class AdoptionManifestError extends Error {
  constructor(public readonly issues: string[]) {
    super(`knowledge/${ADOPTION_DIRNAME}/${ADOPTION_MANIFEST_FILENAME} is not a usable manifest:\n- ${issues.join("\n- ")}`);
    this.name = "AdoptionManifestError";
  }
}

export interface AdoptionStateReadResult {
  state: AdoptionState | null;
  /** Non-empty = the file exists but is unusable. `state` is null either way. */
  problems: string[];
}

/** null state + no problems = adoption has not started, the normal state for a project nobody has adopted. */
export function readAdoptionState(projectRoot: string = defaultProjectRoot()): AdoptionStateReadResult {
  const filePath = adoptionStatePath(projectRoot);
  if (!fs.existsSync(filePath)) return { state: null, problems: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { state: null, problems: [`could not read the file: ${(e as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return { state: null, problems: [`is not valid YAML: ${(e as Error).message}`] };
  }

  const problems = checkAdoptionState(parsed);
  if (problems.length > 0) return { state: null, problems };
  return { state: parsed as AdoptionState, problems: [] };
}

/** Atomic temp+rename, same pattern as knowledgeStore.ts's writeKnowledgeItem. */
export function writeAdoptionState(state: AdoptionState, projectRoot: string = defaultProjectRoot()): string {
  const problems = checkAdoptionState(state);
  if (problems.length > 0) throw new AdoptionStateError(problems);

  const filePath = adoptionStatePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(state, { sortMapEntries: false }), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export interface ManifestEntry {
  path: string;
  action: "created" | "replaced";
  backup: string | null;
  stage: AdoptionStageId;
  at: string;
}

export interface AdoptionManifest {
  schema_version: number;
  entries: ManifestEntry[];
  created_at: string;
  updated_at: string;
}

const MANIFEST_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "adoption-manifest.schema.json",
);

let manifestValidator: ValidateFunction | undefined;

function manifestValidate(): ValidateFunction {
  if (!manifestValidator) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    manifestValidator = ajv.compile(JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, "utf8")));
  }
  return manifestValidator;
}

export function checkAdoptionManifest(data: unknown): string[] {
  const validate = manifestValidate();
  if (!validate(data)) {
    return (validate.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
    });
  }
  const manifest = data as AdoptionManifest;
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    // A `replaced` entry with no backup is an undo that cannot undo, which is
    // worse than no manifest at all: rollback would report success having lost
    // the file's previous contents.
    if (entry.action === "replaced" && entry.backup === null) {
      problems.push(`${entry.path}: recorded as replaced but has no backup — rollback could not restore it`);
    }
    if (entry.action === "created" && entry.backup !== null) {
      problems.push(`${entry.path}: recorded as created but carries a backup — one of the two is wrong`);
    }
  }
  return problems;
}

export interface ManifestReadResult {
  manifest: AdoptionManifest | null;
  problems: string[];
}

export function readAdoptionManifest(projectRoot: string = defaultProjectRoot()): ManifestReadResult {
  const filePath = adoptionManifestPath(projectRoot);
  if (!fs.existsSync(filePath)) return { manifest: null, problems: [] };

  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { manifest: null, problems: [`is not valid YAML: ${(e as Error).message}`] };
  }

  const problems = checkAdoptionManifest(parsed);
  if (problems.length > 0) return { manifest: null, problems };
  return { manifest: parsed as AdoptionManifest, problems: [] };
}

export function writeAdoptionManifest(manifest: AdoptionManifest, projectRoot: string = defaultProjectRoot()): string {
  const problems = checkAdoptionManifest(manifest);
  if (problems.length > 0) throw new AdoptionManifestError(problems);

  const filePath = adoptionManifestPath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, stringifyYaml(manifest, { sortMapEntries: false }), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function newAdoptionManifest(now: string): AdoptionManifest {
  return { schema_version: 1, entries: [], created_at: now, updated_at: now };
}

/**
 * Records one written path, taking a backup first when something was already
 * there. Called *after* the write for a `created` path (nothing to preserve)
 * and *before* it for a `replaced` one — which is why `backupExisting` exists
 * separately below rather than being folded in here.
 *
 * An entry for a path already in the manifest is not duplicated: re-running a
 * stage writes the same file again, and the thing rollback needs to know is
 * "did this path exist before adoption", which the first entry already answers.
 * Overwriting it with a later `replaced` entry would make rollback restore
 * adoption's own earlier output instead of removing the file.
 */
export function recordManifestEntry(
  manifest: AdoptionManifest,
  entry: ManifestEntry,
): AdoptionManifest {
  if (manifest.entries.some((e) => e.path === entry.path)) return manifest;
  manifest.entries.push(entry);
  manifest.updated_at = entry.at;
  return manifest;
}

/** Copies a file that is about to be overwritten into the backup tree, returning its repo-relative backup path. */
export function backupExisting(absPath: string, projectRoot: string): string {
  const rel = relativeToRepo(absPath, projectRoot);
  const dest = path.join(backupDir(projectRoot), ...rel.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absPath, dest);
  return relativeToRepo(dest, projectRoot);
}
