import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem, type KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { sourceIdFor, type SourceRecord } from "../knowledge/sourceRegistry.js";
import { checkboxLines, sections, tableRows } from "./markdown.js";

/**
 * Legacy `plan.md` Migration (T84) — checkbox plan to task database.
 *
 * BOTH FORMATS, BECAUSE BOTH EXIST
 *
 * TASKS_V1.md describes the legacy plan as checkbox-based, and T52 replaced
 * that with one table row per task carrying a real Status cell. A project being
 * adopted can hold either — or both, mid-migration, phase by phase. So this
 * reads a phase's table when it has one and falls back to its checkbox lines
 * when it does not. Reading only the format the task description mentions would
 * silently drop every phase already converted.
 *
 * MAPPING STATUS WITHOUT LOSING ANYTHING
 *
 * A table's Status cell maps straight across — it is already T52's vocabulary.
 * A checkbox has two states and has to map onto four:
 *
 *   `- [x]`  -> `verified`     somebody ticked it. This follows the call T61's
 *                              `fromArtifacts.planItemsFrom` already made for
 *                              the same question, deliberately rather than by
 *                              accident: the tick is a mark already made, and
 *                              re-deciding it here would mean an adoption could
 *                              quietly un-finish finished work.
 *   `- [ ]`  -> `pending`
 *
 * What that mapping loses is the difference between "qa-engineer verified this"
 * and "somebody ticked a box", and CLAUDE.md is clear that only `qa-engineer`
 * may write `verified`. So the raw line is kept verbatim in the item's `body`
 * and the source ref says it came from a checkbox — "ไม่เสียข้อมูล" in the sense
 * that matters, which is that the weaker original claim stays visible and
 * re-checkable instead of being replaced by the stronger one.
 *
 * THE SECURITY GATE SURVIVES
 *
 * `## Phase 2: name 🔒 Security gate` sets `sensitive: true` on every task in
 * that phase — the same thing T61's plan conversion does, and for the reason
 * CLAUDE.md gives: nobody removes a flag except the user, so an import that
 * dropped it would be removing one.
 *
 * A THIRD FORMAT: `[backend]`/`[frontend]` TAG, NO ID AT ALL (T113 pilot finding)
 *
 * A real adoption target's checkboxes carried a `[backend]`/`[frontend]` tag at
 * the front of the line instead of any `BE-`/`FE-` id — a real, currently-used
 * plan.md style this framework had never been run against. Skipping every such
 * line (the original behaviour) meant zero of that project's tasks survived
 * adoption, which is exactly the "ของเดิมต้องไม่หาย" failure V1.3 exists to
 * prevent. So a checkbox (or table row) with a `[tag]` prefix and no id gets one
 * synthesized — `BE-<module>-P<phase>-<NN>` / `FE-<module>-P<phase>-<NN>`,
 * sequential within its phase and tag — which deliberately reuses the same
 * `BE-`/`FE-` shape every other id in this file already has, so
 * `dependsOf`/`tagOf`/relations all keep working on it unchanged. The source
 * note says a synthesized id when one was, so nobody mistakes it for something
 * the legacy plan actually named.
 */

export type PlanStatus = "pending" | "in_progress" | "verified" | "blocked";

const PLAN_STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "verified", "blocked"];

export interface LegacyPlanResult {
  items: KnowledgeItem[];
  sources: SourceRecord[];
  notes: string[];
}

interface ParsedTask {
  id: string;
  description: string;
  status: PlanStatus;
  designIds: string[];
  dependsOn: string[];
  tag: "frontend" | "backend" | null;
  /** The line as written, kept because the mapping above is lossy on purpose. */
  raw: string;
  fromCheckbox: boolean;
  /** This id did not come from the legacy plan — see the module doc's "a third format" note. */
  synthesizedId: boolean;
}

