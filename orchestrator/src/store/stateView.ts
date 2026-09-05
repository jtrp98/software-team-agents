import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStage } from "../types.js";
import { MAX_RETRY } from "../retry/retryPolicy.js";
import { describeStatus, phaseOf } from "../orchestrator/taskStatus.js";
import { assertValidStateView } from "./stateSchema.js";
import type { PersistedTask, TaskStore } from "./taskStore.js";

/**
 * Generates `.workflow/state.yaml` from the store.
 *
 * A human-readable YAML file and runtime state that isn't hand-maintained both
 * hold at once when the YAML is a *view*: the state database stays the thing
 * that is written to and recovered from, and this file is overwritten from it,
 * never read back. The header says so in the file itself, because a generated
 * file that does not announce it will eventually be edited by someone.
 *
 * Every document is checked against `schemas/state-view.schema.json` before it
 * is written. The emitter below is hand-rolled rather than a YAML dependency —
 * the shape it emits is fixed, small, and now schema-checked, so a parser
 * would add a dependency without adding a guarantee.
 */

const STATE_VIEW_SCHEMA_VERSION = 1;

export function defaultStateViewPath(projectRoot: string): string {
  return path.join(projectRoot, ".workflow", "state.yaml");
}

export function defaultStateDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".workflow", "state.db");
}

export interface PreviousRun {
  agent: AgentStage;
  result: "PASS" | "FAIL";
}

export interface StateViewOptions {
  now?: number;
  /**
   * The most recently finished run for a task. It lives in the run log, not on
   * the task row, so the caller that has the store supplies it — `previous:
   * {agent, result}` is the one field the task state alone cannot answer.
   */
  previousRun?: (taskId: string) => PreviousRun | null;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

const PLAIN_SCALAR = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;

/** Quotes anything that is not unambiguously a plain scalar — including YAML's words-that-are-booleans. */
function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `"${String(value)}"`;
  if (typeof value === "boolean") return String(value);
  const reserved = ["true", "false", "null", "yes", "no", "on", "off", "~"];
  if (value !== "" && PLAIN_SCALAR.test(value) && !reserved.includes(value.toLowerCase())) return value;
  return JSON.stringify(value); // JSON string escaping is valid YAML double-quoted style
}

function emit(value: YamlValue, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (value === null || typeof value !== "object") return [`${pad}${scalar(value)}`];

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const nested = emit(item as YamlValue, indent + 1);
        // The first line of the item carries the "- " marker; the rest keep their indent.
        lines.push(`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1));
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return lines;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return [`${pad}{}`];
  const lines: string[] = [];
  for (const [key, v] of entries) {
    if (v !== null && typeof v === "object" && !(Array.isArray(v) && v.length === 0)) {
      lines.push(`${pad}${key}:`, ...emit(v as YamlValue, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${emit(v as YamlValue, 0)[0]}`);
    }
  }
  return lines;
}

export function taskToYamlValue(
  task: PersistedTask,
  allTasks: readonly PersistedTask[],
  previous: PreviousRun | null = null,
): YamlValue {
  const status = describeStatus(task, allTasks);
  // The stage the orchestrator will assign next — the cursor already points at
  // it, including after a failed round routed the task back to an engineer.
  const nextAgent = task.machine.pipeline[task.pipelineCursor] ?? null;
  return {
    task_id: task.taskId,
    status: status.kind,
    phase: phaseOf(status.state, status.currentAgent ?? nextAgent ?? undefined),
    state: status.state,
    current_agent: status.currentAgent ?? null,
    previous: previous ? { agent: previous.agent, result: previous.result } : null,
    next: { agent: nextAgent, state: status.nextState ?? null },
    reason: status.reason ?? null,
    level: task.classification.level,
    pipeline: task.classification.pipeline,
    depends_on: task.dependsOn,
    target_bindings: task.targetBindings,
    waiting_on: status.waitingOn ?? [],
    retry: { qa: task.retries.qa, security: task.retries.security, max: MAX_RETRY },
    approvals: {
      design_approved: task.gateContext.designApproved ?? false,
      human_approved: task.gateContext.humanApproved ?? false,
      // The booleans above are derived from this ledger; this is what records
      // that a decision was *made* — including a "no", which the booleans
      // alone cannot distinguish from "not asked yet".
      ledger: task.approvals.map((a) => ({
        type: a.type,
        required: a.required,
        status: a.status,
        reason: a.reason,
        decided_by: a.decidedBy,
        decided_at: a.decidedAt === null ? null : new Date(a.decidedAt).toISOString(),
      })),
    },
    approval: (() => {
      const outstanding = task.approvals.find((a) => a.status === "pending");
      return outstanding ? { required: outstanding.required, type: outstanding.type, status: outstanding.status } : null;
    })(),
    last_failure: task.lastFailure
      ? {
          category: task.lastFailure.category,
          owner: task.lastFailure.owner,
          severity: task.lastFailure.severity,
          retryable: task.lastFailure.retryable,
          requires_human: task.lastFailure.requiresHuman,
          reason: task.lastFailure.reason,
          affected: task.lastFailure.affected,
        }
      : null,
    updated_at: new Date(task.updatedAt).toISOString(),
  };
}

/** The document, as data — validated against the published schema before anything renders it. */
export function buildStateViewDocument(
  tasks: readonly PersistedTask[],
  opts: StateViewOptions = {},
): Record<string, unknown> {
  const doc = {
    schema_version: STATE_VIEW_SCHEMA_VERSION,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    tasks: tasks.map((t) => taskToYamlValue(t, tasks, opts.previousRun?.(t.taskId) ?? null)),
  };
  assertValidStateView(doc);
  return doc;
}

export function renderStateYaml(tasks: readonly PersistedTask[], opts: StateViewOptions = {}): string {
  return [
    "# GENERATED FILE — do not edit.",
    "# Rewritten from the orchestrator's state database on every state change.",
    "# The database is the source of truth; edits here are overwritten without warning.",
    "# Shape: schemas/state-view.schema.json (checked before this file is written).",
    ...emit(buildStateViewDocument(tasks, opts) as YamlValue, 0),
    "",
  ].join("\n");
}

/** Writes the view wherever the caller keeps it. Creates the directory; never reads the file back. */
export function writeStateView(filePath: string, tasks: readonly PersistedTask[], opts: StateViewOptions = {}): void {
  const rendered = renderStateYaml(tasks, opts);
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, rendered, "utf8");
}

export function writeStateViewFromStore(filePath: string, store: TaskStore, opts: StateViewOptions = {}): void {
  writeStateView(filePath, store.listTasks(), {
    ...opts,
    previousRun:
      opts.previousRun ??
      ((taskId) => {
        const runs = store.runsForTask(taskId);
        const last = runs[runs.length - 1];
        return last ? { agent: last.agent, result: last.result } : null;
      }),
  });
}
