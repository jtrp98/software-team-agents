import * as path from "node:path";
import * as fs from "node:fs";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import {
  assertStandaloneFrameworkRoot,
  assertStandaloneKnowledgeRoot,
  canonicalPathForComparison,
  loadInstallationConfig,
  normalizeKnowledgeRoots,
} from "./installation.js";
import { resolveInstallationRoot, type SelectedKnowledgeRoot } from "./rootSelector.js";
import { checkDeclaredIdentities } from "./identities.js";
import { loadLocalTargetMapping, loadRemoteHostAliases, type ResolvedLocalTarget } from "./localTargets.js";
import { canonicalRepositoryCoordinate, assertCanonicalRepositoryCoordinate, type RemoteHostAliases } from "./repositoryIdentity.js";
import { loadTargetRegistry, normalizeTargetRegistry, isReleasedTombstone, targetById, type TargetRegistry } from "./targets.js";
import { resolveModuleTargets } from "./moduleTargetResolver.js";
import {
  uniqueBoundTargetIds,
  validatePersistedTaskBindings,
  type TaskBindingModuleScope,
} from "./taskBindings.js";

export type WorkspaceAccess = "read" | "write";
export interface WorkRoot { targetId: string; path: string; access: WorkspaceAccess; }
export interface ThreeRepoRequestRoots {
  bindingRoot: string;
  knowledgeRoot: string;
  /** DR §5 env/launch: the selected root's name travels beside its canonical
   * path so a child process can name the root it guards and never re-resolve
   * a default of its own. */
  knowledgeRootName: string;
  workRoots: WorkRoot[];
}

export class TargetPreflightError extends Error {}

function needsCode(stage: AgentStage): boolean {
  return [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY, AgentStage.DEVOPS].includes(stage);
}

function accessFor(
  stage: AgentStage,
  targetId: string,
  task: Pick<PersistedTask, "targetBindings">,
): WorkspaceAccess {
  if (stage === AgentStage.BACKEND_ENGINEER || stage === AgentStage.FRONTEND_ENGINEER) {
    // The unit of write scope is the task's Target set, not the role binding:
    // one module's code is reachable from every Target the task binds, so
    // narrowing an engineer to its own binding strands the sibling Target's
    // half of the same change as read-only. The upper bound stays the module's
    // declared `## Targets` in `validateBindingPolicy`.
    return uniqueBoundTargetIds(task.targetBindings).includes(targetId) ? "write" : "read";
  }
  if (stage === AgentStage.DEVOPS) return "write";
  return "read";
}

function mappingById(mapping: readonly ResolvedLocalTarget[]): Map<string, ResolvedLocalTarget> {
  return new Map(mapping.map((entry) => [entry.target_id, entry]));
}

/** Read just the local `origin.url` field without starting Git. Includes and
 * duplicate origin URLs are rejected: accepting a configuration we cannot
 * fully resolve would make the preflight fail open. */
function readOriginRemote(targetPath: string): string {
  const configPath = path.join(targetPath, ".git", "config");
  let config: string;
  try {
    config = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new TargetPreflightError(`Target at "${targetPath}" cannot read .git/config to verify origin remote`);
  }
  if (/^\s*\[include(?:If)?\b/im.test(config)) {
    throw new TargetPreflightError(`Target at "${targetPath}" uses Git config includes; cannot verify origin remote fail-closed`);
  }
  let section = "";
  const urls: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    if (section !== 'remote "origin"') continue;
    const url = line.match(/^\s*url\s*=\s*(.*?)\s*$/i);
    if (url && url[1]) urls.push(url[1]);
  }
  if (urls.length !== 1) {
    throw new TargetPreflightError(`Target at "${targetPath}" must declare exactly one local origin URL to verify remote identity`);
  }
  return urls[0];
}

function canonicalRemoteOrRefuse(context: string, remoteUrl: string, machineAliases: RemoteHostAliases): string {
  try {
    return canonicalRepositoryCoordinate(remoteUrl, machineAliases);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const alias = /host "([^"]+)" has no machine-local canonical-host mapping/.exec(reason)?.[1];
    if (alias !== undefined) {
      throw new TargetPreflightError(
        `Cannot verify Target ownership: ${context} remote "${remoteUrl}" uses SSH host alias "${alias}" with no machine-local canonical-host mapping. ` +
          "Declare the alias or use a canonical remote_url; preflight is refused fail-closed.",
      );
    }
    throw new TargetPreflightError(
      `Cannot verify Target ownership: ${context} remote "${remoteUrl}" cannot be canonicalized: ${reason}. Preflight is refused fail-closed.`,
    );
  }
}