/** `BE-004 (DES-002) — POST /orders`, or a legacy `BE-004 — POST /orders`. */
function parseTaskCell(cell: string): { id: string | null; description: string; designIds: string[] } {
  const idMatch = /\b((?:BE|FE)-[A-Za-z0-9._-]+)\b/.exec(cell);
  const designIds = [...new Set([...cell.matchAll(/\bDES-\d+\b/g)].map((m) => m[0]))];
  const description = cell
    .replace(/\b(?:BE|FE)-[A-Za-z0-9._-]+\b/, "")
    .replace(/\((?:\s*DES-\d+\s*,?)+\)/g, "")
    .replace(/^\s*[—:.-]\s*/, "")
    .trim();
  return { id: idMatch ? idMatch[1] : null, description, designIds };
}

function tagOf(id: string, owner: string): "frontend" | "backend" | null {
  if (id.startsWith("BE-")) return "backend";
  if (id.startsWith("FE-")) return "frontend";
  if (/backend/i.test(owner)) return "backend";
  if (/frontend/i.test(owner)) return "frontend";
  return null;
}

function normaliseStatus(raw: string): PlanStatus | null {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (PLAN_STATUSES as readonly string[]).includes(value) ? (value as PlanStatus) : null;
}

/** `[backend]`/`[frontend]` at the very start of a line — the tag a plan uses instead of a `BE-`/`FE-` id. See the module doc's "a third format" note. */
function tagPrefixOf(text: string): { tag: "frontend" | "backend"; rest: string } | null {
  const match = /^\s*\[(backend|frontend)\]\s*/i.exec(text);
  if (!match) return null;
  return { tag: match[1].toLowerCase() as "backend" | "frontend", rest: text.slice(match[0].length).trim() };
}

function dependsOf(cell: string | undefined): string[] {
  if (!cell || cell.trim() === "" || cell.trim() === "—" || cell.trim() === "-") return [];
  return [...new Set([...cell.matchAll(/\b(?:BE|FE)-[A-Za-z0-9._-]+\b/g)].map((m) => m[0]))];
}

/**
 * The id a task with no `BE-`/`FE-` id gets when its text carries a
 * `[backend]`/`[frontend]` tag instead — sequential per tag within this phase,
 * so re-running the migration against an unchanged plan produces the same ids
 * (T113's fallback; see the module doc's "a third format" note). `null` when
 * the text has no such tag either — that line stays unimportable, same as
 * before this fallback existed.
 */
function synthesizedIdentityOf(
  text: string,
  module: string,
  phaseNumber: number,
  seqByTag: Record<"backend" | "frontend", number>,
): { id: string; tag: "frontend" | "backend"; rest: string } | null {
  const tagged = tagPrefixOf(text);
  if (!tagged) return null;
  seqByTag[tagged.tag] += 1;
  const prefix = tagged.tag === "backend" ? "BE" : "FE";
  const id = `${prefix}-${module}-P${phaseNumber}-${String(seqByTag[tagged.tag]).padStart(2, "0")}`;
  return { id, tag: tagged.tag, rest: tagged.rest };
}

