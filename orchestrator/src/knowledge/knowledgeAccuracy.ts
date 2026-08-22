import type { DbSchemaPayload, KnowledgeItem } from "./knowledgeModel.js";

/**
 * T115 — Shared Knowledge Accuracy Test.
 *
 * Every other check in this module answers "is this `KnowledgeItem` internally
 * consistent" (`knowledgeBase.ts`'s `check()`, schema validation, the ownership
 * matrix). None of them can answer the question T115 actually asks: does a
 * `db-schema` item discovered or migrated from `design.md` (T78/T85) still
 * describe the *real* database — the same "design.md's Data Model is the
 * contract" rule CLAUDE.md states, checked from the other direction. A
 * `db-schema` item is captured once, at import time; the real `schema.prisma`
 * keeps moving. This is what would catch the gap.
 *
 * WHY IT PARSES `schema.prisma` ITSELF INSTEAD OF SHELLING OUT TO PRISMA
 *
 * `static-analysis-gate.js` and `check-schema-contract.js` already avoid a
 * Prisma CLI dependency for the same reason: a check that only runs where
 * Prisma is installed and generated is a check that silently doesn't run in
 * CI or on a pilot's machine that doesn't have it configured yet. A model
 * block's shape (`model Name { field Type attrs... }`) is regular enough that
 * a narrow parser reading field name + declared type is enough to answer T115's
 * question, without needing the database attributes (`@id`, `@db.VarChar(20)`,
 * `@@index`, ...) that `design.md`'s Data Model never captured either.
 *
 * WHY A TYPE MISMATCH IS REPORTED SEPARATELY FROM A MISSING FIELD
 *
 * "Confidence: Float" vs the real "Confidence: Float?" is a stale capture —
 * the field exists, but was true (or written) before the model changed under
 * it. "Confidence" not appearing in the real model at all is a different
 * failure: the field was removed, or knowledge invented a field that was
 * never there. A single "mismatch" bucket would blur two different reasons a
 * knowledge item stops being trustworthy, and lose which fix applies to which.
 */

export interface PrismaField {
  name: string;
  /** The declared type token verbatim, including a trailing `?` when optional — matches how `DbSchemaPayload.fields[].type` already stores it (see `sampleKnowledge.ts`'s `Float?`). */
  type: string;
  optional: boolean;
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
}

/**
 * Reads every `model Name { ... }` block in a `schema.prisma` source string.
 * Skips blank lines, comments, and block-level attributes (`@@index`, `@@map`,
 * ...) — those describe the database, not the shape `DbSchemaPayload` captures.
 */
export function parsePrismaModels(source: string): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  const modelBlockRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint: regex.exec in a while loop is the standard idiom for a global match
  while ((match = modelBlockRe.exec(source)) !== null) {
    const [, name, body] = match;
    const fields: PrismaField[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;
      const [fieldName, fieldType] = line.split(/\s+/);
      if (!fieldName || !fieldType) continue;
      fields.push({ name: fieldName, type: fieldType, optional: fieldType.endsWith("?") });
    }
    models.set(name, { name, fields });
  }
  return models;
}

export interface FieldTypeMismatch {
  field: string;
  /** What the real schema declares now. */
  real: string;
  /** What the knowledge item still claims. */
  knowledge: string;
}

export interface ModelAccuracy {
  model: string;
  /** The knowledge item's id, so a report line can be traced back to one file. */
  itemId: string;
  /** False means the knowledge item names a model that does not exist in the real schema at all — the strongest possible drift. */
  presentInReal: boolean;
  fieldsMatched: string[];
  /** A field the knowledge item claims that the real model does not have — removed, renamed, or never real. */
  fieldsMissingInReal: string[];
  /** A field the real model has that the knowledge item never captured — import was incomplete, or the model grew since. */
  fieldsMissingInKnowledge: string[];
  typeMismatches: FieldTypeMismatch[];
  /** True only when every field name and type line up exactly, in both directions. */
  exact: boolean;
}

export interface KnowledgeAccuracyReport {
  models: ModelAccuracy[];
  summary: {
    modelsChecked: number;
    modelsExact: number;
    modelsMissingInReal: number;
    /** Field-level accuracy across every checked model: matched / (matched + missing + mismatched). 1 when there was nothing to check. */
    fieldAccuracy: number;
  };
}