/** The coordinates a Target answers to: its remote plus its alias history.
 * Aliases are canonical coordinates already (registry invariant), so only
 * the remote needs canonicalization. */
function owningCoordinates(
  targetId: string,
  remoteUrl: string,
  aliases: readonly string[],
  machineAliases: RemoteHostAliases,
  context: string,
): string[] {
  const coordinates = [canonicalRemoteOrRefuse(context, remoteUrl, machineAliases)];
  for (const alias of aliases) {
    try {
      assertCanonicalRepositoryCoordinate(alias);
    } catch (error) {
      throw new TargetPreflightError(
        `Cannot verify Target ownership: ${context} Target "${targetId}" keeps alias "${alias}" that is not a canonical repository coordinate: ${error instanceof Error ? error.message : String(error)}. Preflight is refused fail-closed.`,
      );
    }
    coordinates.push(alias);
  }
  return coordinates;
}

/** DT §3.2 — the machine-wide ownership invariant, re-proven at every
 * preflight. The register writer refuses a duplicate at the source; a
 * hand-edited targets.yaml bypasses only the writer, never this layer. The
 * task's bound Targets are compared by canonical coordinate against every
 * owning entry (remote + aliases) of every other named root from the
 * installation snapshot; an unreadable registry or a coordinate that cannot
 * be canonicalized refuses fail-closed. A task without Target bindings is
 * never blocked by a registry it does not use — doctor reports those
 * installation-wide. */
function assertCrossRootOwnership(
  taskId: string,
  targetIds: readonly string[],
  registry: TargetRegistry,
  selectedRootName: string,
  rootsMap: Readonly<Record<string, string>>,
): void {
  const normalizedSelected = normalizeTargetRegistry(registry);
  let selectedAliases: RemoteHostAliases;
  try {
    selectedAliases = loadRemoteHostAliases(rootsMap[selectedRootName] as string);
  } catch (error) {
    throw new TargetPreflightError(
      `Cannot verify machine-local Target ownership: local Target mapping of root "${selectedRootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const boundCoordinates = new Map<string, string>();
  for (const targetId of targetIds) {
    const entry = normalizedSelected.targets.find((candidate) => candidate.target_id === targetId);
    if (!entry) continue;
    for (const coordinate of owningCoordinates(targetId, entry.remote_url, entry.repository_aliases, selectedAliases, `Target "${targetId}" in root "${selectedRootName}"`)) {
      boundCoordinates.set(coordinate, targetId);
    }
  }
  const otherRoots = Object.keys(rootsMap).filter((name) => name !== selectedRootName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const rootName of otherRoots) {
    const rootPath = rootsMap[rootName] as string;
    if (!fs.existsSync(path.join(rootPath, "targets.yaml"))) continue;
    let otherRegistry: TargetRegistry;
    try {
      otherRegistry = loadTargetRegistry(rootPath);
    } catch (error) {
      throw new TargetPreflightError(
        `Cannot verify machine-local Target ownership: registry for root "${rootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}. ` +
          "Repair that registry and retry; the task is refused fail-closed.",
      );
    }
    let otherAliases: RemoteHostAliases;
    try {
      otherAliases = loadRemoteHostAliases(rootPath);
    } catch (error) {
      throw new TargetPreflightError(
        `Cannot verify machine-local Target ownership: local Target mapping of root "${rootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}. Repair that mapping and retry; the task is refused fail-closed.`,
      );
    }
    for (const entry of normalizeTargetRegistry(otherRegistry).targets) {
      // A released tombstone claims nothing — that is what being released means.
      if (entry.ownership_state === "released") continue;
      const context = `root "${rootName}" Target "${entry.target_id}"`;
      for (const coordinate of owningCoordinates(entry.target_id, entry.remote_url, entry.repository_aliases, otherAliases, context)) {
        const boundTargetId = boundCoordinates.get(coordinate);
        if (boundTargetId !== undefined) {
          throw new TargetPreflightError(
            `Task "${taskId}" refused: Target "${boundTargetId}" in root "${selectedRootName}" conflicts with Target "${entry.target_id}" in root "${rootName}" for canonical repository "${coordinate}". ` +
              "Resolve ownership through the human-gated transfer before run or resume.",
          );
        }
      }
    }
  }
}

