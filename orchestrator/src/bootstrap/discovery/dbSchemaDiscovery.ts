import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItemOf } from "../../knowledge/knowledgeModel.js";
import type { SourceRecord } from "../../knowledge/sourceRegistry.js";
import { sourceIdFor } from "../../knowledge/sourceRegistry.js";
import { digestOfSource } from "../../knowledge/sourceDigest.js";
import type { DiscoveryResult, DiscoveryStage } from "../bootstrapRunner.js";

/**
 * Database Schema Discovery (T76) — the third Discovery stage in T73's flow.
 *
 * Reads `prisma/schema.prisma` — CLAUDE.md's fixed stack, and per
 * `policies/architecture.md` §7 the working copy the engineers' queries
 * actually run against once `setup` has written it. This stage does not
 * connect to a live database: the schema file is deterministic, offline,
 * and already the contract of record, so introspecting a running Postgres
 * instance would be a second, less authoritative copy of what this file
 * already says.
 *
 * ONE FILE, MANY ITEMS — the case sourceRegistry.ts's module doc calls out
 * by name: every `db-schema` item this stage produces cites the same
 * registered source (`prisma/schema.prisma`), because one schema file is
 * the origin of every model in it. The registry record's digest hashes the
 * whole file; each item's own source ref hashes and line-ranges just its
 * model's block, so a later run can tell which model actually moved.
 */

export const SCHEMA_RELATIVE_PATH = "prisma/schema.prisma";

const MODEL_BLOCK = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;

export interface ParsedModel {
  name: string;
  fields: Array<{ name: string; type: string; optional: boolean }>;
  startLine: number;
  endLine: number;
  raw: string;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === "\n") line++;
  return line;
}

/**
 * Reads `model X { ... }` blocks out of Prisma text.
 *
 * Exported because `design.md`'s `## Data Model` section holds the same syntax —
 * the `system-analyst` template requires real `schema.prisma` syntax there, and
 * `setup` seeds the actual file from it — so T85's legacy migration reads it
 * with this function rather than its own. Two readings of one syntax agree until
 * the first fix to one of them; the T61-T80 review traced both of its worst
 * defects to exactly that shape of duplication.
 */
export function parsePrismaModels(content: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  MODEL_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MODEL_BLOCK.exec(content)) !== null) {
    const [raw, name, body] = match;
    const fields: ParsedModel["fields"] = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;
      const fieldMatch = line.match(/^(\w+)\s+(\S+)/);
      if (!fieldMatch) continue;
      const [, fieldName, rawType] = fieldMatch;
      fields.push({ name: fieldName, type: rawType, optional: rawType.endsWith("?") });
    }
    const startLine = lineOf(content, match.index);
    const endLine = startLine + raw.split(/\r?\n/).length - 1;
    models.push({ name, fields, startLine, endLine, raw });
  }
  return models;
}

function relationsOf(model: ParsedModel, modelNames: Set<string>): string[] {
  const found = new Set<string>();
  for (const field of model.fields) {
    const base = field.type.replace(/[?[\]]/g, "");
    if (base !== model.name && modelNames.has(base)) found.add(base);
  }
  return [...found].sort();
}

function dbItem(
  model: ParsedModel,
  modelNames: Set<string>,
  projectRoot: string,
  now: string,
  sourceId: string,
  targetId?: string,
): KnowledgeItemOf<"db-schema"> {
  const locator = `${SCHEMA_RELATIVE_PATH}#L${model.startLine}-L${model.endLine}`;
  const relations = relationsOf(model, modelNames);

  return {
    schema_version: targetId ? 2 : KNOWLEDGE_SCHEMA_VERSION,
    id: `DB-${model.name}`,
    kind: "db-schema",
    title: `Database model: ${model.name}`,
    body:
      `Database Schema Discovery (T76) read this model from \`${SCHEMA_RELATIVE_PATH}\` (lines ${model.startLine}-${model.endLine}).` +
      (relations.length > 0 ? ` Relates to: ${relations.join(", ")}.` : ""),
    repo: null,
    module: null,
    owner: AgentStage.SYSTEM_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: now,
    updated_at: now,
    // Hashed through the locator, not from `model.raw`: the two are nearly the
    // same text but not identical (the match starts at `model`, the line range
    // starts at column 0), and T71 recomputes from the locator.
    ...(targetId ? { target_ids: [targetId] } : {}),
    sources: [{ type: "file", locator, captured_at: now, digest: digestOfSource(locator, projectRoot), source_id: sourceId, ...(targetId ? { origin: { root: "target" as const, target_id: targetId } } : {}) }],
    relations: [],
    payload: {
      model: model.name,
      fields: model.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
      relations,
    },
  };
}

/** `now` is threaded through so callers (and tests) control the timestamp — this module never reads the clock itself. */
export function dbSchemaDiscoveryStage(now: () => string = () => new Date().toISOString(), targetId?: string): DiscoveryStage {
  return {
    id: "db-schema",
    discover: (projectRoot: string): DiscoveryResult => {
      const timestamp = now();
      const absPath = path.join(projectRoot, SCHEMA_RELATIVE_PATH);
      if (!fs.existsSync(absPath)) {
        return { items: [], sources: [], skipped: true, note: `no ${SCHEMA_RELATIVE_PATH} found` };
      }

      const content = fs.readFileSync(absPath, "utf8");
      const models = parsePrismaModels(content);
      if (models.length === 0) {
        return { items: [], sources: [], skipped: true, note: `${SCHEMA_RELATIVE_PATH} exists but declares no model blocks yet` };
      }

      const source: SourceRecord = {
        schema_version: 1,
        id: sourceIdFor(SCHEMA_RELATIVE_PATH),
        type: "file",
        locator: SCHEMA_RELATIVE_PATH,
        captured_at: timestamp,
        captured_by: AgentStage.SYSTEM_ANALYST,
        // Whole file — the registry answers "did this file move", each item's own
        // ref answers "did my model move".
        digest: digestOfSource(SCHEMA_RELATIVE_PATH, projectRoot),
        ...(targetId ? { origin: { root: "target" as const, target_id: targetId } } : {}),
      };

      const modelNames = new Set(models.map((m) => m.name));
      const items = models.map((model) => dbItem(model, modelNames, projectRoot, timestamp, source.id, targetId));

      return { items, sources: [source] };
    },
  };
}
