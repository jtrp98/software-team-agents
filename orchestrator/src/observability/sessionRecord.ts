import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { RunLog, type RunRecord } from "./runLog.js";
import type { TaskStore } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { assetsForRole, type WorkspaceRole } from "../targetcli/roleWorkspace.js";
import { estimateInputTokens } from "../context/contextBudget.js";
import type { ContextComposition } from "../context/contextCommand.js";

export interface WorkspaceStaticMeasurement {
  /** Character count of the root instruction files loaded before interactive work. */
  always_loaded_chars: number;
  /** Exact on-disk bytes of the root instruction files the selected runtime auto-loads at launch. */
  instruction_surface_bytes: number;
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

function fileBytes(file: string): number {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Root instruction files loaded before the interactive prompt begins. Nested
 * instructions are reported by status/doctor, but are not counted here: they
 * become active only when work enters their directory. Agent prompts and
 * policies remain reachable context, not always-on context.
 */
function autoLoadedInstructionFiles(workspaceRoot: string, runtime: string): string[] {
  if (runtime === "claude") {
    return [path.join(workspaceRoot, "CLAUDE.md"), path.join(workspaceRoot, "CLAUDE.local.md")];
  }
  if (runtime === "codex" || runtime === "opencode") return [path.join(workspaceRoot, "AGENTS.md")];
  return [];
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
export function measureWorkspaceStatic(workspaceRoot: string, role: WorkspaceRole, runtime = "claude"): WorkspaceStaticMeasurement {
  const include = assetsForRole(role);
  const autoLoaded = autoLoadedInstructionFiles(workspaceRoot, runtime);
  return {
    always_loaded_chars: autoLoaded.reduce((total, file) => total + fileChars(file), 0),
    instruction_surface_bytes: autoLoaded.reduce((total, file) => total + fileBytes(file), 0),
    reachable_static_chars:
      walk(workspaceRoot, "policies", (rel) => include(rel)) +
      walk(workspaceRoot, ".claude/agents", (rel) => include(rel)) +
      commandDescriptionChars(workspaceRoot, include),
  };
}

const SESSION_AGENT: Record<WorkspaceRole, AgentStage> = {
  ba: AgentStage.BUSINESS_ANALYST,
  // `dev` is the interactive engineering workspace role rather than a pipeline stage;
  // backend-engineer is its durable, queryable representative stage.
  dev: AgentStage.BACKEND_ENGINEER,
};

/** Writes a session row through the existing TaskStore seam. It intentionally never throws. */
export function recordInteractiveSession(params: {
  workspaceRoot: string;
  role: WorkspaceRole;
  runtime: string;
  startedAt: number;
  endedAt: number;
  /** Captured immediately before launch so edits made during the session cannot rewrite history. */
  measurement?: WorkspaceStaticMeasurement;
  store?: TaskStore;
}): void {
  try {
    const measurement = params.measurement ?? measureWorkspaceStatic(params.workspaceRoot, params.role, params.runtime);
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
        instruction_surface_bytes: measurement.instruction_surface_bytes,
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

/**
 * Persists the one composition number `sta tokens` can
 * actually measure without runtime cooperation: what `sta context` assembled.
 * Reuses the existing interactive-session recording path (`RunLog` +
 * `TaskStore`), not a new store. Fail-open like `recordInteractiveSession`: a
 * telemetry write failure is logged and never changes the caller's exit code.
 */
export function recordContextComposition(params: {
  projectRoot: string;
  agent: AgentStage;
  composition: ContextComposition;
  startedAt: number;
  endedAt: number;
  store?: TaskStore;
}): void {
  try {
    const c = params.composition;
    const contextChars = c.doc_chars + c.knowledge_chars + c.code_intel_chars;
    const taskId = `context:${params.agent}:${new Date(params.startedAt).toISOString()}`;
    const record = new RunLog().record({
      task_id: taskId,
      agent: params.agent,
      start_time: params.startedAt,
      end_time: params.endedAt,
      outcome: {
        tokens: 0,
        cost: 0,
        result: "PASS",
        session_kind: "interactive",
        context_chars: contextChars,
        estimated_input_tokens: estimateInputTokens(contextChars),
        doc_chars: c.doc_chars,
        doc_chars_before: c.doc_chars_before,
        knowledge_chars: c.knowledge_chars,
        code_intel_chars: c.code_intel_chars,
      },
    });
    const store = params.store ?? new SqliteTaskStore(defaultStateDbPath(params.projectRoot));
    try {
      store.appendRun(record);
    } finally {
      if (!params.store) store.close();
    }
  } catch (error) {
    console.error(`[software-team-agents] could not record context composition telemetry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function interactiveSessionRecordForTest(params: {
  workspaceRoot: string;
  role: WorkspaceRole;
  runtime: string;
  startedAt: number;
  endedAt: number;
  measurement?: WorkspaceStaticMeasurement;
}): RunRecord | null {
  // Small test-only capture seam that still exercises the production recorder.
  const records: RunRecord[] = [];
  recordInteractiveSession({ ...params, store: { appendRun: (r) => records.push(r), createTask() {}, saveTask() {}, loadTask() { return null; }, listTasks() { return []; }, runsForTask() { return []; }, allRuns() { return []; }, appendEvent() {}, eventsForTask() { return []; }, close() {} } });
  return records[0] ?? null;
}