/**
 * Checks every `db-schema` item this module owns against the real
 * `schema.prisma` source it is supposed to describe.
 *
 * Deliberately takes `items` rather than a `KnowledgeBase` — the caller has
 * usually already scoped to one module (`kb.query({ module, kinds: ["db-schema"] })`),
 * and this function has no reason to know about modules at all.
 */
export function checkDbSchemaAccuracy(items: KnowledgeItem[], prismaSource: string): KnowledgeAccuracyReport {
  const real = parsePrismaModels(prismaSource);
  const models: ModelAccuracy[] = [];

  for (const item of items) {
    if (item.kind !== "db-schema") continue;
    const payload = item.payload as DbSchemaPayload;
    const realModel = real.get(payload.model);

    if (!realModel) {
      models.push({
        model: payload.model,
        itemId: item.id,
        presentInReal: false,
        fieldsMatched: [],
        fieldsMissingInReal: payload.fields.map((f) => f.name),
        fieldsMissingInKnowledge: [],
        typeMismatches: [],
        exact: false,
      });
      continue;
    }

    const realByName = new Map(realModel.fields.map((f) => [f.name, f]));
    const knownNames = new Set(payload.fields.map((f) => f.name));

    const fieldsMatched: string[] = [];
    const fieldsMissingInReal: string[] = [];
    const typeMismatches: FieldTypeMismatch[] = [];

    for (const field of payload.fields) {
      const realField = realByName.get(field.name);
      if (!realField) {
        fieldsMissingInReal.push(field.name);
      } else if (realField.type !== field.type) {
        typeMismatches.push({ field: field.name, real: realField.type, knowledge: field.type });
      } else {
        fieldsMatched.push(field.name);
      }
    }

    const fieldsMissingInKnowledge = realModel.fields.map((f) => f.name).filter((name) => !knownNames.has(name));

    models.push({
      model: payload.model,
      itemId: item.id,
      presentInReal: true,
      fieldsMatched,
      fieldsMissingInReal,
      fieldsMissingInKnowledge,
      typeMismatches,
      exact: fieldsMissingInReal.length === 0 && fieldsMissingInKnowledge.length === 0 && typeMismatches.length === 0,
    });
  }

  const totalFieldChecks = models.reduce(
    (n, m) => n + m.fieldsMatched.length + m.fieldsMissingInReal.length + m.typeMismatches.length,
    0,
  );
  const matchedFieldChecks = models.reduce((n, m) => n + m.fieldsMatched.length, 0);

  return {
    models,
    summary: {
      modelsChecked: models.length,
      modelsExact: models.filter((m) => m.exact).length,
      modelsMissingInReal: models.filter((m) => !m.presentInReal).length,
      fieldAccuracy: totalFieldChecks === 0 ? 1 : matchedFieldChecks / totalFieldChecks,
    },
  };
}

/** One human-readable line per model, worst problems first — for a CLI or a pilot write-up, not for parsing. */
export function describeAccuracy(report: KnowledgeAccuracyReport): string[] {
  const lines: string[] = [];
  for (const m of report.models) {
    if (!m.presentInReal) {
      lines.push(`${m.itemId} (${m.model}): model does not exist in the real schema — knowledge is stale or was never real`);
      continue;
    }
    if (m.exact) {
      lines.push(`${m.itemId} (${m.model}): exact match, ${m.fieldsMatched.length} field(s)`);
      continue;
    }
    const problems: string[] = [];
    if (m.typeMismatches.length > 0) {
      problems.push(
        `${m.typeMismatches.length} type mismatch(es): ${m.typeMismatches
          .map((t) => `${t.field} knowledge=${t.knowledge} real=${t.real}`)
          .join(", ")}`,
      );
    }
    if (m.fieldsMissingInReal.length > 0) {
      problems.push(`${m.fieldsMissingInReal.length} field(s) no longer real: ${m.fieldsMissingInReal.join(", ")}`);
    }
    if (m.fieldsMissingInKnowledge.length > 0) {
      problems.push(`${m.fieldsMissingInKnowledge.length} real field(s) never captured: ${m.fieldsMissingInKnowledge.join(", ")}`);
    }
    lines.push(`${m.itemId} (${m.model}): ${problems.join("; ")}`);
  }
  return lines;
}
