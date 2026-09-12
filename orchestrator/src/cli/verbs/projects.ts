import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteTaskStore } from "../../store/sqliteStore.js";
import { defaultStateDbPath } from "../../store/stateView.js";
import { describeStatus, type TaskStatusKind } from "../../orchestrator/taskStatus.js";
import { hasWorkspace, loadWorkspace, workspacePath, type Workspace } from "../../workspace/workspace.js";
import { STATUS_EMOJI } from "../rendering/taskListing.js";
import { flagValue } from "../support.js";

/**
 * `projects [--workspace <path>]` — read-only fan-out: one line per
 * project workspace.yaml names, each with its own store's status counts.
 *
 * Deliberately never opens a `SqliteTaskStore` for a project that has no
 * `.workflow/state.db` yet — the constructor creates one on open (same as
 * every other verb's first run), and a status listing should never be the
 * thing that plants an empty database in a project nobody has run yet.
 */
export async function runProjectsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const workspaceFlag = flagValue(rest, "--workspace");
  const root = workspaceFlag ? path.dirname(path.resolve(workspaceFlag)) : projectRoot;

  if (!hasWorkspace(root)) {
    console.log(
      `[orchestrator] no workspace.yaml at ${workspacePath(root)} — this project runs standalone. ` +
        "Add one to list other project roots here, or use --project-root with status/audit directly.",
    );
    return 0;
  }

  let workspace: Workspace;
  try {
    workspace = loadWorkspace(root);
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  for (const project of workspace.projects) {
    const dbPath = defaultStateDbPath(project.root);
    if (!fs.existsSync(dbPath)) {
      console.log(`  ${project.name.padEnd(20)} ${project.root} — no tasks yet`);
      continue;
    }
    const store = new SqliteTaskStore(dbPath);
    try {
      const tasks = store.listTasks();
      const counts = new Map<TaskStatusKind, number>();
      for (const t of tasks) {
        const kind = describeStatus(t, tasks).kind;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([kind, n]) => `${STATUS_EMOJI[kind] ?? " "}${n}`).join(" ");
      console.log(`  ${project.name.padEnd(20)} ${project.root} — ${tasks.length} task(s)${summary ? " " + summary : ""}`);
    } finally {
      store.close();
    }
  }
  return 0;
}
