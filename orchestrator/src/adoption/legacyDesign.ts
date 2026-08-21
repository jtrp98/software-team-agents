import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { KNOWLEDGE_SCHEMA_VERSION, type DbSchemaPayload, type KnowledgeItem, type Relation } from "../knowledge/knowledgeModel.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { sourceIdFor, type SourceRecord } from "../knowledge/sourceRegistry.js";
import { parsePrismaModels } from "../bootstrap/discovery/dbSchemaDiscovery.js";
import { sectionBody, sections } from "./markdown.js";

/**
 * Legacy `design.md` Migration (T85).
 *
 * `design.md` is the one legacy document that is a *contract* rather than a
 * description: CLAUDE.md's rule is that its Data Model is what
 * `backend-engineer` implements verbatim and what `qa-engineer` fails drift
 * against. So it is the document where losing structure costs the most, and the
 * one worth parsing into three real kinds instead of one prose item:
 *
 *   `## Feature-by-Feature Feasibility`  -> `architecture` items, one per DES-NNN,
 *                                           each `refines` the REQ-NNN it names
 *   `## Data Model`                      -> `db-schema` items, one per Prisma model
 *   `## Modules`                         -> the sensitive flag, per module section
 *
 * FEASIBILITY IS NEVER GUESSED
 *
 * The heading says "feasibility" and the rows say things like "straightforward".
 * It is tempting to map that to `feasible`. This does not, for the same reason
 * T74-T78 do not: a converter that reads prose and emits a verdict is a
 * converter that can make a risk disappear. Rows land as `unknown`, or
 * `feasible-with-risk` when the document itself lists a risk against them —
 * and `## Risks & Dependencies` is carried onto every item from that document,
 * because a risk written once in a shared section applies to the design, not to
 * whichever row happens to be next to it.
 *
 * THE PRISMA PARSER IS THE ONE FROM T76
 *
 * `## Data Model` holds real `schema.prisma` syntax — the agent template
 * requires it ("valid `schema.prisma` syntax, not a high-level summary"), and
 * `setup` seeds the real schema file from it. So this calls
 * `parsePrismaModels`, the same function T76's discovery uses on
 * `prisma/schema.prisma`. A second Prisma parser here would be two readings of
 * one syntax that agree until the first fix — which is exactly the failure the
 * T61-T80 review traced its two worst bugs to.
 *
 * MARKED AS A LEGACY IMPORT
 *
 * Every item's source ref carries `note: "legacy import (T85)"` and every item
 * starts at `version: 1` — T63's history then reads the rest from git, so
 * "where did this come from" is answerable without a second bookkeeping field
 * that nobody updates.
 */

export interface LegacyDesignResult {
  items: KnowledgeItem[];
  sources: SourceRecord[];
  notes: string[];
}

interface DesignRow {
  id: string;
  requirementIds: string[];
  text: string;
}

/** `DES-001 — covers REQ-001, REQ-002: straightforward, standard JWT login.` */
function featureRows(body: string): DesignRow[] {
  const rows: DesignRow[] = [];
  const seen = new Set<string>();

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "");
    const match = /\b(DES-\d+)\b/.exec(line);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      requirementIds: [...new Set([...line.matchAll(/\bREQ-\d+\b/g)].map((m) => m[0]))],
      text: line,
    });
  }
  return rows;
}

