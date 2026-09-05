import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

/**
 * local / dev / staging / production — a fixed, small vocabulary, not an open
 * one. Letting a project invent its own environment names would make "which
 * environment is this?" a question every reader has to look up per project;
 * four names every agent already understands from CLAUDE.md's own deploy
 * language is worth more than letting a project rename them.
 *
 * `environments.yaml` is optional and adds description / `requires_approval`
 * metadata for these four names — it never defines new ones (the schema's
 * `enum` enforces that). Absence is not an error: every project gets the
 * built-in generic descriptions below even with no file at all.
 */
export enum Environment {
  LOCAL = "local",
  DEV = "dev",
  STAGING = "staging",
  PRODUCTION = "production",
}

const ALL_ENVIRONMENTS = Object.values(Environment);

export function isEnvironment(value: string): value is Environment {
  return (ALL_ENVIRONMENTS as string[]).includes(value);
}

/** Used when a project declares no environments.yaml, and as the fallback for a name the file doesn't mention. */
const BUILT_IN_DESCRIPTION: Record<Environment, string> = {
  [Environment.LOCAL]: "a developer's own machine — not shared, not production; safe to experiment.",
  [Environment.DEV]: "a shared development environment — may hold non-critical shared state other people rely on.",
  [Environment.STAGING]: "pre-production — treat changes as if they could reach real users soon.",
  [Environment.PRODUCTION]: "real users and real data — the environment every other guardrail in this pipeline (security, QA, deploy approval) exists to protect.",
};

export interface EnvironmentEntry {
  name: Environment;
  description: string;
  requiresApproval?: boolean;
}

export interface EnvironmentConfig {
  version: number;
  environments: EnvironmentEntry[];
  default?: Environment;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "environments.schema.json",
);

export function environmentsPath(projectRoot: string): string {
  return path.join(projectRoot, "environments.yaml");
}

export function hasEnvironmentConfig(projectRoot: string): boolean {
  return fs.existsSync(environmentsPath(projectRoot));
}

export class EnvironmentConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`environments.yaml is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "EnvironmentConfigError";
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

/** Reads and validates environments.yaml. Throws rather than returning a partly trusted config. */
export function loadEnvironmentConfig(projectRoot: string): EnvironmentConfig {
  const file = environmentsPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new EnvironmentConfigError([`no file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new EnvironmentConfigError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new EnvironmentConfigError(
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }

  const doc = parsed as {
    version: number;
    environments: { name: string; description: string; requires_approval?: boolean }[];
    default?: string;
  };
  return {
    version: doc.version,
    environments: doc.environments.map((e) => ({
      name: e.name as Environment, // schema enum already restricts this to a real Environment value
      description: e.description,
      requiresApproval: e.requires_approval,
    })),
    default: doc.default as Environment | undefined,
  };
}

/** The description an agent's prompt should see for this environment — from environments.yaml if it names one, the built-in generic text otherwise. Never empty: an agent must always be told *something*. */
export function describeEnvironment(env: Environment, projectRoot: string): string {
  if (hasEnvironmentConfig(projectRoot)) {
    try {
      const entry = loadEnvironmentConfig(projectRoot).environments.find((e) => e.name === env);
      if (entry) return entry.description;
    } catch {
      // A broken environments.yaml falls back to the built-in text rather than crashing a run —
      // --check-environments is what surfaces the breakage; a task shouldn't be blocked by it.
    }
  }
  return BUILT_IN_DESCRIPTION[env];
}

/** environments.yaml's declared default, or the built-in default (local) when there is none or no file. */
export function resolveDefaultEnvironment(projectRoot: string): Environment {
  if (hasEnvironmentConfig(projectRoot)) {
    try {
      return loadEnvironmentConfig(projectRoot).default ?? Environment.LOCAL;
    } catch {
      return Environment.LOCAL;
    }
  }
  return Environment.LOCAL;
}

export interface EnvironmentConfigCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * The check `--check-environments` runs. No file at all is not a problem —
 * every project gets the four built-in descriptions. A file that exists has
 * to actually work: parse, every declared name distinct, and `default` (if
 * set) naming an environment the file actually declares.
 */
export function checkEnvironmentConfig(projectRoot: string): EnvironmentConfigCheckResult {
  if (!hasEnvironmentConfig(projectRoot)) {
    return {
      ok: true,
      problems: [],
      notes: ["no environments.yaml — using the four built-in generic descriptions (T43)."],
    };
  }

  let config: EnvironmentConfig;
  try {
    config = loadEnvironmentConfig(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof EnvironmentConfigError ? e.issues : [String(e)], notes: [] };
  }

  const problems: string[] = [];
  const seen = new Set<Environment>();
  for (const entry of config.environments) {
    if (seen.has(entry.name)) {
      problems.push(`environment "${entry.name}" is declared more than once`);
    }
    seen.add(entry.name);
  }

  if (config.default !== undefined && !seen.has(config.default)) {
    problems.push(`default "${config.default}" is not one of the environments this file declares`);
  }

  return { ok: problems.length === 0, problems, notes: [] };
}
