import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  assertStandaloneKnowledgeRoot,
  canonicalPathForComparison,
  configureDefaultRoot,
  configureNamedKnowledgeRoot,
  defaultInstallationConfigPath,
  InstallationConfigError,
  KNOWLEDGE_ROOT_NAME_PATTERN,
  loadInstallationConfig,
  normalizeKnowledgeRoots,
  removeNamedKnowledgeRoot,
  type InstallationConfig,
} from "../threeRepo/installation.js";
import { auditTargetOwnershipAcrossRoots } from "../threeRepo/ownershipAudit.js";
import { loadTargetRegistry, normalizeTargetRegistry, targetsPath } from "../threeRepo/targets.js";
import { declaredCheckoutPaths, localTargetsPath } from "../threeRepo/localTargets.js";
import { assertInsideMachineRoots, MachineConfigError, type MachineConfig } from "./machineConfig.js";

/**
 * Knowledge workspaces as STA Core sees them — a read/validate/register layer
 * over the existing named-root registry in `installation.yaml`. It adds no
 * second registry: names and paths are read from and written through
 * `threeRepo/installation.ts`, so `sta configure knowledge-root --root`,
 * `sta knowledge add` and the Web UI all edit the same map.
 *
 * Isolation starts here: every listing below is computed from ONE root's own
 * files (`_docs/module/*`, `targets.yaml`, `.workflow/targets.local.yaml`).
 * Nothing merges two roots; the cross-root view exists only for the ownership
 * proof, which is exactly the check that keeps a Target from being implicitly
 * owned by two Knowledge roots.
 */

export type KnowledgeState = "READY" | "WARNING" | "INVALID" | "MISSING";

export interface KnowledgeTargetSummary {
  targetId: string;
  name: string;
  type: string | null;
  status: string;
  ownership: string;
  localPath: string | null;
}

export interface KnowledgeSummary {
  name: string;
  path: string;
  isDefault: boolean;
  state: KnowledgeState;
  modules: string[];
  targets: KnowledgeTargetSummary[];
  problems: string[];
  warnings: string[];
}

export class KnowledgeRegistryError extends Error {}