function assertRemoteIdentity(targetId: string, targetPath: string, remoteUrl: string, knowledgeRoot: string): void {
  const actual = readOriginRemote(targetPath);
  const machineAliases = loadRemoteHostAliases(knowledgeRoot);
  const actualCoordinate = canonicalRemoteOrRefuse(`Target "${targetId}" origin`, actual, machineAliases);
  const declaredCoordinate = canonicalRemoteOrRefuse(`Target "${targetId}" registry`, remoteUrl, machineAliases);
  if (actualCoordinate !== declaredCoordinate) {
    throw new TargetPreflightError(
      `Target "${targetId}" at "${targetPath}" has origin "${actual}" (canonical "${actualCoordinate}"), expected canonical remote_url "${remoteUrl}" (canonical "${declaredCoordinate}") — correct .workflow/targets.local.yaml`,
    );
  }
}

export interface ThreeRepoPreflightOptions {
  frameworkRoot: string;
  installationConfigPath?: string;
  /** DR §3: the command's `--root <name>`; absent = the installation's default. */
  knowledgeRootName?: string;
  verifyRemote?: (targetId: string, targetPath: string, remoteUrl: string, knowledgeRoot: string) => void;
  /** Creation passes the already-resolved scope; resume derives it from durable plan_source. */
  moduleScope?: TaskBindingModuleScope;
  /** CLI resume supplies the selected module even when an ad-hoc task has no compiled RuntimeTask. */
  moduleName?: string;
  bindingWarning?: (message: string) => void;
}

function resolvedModuleScope(
  moduleName: string,
  knowledgeRoot: string,
  frameworkRoot: string,
): TaskBindingModuleScope {
  const resolved = resolveModuleTargets(moduleName, knowledgeRoot, { frameworkRoot });
  return {
    module: resolved.module,
    designPath: resolved.designPath,
    declaredTargetIds: resolved.declaredTargetIds,
  };
}

function persistedModuleScope(
  task: Partial<Pick<PersistedTask, "runtimeTask">>,
  knowledgeRoot: string,
  frameworkRoot: string,
): TaskBindingModuleScope | undefined {
  const runtimeTask = task.runtimeTask;
  if (!runtimeTask || !("version" in runtimeTask) || runtimeTask.version !== 2) return undefined;
  const modulesRoot = path.join(path.resolve(knowledgeRoot), "_docs", "module");
  const planPath = path.resolve(runtimeTask.plan_source);
  const relative = path.relative(modulesRoot, planPath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[0] === ".." || path.isAbsolute(relative) || parts[1] !== "plan.md") return undefined;
  return resolvedModuleScope(parts[0], knowledgeRoot, frameworkRoot);
}

