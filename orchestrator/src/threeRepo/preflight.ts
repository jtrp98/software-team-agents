import * as path from "node:path";
import * as fs from "node:fs";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { assertStandaloneFrameworkRoot, assertStandaloneKnowledgeRoot, loadInstallationConfig } from "./installation.js";
import { resolveInstallationRoot } from "./rootSelector.js";
import { checkDeclaredIdentities } from "./identities.js";
import { loadLocalTargetMapping, type ResolvedLocalTarget } from "./localTargets.js";
import { loadTargetRegistry, targetById, type TargetRegistry } from "./targets.js";
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

function normaliseRemote(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
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

function assertRemoteIdentity(targetId: string, targetPath: string, remoteUrl: string): void {
  const actual = readOriginRemote(targetPath);
  if (normaliseRemote(actual) !== normaliseRemote(remoteUrl)) {
    throw new TargetPreflightError(`Target "${targetId}" at "${targetPath}" has origin "${actual}", expected canonical remote_url "${remoteUrl}" — correct .workflow/targets.local.yaml`);
  }
}

export interface ThreeRepoPreflightOptions {
  frameworkRoot: string;
  installationConfigPath?: string;
  /** DR §3: the command's `--root <name>`; absent = the installation's default. */
  knowledgeRootName?: string;
  verifyRemote?: (targetId: string, targetPath: string, remoteUrl: string) => void;
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
  task: Pick<PersistedTask, "taskId" | "classification" | "targetBindings"> & Partial<Pick<PersistedTask, "runtimeTask">>,
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
  let knowledgeRoot: string;
  try {
    // The installation file names every root; the command's `--root` (or the
    // default) picks exactly one here, before any registry/module read.
    knowledgeRoot = assertStandaloneKnowledgeRoot(resolveInstallationRoot(installation, opts.knowledgeRootName).path);
  } catch (error) {
    throw new TargetPreflightError(`Knowledge root is not usable before starting ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (knowledgeRoot === bindingRoot || knowledgeRoot.startsWith(`${bindingRoot}${path.sep}`) || bindingRoot.startsWith(`${knowledgeRoot}${path.sep}`)) {
    throw new TargetPreflightError(`Knowledge root "${knowledgeRoot}" overlaps Framework root "${bindingRoot}"`);
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

  // Knowledge-only lanes deliberately stop here: a BA/SA/UXUI task does not
  // acquire a Target merely because another phase of the same task has one.
  if (!needsCode(stage)) return { bindingRoot, knowledgeRoot, workRoots: [] };

  const targetIds = uniqueBoundTargetIds(task.targetBindings);
  if (targetIds.length === 0) return { bindingRoot, knowledgeRoot, workRoots: [] };
  let mapping: Map<string, ResolvedLocalTarget>;
  try {
    mapping = mappingById(loadLocalTargetMapping(knowledgeRoot, registry, bindingRoot));
  } catch (error) {
    throw new TargetPreflightError(`task ${task.taskId} cannot use local Target mapping: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidates: { targetId: string; targetPath: string; remoteUrl: string }[] = [];
  for (const targetId of targetIds) {
    const target = targetById(registry, targetId);
    if (target.status === "retired") throw new TargetPreflightError(`Target "${targetId}" is retired — reactivate it before running or resuming task ${task.taskId}`);
    const local = mapping.get(targetId);
    if (!local) throw new TargetPreflightError(`Target "${targetId}" has no local path mapping — add it to ${path.join(knowledgeRoot, ".workflow", "targets.local.yaml")}`);
    candidates.push({ targetId, targetPath: local.path, remoteUrl: target.remote_url });
  }
  // Validate the entire task's local availability before probing either repo.
  // This prevents a two-Target task from partially continuing when its second
  // Target is misconfigured.
  for (const candidate of candidates) (opts.verifyRemote ?? assertRemoteIdentity)(candidate.targetId, candidate.targetPath, candidate.remoteUrl);
  const workRoots = candidates.map((candidate) => ({ targetId: candidate.targetId, path: candidate.targetPath, access: accessFor(stage, candidate.targetId, task) }));
  return { bindingRoot, knowledgeRoot, workRoots };
}