/** Module sections that name a sensitive concern — the flag `project-manager` turns into a 🔒 Security gate. */
function sensitiveModules(text: string): Set<string> {
  const body = sectionBody(text, /^##\s+Modules/);
  if (body === null) return new Set();

  const flagged = new Set<string>();
  for (const section of sections(body, 3)) {
    const name = section.title.replace(/^Module:\s*/i, "").trim();
    if (/Security Considerations:/i.test(section.body) || /\bsensitive\b/i.test(section.body)) flagged.add(name);
  }
  return flagged;
}

function riskLines(text: string): string[] {
  const body = sectionBody(text, /^##\s+Risks/);
  if (body === null) return [];
  return body
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter((l) => l !== "" && !l.startsWith("#") && l !== "...");
}

function contractVersionOf(text: string): number | null {
  const match = /^\*\*Contract Version:\*\*\s*(\d+)/im.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

function lineOf(text: string, needle: string): number | null {
  const index = text.indexOf(needle);
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

interface Ctx {
  relativePath: string;
  module: string;
  projectRoot: string;
  now: string;
  sourceId: string;
}

function envelope(
  ctx: Ctx,
  parts: { id: string; title: string; body: string; owner: AgentStage; locator: string; relations?: Relation[]; sensitive?: boolean },
): Omit<KnowledgeItem, "kind" | "payload"> {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: parts.id,
    title: parts.title,
    body: parts.body,
    repo: null,
    module: ctx.module,
    owner: parts.owner,
    status: "draft",
    sensitive: parts.sensitive ?? false,
    version: 1,
    created_at: ctx.now,
    updated_at: ctx.now,
    sources: [
      {
        type: "file",
        locator: parts.locator,
        captured_at: ctx.now,
        digest: digestOfSource(parts.locator, ctx.projectRoot),
        source_id: ctx.sourceId,
        note: "legacy import (T85)",
      },
    ],
    relations: parts.relations ?? [],
  };
}

function designItemsFor(text: string, ctx: Ctx, notes: string[]): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  const risks = riskLines(text);
  const contractVersion = contractVersionOf(text);
  const flagged = sensitiveModules(text);
  // A module document's own sensitivity, applied to the design rows: a row
  // cannot name which module it belongs to, but a design with a sensitive
  // module in it is a design where the flag has to survive the import — the one
  // thing CLAUDE.md says nobody but the user may remove.
  const anySensitive = flagged.size > 0;

  const featureBody = sectionBody(text, /^##\s+Feature-by-Feature Feasibility/);
  if (featureBody === null) {
    notes.push(`${ctx.relativePath} has no \`## Feature-by-Feature Feasibility\` section — no architecture item derived`);
  } else {
    const rows = featureRows(featureBody);
    if (rows.length === 0) {
      notes.push(`${ctx.relativePath}'s feasibility section has no DES-NNN row — nothing to key an architecture item on`);
    }
    for (const row of rows) {
      const line = lineOf(text, row.text.slice(0, 40));
      const rowRisks = risks.filter((r) => r.includes(row.id));
      items.push({
        ...envelope(ctx, {
          id: row.id,
          title: row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text,
          body: [row.text, contractVersion !== null ? `Contract Version at import: ${contractVersion}` : ""]
            .filter((p) => p !== "")
            .join("\n"),
          owner: AgentStage.SYSTEM_ANALYST,
          locator: line === null ? ctx.relativePath : `${ctx.relativePath}#L${line}`,
          relations: row.requirementIds.map((id) => ({ type: "refines" as const, to: id })),
          sensitive: anySensitive,
        }),
        kind: "architecture",
        payload: {
          // See the module doc: read, never judged.
          feasibility: rowRisks.length > 0 || risks.length > 0 ? "feasible-with-risk" : "unknown",
          risks: rowRisks.length > 0 ? rowRisks : risks,
          component: null,
        },
      });
    }
  }

  const dataModel = sectionBody(text, /^##\s+Data Model/);
  if (dataModel === null) {
    notes.push(`${ctx.relativePath} has no \`## Data Model\` section — no db-schema item derived`);
    return items;
  }

  const models = parsePrismaModels(dataModel);
  if (models.length === 0) {
    notes.push(
      `${ctx.relativePath}'s Data Model holds no \`model\` block — it is a summary rather than the schema the template requires, so no db-schema item could be derived`,
    );
    return items;
  }

  const modelNames = new Set(models.map((m) => m.name));
  const firstArchitecture = items[0]?.id;
  for (const model of models) {
    const start = lineOf(text, model.raw.split(/\r?\n/)[0]);
    const relations = model.fields
      .map((f) => f.type.replace(/[?[\]]/g, ""))
      .filter((t) => t !== model.name && modelNames.has(t));

    items.push({
      ...envelope(ctx, {
        id: `DB-${model.name}`,
        title: `Database model: ${model.name}`,
        body: `Migrated from ${ctx.relativePath}'s Data Model, which CLAUDE.md makes the contract \`backend-engineer\` implements verbatim.`,
        owner: AgentStage.SYSTEM_ANALYST,
        locator: start === null ? ctx.relativePath : `${ctx.relativePath}#L${start}-L${start + model.raw.split(/\r?\n/).length - 1}`,
        relations: firstArchitecture ? [{ type: "derived-from", to: firstArchitecture }] : [],
      }),
      kind: "db-schema",
      payload: {
        model: model.name,
        fields: model.fields,
        relations: [...new Set(relations)].sort(),
      },
    });
  }

  return items;
}

/**
 * Legacy design files sometimes repeat a Prisma model while extending it in a
 * later amendment. Preserve both declarations as one schema item rather than
 * letting the last write silently erase the earlier fields. A field that is
 * required in one declaration and optional in another becomes optional — the
 * only merged form that can represent both declarations. Incompatible base
 * types remain a hard error rather than a guessed conversion.
 */
function mergeRepeatedDbSchemas(items: KnowledgeItem[], notes: string[]): KnowledgeItem[] {
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of items) groups.set(item.id, [...(groups.get(item.id) ?? []), item]);
  const merged: KnowledgeItem[] = [];
  const emitted = new Set<string>();

  for (const item of items) {
    if (emitted.has(item.id)) continue;
    emitted.add(item.id);
    const group = groups.get(item.id)!;
    if (group.length === 1 || item.kind !== "db-schema") { merged.push(item); continue; }
    if (!group.every((candidate) => candidate.kind === "db-schema")) {
      throw new Error(`cannot merge legacy item ${item.id}: duplicate ids have different kinds`);
    }
    const schemas = group as Array<Extract<KnowledgeItem, { kind: "db-schema" }>>;
    const first = schemas[0];
    const fields = new Map<string, DbSchemaPayload["fields"][number]>();
    for (const schema of schemas) {
      for (const field of schema.payload.fields) {
        const previous = fields.get(field.name);
        if (!previous) { fields.set(field.name, { ...field }); continue; }
        const previousBase = previous.type.replace(/\?$/, "");
        const nextBase = field.type.replace(/\?$/, "");
        if (previousBase !== nextBase) {
          throw new Error(`cannot merge legacy db schema ${item.id}: field ${field.name} has incompatible types ${previous.type} and ${field.type}`);
        }
        const optional = previous.optional || field.optional;
        fields.set(field.name, { ...previous, type: optional && !previousBase.endsWith("[]") ? `${previousBase}?` : previousBase, optional });
      }
    }
    const sourceKey = (source: typeof first.sources[number]) => `${source.locator}\u0000${source.digest}`;
    const sources = [...new Map(schemas.flatMap((schema) => schema.sources).map((source) => [sourceKey(source), source])).values()];
    const payloadRelations = [...new Set(schemas.flatMap((schema) => schema.payload.relations))].sort();
    const relationKey = (relation: Relation) => `${relation.type}\u0000${relation.to}`;
    const relations = [...new Map(schemas.flatMap((schema) => schema.relations).map((relation) => [relationKey(relation), relation])).values()];
    merged.push({ ...first, sources, relations, payload: { ...first.payload, fields: [...fields.values()], relations: payloadRelations } });
    notes.push(`merged ${schemas.length} repeated declarations of ${item.id} into one db-schema item`);
  }
  return merged;
}

/**
 * Reads every module's `design.md` and migrates it. Never writes.
 *
 * `docsRoot` (defaulting to `<projectRoot>/_docs`) is where `module/` lives —
 * see `legacyDocs.ts`'s `importLegacyDocs` doc-comment for why this is a
 * separate option from `projectRoot` rather than assumed to be `_docs` right
 * under it.
 */
export function migrateLegacyDesign(
  projectRoot: string,
  now: string,
  docsRoot: string = path.join(projectRoot, "_docs"),
): LegacyDesignResult {
  const moduleRoot = path.join(docsRoot, "module");
  if (!fs.existsSync(moduleRoot)) {
    return { items: [], sources: [], notes: [`no \`module/\` under ${path.relative(projectRoot, docsRoot) || "."} — no legacy design.md to migrate`] };
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
    const abs = path.join(moduleRoot, module, "design.md");
    const relativePath = path.relative(projectRoot, abs).split(path.sep).join("/");
    if (!fs.existsSync(abs)) {
      notes.push(`${module} has no design.md`);
      continue;
    }

    const text = fs.readFileSync(abs, "utf8");
    const source: SourceRecord = {
      schema_version: KNOWLEDGE_SCHEMA_VERSION,
      id: sourceIdFor(relativePath),
      type: "file",
      locator: relativePath,
      captured_at: now,
      captured_by: AgentStage.SYSTEM_ANALYST,
      digest: digestOfSource(relativePath, projectRoot),
      note: "legacy import (T85)",
    };

    const produced = designItemsFor(text, { relativePath, module, projectRoot, now, sourceId: source.id }, notes);
    if (produced.length === 0) continue;
    sources.push(source);
    items.push(...produced);
  }

  return { items: mergeRepeatedDbSchemas(items, notes), sources, notes };
}
