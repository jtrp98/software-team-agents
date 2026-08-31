/**
 * T-V4-CLI-003 — the four duplicated three-repo root-resolution blocks from
 * `runCli`, extracted once.
 *
 * Until this task `runCli` carried the `loadInstallationConfig` →
 * `preflightThreeRepoTask` → filter-write-roots → swallow-and-default pattern
 * four times (V4-ANALYSIS §2.4): the QA work roots, the QA docs root, the
 * change-discovery closure, and the previous-round closure. Four independently
 * maintained copies of a fail-open `catch {}` drift, and a drifted copy
 * silently resolves QA against the wrong root — the one correctness risk in
 * this topic.
 *
 * The fail-open contract is load-bearing and preserved exactly here: a missing
 * or unreadable installation config means "legacy project — `projectRoot`
 * stands", never an error. `preflightThreeRepoTask` is reused, never
 * reimplemented.
 */
import { AgentStage } from "../types.js";
import type { PersistedTask } from "../store/taskStore.js";
import type { ThreeRepoRequestRoots } from "./preflight.js";
import { loadInstallationConfig } from "./installation.js";
import { preflightThreeRepoTask } from "./preflight.js";

/** The one bit of task state these resolvers read — a `SqliteTaskStore` satisfies it. */
export type TaskLookup = { loadTask(taskId: string): PersistedTask | null };

/** `process.env.AGENTCLAUDE_INSTALLATION_CONFIG`, normalised to `undefined` when unset/empty. */
const installationConfigPath = (): string | undefined =>
  process.env.AGENTCLAUDE_INSTALLATION_CONFIG || undefined;

/**
 * The writable work roots a QA-side stage operates on.
 *
 * - three-repo mode → the Target's `write` work roots, deduped
 * - single-repo / legacy project / any installation-config load failure → `[projectRoot]`
 *
 * Byte-for-byte with the pre-extraction `qaRoots` block (`cli.ts`): the guard
 * `loadInstallationConfig()` call runs first so a missing config drops straight
 * into the fallback, `preflightThreeRepoTask` does the real resolution, and only
 * a non-empty write set replaces the default.
 */
export function resolveWritableWorkRoots(
  projectRoot: string,
  taskId: string,
  store: TaskLookup,
  stage: AgentStage = AgentStage.QA_ENGINEER,
): string[] {
  try {
    loadInstallationConfig(installationConfigPath());
    const task = store.loadTask(taskId);
    if (task) {
      const roots3: ThreeRepoRequestRoots = preflightThreeRepoTask(task, stage, {
        frameworkRoot: projectRoot,
        installationConfigPath: installationConfigPath(),
      });
      const writes = roots3.workRoots.filter((r) => r.access === "write").map((r) => r.path);
      if (writes.length > 0) return [...new Set(writes)];
    }
  } catch {
    // legacy project: projectRoot stands
  }
  return [projectRoot];
}

/**
 * The root the module docs live under.
 *
 * - three-repo mode → the installation's `knowledge_root`
 * - single-repo / legacy project / any installation-config load failure → `projectRoot`
 *
 * Byte-for-byte with the pre-extraction `qaDocsRoot` / `previousRound` blocks.
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

/**
 * The per-stage `{ task, roots }` lookup the runtime executor calls, or
 * `undefined` when this is not a three-repo installation.
 *
 * Byte-for-byte with the pre-extraction `threeRepoTask` IIFE in `runCli`: the
 * outer `loadInstallationConfig` guard decides three-repo vs legacy once; the
 * returned callback reloads the task every stage (so `--resume` observes
 * retirement/mapping changes) and throws if it vanished from the store.
 */
export function resolveThreeRepoTaskLookup(
  projectRoot: string,
  store: TaskLookup,
): ((taskId: string, stage: AgentStage) => { task: PersistedTask; roots: ThreeRepoRequestRoots }) | undefined {
  try {
    loadInstallationConfig(installationConfigPath());
    return (taskId: string, stage: AgentStage) => {
      const task = store.loadTask(taskId);
      if (!task) throw new Error(`task ${taskId} disappeared from the state store`);
      return {
        task,
        roots: preflightThreeRepoTask(task, stage, {
          frameworkRoot: projectRoot,
          installationConfigPath: installationConfigPath(),
        }),
      };
    };
  } catch {
    return undefined;
  }
}
