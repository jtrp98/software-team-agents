import * as fs from "node:fs";
import * as path from "node:path";
import { TaskState } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import type { AdoptionPreflight } from "./adoptionModel.js";
import { allTableRows, sectionBody, tableRows } from "./markdown.js";

/**
 * Existing State Detection (T86) — what the legacy project has in flight,
 * checked before adoption writes anything.
 *
 * WHAT COLLIDES WITH WHAT
 *
 * TASKS_V1.md's reason is "เพื่อไม่ให้ state ชนกัน", and the collision is
 * specific. Adoption reads a legacy `plan.md` and derives a `task` item per row,
 * with `plan_status` taken from the Status cell. If a row says `in_progress`,
 * somebody is editing the code behind it *right now*, and the row is a snapshot
 * of a moment that has already passed. Importing it is not wrong, but it is a
 * claim about live work, and the person doing that work is the only one who can
 * say whether the snapshot is safe to build on.
 *
 * Four places are checked, because they fail differently:
 *
 *   `.workflow/state.db`  a task this orchestrator is part-way through. The
 *                         sharpest signal, because it means a *run* is open,
 *                         not just a document.
 *   `plan.md`             `in_progress` rows, and legacy unticked checkboxes.
 *   `review.md`           open QA issues — work the pipeline already knows is
 *                         wrong and has routed to somebody.
 *   `security.md`         findings still 🔵 Open or 🟣 Fix claimed. Only
 *                         `security` may close one (CLAUDE.md), so an adoption
 *                         that quietly imported these as settled would be
 *                         making a call reserved for one agent.
 *
 * NOT A REFUSAL
 *
 * This returns blockers; it does not decide. Adoption stops at `blocked` until a
 * person acknowledges them by name (`acknowledgePreflight`), because "is it safe
 * to import on top of half-finished work" depends on things not in any file —
 * who is mid-edit, whether that branch is being thrown away. A framework that
 * refused outright would be worked around by deleting the evidence, which is
 * strictly worse than recording it and asking.
 */

/** States that mean a run is open. DEPLOYED is finished; BLOCKED is stuck, which is still unfinished work somebody has to see. */
const OPEN_TASK_STATES: readonly TaskState[] = Object.values(TaskState).filter((s) => s !== TaskState.DEPLOYED);

export interface DetectedState {
  blockers: string[];
  notes: string[];
}

function moduleDirs(projectRoot: string): string[] {
  const root = path.join(projectRoot, "_docs", "module");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readIfPresent(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * Open orchestrator tasks. A missing `.workflow/state.db` is the normal case for
 * a project that never ran this framework — which is most projects being
 * adopted — so it is a note, not a blocker.
 */
function detectOrchestratorState(projectRoot: string, out: DetectedState): void {
  const dbPath = defaultStateDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) {
    out.notes.push("no `.workflow/state.db` — this project has no orchestrator run history to collide with");
    return;
  }

  let store: SqliteTaskStore | undefined;
  try {
    store = new SqliteTaskStore(dbPath);
    const tasks = store.listTasks();
    const open = tasks.filter((t) => OPEN_TASK_STATES.includes(t.machine.current) && !t.cancelled);
    if (open.length === 0) {
      out.notes.push(`.workflow/state.db holds ${tasks.length} task(s), none of them open`);
      return;
    }
    for (const task of open) {
      const marks = [task.paused ? "paused" : null, task.blockedReason ? "blocked" : null].filter(Boolean).join(", ");
      out.blockers.push(
        `task "${task.taskId}" is at ${task.machine.current} in .workflow/state.db${marks ? ` (${marks})` : ""} — an open run`,
      );
    }
  } catch (e) {
    // A state.db that cannot be opened is itself worth stopping for: adoption
    // would be proceeding without knowing what is in flight.
    out.blockers.push(`.workflow/state.db exists but could not be read (${(e as Error).message}) — what is in flight is unknown`);
  } finally {
    store?.close();
  }
}

/** A `plan.md` task table row's Status cell, or a legacy `- [ ]` checkbox line. */
function detectPlanState(projectRoot: string, module: string, out: DetectedState): void {
  const file = path.join(projectRoot, "_docs", "module", module, "plan.md");
  const text = readIfPresent(file);
  if (text === null) return;

  const inProgress = allTableRows(text)
    .filter((cells) => cells.length >= 2 && cells[1].toLowerCase() === "in_progress")
    .map((cells) => cells[0]);
  if (inProgress.length > 0) {
    out.blockers.push(
      `${module}/plan.md has ${inProgress.length} task(s) marked in_progress: ${inProgress.join(", ")} — somebody is working on them now`,
    );
  } else {
    out.notes.push(`${module}/plan.md has no in_progress task`);
  }
}

/** Open QA issues. `review.md`'s `## Open Issues` section outlives its round on purpose (CLAUDE.md), so anything in it is current. */
function detectReviewState(projectRoot: string, module: string, out: DetectedState): void {
  const file = path.join(projectRoot, "_docs", "module", module, "review.md");
  const text = readIfPresent(file);
  if (text === null) return;

  const body = sectionBody(text, /^##\s+Open Issues/);
  if (body === null) {
    out.notes.push(`${module}/review.md has no \`## Open Issues\` section`);
    return;
  }
  // Table rows only: the section can hold prose ("none outstanding"), and
  // counting that as an issue would block adoption on nothing.
  const rows = tableRows(body);
  if (rows.length > 0) {
    out.blockers.push(`${module}/review.md lists ${rows.length} open QA issue(s) — work the pipeline already routed to somebody`);
  } else {
    out.notes.push(`${module}/review.md lists no open QA issue`);
  }
}

/** Security findings still 🔵 Open or 🟣 Fix claimed — only the `security` agent may close one. */
function detectSecurityState(projectRoot: string, module: string, out: DetectedState): void {
  const file = path.join(projectRoot, "_docs", "module", module, "security.md");
  const text = readIfPresent(file);
  if (text === null) return;

  const open = [...text.matchAll(/[🔵🟣]/gu)].length;
  if (open > 0) {
    out.blockers.push(
      `${module}/security.md has ${open} finding(s) still open or fix-claimed — only the \`security\` agent closes one`,
    );
  } else {
    out.notes.push(`${module}/security.md has no open or fix-claimed finding`);
  }
}

/**
 * Reads everything and reports. Never writes, never throws for a missing file:
 * every input here is optional in a real project, and "not present" is an
 * answer.
 */
export function detectExistingState(projectRoot: string = defaultProjectRoot()): DetectedState {
  const out: DetectedState = { blockers: [], notes: [] };

  detectOrchestratorState(projectRoot, out);

  const modules = moduleDirs(projectRoot);
  if (modules.length === 0) {
    out.notes.push("no `_docs/module/` — no legacy module documents to collide with");
    return out;
  }

  for (const module of modules) {
    detectPlanState(projectRoot, module, out);
    detectReviewState(projectRoot, module, out);
    detectSecurityState(projectRoot, module, out);
  }
  return out;
}

/** The preflight record `initAdoption`/`runPreflight` stores. Timestamped by the caller, per the repo's clock rule. */
export function preflightFrom(detected: DetectedState, now: string): AdoptionPreflight {
  return {
    detected_at: now,
    blockers: detected.blockers,
    notes: detected.notes,
    acknowledged_by: null,
    acknowledged_at: null,
  };
}