function tasksOfPhase(body: string, notes: string[], label: string, module: string, phaseNumber: number): ParsedTask[] {
  const rows = tableRows(body);
  const tasks: ParsedTask[] = [];
  const seqByTag: Record<"backend" | "frontend", number> = { backend: 0, frontend: 0 };

  if (rows.length > 0) {
    for (const cells of rows) {
      const [taskCell, statusCell = "", ownerCell = "", dependsCell = ""] = cells;
      const parsed = parseTaskCell(taskCell);
      const synthesized = parsed.id ? null : synthesizedIdentityOf(taskCell, module, phaseNumber, seqByTag);
      const id = parsed.id ?? synthesized?.id ?? null;
      if (!id) {
        notes.push(`${label}: table row "${taskCell.slice(0, 60)}" has no BE-/FE- id — skipped, an id is the identity`);
        continue;
      }
      if (synthesized) notes.push(`${label}: table row "${taskCell.slice(0, 60)}" had no BE-/FE- id — synthesized ${id} from its [${synthesized.tag}] tag`);
      const status = normaliseStatus(statusCell);
      if (status === null) {
        notes.push(`${label}: task ${id} has Status "${statusCell.trim()}", which is not one of T52's four — imported as pending`);
      }
      const description = synthesized ? synthesized.rest : parsed.description;
      tasks.push({
        id,
        description: description || id,
        status: status ?? "pending",
        designIds: parsed.designIds,
        dependsOn: dependsOf(dependsCell),
        tag: synthesized?.tag ?? tagOf(id, ownerCell),
        raw: `| ${cells.join(" | ")} |`,
        fromCheckbox: false,
        synthesizedId: synthesized !== null,
      });
    }
    return tasks;
  }

  for (const box of checkboxLines(body)) {
    const parsed = parseTaskCell(box.text);
    const synthesized = parsed.id ? null : synthesizedIdentityOf(box.text, module, phaseNumber, seqByTag);
    const id = parsed.id ?? synthesized?.id ?? null;
    if (!id) {
      notes.push(`${label}: checkbox "${box.text.slice(0, 60)}" has no BE-/FE- id — skipped, an id is the identity`);
      continue;
    }
    if (synthesized) notes.push(`${label}: checkbox "${box.text.slice(0, 60)}" had no BE-/FE- id — synthesized ${id} from its [${synthesized.tag}] tag`);
    const description = synthesized ? synthesized.rest : parsed.description;
    tasks.push({
      id,
      description: description || id,
      // See the module doc: the tick is a mark already made, kept rather than re-decided.
      status: box.done ? "verified" : "pending",
      designIds: parsed.designIds,
      dependsOn: [],
      tag: synthesized?.tag ?? tagOf(id, ""),
      raw: `- [${box.done ? "x" : " "}] ${box.text}`,
      fromCheckbox: true,
      synthesizedId: synthesized !== null,
    });
  }
  return tasks;
}

function phaseNumberOf(title: string, index: number): number {
  const match = /\bPhase\s*(\d+)/i.exec(title);
  return match ? Number.parseInt(match[1], 10) : index + 1;
}

function lineOf(text: string, needle: string): number | null {
  const index = text.indexOf(needle);
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

function taskItem(
  task: ParsedTask,
  phase: number,
  sensitive: boolean,
  ctx: { relativePath: string; module: string; projectRoot: string; now: string; sourceId: string; text: string },
): KnowledgeItemOf<"task"> {
  const agent =
    task.tag === "backend"
      ? AgentStage.BACKEND_ENGINEER
      : task.tag === "frontend"
        ? AgentStage.FRONTEND_ENGINEER
        : null;
  const line = lineOf(ctx.text, task.raw.slice(0, 40));
  const locator = line === null ? ctx.relativePath : `${ctx.relativePath}#L${line}`;

  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: task.id,
    kind: "task",
    title: task.description.length > 200 ? `${task.description.slice(0, 200)}…` : task.description,
    // The line as written. The status mapping above is lossy on purpose, and
    // this is what makes it re-checkable rather than final.
    body: task.raw,
    repo: null,
    module: ctx.module,
    // A task's owner is the engineer that would do it. Where the plan does not
    // say (no BE-/FE- prefix, no owner column), `project-manager` owns it — it
    // is the role that decides which engineer a task belongs to, and guessing
    // one here would be answering a question T65 gives to somebody else.
    owner: agent ?? AgentStage.PROJECT_MANAGER,
    status: "draft",
    sensitive,
    version: 1,
    created_at: ctx.now,
    updated_at: ctx.now,
    sources: [
      {
        type: "file",
        locator,
        captured_at: ctx.now,
        digest: digestOfSource(locator, ctx.projectRoot),
        source_id: ctx.sourceId,
        note: [
          "legacy import (T84)",
          task.fromCheckbox ? "from a `[x]`/`[ ]` checkbox, not a T52 Status cell" : null,
          task.synthesizedId ? "id synthesized from a [tag] prefix — the legacy plan named no BE-/FE- id" : null,
        ]
          .filter((s): s is string => s !== null)
          .join(" — "),
      },
    ],
    relations: [
      ...task.designIds.map((id) => ({ type: "implements" as const, to: id })),
      ...task.dependsOn.map((id) => ({ type: "depends-on" as const, to: id })),
    ],
    payload: {
      agent,
      phase,
      tag: task.tag,
      plan_status: task.status,
      // A legacy plan names neither, and `taskGraph` derives ordering from
      // these — an invented contract name would produce an invented ordering.
      produces: [],
      consumes: [],
      contract_version: null,
      // No orchestrator run produced this task, so there is nothing to join to.
      // T102 sets it when the task is next actually run.
      orchestrator_task_id: null,
    },
  };
}

