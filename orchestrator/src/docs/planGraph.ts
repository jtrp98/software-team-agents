import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { TaskGraph, TaskGraphError, CircularDependencyError, UnknownTaskError, type TaskNode } from "../graph/taskGraph.js";
import { sections, firstTable, checkboxLines } from "../adoption/markdown.js";
import { extractIds } from "../traceability/traceability.js";

/**
 * The plan.md task table as a machine-checkable graph (pm-improvements T-PM1.x).
 *
 * Before this module, `Depends on` was prose the orchestrator never read at
 * runtime — only the adoption importer (`legacyPlan.ts`) parsed it, and only
 * `--check-doc-structure` looked at plan.md at all, structurally (sections
 * exist, phase count ≥ 1). A plan whose dependency named a task that did not
 * exist, depended on itself, or cycled was nobody's error until an engineer
 * hit it mid-run.
 *
 * This module is the deterministic half of the fix: parse every phase's task
 * table into rows, then validate the graph without an LLM — duplicate ids,
 * missing/self/duplicate dependencies, cycles, unknown owners, unknown
 * statuses, missing DES traceability, impossible authored wave ordering.
 * Every failure names its task id, because "somewhere in phase 3" is not
 * actionable.
 *
 * Waves are *derived* here, never persisted as truth: `waveOf` layers the
 * graph the same way runtime scheduling would (declared dependencies plus
 * phase order — a later phase's work never starts before an earlier phase's,
 * which is `buildPlanGraph`'s reading). An authored `Wave` column is validated
 * against it, not trusted: PM writes grouping intent, the graph decides what
 * is actually ordered after what.
 *
 * Readiness is also derived, not read: `readinessOf` treats `verified` rows
 * (qa-engineer's mark, the only writer) as satisfied dependencies and answers
 * "what may start now" from the document as it stands. Nothing here writes
 * runtime state — that remains the orchestrator's store's job (T-PM5.1); this
 * is the plan-side mirror a person or a driver reads before creating tasks.
 */

export type PlanTaskStatus = "pending" | "in_progress" | "verified" | "blocked";

const PLAN_STATUSES: readonly PlanTaskStatus[] = ["pending", "in_progress", "verified", "blocked"];

/** Every role an Owner cell may name — exactly AgentStage minus HUMAN, kebab-case, the roster CLAUDE.md fixes. */
const VALID_OWNERS: readonly string[] = Object.values(AgentStage).filter((s) => s !== AgentStage.HUMAN);

const TASK_ID_PATTERN = /\b(?:BE|FE)-[A-Za-z0-9._-]+\b/;
const DESIGN_REF_PATTERN = /\bDES-\d+\b/g;

export interface PlanTaskRow {
  /** Plan-level id, e.g. `BE-004`. Unique within the plan — validated, not assumed. */
  id: string;
  /** The `## Phase N` heading this row sits under. */
  phase: number;
  /** `DES-NNN` refs named in the Task cell — the traceability chain's task leg (T19). */
  designRefs: string[];
  /** Declared dependencies from the `Depends on` cell, deduped, document order. */
  dependsOn: string[];
  status: PlanTaskStatus;
  owner: string;
  /** Authored wave from an optional `Wave` column; null when the plan carries none. */
  wave: number | null;
  description: string;
  /** True when the row came from a legacy `- [ ]` line rather than a T52 table. */
  fromCheckbox: boolean;
  /** Explicit contract columns from the authoritative task table; undefined means the plan did not make the claim. */
  produces?: string[];
  consumes?: string[];
}

export interface ParsedPlan {
  tasks: PlanTaskRow[];
  /** Rows skipped before they could become a task — each becomes a validation problem below. */
  problems: string[];
}

/** `BE-004 (DES-002) — POST /orders`, or a legacy `BE-004 — POST /orders`. Same reading as legacyPlan.ts. */
function parseTaskCell(cell: string): { id: string | null; description: string; designRefs: string[] } {
  const idMatch = TASK_ID_PATTERN.exec(cell);
  const designRefs = [...new Set([...cell.matchAll(DESIGN_REF_PATTERN)].map((m) => m[0]))];
  const description = cell
    .replace(TASK_ID_PATTERN, "")
    .replace(/\((?:\s*DES-\d+\s*,?)+\)/g, "")
    .replace(/^\s*[—:.-]\s*/, "")
    .trim();
  return { id: idMatch ? idMatch[0] : null, description, designRefs };
}

function normaliseStatus(raw: string): PlanTaskStatus | null {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (PLAN_STATUSES as readonly string[]).includes(value) ? (value as PlanTaskStatus) : null;
}