/** `_docs/module/<name>/` folders of one Knowledge root — never another root's. */
export function listModules(knowledgePath: string): string[] {
  const dir = path.join(knowledgePath, "_docs", "module");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function targetsOf(knowledgePath: string, problems: string[]): KnowledgeTargetSummary[] {
  if (!fs.existsSync(targetsPath(knowledgePath))) return [];
  try {
    const registry = normalizeTargetRegistry(loadTargetRegistry(knowledgePath));
    const local = declaredCheckoutPaths(knowledgePath);
    return registry.targets.map((target) => ({
      targetId: target.target_id,
      name: target.name,
      type: target.type ?? null,
      status: target.status,
      ownership: target.ownership_state,
      localPath: local[target.target_id] ?? null,
    }));
  } catch (error) {
    problems.push(`targets.yaml cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Everything checkable about one Knowledge root without touching another:
 * exists, is a standalone Git repository, looks like a Knowledge workspace,
 * its Target registry and local mapping read, and (with a machine config)
 * the root and every mapped Target checkout sit inside the machine boundary.
 */
export function inspectKnowledgeRoot(name: string, knowledgePath: string, options: { isDefault?: boolean; machine?: MachineConfig } = {}): KnowledgeSummary {
  const problems: string[] = [];
  const warnings: string[] = [];
  const resolved = path.resolve(knowledgePath);
  if (!fs.existsSync(resolved)) {
    return { name, path: resolved, isDefault: options.isDefault ?? false, state: "MISSING", modules: [], targets: [], problems: [`path does not exist: ${resolved}`], warnings };
  }
  try {
    assertStandaloneKnowledgeRoot(resolved);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const markers = ["_docs", "targets.yaml", path.join(".agent-team", "config.yaml"), "knowledge"].filter((marker) => fs.existsSync(path.join(resolved, marker)));
  if (markers.length === 0) {
    problems.push("does not look like a Knowledge workspace (no _docs/, targets.yaml, .agent-team/config.yaml or knowledge/) — run `software-team-agents init` in it first");
  }
  if (options.machine) {
    try {
      assertInsideMachineRoots(options.machine, resolved, "Knowledge root");
    } catch (error) {
      problems.push(error instanceof MachineConfigError ? error.message : String(error));
    }
  }
  const targets = targetsOf(resolved, problems);
  if (fs.existsSync(localTargetsPath(resolved)) && options.machine) {
    for (const target of targets) {
      if (!target.localPath) continue;
      try {
        assertInsideMachineRoots(options.machine, target.localPath, `Target "${target.targetId}" checkout`);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (targets.length === 0) warnings.push("no Targets registered yet (targets.yaml) — work that writes code needs at least one");
  const modules = listModules(resolved);
  if (modules.length === 0) warnings.push("no modules under _docs/module/ yet");
  const state: KnowledgeState = problems.length > 0 ? "INVALID" : warnings.length > 0 ? "WARNING" : "READY";
  return { name, path: resolved, isDefault: options.isDefault ?? false, state, modules, targets, problems, warnings };
}

function loadInstallationOrNull(configPath: string): InstallationConfig | null {
  if (!fs.existsSync(configPath)) return null;
  return loadInstallationConfig(configPath);
}

export function listKnowledge(options: { machine?: MachineConfig; configPath?: string } = {}): KnowledgeSummary[] {
  const configPath = options.configPath ?? defaultInstallationConfigPath();
  const config = loadInstallationOrNull(configPath);
  if (!config) return [];
  const normalized = normalizeKnowledgeRoots(config);
  return Object.keys(normalized.roots).sort().map((name) =>
    inspectKnowledgeRoot(name, normalized.roots[name] as string, { isDefault: name === normalized.defaultRoot, machine: options.machine }));
}

/** Resolves one registered Knowledge root by name (or the default), with its canonical path. */
export function resolveKnowledge(name: string | undefined, configPath = defaultInstallationConfigPath()): { name: string; path: string } {
  const config = loadInstallationOrNull(configPath);
  if (!config) throw new KnowledgeRegistryError("no Knowledge root is registered yet — run `sta knowledge add <name> <path>`");
  const normalized = normalizeKnowledgeRoots(config);
  const chosen = name ?? normalized.defaultRoot;
  const rootPath = normalized.roots[chosen];
  if (rootPath === undefined) {
    throw new KnowledgeRegistryError(`unknown Knowledge root "${chosen}"; registered: ${Object.keys(normalized.roots).sort().join(", ")}`);
  }
  let canonical = path.resolve(rootPath);
  try { canonical = fs.realpathSync.native(canonical); } catch { /* reported by inspect */ }
  return { name: chosen, path: canonical };
}

/**
 * The cross-root ownership proof for a candidate registration, computed on a
 * temporary copy of the installation map that already includes it. The real
 * installation file is not touched until the proof passes.
 */
function ownershipProblemsWith(name: string, candidatePath: string, configPath: string): string[] {
  const existing = loadInstallationOrNull(configPath);
  const roots = existing ? { ...normalizeKnowledgeRoots(existing).roots } : {};
  roots[name] = candidatePath;
  const defaultRoot = existing ? normalizeKnowledgeRoots(existing).defaultRoot : name;
  const effectiveDefault = roots[defaultRoot] !== undefined ? defaultRoot : name;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sta-ownership-"));
  const file = path.join(temp, "installation.yaml");
  try {
    fs.writeFileSync(file, stringifyYaml({ schema_version: 2, default_root: effectiveDefault, knowledge_roots: roots, knowledge_root: roots[effectiveDefault] }), "utf8");
    const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: file });
    return audit.problems;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export interface AddKnowledgeOptions {
  makeDefault?: boolean;
  machine?: MachineConfig;
  configPath?: string;
  frameworkRoot?: string;
}

/**
 * `sta knowledge add <name> <path>` / Web "Add Knowledge": validate first,
 * register second. Refuses an invalid root, a duplicate name or path, a root
 * outside the machine boundary, and any registration that would make a Target
 * owned by two Knowledge roots.
 */
export function addKnowledge(name: string, knowledgePath: string, options: AddKnowledgeOptions = {}): KnowledgeSummary {
  if (!KNOWLEDGE_ROOT_NAME_PATTERN.test(name)) {
    throw new KnowledgeRegistryError(`Knowledge name "${name}" must match ${KNOWLEDGE_ROOT_NAME_PATTERN.source} (lowercase, digits, '-')`);
  }
  const configPath = options.configPath ?? defaultInstallationConfigPath();
  const existing = loadInstallationOrNull(configPath);
  if (existing) {
    const roots = normalizeKnowledgeRoots(existing).roots;
    if (roots[name] !== undefined && canonicalPathForComparison(roots[name] as string) !== canonicalPathForComparison(knowledgePath)) {
      throw new KnowledgeRegistryError(`Knowledge "${name}" is already registered at ${roots[name]} — remove it first or choose another name`);
    }
    for (const [other, otherPath] of Object.entries(roots)) {
      if (other !== name && canonicalPathForComparison(otherPath) === canonicalPathForComparison(knowledgePath)) {
        throw new KnowledgeRegistryError(`path ${knowledgePath} is already registered as Knowledge "${other}"`);
      }
    }
  }
  const summary = inspectKnowledgeRoot(name, knowledgePath, { machine: options.machine });
  if (summary.state === "MISSING" || summary.state === "INVALID") {
    throw new KnowledgeRegistryError(`cannot add Knowledge "${name}": ${summary.problems.join("; ")}`);
  }
  const ownership = ownershipProblemsWith(name, summary.path, configPath);
  if (ownership.length > 0) {
    throw new KnowledgeRegistryError(`cannot add Knowledge "${name}": Target ownership would conflict — ${ownership.join("; ")}`);
  }
  try {
    configureNamedKnowledgeRoot(summary.path, { rootName: name, makeDefault: options.makeDefault, configPath, frameworkRoot: options.frameworkRoot });
  } catch (error) {
    if (error instanceof InstallationConfigError) throw new KnowledgeRegistryError(error.message);
    throw error;
  }
  const after = loadInstallationConfig(configPath);
  return { ...summary, isDefault: normalizeKnowledgeRoots(after).defaultRoot === name };
}

export function setDefaultKnowledge(name: string, configPath = defaultInstallationConfigPath()): void {
  try {
    configureDefaultRoot(name, configPath);
  } catch (error) {
    if (error instanceof InstallationConfigError) throw new KnowledgeRegistryError(error.message);
    throw error;
  }
}

/** Registration only — the repository on disk is never deleted. */
export function removeKnowledgeRegistration(name: string, configPath = defaultInstallationConfigPath()): void {
  try {
    removeNamedKnowledgeRoot(name, configPath);
  } catch (error) {
    if (error instanceof InstallationConfigError) throw new KnowledgeRegistryError(error.message);
    throw error;
  }
}

/** Full validation of one registered root, including the cross-root ownership proof. */
export function validateKnowledge(name: string, options: { machine?: MachineConfig; configPath?: string } = {}): KnowledgeSummary {
  const configPath = options.configPath ?? defaultInstallationConfigPath();
  const resolved = resolveKnowledge(name, configPath);
  const config = loadInstallationConfig(configPath);
  const summary = inspectKnowledgeRoot(resolved.name, resolved.path, { machine: options.machine, isDefault: normalizeKnowledgeRoots(config).defaultRoot === resolved.name });
  const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: configPath });
  const problems = [...summary.problems, ...audit.problems.filter((problem) => problem.includes(`"${resolved.name}"`) || problem.includes(`${resolved.name}/`))];
  return { ...summary, problems, state: problems.length > 0 ? "INVALID" : summary.state };
}
