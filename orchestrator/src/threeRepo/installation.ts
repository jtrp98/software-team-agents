import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface InstallationConfig {
  schema_version: 1;
  knowledge_root: string;
}

export class InstallationConfigError extends Error {}

function isSameOrNested(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Validates the repository identity root, not merely the presence of a
 * `.git` marker. Linked worktrees share metadata with another checkout and
 * cannot safely be a Framework, Knowledge, or Target authority root.
 *
 * This deliberately inspects local metadata rather than invoking Git. The
 * runtime guard forbids Git commands, so validation must not create the very
 * policy violation it is supposed to prevent. A directory-form `.git` with no
 * `commondir` is the fail-closed standalone shape; a file-form marker is a
 * linked worktree and is rejected. */
export function assertStandaloneRepositoryRoot(repositoryRoot: string, label: string): string {
  const resolved = path.resolve(repositoryRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new InstallationConfigError(`${label} root "${repositoryRoot}" is not an existing directory`);
  }
  const canonical = fs.realpathSync.native(resolved);
  const gitMarker = path.join(canonical, ".git");
  if (!fs.existsSync(gitMarker)) {
    throw new InstallationConfigError(`${label} root "${canonical}" is not a standalone Git repository`);
  }
  if (!fs.statSync(gitMarker).isDirectory()) {
    throw new InstallationConfigError(`${label} root "${canonical}" is a Git linked worktree; configure a standalone ${label} repository path instead`);
  }
  if (fs.existsSync(path.join(gitMarker, "commondir"))) {
    throw new InstallationConfigError(`${label} root "${canonical}" uses shared Git metadata and is not a standalone repository`);
  }
  return canonical;
}

export function assertStandaloneKnowledgeRoot(knowledgeRoot: string): string {
  return assertStandaloneRepositoryRoot(knowledgeRoot, "Knowledge");
}

export function assertStandaloneFrameworkRoot(frameworkRoot: string): string {
  return assertStandaloneRepositoryRoot(frameworkRoot, "Framework");
}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "installation.schema.json");
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}

export function defaultInstallationConfigPath(platform = process.platform, localAppData = process.env.LOCALAPPDATA, home = os.homedir()): string {
  if (platform === "win32") {
    if (!localAppData) throw new InstallationConfigError("LOCALAPPDATA is unavailable; cannot resolve installation config path");
    return path.join(localAppData, "software-team-agents", "installation.yaml");
  }
  return path.join(home, ".config", "software-team-agents", "installation.yaml");
}

export function loadInstallationConfig(configPath = defaultInstallationConfigPath()): InstallationConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new InstallationConfigError(`cannot read installation config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = validator();
  if (!validate(parsed)) throw new InstallationConfigError(`installation config is invalid: ${(validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`);
  return parsed as InstallationConfig;
}

export function configureKnowledgeRoot(knowledgeRoot: string, configPath = defaultInstallationConfigPath(), frameworkRoot?: string): InstallationConfig {
  const canonical = assertStandaloneKnowledgeRoot(knowledgeRoot);
  if (frameworkRoot) {
    const frameworkCanonical = assertStandaloneFrameworkRoot(frameworkRoot);
    if (isSameOrNested(canonical, frameworkCanonical) || isSameOrNested(frameworkCanonical, canonical)) {
      throw new InstallationConfigError("Knowledge root must not overlap the Framework root");
    }
  }
  const configCanonicalCandidate = path.resolve(configPath);
  if (configCanonicalCandidate === canonical || configCanonicalCandidate.startsWith(`${canonical}${path.sep}`)) {
    throw new InstallationConfigError("installation config must be installation-local, not inside the Knowledge repo");
  }
  // A per-run override must never turn a Target or the framework itself into
  // installation state. Both are writable workspaces, not configuration homes.
  // A clone has a .git directory at its root. Installation-local state may be
  // anywhere on the machine, but it must not be committed into either a Target
  // or Framework repository (nor into any nested worktree).
  for (let cursor = path.dirname(configCanonicalCandidate); ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) {
      throw new InstallationConfigError("installation config must be installation-local, not inside a Framework or Target repository");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config: InstallationConfig = { schema_version: 1, knowledge_root: canonical };
  fs.writeFileSync(configPath, stringifyYaml(config, { sortMapEntries: false }), "utf8");
  return config;
}
