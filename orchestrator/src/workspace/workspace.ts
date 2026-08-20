import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";

/**
 * Reads `workspace.yaml` — an optional file naming other project roots this
 * orchestrator instance can also drive (T41).
 *
 * Every checker and CLI verb already takes `--project-root`/`--state-db` per
 * invocation, and `.workflow/state.db` already lives under that root — a
 * single project has never needed a new concept to be isolated from another
 * one. What was missing was a way to see several of them *together* without
 * a person remembering each root by hand. That's all this file is: a list of
 * (name, root) pairs. It carries no task state of its own, so it never goes
 * stale the way a cached status would — `projects` re-reads each project's
 * own store every time.
 *
 * Absence is not an error. Most projects run standalone, the same as before
 * T41 — `checkWorkspace()` reports that as a note, not a problem, the same
 * way `checkProfile()`'s target/blocked_on note does for an unfinished
 * migration.
 */

export interface WorkspaceProjectEntry {
  name: string;
  /** Absolute, resolved relative to the directory holding workspace.yaml. */
  root: string;
}

export interface Workspace {
  version: number;
  projects: WorkspaceProjectEntry[];
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "workspace.schema.json",
);

export function workspacePath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "workspace.yaml");
}

export function hasWorkspace(projectRoot: string = defaultProjectRoot()): boolean {
  return fs.existsSync(workspacePath(projectRoot));
}

export class WorkspaceError extends Error {
  constructor(public readonly issues: string[]) {
    super(`workspace.yaml is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "WorkspaceError";
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

/** Reads and validates workspace.yaml, resolving every `root` relative to the file's own directory. Throws rather than returning a partly trusted list — a workspace an agent can't fully parse shouldn't be iterated over. */
export function loadWorkspace(projectRoot: string = defaultProjectRoot()): Workspace {
  const file = workspacePath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new WorkspaceError([`no file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new WorkspaceError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new WorkspaceError(
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }

  const doc = parsed as { version: number; projects: { name: string; root: string }[] };
  const baseDir = path.dirname(file);
  return {
    version: doc.version,
    projects: doc.projects.map((p) => ({ name: p.name, root: path.resolve(baseDir, p.root) })),
  };
}

export interface WorkspaceCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * The check `--check-workspace` runs. No file at all is not a problem — most
 * projects run standalone. A file that exists has to actually work: parse,
 * every project name unique, and every root a real directory — a workspace
 * pointing at nothing is worse than no workspace at all.
 */
export function checkWorkspace(projectRoot: string = defaultProjectRoot()): WorkspaceCheckResult {
  if (!hasWorkspace(projectRoot)) {
    return {
      ok: true,
      problems: [],
      notes: [
        "no workspace.yaml — this project runs standalone. Add one to group several project roots under one workspace (T41).",
      ],
    };
  }

  let workspace: Workspace;
  try {
    workspace = loadWorkspace(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof WorkspaceError ? e.issues : [String(e)], notes: [] };
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of workspace.projects) {
    if (seen.has(p.name)) {
      problems.push(`project name "${p.name}" is declared more than once`);
    }
    seen.add(p.name);
    if (!fs.existsSync(p.root) || !fs.statSync(p.root).isDirectory()) {
      problems.push(`project "${p.name}": root "${p.root}" is not a directory`);
    }
  }

  return { ok: problems.length === 0, problems, notes: [] };
}
