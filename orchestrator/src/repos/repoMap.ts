import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Reads `repos.yaml` — an optional file naming the separate git repos a
 * single project's pipeline spans (frontend/backend/infra), each written to
 * by a different subset of pipeline stages. Docs (`_docs/`, `.claude/`,
 * `design.md`, `status.md`) still live in one project root; only
 * `backend-engineer`/`frontend-engineer` may need `claude` running in a
 * different working directory to commit code where it belongs.
 * `runtime/runtimeExecutor.ts`'s `stageRoots` option acts on what this module
 * reads and validates.
 *
 * Absence is not an error: most projects keep everything in one repo, and
 * `checkRepoMap()` reports that as a note, not a problem.
 */

export interface RepoEntry {
  name: string;
  /** Absolute, resolved relative to the directory holding repos.yaml. */
  root: string;
  stages: AgentStage[];
}

export interface RepoMap {
  version: number;
  repos: RepoEntry[];
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "repos.schema.json",
);

export function reposPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "repos.yaml");
}

export function hasRepoMap(projectRoot: string = defaultProjectRoot()): boolean {
  return fs.existsSync(reposPath(projectRoot));
}

export class RepoMapError extends Error {
  constructor(public readonly issues: string[]) {
    super(`repos.yaml is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "RepoMapError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/** Reads and validates repos.yaml, resolving every `root` relative to the file's own directory. Throws rather than returning a partly trusted map — a stage sent to the wrong checkout is worse than one sent nowhere. */
export function loadRepoMap(projectRoot: string = defaultProjectRoot()): RepoMap {
  const file = reposPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new RepoMapError([`no file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new RepoMapError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new RepoMapError(
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }

  const doc = parsed as { version: number; repos: { name: string; root: string; stages: string[] }[] };
  const baseDir = path.dirname(file);
  return {
    version: doc.version,
    repos: doc.repos.map((r) => ({
      name: r.name,
      root: path.resolve(baseDir, r.root),
      stages: r.stages as AgentStage[], // schema enum already restricts these to real AgentStage values
    })),
  };
}

/** Stage -> repo root, flattened from every repo's `stages` list. A stage this map does not mention is simply absent from the result — the caller falls back to the project root for it. */
export function stageRoots(repoMap: RepoMap): Partial<Record<AgentStage, string>> {
  const result: Partial<Record<AgentStage, string>> = {};
  for (const repo of repoMap.repos) {
    for (const stage of repo.stages) result[stage] = repo.root;
  }
  return result;
}

/** `loadRepoMap` + `stageRoots` in one call, or `undefined` when there is no repos.yaml — the shape `createRuntimeExecutor`'s options want directly. */
export function loadStageRoots(projectRoot: string = defaultProjectRoot()): Partial<Record<AgentStage, string>> | undefined {
  if (!hasRepoMap(projectRoot)) return undefined;
  return stageRoots(loadRepoMap(projectRoot));
}

export interface RepoMapCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * The check `--check-repos` runs. No file at all is not a problem. A file
 * that exists has to actually work: parse, every repo name unique, every
 * root a real directory, and no stage claimed by two repos at once (that
 * would make "where does this stage's code land" ambiguous).
 */
export function checkRepoMap(projectRoot: string = defaultProjectRoot()): RepoMapCheckResult {
  if (!hasRepoMap(projectRoot)) {
    return {
      ok: true,
      problems: [],
      notes: ["no repos.yaml — every stage writes into the project root, the same repo."],
    };
  }

  let repoMap: RepoMap;
  try {
    repoMap = loadRepoMap(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof RepoMapError ? e.issues : [String(e)], notes: [] };
  }

  const problems: string[] = [];
  const seenNames = new Set<string>();
  const stageOwner = new Map<AgentStage, string>();
  for (const repo of repoMap.repos) {
    if (seenNames.has(repo.name)) {
      problems.push(`repo name "${repo.name}" is declared more than once`);
    }
    seenNames.add(repo.name);

    if (!fs.existsSync(repo.root) || !fs.statSync(repo.root).isDirectory()) {
      problems.push(`repo "${repo.name}": root "${repo.root}" is not a directory`);
    }

    for (const stage of repo.stages) {
      const owner = stageOwner.get(stage);
      if (owner && owner !== repo.name) {
        problems.push(`stage "${stage}" is claimed by both "${owner}" and "${repo.name}" — a stage can only write into one repo`);
      }
      stageOwner.set(stage, repo.name);
    }
  }

  return { ok: problems.length === 0, problems, notes: [] };
}