/** Resolves every root before an adapter is started.  It never writes. */
export function preflightThreeRepoTask(
  task: Pick<PersistedTask, "taskId" | "classification" | "targetBindings"> & Partial<Pick<PersistedTask, "runtimeTask" | "knowledgeRoot">>,
  stage: AgentStage,
  opts: ThreeRepoPreflightOptions,
): ThreeRepoRequestRoots {
  let bindingRoot: string;
  try {
    bindingRoot = assertStandaloneFrameworkRoot(opts.frameworkRoot);
  } catch (error) {
    throw new TargetPreflightError(`Framework root is not usable before starting ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let installation;
  try {
    installation = loadInstallationConfig(opts.installationConfigPath);
  } catch (error) {
    throw new TargetPreflightError(`installation config is required before starting ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let selectedRoot: SelectedKnowledgeRoot;
  let knowledgeRoot: string;
  try {
    // The installation file names every root; the command's `--root` (or the
    // default) picks exactly one here, before any registry/module read.
    selectedRoot = resolveInstallationRoot(installation, opts.knowledgeRootName);
    knowledgeRoot = assertStandaloneKnowledgeRoot(selectedRoot.path);
  } catch (error) {
    throw new TargetPreflightError(`Knowledge root is not usable before starting ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (knowledgeRoot === bindingRoot || knowledgeRoot.startsWith(`${bindingRoot}${path.sep}`) || bindingRoot.startsWith(`${knowledgeRoot}${path.sep}`)) {
    throw new TargetPreflightError(`Knowledge root "${knowledgeRoot}" overlaps Framework root "${bindingRoot}"`);
  }
  // DR §5: a task with a frozen root identity never re-selects. The resolved
  // selection must still be the frozen entry — name and canonical path both —
  // or the run stops here, before any registry, task or runtime read.
  const frozen = task.knowledgeRoot;
  if (frozen) {
    const samePath = canonicalPathForComparison(selectedRoot.path) === canonicalPathForComparison(frozen.path);
    if (selectedRoot.name !== frozen.name || !samePath) {
      throw new TargetPreflightError(
        `task ${task.taskId} is frozen to Knowledge root "${frozen.name}" (${frozen.path}) but the selection resolved to "${selectedRoot.name}" (${selectedRoot.path}) — a frozen task never re-selects; start a new task for another root`,
      );
    }
  }
  // The UX/UI stage's identity gate: the declared Figma/Claude emails must
  // exist, be well-formed, and agree, or the run stops before any agent
  // starts. The runtime-side half — comparing `get_me` against the declaration
  // at MCP connect time — sits in identities.ts and fails closed the same way.
  if (stage === AgentStage.UXUI_DESIGNER) {
    const verdict = checkDeclaredIdentities(installation);
    if (!verdict.ok) {
      throw new TargetPreflightError(`identity gate blocked ${task.taskId}: ${verdict.problems.join("; ")}`);
    }
  }
  let registry: TargetRegistry;
  try {
    registry = loadTargetRegistry(knowledgeRoot);
    const result = validatePersistedTaskBindings(task, registry, {
      moduleScope:
        opts.moduleScope ??
        (opts.moduleName
          ? resolvedModuleScope(opts.moduleName, knowledgeRoot, opts.frameworkRoot)
          : persistedModuleScope(task, knowledgeRoot, opts.frameworkRoot)),
    });
    const warn = opts.bindingWarning ?? ((message: string) => console.warn(`[orchestrator] WARNING: ${message}`));
    for (const warning of result.warnings) warn(warning);
  } catch (error) {
    throw new TargetPreflightError(`task ${task.taskId} Target bindings are not usable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const targetIds = uniqueBoundTargetIds(task.targetBindings);
  // DT §3.2: the ownership invariant runs after the selected root is
  // resolved/validated and before any lane returns or any work grant is
  // built, so every lane of a Target-bound task sees the same machine-wide
  // answer. Tasks without bindings are never blocked by unrelated roots.
  if (targetIds.length > 0) {
    assertCrossRootOwnership(task.taskId, targetIds, registry, selectedRoot.name, normalizeKnowledgeRoots(installation).roots);
  }
  // Knowledge-only lanes deliberately stop here: a BA/SA/UXUI task does not
  // acquire a Target merely because another phase of the same task has one.
  if (!needsCode(stage)) return { bindingRoot, knowledgeRoot, knowledgeRootName: selectedRoot.name, workRoots: [] };

  if (targetIds.length === 0) return { bindingRoot, knowledgeRoot, knowledgeRootName: selectedRoot.name, workRoots: [] };
  let mapping: Map<string, ResolvedLocalTarget>;
  try {
    mapping = mappingById(loadLocalTargetMapping(knowledgeRoot, registry, bindingRoot));
  } catch (error) {
    throw new TargetPreflightError(`task ${task.taskId} cannot use local Target mapping: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidates: { targetId: string; targetPath: string; remoteUrl: string }[] = [];
  for (const targetId of targetIds) {
    const target = targetById(registry, targetId);
    // A released tombstone refuses both a new run and a resume (DT §5.1): the
    // transfer moved ownership, so this root must not execute against it.
    if (isReleasedTombstone(target)) {
      throw new TargetPreflightError(
        `task ${task.taskId} binds Target "${targetId}", a released tombstone in this root — its ownership moved through the human-gated transfer; bind the Target in its owning root`,
      );
    }
    if (target.status === "retired") throw new TargetPreflightError(`Target "${targetId}" is retired — reactivate it before running or resuming task ${task.taskId}`);
    const local = mapping.get(targetId);
    if (!local) throw new TargetPreflightError(`Target "${targetId}" has no local path mapping — add it to ${path.join(knowledgeRoot, ".workflow", "targets.local.yaml")}`);
    candidates.push({ targetId, targetPath: local.path, remoteUrl: target.remote_url });
  }
  // Validate the entire task's local availability before probing either repo.
  // This prevents a two-Target task from partially continuing when its second
  // Target is misconfigured.
  for (const candidate of candidates) (opts.verifyRemote ?? assertRemoteIdentity)(candidate.targetId, candidate.targetPath, candidate.remoteUrl, knowledgeRoot);
  const workRoots = candidates.map((candidate) => ({ targetId: candidate.targetId, path: candidate.targetPath, access: accessFor(stage, candidate.targetId, task) }));
  return { bindingRoot, knowledgeRoot, knowledgeRootName: selectedRoot.name, workRoots };
}
