import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import { assertStandaloneFrameworkRoot, assertStandaloneKnowledgeRoot, loadInstallationConfig } from "./installation.js";
import { loadLocalTargetMapping, type ResolvedLocalTarget } from "./localTargets.js";
import { loadTargetRegistry, targetById, type TargetRegistry } from "./targets.js";
import { uniqueBoundTargetIds, validatePersistedTaskBindings } from "./taskBindings.js";

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

function accessFor(stage: AgentStage, targetId: string, task: PersistedTask): WorkspaceAccess {
  if (stage === AgentStage.BACKEND_ENGINEER) return targetId === task.targetBindings.backend_target ? "write" : "read";
  if (stage === AgentStage.FRONTEND_ENGINEER) return targetId === task.targetBindings.frontend_target ? "write" : "read";
  if (stage === AgentStage.DEVOPS) return "write";
  return "read";
}

function mappingById(mapping: readonly ResolvedLocalTarget[]): Map<string, ResolvedLocalTarget> {
  return new Map(mapping.map((entry) => [entry.target_id, entry]));
}

function normaliseRemote(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function assertRemoteIdentity(targetId: string, targetPath: string, remoteUrl: string): void {
  const result = spawnSync("git", ["-C", targetPath, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new TargetPreflightError(`Target "${targetId}" at "${targetPath}" cannot verify origin remote — configure a cloned repository whose origin is ${remoteUrl}`);
  }
  const actual = (result.stdout ?? "").trim();
  if (normaliseRemote(actual) !== normaliseRemote(remoteUrl)) {
    throw new TargetPreflightError(`Target "${targetId}" at "${targetPath}" has origin "${actual}", expected canonical remote_url "${remoteUrl}" — correct .workflow/targets.local.yaml`);
  }
}

export interface ThreeRepoPreflightOptions {
  frameworkRoot: string;
  installationConfigPath?: string;
  verifyRemote?: (targetId: string, targetPath: string, remoteUrl: string) => void;
}

/** Resolves every root before an adapter is started.  It never writes. */
export function preflightThreeRepoTask(
  task: PersistedTask,
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
    knowledgeRoot = assertStandaloneKnowledgeRoot(installation.knowledge_root);
  } catch (error) {
    throw new TargetPreflightError(`Knowledge root is not usable before starting ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (knowledgeRoot === bindingRoot || knowledgeRoot.startsWith(`${bindingRoot}${path.sep}`) || bindingRoot.startsWith(`${knowledgeRoot}${path.sep}`)) {
    throw new TargetPreflightError(`Knowledge root "${knowledgeRoot}" overlaps Framework root "${bindingRoot}"`);
  }
  let registry: TargetRegistry;
  try {
    registry = loadTargetRegistry(knowledgeRoot);
    validatePersistedTaskBindings(task, registry);
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