/**
 * Reads every module's `plan.md` and migrates it. Never writes.
 *
 * `docsRoot` (defaulting to `<projectRoot>/_docs`) is where `module/` lives —
 * see `legacyDocs.ts`'s `importLegacyDocs` doc-comment for why this is a
 * separate option from `projectRoot` rather than assumed to be `_docs` right
 * under it.
 */
export function migrateLegacyPlan(
  projectRoot: string,
  now: string,
  docsRoot: string = path.join(projectRoot, "_docs"),
): LegacyPlanResult {
  const moduleRoot = path.join(docsRoot, "module");
  if (!fs.existsSync(moduleRoot)) {
    return { items: [], sources: [], notes: [`no \`module/\` under ${path.relative(projectRoot, docsRoot) || "."} — no legacy plan.md to migrate`] };
  }

  const items: KnowledgeItem[] = [];
  const sources: SourceRecord[] = [];
  const notes: string[] = [];

  const modules = fs
    .readdirSync(moduleRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const module of modules) {
    const abs = path.join(moduleRoot, module, "plan.md");
    const relativePath = path.relative(projectRoot, abs).split(path.sep).join("/");
    if (!fs.existsSync(abs)) {
      notes.push(`${module} has no plan.md`);
      continue;
    }

    const text = fs.readFileSync(abs, "utf8");
    const source: SourceRecord = {
      schema_version: KNOWLEDGE_SCHEMA_VERSION,
      id: sourceIdFor(relativePath),
      type: "file",
      locator: relativePath,
      captured_at: now,
      captured_by: AgentStage.PROJECT_MANAGER,
      digest: digestOfSource(relativePath, projectRoot),
      note: "legacy import (T84)",
    };
    const ctx = { relativePath, module, projectRoot, now, sourceId: source.id, text };

    const phases = sections(text, 2).filter((s) => /^Phase\s*\d+/i.test(s.title));
    if (phases.length === 0) {
      notes.push(`${relativePath} has no \`## Phase N\` heading — no task derived`);
      continue;
    }

    const produced: KnowledgeItem[] = [];
    const seen = new Set<string>();
    for (const [index, phase] of phases.entries()) {
      const number = phaseNumberOf(phase.title, index);
      // Nobody removes a security flag except the user (CLAUDE.md), so an
      // import that dropped it would be removing one.
      const sensitive = /🔒/u.test(phase.title) || /Security gate/i.test(phase.title);
      for (const task of tasksOfPhase(phase.body, notes, `${relativePath} Phase ${number}`, module, number)) {
        if (seen.has(task.id)) {
          notes.push(`${relativePath}: task id ${task.id} appears more than once — only the first was imported`);
          continue;
        }
        seen.add(task.id);
        produced.push(taskItem(task, number, sensitive, ctx));
      }
    }

    if (produced.length === 0) continue;
    sources.push(source);
    items.push(...produced);
  }

  return { items, sources, notes };
}
