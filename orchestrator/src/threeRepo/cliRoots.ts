/**
 * The three-repo root-resolution logic `runCli` needs in five places (QA work
 * roots, two change-discovery closures, QA docs root, and the previous-round
 * closure), extracted once so the `loadInstallationConfig` ->
 * `preflightThreeRepoTask` -> resolve-task-target-roots
 * pattern has a single implementation instead of five independently
 * maintained copies that could drift — a drifted copy would silently resolve
 * QA against the wrong root.
 *
 * A missing installation config means "legacy project — `projectRoot`
 * stands". Once a three-repo installation is detectable, resolution is
 * fail-closed. `preflightThreeRepoTask` is reused, never reimplemented.
 */
import * as fs from "node:fs";
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import type { ThreeRepoRequestRoots } from "./preflight.js";
import { defaultInstallationConfigPath, installationConfigOverride, loadInstallationConfig } from "./installation.js";
import { preflightThreeRepoTask } from "./preflight.js";
import { resolveFrameworkRoot } from "../targetcli/roots.js";

/** The one bit of task state these resolvers read — a `SqliteTaskStore` satisfies it. */
export type TaskLookup = { loadTask(taskId: string): PersistedTask | null };

/** The `STA_INSTALLATION_CONFIG` override, refused outside a declared test/E2E
 * harness and normalized to `undefined` when unset/empty. */
const installationConfigPath = (): string | undefined => installationConfigOverride();

export class WritableWorkRootResolutionError extends Error {}

export interface QaWorkRoot {
  targetId?: string;
  path: string;
}

/**
 * The writable work roots a QA-side stage operates on.
 *
 * - three-repo mode → every Target bound to the task, deduped by (targetId, path)
 * - single-repo / legacy project with no installation config → `[{ path: projectRoot }]`
 * - detectable three-repo mode with an unusable task/Target binding → throws
 *
 * QA deliberately has read access to each Target. These are nevertheless the
 * task's writable implementation roots, so filtering by QA's access would
 * erase the exact roots QA must inspect.
 */
export function resolveWritableWorkRoots(
  projectRoot: string,
  taskId: string,
  store: TaskLookup,
  stage: AgentStage,
  moduleName?: string,
): QaWorkRoot[] {
  const configPath = installationConfigPath();
  try {
    loadInstallationConfig(configPath);
  } catch (error) {
    const resolvedConfigPath = configPath ?? defaultInstallationConfigPath();
    if (!fs.existsSync(resolvedConfigPath)) return [{ path: projectRoot }];
    throw new WritableWorkRootResolutionError(
      `task ${taskId} cannot resolve its Target binding because the installation config is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const task = store.loadTask(taskId);
  if (!task) {
    throw new WritableWorkRootResolutionError(
      `task ${taskId} cannot resolve its Target binding because it is missing from the state store`,
    );
  }

  let roots3: ThreeRepoRequestRoots;
  try {
    roots3 = preflightThreeRepoTask(task, stage, {
      frameworkRoot: resolveFrameworkRoot(),
      installationConfigPath: configPath,
      moduleName,
    });
  } catch (error) {
    throw new WritableWorkRootResolutionError(
      `task ${taskId} cannot resolve its Target binding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Deduplicate without dropping targetId (R-2).
  const seen = new Set<string>();
  const targetRoots: QaWorkRoot[] = [];
  for (const root of roots3.workRoots) {
    const key = `${root.targetId}::${root.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      targetRoots.push({ targetId: root.targetId, path: root.path });
    }
  }
  if (targetRoots.length === 0) {
    throw new WritableWorkRootResolutionError(
      `task ${taskId} has no resolvable Target work root; its Target binding is missing`,
    );
  }
  return targetRoots;
}

/**
 * The root the module docs live under.
 *
 * - three-repo mode → the installation's `knowledge_root`
 * - single-repo / legacy project / any installation-config load failure → `projectRoot`
 */
export function resolveDocsRoot(projectRoot: string): string {
  try {
    const installation = loadInstallationConfig(installationConfigPath());
    if (installation.knowledge_root) return installation.knowledge_root;
  } catch {
    // legacy project: projectRoot stands
  }
  return projectRoot;
}

/** Thin wrapper naming the QA-side caller's intent — same resolver, same rules. */
export function resolveQaWorkRoots(
  projectRoot: string,
  taskId: string,
  store: TaskLookup,
  moduleName?: string,
): QaWorkRoot[] {
  return resolveWritableWorkRoots(projectRoot, taskId, store, AgentStage.QA_ENGINEER, moduleName);
}

/**
 * The per-stage `{ task, roots }` lookup the runtime executor calls, or
 * `undefined` when this is not a three-repo installation.
 *
 * The outer `loadInstallationConfig` guard decides three-repo vs legacy once;
 * the returned callback reloads the task every stage (so `--resume` observes
 * retirement/mapping changes) and throws if it vanished from the store.
 */
export function resolveThreeRepoTaskLookup(
  projectRoot: string,
  store: TaskLookup,
  moduleName?: string,
): ((taskId: string, stage: AgentStage) => { task: PersistedTask; roots: ThreeRepoRequestRoots }) | undefined {
  try {
    loadInstallationConfig(installationConfigPath());
    return (taskId: string, stage: AgentStage) => {
      const task = store.loadTask(taskId);
      if (!task) throw new Error(`task ${taskId} disappeared from the state store`);
      return {
        task,
        roots: preflightThreeRepoTask(task, stage, {
          frameworkRoot: resolveFrameworkRoot(),
          installationConfigPath: installationConfigPath(),
          moduleName,
        }),
      };
    };
  } catch {
    return undefined;
  }
}
