import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { KnowledgeItem, KnowledgeKind, Relation, SourceRef } from "./knowledgeModel.js";

/**
 * Field-level context policy per role (T68).
 *
 * T67 answers "which kinds does this role see". This answers the finer
 * question: of an item it does see, which parts. Kept in `knowledge-policy.yaml`
 * rather than in this file, for the reason T15 kept path permissions in
 * `contracts/*.yaml` — a permission expressible only as TypeScript is one no
 * project outside this repo can set.
 *
 * REDACTION IS NEVER SILENT
 *
 * Every redaction returns what it removed. `contextManager.ts` established this
 * for document slicing: "a filter can never silently edit its inputs", because
 * an agent cannot tell a rule that was withheld from a rule that never existed,
 * and will confidently implement around the gap. Same rule, finer granularity.
 *
 * THE OWNER EXCEPTION
 *
 * An item's own owner always sees it in full. Any other reading turns a policy
 * into a bug: `business-analyst` writing a requirement about personal data and
 * then being unable to read it back is not a security posture.
 */

export type SensitiveAccess = "full" | "redacted" | "hidden";

export interface RolePolicy {
  sensitive: SensitiveAccess;
  hideFields: string[];
}

export interface FreshnessThreshold {
  agingAfterDays: number;
  staleAfterDays: number;
}

export interface KnowledgePolicy {
  version: number;
  defaults: RolePolicy;
  roles: Partial<Record<AgentStage, Partial<RolePolicy>>>;
  freshness: {
    default: FreshnessThreshold;
    byKind: Partial<Record<KnowledgeKind, FreshnessThreshold>>;
  };
}

/**
 * What applies when there is no file. Permissive on purpose: field-level
 * restriction breaks pipelines when it is wrong (an engineer who cannot see the
 * acceptance criteria implements the wrong thing), so it is opt-in.
 */
export const DEFAULT_KNOWLEDGE_POLICY: KnowledgePolicy = {
  version: 1,
  defaults: { sensitive: "full", hideFields: [] },
  roles: {},
  freshness: {
    default: { agingAfterDays: 90, staleAfterDays: 180 },
    byKind: {},
  },
};

export const POLICY_FILENAME = "knowledge-policy.yaml";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "knowledge-policy.schema.json",
);

export function knowledgePolicyPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, POLICY_FILENAME);
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