function dependsOf(cell: string | undefined): string[] {
  const text = (cell ?? "").trim();
  if (text === "" || text === "—" || text === "-") return [];
  return [...new Set([...text.matchAll(/\b(?:BE|FE)-[A-Za-z0-9._-]+\b/g)].map((m) => m[0]))];
}

function waveOf(cell: string | undefined): number | null | "invalid" {
  const text = (cell ?? "").trim();
  if (text === "" || text === "—" || text === "-") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 ? value : "invalid";
}

function contractsOf(cell: string | undefined): string[] | undefined {
  if (cell === undefined) return undefined;
  const text = cell.trim();
  if (text === "" || text === "—" || text === "-") return [];
  return [...new Set(text.split(/\s*(?:,|;|<br\s*\/?>)\s*/i).map((value) => value.replace(/^`|`$/g, "").trim()).filter(Boolean))];
}

function rowsForPhase(phaseNumber: number, body: string, problems: string[]): PlanTaskRow[] {
  const rows: PlanTaskRow[] = [];
  const push = (
    taskCell: string,
    statusCell: string,
    ownerCell: string,
    dependsCell: string,
    waveCell: string | undefined,
    producesCell: string | undefined,
    consumesCell: string | undefined,
    fromCheckbox: boolean,
  ): void => {
    const parsed = parseTaskCell(taskCell);
    if (!parsed.id) {
      problems.push(`phase ${phaseNumber}: row "${taskCell.slice(0, 60)}" has no BE-/FE- id — an id is the identity a dependency points at`);
      return;
    }
    const status = normaliseStatus(statusCell);
    const wave = waveOf(waveCell);
    rows.push({
      id: parsed.id,
      phase: phaseNumber,
      designRefs: parsed.designRefs,
      dependsOn: dependsOf(dependsCell),
      status: status ?? "pending",
      owner: ownerCell.trim(),
      wave: wave === "invalid" ? null : wave,
      description: parsed.description || parsed.id,
      fromCheckbox,
      produces: contractsOf(producesCell),
      consumes: contractsOf(consumesCell),
    });
    if (status === null) {
      problems.push(`task ${parsed.id}: Status "${statusCell.trim()}" is not one of ${PLAN_STATUSES.join(", ")}`);
    }
    if (wave === "invalid") {
      problems.push(`task ${parsed.id}: Wave "${(waveCell ?? "").trim()}" is not a positive integer`);
    }
  };

  const table = firstTable(body);
  if (table.rows.length > 0) {
    const column = (name: string, fallback: number): number => {
      const found = table.header.findIndex((heading) => heading.trim().toLowerCase() === name);
      return found === -1 ? fallback : found;
    };
    const task = column("task", 0);
    const status = column("status", 1);
    const owner = column("owner", 2);
    const depends = column("depends on", 3);
    const wave = table.header.findIndex((heading) => heading.trim().toLowerCase() === "wave");
    const produces = table.header.findIndex((heading) => heading.trim().toLowerCase() === "produces");
    const consumes = table.header.findIndex((heading) => heading.trim().toLowerCase() === "consumes");
    for (const cells of table.rows) {
      push(
        cells[task] ?? "",
        cells[status] ?? "",
        cells[owner] ?? "",
        cells[depends] ?? "",
        wave === -1 ? undefined : cells[wave],
        produces === -1 ? undefined : cells[produces],
        consumes === -1 ? undefined : cells[consumes],
        false,
      );
    }
    return rows;
  }

  // Legacy checkbox shape (pre-T52). Still parsed so --check-plan says something
  // useful about an unmigrated plan instead of silently passing it.
  for (const line of checkboxLines(body)) {
    push(line.text, "", "", "", undefined, undefined, undefined, true);
  }
  return rows;
}

/** Parses every `## Phase N` task row out of a plan.md. Never throws — bad rows come back as problems. */
export function parsePlanTasks(planMd: string): ParsedPlan {
  const tasks: PlanTaskRow[] = [];
  const problems: string[] = [];
  for (const section of sections(planMd, 2)) {
    const match = /^Phase\s+(\d+)\b/i.exec(section.title);
    if (!match) continue;
    tasks.push(...rowsForPhase(Number(match[1]), section.body, problems));
  }
  return { tasks, problems };
}

export interface PlanGraphCheck {
  ok: boolean;
  /** One message per finding, each naming the task (or phase) it is about. */
  errors: string[];
  /** Derived execution waves — present even when validation fails, as far as the graph allowed. */
  waves: Map<string, number>;
}

/**
 * Validates the parsed rows as a dependency graph (T-PM1.3). Deterministic by
 * construction — no LLM, fixed check order, one error per finding.
 */
