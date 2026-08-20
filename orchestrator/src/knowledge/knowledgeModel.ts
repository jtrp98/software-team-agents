import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { AgentStage } from "../types.js";

/**
 * The shared Project Knowledge model (T61) — one shape for all nine entity
 * types V1.1 names: requirement, business rule, domain term, architecture,
 * API, DB schema, decision, task, test.
 *
 * WHY ONE ENVELOPE AND NOT NINE TABLES
 *
 * T64/T67/T69/T70 all need to walk *across* kinds — "which tasks implement the
 * API this requirement needs", "what does DEV see for this module". Split into
 * nine per-kind modules, every one of those questions becomes a join each
 * caller writes for itself, which is precisely the "subsystem you cannot query
 * across" this model exists to prevent. So: one envelope, one `payload`
 * discriminated on `kind`, one query entry point (knowledgeBase.ts).
 *
 * WHY AJV AND A HAND-WRITTEN INTERFACE, NOT ZOD
 *
 * `store/stateSchema.ts` fixed the rule: an artefact that lands on disk and is
 * read by things outside this process is validated by JSON Schema; a value
 * that never leaves the process uses zod. A knowledge item is on disk and other
 * tools read it, so the schema file is the definition and the TypeScript below
 * is a hand-kept mirror — the same arrangement `decisions/decisionLog.ts` has
 * with `AdrFrontmatter`. A zod copy would be a second definition free to drift
 * from the first.
 *
 * WHAT THIS FILE ADDS ON TOP OF THE SCHEMA
 *
 * Two rules JSON Schema cannot state without exploding into branches, and both
 * are load-bearing:
 *
 *   1. The id prefix must match the kind. The ids here are the *same* ids T19
 *      already traces (`REQ-`/`DES-`/`BE-`/`FE-`/`TEST-`, `ADR-NNN`), not a
 *      parallel id space, so `REQ-003` naming a `task` is a mistake to reject,
 *      not a value to accept.
 *   2. A relation's two ends must be a legal pair. A graph where anything may
 *      point at anything is a flat list with arrows: check() could report
 *      nothing useful, and traverse() would return noise.
 */

