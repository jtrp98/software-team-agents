import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { RunLog, type RunRecord } from "./runLog.js";
import type { TaskStore } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { assetsForRole, type RoleName } from "../targetcli/roleWorkspace.js";

export interface WorkspaceStaticMeasurement {
  /** CLAUDE.md is loaded by the interactive runtime before any session work. */
  always_loaded_chars: number;
  /** Role-reachable policies and role prompts. This deliberately excludes CLAUDE.md to avoid double counting. */
  reachable_static_chars: number;
}

function fileChars(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").length;
  } catch {
    return 0;
  }
}

function walk(root: string, rel: string, include: (relPath: string) => boolean): number {
  const absolute = path.join(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.reduce((total, entry) => {
    const child = path.join(rel, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) return total + walk(root, child, include);
    return entry.isFile() && include(child) ? total + fileChars(path.join(root, child)) : total;
  }, 0);
}

/** Claude lists command descriptions, not every command body, at session start. */
function commandDescriptionChars(root: string, include: (relPath: string) => boolean): number {
  const dir = path.join(root, ".claude", "commands");
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      const rel = `.claude/commands/${entry.name}`;
      if (!entry.isFile() || !entry.name.endsWith(".md") || !include(rel)) return total;
      try {
        const description = /^description:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, entry.name), "utf8"))?.[1] ?? "";
        return total + description.length;
      } catch { return total; }
    }, 0);
  } catch { return 0; }
}

/**
 * Measures the managed static payload actually present in one role workspace.
 * The two values remain separate because "always loaded" and "reachable only
 * when followed" are different observability facts, even though the current
 * run-record schema stores their truthful combined footprint in static_chars.
 */
export function measureWorkspaceStatic(workspaceRoot: string, role: RoleName): WorkspaceStaticMeasurement {
  const include = assetsForRole(role);
  return {
    always_loaded_chars: fileChars(path.join(workspaceRoot, "CLAUDE.md")),
    reachable_static_chars:
      walk(workspaceRoot, "policies", (rel) => include(rel)) +
      walk(workspaceRoot, ".claude/agents", (rel) => include(rel)) +
      commandDescriptionChars(workspaceRoot, include),
  };
}

const SESSION_AGENT: Record<RoleName, AgentStage> = {
  ba: AgentStage.BUSINESS_ANALYST,
  // `dev` is the interactive engineering lane rather than a pipeline stage;
  // backend-engineer is its durable, queryable representative stage.
  dev: AgentStage.BACKEND_ENGINEER,
};

/** Writes a session row through the existing TaskStore seam. It intentionally never throws. */
export function recordInteractiveSession(params: {
  workspaceRoot: string;
  role: RoleName;
  runtime: string;
  startedAt: number;
  endedAt: number;
  store?: TaskStore;
}): void {
  try {
    const measurement = measureWorkspaceStatic(params.workspaceRoot, params.role);
    const taskId = `session:${params.role}:${new Date(params.startedAt).toISOString()}`;
    // stdio:"inherit" makes real usage inaccessible here. input/output stay
    // null (not zero); the legacy combined `tokens` column remains 0 solely
    // for its non-null-compatible schema and is never used by `sta tokens`.
    const record = new RunLog().record({
      task_id: taskId,
      agent: SESSION_AGENT[params.role],
      start_time: params.startedAt,
      end_time: params.endedAt,
      outcome: {
        tokens: 0,
        cost: 0,
        result: "PASS",
        input_tokens: undefined,
        output_tokens: undefined,
        context_chars: undefined,
        runtime: params.runtime,
        session_kind: "interactive",
        static_chars: measurement.always_loaded_chars + measurement.reachable_static_chars,
      },
    });
    const store = params.store ?? new SqliteTaskStore(defaultStateDbPath(params.workspaceRoot));
    try {
      store.appendRun(record);
    } finally {
      if (!params.store) store.close();
    }
  } catch (error) {
    // Observability is additive: an unavailable/locked state DB must never end
    // the user's interactive session. This matches knowledgeBriefFor's posture.
    console.error(`[software-team-agents] could not record interactive session telemetry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function interactiveSessionRecordForTest(params: {
  workspaceRoot: string;
  role: RoleName;
  runtime: string;
  startedAt: number;
  endedAt: number;
}): RunRecord | null {
  // Small test-only capture seam that still exercises the production recorder.
  const records: RunRecord[] = [];
  recordInteractiveSession({ ...params, store: { appendRun: (r) => records.push(r), createTask() {}, saveTask() {}, loadTask() { return null; }, listTasks() { return []; }, runsForTask() { return []; }, allRuns() { return []; }, appendEvent() {}, eventsForTask() { return []; }, close() {} } });
  return records[0] ?? null;
}