export class KnowledgePolicyError extends Error {
  constructor(public readonly issues: string[]) {
    super(`${POLICY_FILENAME} is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "KnowledgePolicyError";
  }
}

interface RawRolePolicy {
  sensitive?: SensitiveAccess;
  hide_fields?: string[];
}

interface RawPolicy {
  version: number;
  defaults?: RawRolePolicy;
  roles?: Record<string, RawRolePolicy>;
  freshness?: {
    default: { aging_after_days: number; stale_after_days: number };
    by_kind?: Record<string, { aging_after_days: number; stale_after_days: number }>;
  };
}

function fromRaw(raw: RawPolicy): KnowledgePolicy {
  const defaults: RolePolicy = {
    sensitive: raw.defaults?.sensitive ?? DEFAULT_KNOWLEDGE_POLICY.defaults.sensitive,
    hideFields: raw.defaults?.hide_fields ?? [],
  };

  const roles: KnowledgePolicy["roles"] = {};
  for (const [role, entry] of Object.entries(raw.roles ?? {})) {
    roles[role as AgentStage] = {
      ...(entry.sensitive !== undefined ? { sensitive: entry.sensitive } : {}),
      ...(entry.hide_fields !== undefined ? { hideFields: entry.hide_fields } : {}),
    };
  }

  const byKind: KnowledgePolicy["freshness"]["byKind"] = {};
  for (const [kind, t] of Object.entries(raw.freshness?.by_kind ?? {})) {
    byKind[kind as KnowledgeKind] = { agingAfterDays: t.aging_after_days, staleAfterDays: t.stale_after_days };
  }

  return {
    version: raw.version,
    defaults,
    roles,
    freshness: {
      default: raw.freshness
        ? { agingAfterDays: raw.freshness.default.aging_after_days, staleAfterDays: raw.freshness.default.stale_after_days }
        : DEFAULT_KNOWLEDGE_POLICY.freshness.default,
      byKind,
    },
  };
}

/** Parses and validates a policy document that is already in memory. */
export function parseKnowledgePolicy(data: unknown): KnowledgePolicy {
  const validate = validator();
  if (!validate(data)) {
    throw new KnowledgePolicyError(
      (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
    );
  }
  return fromRaw(data as RawPolicy);
}

/** The project's policy, or the built-in permissive default when there is no file. */
export function loadKnowledgePolicy(projectRoot: string = defaultProjectRoot()): KnowledgePolicy {
  const filePath = knowledgePolicyPath(projectRoot);
  if (!fs.existsSync(filePath)) return DEFAULT_KNOWLEDGE_POLICY;

  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new KnowledgePolicyError([`is not valid YAML: ${(e as Error).message}`]);
  }
  return parseKnowledgePolicy(parsed);
}

export interface PolicyCheckResult {
  problems: string[];
  notes: string[];
}

/** The `--check-knowledge` half that covers the policy file. No file is a note, not a problem. */
export function checkKnowledgePolicyFile(projectRoot: string = defaultProjectRoot()): PolicyCheckResult {
  const filePath = knowledgePolicyPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { problems: [], notes: [`no ${POLICY_FILENAME} — every role sees every field of what its view allows.`] };
  }

  let policy: KnowledgePolicy;
  try {
    policy = loadKnowledgePolicy(projectRoot);
  } catch (e) {
    return { problems: e instanceof KnowledgePolicyError ? e.issues.map((i) => `${POLICY_FILENAME} ${i}`) : [String(e)], notes: [] };
  }

  const problems: string[] = [];
  const notes: string[] = [];

  for (const [kind, threshold] of Object.entries(policy.freshness.byKind)) {
    if (threshold.agingAfterDays >= threshold.staleAfterDays) {
      problems.push(
        `${POLICY_FILENAME}: freshness.by_kind.${kind} ages after ${threshold.agingAfterDays} days but goes stale after ` +
          `${threshold.staleAfterDays} — an item would never be reported as merely aging`,
      );
    }
  }
  const d = policy.freshness.default;
  if (d.agingAfterDays >= d.staleAfterDays) {
    problems.push(
      `${POLICY_FILENAME}: freshness.default ages after ${d.agingAfterDays} days but goes stale after ` +
        `${d.staleAfterDays} — an item would never be reported as merely aging`,
    );
  }

  const restricted = Object.entries(policy.roles).filter(
    ([, p]) => (p?.sensitive && p.sensitive !== "full") || (p?.hideFields && p.hideFields.length > 0),
  );
  if (restricted.length > 0) {
    notes.push(`field-level restrictions apply to: ${restricted.map(([role]) => role).join(", ")}`);
  }

  return { problems, notes };
}

export function policyFor(role: AgentStage, policy: KnowledgePolicy = DEFAULT_KNOWLEDGE_POLICY): RolePolicy {
  const override = policy.roles[role] ?? {};
  return {
    sensitive: override.sensitive ?? policy.defaults.sensitive,
    hideFields: override.hideFields ?? policy.defaults.hideFields,
  };
}

export function freshnessThresholdFor(
  kind: KnowledgeKind,
  policy: KnowledgePolicy = DEFAULT_KNOWLEDGE_POLICY,
): FreshnessThreshold {
  return policy.freshness.byKind[kind] ?? policy.freshness.default;
}

/**
 * An item as one role is allowed to see it. Always this shape, redacted or not,
 * so a caller never has two types to handle — and `withheld` is always present,
 * so "nothing was hidden" is a value rather than an absence.
 */
export interface VisibleItem {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  repo: string | null;
  module: string | null;
  owner: AgentStage;
  status: KnowledgeItem["status"];
  sensitive: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  sources: SourceRef[];
  relations: Relation[];
  payload: Record<string, unknown>;
  /** Field names removed for this role. Empty when nothing was. */
  withheld: string[];
}

const REDACTED_ON_SENSITIVE = ["body", "sources", "payload"];

/**
 * The item as `role` may see it, or null when the policy hides it entirely.
 *
 * The owner always gets everything. Redaction keeps identity, status and
 * relations — enough to know the item exists, who to ask, and how it connects —
 * and drops the contents.
 */
export function visibleItemFor(
  item: KnowledgeItem,
  role: AgentStage,
  policy: KnowledgePolicy = DEFAULT_KNOWLEDGE_POLICY,
): VisibleItem | null {
  const rolePolicy = policyFor(role, policy);
  const isOwner = item.owner === role || role === AgentStage.HUMAN;

  if (item.sensitive && !isOwner && rolePolicy.sensitive === "hidden") return null;

  const withheld = new Set<string>();
  if (item.sensitive && !isOwner && rolePolicy.sensitive === "redacted") {
    for (const field of REDACTED_ON_SENSITIVE) withheld.add(field);
  }
  if (!isOwner) {
    for (const field of rolePolicy.hideFields) withheld.add(field);
  }

  const visible: VisibleItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: withheld.has("body") ? "" : item.body,
    repo: item.repo,
    module: item.module,
    owner: item.owner,
    status: item.status,
    sensitive: item.sensitive,
    version: item.version,
    created_at: item.created_at,
    updated_at: item.updated_at,
    sources: withheld.has("sources") ? [] : item.sources,
    relations: withheld.has("relations") ? [] : item.relations,
    payload: withheld.has("payload") ? {} : { ...(item.payload as unknown as Record<string, unknown>) },
    withheld: [],
  };

  // `payload.<key>` entries hide one field of the payload rather than all of it.
  for (const field of withheld) {
    if (!field.startsWith("payload.")) continue;
    delete visible.payload[field.slice("payload.".length)];
  }

  visible.withheld = [...withheld].sort();
  return visible;
}