export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const KNOWLEDGE_KINDS = [
  "requirement",
  "business-rule",
  "domain",
  "architecture",
  "api",
  "db-schema",
  "decision",
  "task",
  "test",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const RELATION_TYPES = [
  "refines",
  "implements",
  "verifies",
  "references",
  "depends-on",
  "constrains",
  "supersedes",
  "conflicts-with",
  "derived-from",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export type KnowledgeStatus = "draft" | "reviewed" | "approved" | "deprecated";
export type SourceType = "file" | "db" | "api-spec" | "code" | "human" | "agent";

export interface SourceRef {
  type: SourceType;
  /** `path#L10-L24`, a table name, an OpenAPI path, a person's name, a role name. */
  locator: string;
  /** When the source was read — not when the item was edited. T71's input. */
  captured_at: string;
  /** Hash of the slice read, so a later run can tell the source moved. null when unhashable (a person). */
  digest: string | null;
  /** The registered raw source (T62) this came from, when there is one. */
  source_id?: string;
  note?: string;
}

export interface Relation {
  type: RelationType;
  /** Id of the target item. May not exist yet — check() reports that, nothing throws. */
  to: string;
  note?: string;
}

/** Everything every kind carries. Only `payload` differs below. */
export interface KnowledgeEnvelope {
  schema_version: number;
  id: string;
  title: string;
  body: string;
  repo: string | null;
  module: string | null;
  owner: AgentStage;
  status: KnowledgeStatus;
  sensitive: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  sources: SourceRef[];
  relations: Relation[];
}

export interface RequirementPayload {
  acceptance_criteria: string[];
  actors: string[];
  priority: "must" | "should" | "could" | null;
  /** CLAUDE.md's rule in a field: a fact with no source is an assumption, in writing. */
  assumption_unconfirmed: boolean;
}

export interface BusinessRulePayload {
  statement: string;
  enforcement: "code" | "policy" | "manual" | "unknown";
}

export interface DomainPayload {
  term: string;
  definition: string;
  aliases: string[];
}

export interface ArchitecturePayload {
  feasibility: "feasible" | "feasible-with-risk" | "not-feasible" | "unknown";
  risks: string[];
  component: string | null;
}

export interface ApiPayload {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "other";
  path: string;
  /** The same string a plan task names in produces/consumes — that shared name is what taskGraph derives ordering from. */
  contract_name: string | null;
  request_shape: string | null;
  response_shape: string | null;
}

export interface DbSchemaPayload {
  model: string;
  fields: Array<{ name: string; type: string; optional: boolean }>;
  relations: string[];
}

export interface DecisionPayload {
  adr_status: "proposed" | "accepted" | "superseded" | "rejected";
  date: string;
  supersedes: string | null;
  superseded_by: string | null;
}

export interface TaskPayload {
  agent: AgentStage | null;
  phase: number | null;
  tag: "frontend" | "backend" | null;
  /** plan.md's Status cell (T52). */
  plan_status: "pending" | "in_progress" | "verified" | "blocked";
  produces: string[];
  consumes: string[];
  contract_version: number | null;
  /** PersistedTask.taskId — the join between this graph and the running state machine. */
  orchestrator_task_id: string | null;
}

export interface TestPayload {
  levels: Array<"unit" | "integration" | "api" | "e2e">;
  automated: boolean;
}

export interface PayloadByKind {
  requirement: RequirementPayload;
  "business-rule": BusinessRulePayload;
  domain: DomainPayload;
  architecture: ArchitecturePayload;
  api: ApiPayload;
  "db-schema": DbSchemaPayload;
  decision: DecisionPayload;
  task: TaskPayload;
  test: TestPayload;
}

export interface KnowledgeItemOf<K extends KnowledgeKind> extends KnowledgeEnvelope {
  kind: K;
  payload: PayloadByKind[K];
}

export type KnowledgeItem = { [K in KnowledgeKind]: KnowledgeItemOf<K> }[KnowledgeKind];

/**
 * Which id prefixes belong to which kind. `task` has two because the pipeline
 * already tags tasks by side (`BE-`/`FE-`) and inventing a third id for the
 * same task is how the id space stops being one space.
 */
export const ID_PREFIXES: Record<KnowledgeKind, string[]> = {
  requirement: ["REQ"],
  "business-rule": ["RULE"],
  domain: ["DOM"],
  architecture: ["DES"],
  api: ["API"],
  "db-schema": ["DB"],
  decision: ["ADR"],
  task: ["BE", "FE"],
  test: ["TEST"],
};

export const ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Za-z0-9._/-]+$/;

/** The prefix half of an id — everything before the first hyphen. */
export function prefixOf(id: string): string {
  const hyphen = id.indexOf("-");
  return hyphen === -1 ? id : id.slice(0, hyphen);
}

export function isPrefixValidForKind(id: string, kind: KnowledgeKind): boolean {
  return ID_PREFIXES[kind].includes(prefixOf(id));
}

type EndSpec = KnowledgeKind[] | "any";
interface RelationRule {
  from: EndSpec;
  /** "same" = the two ends must be the same kind, whatever that kind is. */
  to: EndSpec | "same";
}

/**
 * The legality matrix. A relation is legal when any one of its rules matches;
 * `refines` needs two rules rather than a cross product because
 * architecture→domain is not a thing anyone meant to allow.
 */
export const RELATION_RULES: Record<RelationType, RelationRule[]> = {
  refines: [
    { from: ["architecture", "business-rule"], to: ["requirement"] },
    { from: ["domain"], to: ["domain"] },
  ],
  implements: [{ from: ["task"], to: ["architecture", "api", "db-schema", "business-rule"] }],
  verifies: [{ from: ["test"], to: ["requirement", "business-rule", "task"] }],
  // Soft citation — deliberately unrestricted. api->db-schema is the common case,
  // but "this mentions that" is a real edge between any two kinds.
  references: [{ from: "any", to: "any" }],
  "depends-on": [
    { from: ["task"], to: ["task"] },
    { from: ["api"], to: ["api"] },
  ],
  constrains: [{ from: ["decision", "business-rule"], to: "any" }],
  supersedes: [{ from: "any", to: "same" }],
  // T66's edge. Same-kind only: a requirement and a task cannot contradict each
  // other, they can only fail to match, which is a different finding.
  "conflicts-with": [{ from: "any", to: "same" }],
  "derived-from": [{ from: "any", to: "any" }],
};

export function isRelationLegal(type: RelationType, fromKind: KnowledgeKind, toKind: KnowledgeKind): boolean {
  return RELATION_RULES[type].some((rule) => {
    const fromOk = rule.from === "any" || rule.from.includes(fromKind);
    if (!fromOk) return false;
    if (rule.to === "same") return fromKind === toKind;
    if (rule.to === "any") return true;
    return rule.to.includes(toKind);
  });
}

/** One line naming what the relation would have to be for check()'s message to be actionable. */
export function describeRelationRule(type: RelationType): string {
  return RELATION_RULES[type]
    .map((rule) => {
      const from = rule.from === "any" ? "any" : rule.from.join("|");
      const to = rule.to === "same" ? "the same kind" : rule.to === "any" ? "any" : rule.to.join("|");
      return `${from} -> ${to}`;
    })
    .join(", ");
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "knowledge-item.schema.json",
);

export function knowledgeItemSchemaPath(): string {
  return SCHEMA_PATH;
}

export class KnowledgeItemError extends Error {
  constructor(
    public readonly label: string,
    public readonly issues: string[],
  ) {
    super(`${label} is not a usable knowledge item:\n- ${issues.join("\n- ")}`);
    this.name = "KnowledgeItemError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    // discriminator:true is what turns nine `oneOf` branches into one readable
    // error ("payload/priority must be ...") instead of nine parallel failures
    // nobody can read. It requires every branch to pin `kind` with a const and
    // list it as required — both done in the schema file.
    const ajv = new Ajv({ allErrors: true, strict: true, discriminator: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/**
 * Ajv's own message stops exactly where the reader needs one more word: "must
 * NOT have additional properties" never says which one, and "must be equal to
 * one of the allowed values" never says which values. Both are in `params`, so
 * they go into the message — a check whose output does not name the offending
 * field costs a round trip to find it.
 */
function formatAjvError(error: { instancePath?: string; message?: string; params?: Record<string, unknown> }): string {
  const where = error.instancePath || "(root)";
  const what = error.message ?? "is invalid";
  const params = error.params ?? {};
  if (typeof params.additionalProperty === "string") {
    return `${where} ${what}: "${params.additionalProperty}"`;
  }
  if (Array.isArray(params.allowedValues)) {
    return `${where} ${what}: ${params.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return `${where} ${what}`;
}

/**
 * Every problem with one candidate item, as strings — schema first, then the
 * two rules the schema cannot express. Returns a list rather than throwing so
 * a loader can report every bad file in one pass instead of stopping at the
 * first.
 */
export function checkKnowledgeItem(data: unknown): string[] {
  const validate = validator();
  if (!validate(data)) {
    return (validate.errors ?? []).map(formatAjvError);
  }

  const item = data as KnowledgeItem;
  const problems: string[] = [];

  if (!isPrefixValidForKind(item.id, item.kind)) {
    problems.push(
      `id "${item.id}" has prefix "${prefixOf(item.id)}" but kind "${item.kind}" uses ` +
        `${ID_PREFIXES[item.kind].map((p) => `${p}-`).join(" or ")} — the prefix is how a reader knows what an id refers to`,
    );
  }

  for (const relation of item.relations) {
    if (relation.to === item.id) {
      problems.push(`relation ${relation.type} points at "${item.id}" itself — an item cannot relate to itself`);
    }
  }

  return problems;
}

/**
 * Validates and returns a typed item, or throws with every problem listed.
 * Used where a partly-trusted item would be worse than none: reading one file
 * the caller asked for by name.
 */
export function validateKnowledgeItem(data: unknown, label: string): KnowledgeItem {
  const problems = checkKnowledgeItem(data);
  if (problems.length > 0) throw new KnowledgeItemError(label, problems);
  return data as KnowledgeItem;
}

export function isKnowledgeKind(value: string): value is KnowledgeKind {
  return (KNOWLEDGE_KINDS as readonly string[]).includes(value);
}