export function validatePlanTasks(
  tasks: PlanTaskRow[],
  opts: { designMd?: string } = {},
): PlanGraphCheck {
  const errors: string[] = [];

  const byId = new Map<string, PlanTaskRow>();
  for (const task of tasks) {
    const existing = byId.get(task.id);
    if (existing) {
      errors.push(
        `duplicate task id "${task.id}" (phases ${existing.phase} and ${task.phase}) — an id has to identify one task`,
      );
      continue;
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    const ownerValue = task.owner.trim().toLowerCase();
    if (!ownerValue) {
      errors.push(
        `task ${task.id} has an empty Owner cell — a row nobody owns cannot be dispatched; expected one of ${VALID_OWNERS.join(", ")}`,
      );
    } else if (!VALID_OWNERS.includes(ownerValue)) {
      errors.push(
        `task ${task.id}: Owner "${task.owner}" is not a role this pipeline has — expected one of ${VALID_OWNERS.join(", ")}`,
      );
    }
    if (task.designRefs.length === 0) {
      errors.push(`task ${task.id} names no DES-NNN — a task implementing nothing identifiable is the gap the traceability chain exists to catch`);
    }
    const seenDeps = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        errors.push(`task ${task.id} depends on itself — nothing else can run first, so it can never run`);
        continue;
      }
      if (seenDeps.has(dep)) {
        errors.push(`task ${task.id} declares its dependency on ${dep} more than once`);
        continue;
      }
      seenDeps.add(dep);
      if (!byId.has(dep)) {
        errors.push(`task ${task.id} depends on ${dep}, which is not a task in this plan — a dependency on a task that does not exist can never be satisfied`);
      }
    }
  }

  if (opts.designMd !== undefined) {
    const knownDesign = new Set(extractIds(opts.designMd, "DES"));
    for (const task of tasks) {
      for (const des of task.designRefs) {
        if (!knownDesign.has(des)) {
          errors.push(`task ${task.id} cites ${des}, which design.md does not define — a traceability reference into nothing cannot be resolved`);
        }
      }
    }
  }

  // Authored waves are only comparable when the whole plan commits to them —
  // half-authored is neither legacy (none) nor migrated (all), so it is its own finding.
  const withWave = tasks.filter((t) => t.wave !== null);
  const waves = new Map<string, number>();
  if (withWave.length > 0 && withWave.length < tasks.length) {
    errors.push(
      `${withWave.length} of ${tasks.length} tasks carry a Wave value — author the column for every task or drop it entirely; a half-derived wave is neither legacy nor current`,
    );
  }
  if (withWave.length === tasks.length && tasks.length > 0) {
    for (const task of tasks) {
      for (const dep of task.dependsOn) {
        const depWave = byId.get(dep)?.wave ?? null;
        if (depWave !== null && task.wave !== null && depWave >= task.wave) {
          errors.push(
            `task ${task.id} is wave ${task.wave} but depends on ${dep} in wave ${depWave} — a task's wave must be strictly greater than every dependency's`,
          );
        }
      }
    }
  }

  let derived: Map<string, number> = new Map();
  try {
    derived = deriveWaves(tasks);
  } catch (error) {
    if (error instanceof CircularDependencyError) {
      errors.push(`${error.message}`);
    } else if (error instanceof UnknownTaskError) {
      // Already reported per-row above; the graph-level echo adds nothing.
    } else if (error instanceof TaskGraphError) {
      errors.push(error.message);
    } else {
      throw error;
    }
  }
  for (const [id, wave] of derived) waves.set(id, wave);

  return { ok: errors.length === 0, errors, waves };
}

/**
 * Execution waves derived from the plan's own edges: declared dependencies plus
 * phase order. Wave 1 has no unresolved prerequisite; every task in wave N only
 * waits on strictly lower waves. Not runtime state — the orchestrator still
 * checks dependency status before dispatch (T-PM1.2).
 */
export function deriveWaves(tasks: PlanTaskRow[]): Map<string, number> {
  const nodes: TaskNode[] = tasks.map((t) => ({
    id: t.id,
    phase: t.phase,
    dependsOn: t.dependsOn.filter((d) => d !== t.id),
  }));
  const graph = new TaskGraph(nodes);
  const waves = new Map<string, number>();
  graph.parallelLayers().forEach((layer, i) => layer.forEach((n) => waves.set(n.id, i + 1)));
  return waves;
}

export interface PlanWaiting {
  task: PlanTaskRow;
  /** Dependency ids not yet `verified`. */
  waitingOn: string[];
}

export interface PlanReadiness {
  /** `pending`, every dependency `verified` — may start now, in document order. */
  ready: PlanTaskRow[];
  /** `in_progress` — started, not finished. */
  started: PlanTaskRow[];
  done: PlanTaskRow[];
  /** `blocked` rows, plus every pending row behind one — named so downstream stalls are visible, not silent. */
  stalledByBlocked: PlanTaskRow[];
  waiting: PlanWaiting[];
  /** Static waves over the whole plan (derived, 1-based). */
  waves: Map<string, number>;
}

/**
 * The ready-task selector for a plan (T-PM5.2), answered from the document's
 * own Status cells: `pending` AND every dependency `verified` AND not itself
 * blocked. A failed (`blocked`) dependency is never satisfied, so everything
 * downstream stays out of `ready` — visible in `waiting` with the reason.
 * Pure function of the parsed rows: re-running after a retry/resume cannot
 * drift, because there is no stored readiness to drift from.
 */
export function readinessOf(tasks: PlanTaskRow[]): PlanReadiness {
  const verified = new Set(tasks.filter((t) => t.status === "verified").map((t) => t.id));
  const blockedIds = new Set(tasks.filter((t) => t.status === "blocked").map((t) => t.id));

  const ready: PlanTaskRow[] = [];
  const started: PlanTaskRow[] = [];
  const done: PlanTaskRow[] = [];
  const stalledByBlocked: PlanTaskRow[] = [];
  const waiting: PlanWaiting[] = [];

  for (const task of tasks) {
    if (task.status === "verified") {
      done.push(task);
      continue;
    }
    if (task.status === "blocked") {
      stalledByBlocked.push(task);
      continue;
    }
    if (task.status === "in_progress") {
      started.push(task);
      continue;
    }
    const unmet = task.dependsOn.filter((dep) => !verified.has(dep));
    if (unmet.some((dep) => blockedIds.has(dep))) {
      stalledByBlocked.push(task);
      continue;
    }
    if (unmet.length > 0) {
      waiting.push({ task, waitingOn: unmet });
      continue;
    }
    ready.push(task);
  }

  let waves: Map<string, number>;
  try {
    waves = deriveWaves(tasks);
  } catch {
    waves = new Map(); // an invalid graph still gets a readiness answer; validatePlanTasks reports why
  }
  return { ready, started, done, stalledByBlocked, waiting, waves };
}

export interface PlanGraphModuleResult {
  module: string;
  ok: boolean;
  errors: string[];
  notes: string[];
}

/** Validates one module's plan.md (and its design.md DES refs, when design.md exists). */
export function checkPlanGraphForModule(docsModuleDir: string, module: string): PlanGraphModuleResult {
  const planPath = path.join(docsModuleDir, module, "plan.md");
  const notes: string[] = [];
  if (!fs.existsSync(planPath)) {
    return { module, ok: true, errors: [], notes: [`${module}/plan.md does not exist yet — nothing to graph-check`] };
  }
  const designPath = path.join(docsModuleDir, module, "design.md");
  const designMd = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8") : undefined;

  const { tasks, problems } = parsePlanTasks(fs.readFileSync(planPath, "utf8"));
  const errors = [...problems];
  if (tasks.length === 0) {
    notes.push(`${module}/plan.md has no task rows under any ## Phase heading`);
  }
  const check = validatePlanTasks(tasks, { designMd });
  errors.push(...check.errors);

  const widest = Math.max(0, ...[...check.waves.values()]);
  notes.push(`${module}/plan.md: ${tasks.length} task(s), ${widest} wave(s)`);
  return { module, ok: errors.length === 0, errors, notes };
}

export interface PlanGraphCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * The check `--check-plan` runs: every module's plan.md becomes a validated
 * DAG. A project with no `_docs/module/` yet is the normal pre-BA state — a
 * note, not a failure, matching `--check-doc-structure`'s reading.
 */
export function checkPlanGraphs(projectRoot: string, moduleName?: string): PlanGraphCheckResult {
  const docsModuleDir = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(docsModuleDir)) {
    return { ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to check."] };
  }

  const modules = moduleName
    ? [moduleName]
    : fs
        .readdirSync(docsModuleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  if (!moduleName && modules.length === 0) {
    return { ok: true, problems: [], notes: ["`_docs/module/` has no module folders yet."] };
  }
  if (moduleName && !fs.existsSync(path.join(docsModuleDir, moduleName))) {
    return { ok: false, problems: [`module "${moduleName}" has no folder under _docs/module/`], notes: [] };
  }

  const problems: string[] = [];
  const notes: string[] = [];
  for (const module of modules) {
    const result = checkPlanGraphForModule(docsModuleDir, module);
    notes.push(...result.notes);
    problems.push(...result.errors.map((e) => `${module}/plan.md: ${e}`));
  }
  return { ok: problems.length === 0, problems, notes };
}
