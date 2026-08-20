import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { KnowledgeItem } from "./knowledgeModel.js";
import type { KnowledgeBase } from "./knowledgeBase.js";
import { knowledgeDir } from "./knowledgeStore.js";

/**
 * Conflict detection and resolution (T66).
 *
 * Knowledge arrives from several places — a document, the code, a person — and
 * they disagree. The rule this module exists to enforce is that an agent does
 * not get to pick a winner: it flags the disagreement and a person decides.
 *
 * WHAT IS STORED AND WHAT IS NOT
 *
 * Conflicts are **detected fresh every run** and never written down. A stored
 * conflict list goes stale the instant somebody fixes one, and then the system
 * is escalating a problem that no longer exists — which is the fastest way to
 * teach people to ignore it.
 *
 * Resolutions **are** stored, in `knowledge/_conflicts/<CONF-id>.yaml`, because
 * a decision is not re-derivable: nothing in the items records that a person
 * looked at both and chose. The id is a hash of the conflicting ids plus the
 * kind, so the same conflict gets the same id every run and last month's
 * decision still matches today's detection.
 *
 * DECLARED VERSUS DETECTED, AND WHY ONLY ONE IS RED
 *
 * A `conflicts-with` relation was written by somebody who meant it, so leaving
 * it unresolved is a real, blocking problem. A duplicate model name found by
 * pattern-matching is a suggestion — sometimes two modules legitimately define
 * a `Note` — so it is reported and does not fail the check. A heuristic that
 * can block CI is a heuristic that gets deleted the first time it is wrong.
 */

export const CONFLICTS_DIRNAME = "_conflicts";

export type ConflictKind = "declared" | "duplicate-model" | "duplicate-endpoint" | "duplicate-term";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  /** Sorted, so the same pair always hashes to the same id. */
  items: string[];
  /** What is actually contradictory, in one line — this is what a person reads before deciding. */
  summary: string;
  /** True when a person wrote the conflict down, rather than a pattern finding it. */
  declared: boolean;
}

export interface ConflictResolution {
  schema_version: number;
  id: string;
  conflict_kind: ConflictKind;
  items: string[];
  decision: string;
  decided_by: string;
  decided_at: string;
  note?: string;
}

export function conflictId(kind: ConflictKind, itemIds: string[]): string {
  const digest = createHash("sha1").update(`${kind}:${[...itemIds].sort().join("|")}`).digest("hex");
  return `CONF-${digest.slice(0, 10)}`;
}

function conflict(kind: ConflictKind, itemIds: string[], summary: string): Conflict {
  const items = [...itemIds].sort();
  return { id: conflictId(kind, items), kind, items, summary, declared: kind === "declared" };
}

/** Groups items by a natural key, returning only the keys more than one item claims. */
function duplicatesBy(
  items: KnowledgeItem[],
  key: (item: KnowledgeItem) => string | null,
): Array<{ key: string; items: KnowledgeItem[] }> {
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([k, group]) => ({ key: k, items: group }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Every contradiction currently in the base. Deterministic and side-effect
 * free: the same items always produce the same conflicts with the same ids.
 */
export function detectConflicts(kb: KnowledgeBase): Conflict[] {
  const found: Conflict[] = [];
  const seen = new Set<string>();
  const push = (c: Conflict): void => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    found.push(c);
  };

  for (const item of kb.items) {
    for (const relation of item.relations) {
      if (relation.type !== "conflicts-with") continue;
      const other = kb.get(relation.to);
      if (!other) continue; // dangling — check() already reports it as a broken link
      push(
        conflict(
          "declared",
          [item.id, other.id],
          relation.note ?? `${item.id} and ${other.id} are recorded as contradicting each other`,
        ),
      );
    }
  }

  for (const group of duplicatesBy(kb.items, (i) => (i.kind === "db-schema" ? i.payload.model : null))) {
    push(
      conflict(
        "duplicate-model",
        group.items.map((i) => i.id),
        `${group.items.length} records define the model "${group.key}" — design.md is the contract, so only one of them can be it`,
      ),
    );
  }

  for (const group of duplicatesBy(kb.items, (i) => (i.kind === "api" ? `${i.payload.method} ${i.payload.path}` : null))) {
    push(
      conflict(
        "duplicate-endpoint",
        group.items.map((i) => i.id),
        `${group.items.length} records define the endpoint "${group.key}"`,
      ),
    );
  }

  for (const group of duplicatesBy(kb.items, (i) => (i.kind === "domain" ? i.payload.term.toLowerCase() : null))) {
    push(
      conflict(
        "duplicate-term",
        group.items.map((i) => i.id),
        `the term "${group.key}" is defined more than once — a glossary with two entries for one word is not a glossary`,
      ),
    );
  }

  return found;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "knowledge-conflict.schema.json",
);

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

export class ConflictResolutionError extends Error {
  constructor(
    public readonly label: string,
    public readonly issues: string[],
  ) {
    super(`${label} is not a usable conflict resolution:\n- ${issues.join("\n- ")}`);
    this.name = "ConflictResolutionError";
  }
}

export function checkResolution(data: unknown): string[] {
  const validate = validator();
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
}

export function conflictsDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(knowledgeDir(projectRoot), CONFLICTS_DIRNAME);
}

export function resolutionPath(id: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(conflictsDir(projectRoot), `${id}.yaml`);
}

export interface ResolutionLoadResult {
  resolutions: ConflictResolution[];
  problems: string[];
}

export function loadResolutions(projectRoot: string = defaultProjectRoot()): ResolutionLoadResult {
  const dir = conflictsDir(projectRoot);
  if (!fs.existsSync(dir)) return { resolutions: [], problems: [] };

  const resolutions: ConflictResolution[] = [];
  const problems: string[] = [];

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const label = `${CONFLICTS_DIRNAME}/${name}`;
    let parsed: unknown;
    try {
      parsed = parseYaml(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch (e) {
      problems.push(`${label}: is not valid YAML: ${(e as Error).message}`);
      continue;
    }
    const issues = checkResolution(parsed);
    if (issues.length > 0) {
      problems.push(new ConflictResolutionError(label, issues).message);
      continue;
    }
    const resolution = parsed as ConflictResolution;
    if (`${resolution.id}.yaml` !== name) {
      problems.push(`${label}: declares id "${resolution.id}", so it belongs at ${CONFLICTS_DIRNAME}/${resolution.id}.yaml`);
      continue;
    }
    // The id is a hash of what the resolution claims to be about. If they
    // disagree, the file was hand-edited into naming a different conflict, and
    // trusting it would close the wrong one.
    const expected = conflictId(resolution.conflict_kind, resolution.items);
    if (expected !== resolution.id) {
      problems.push(
        `${label}: id "${resolution.id}" does not match its own conflict_kind/items (expected ${expected}) — ` +
          "this resolution would close a conflict it is not about",
      );
      continue;
    }
    resolutions.push(resolution);
  }

  return { resolutions, problems };
}

export function renderResolution(resolution: ConflictResolution): string {
  const ordered: Record<string, unknown> = {
    schema_version: resolution.schema_version,
    id: resolution.id,
    conflict_kind: resolution.conflict_kind,
    items: resolution.items,
    decision: resolution.decision,
    decided_by: resolution.decided_by,
    decided_at: resolution.decided_at,
  };
  if (resolution.note !== undefined) ordered.note = resolution.note;
  return stringifyYaml(ordered, { lineWidth: 0 });
}

export function writeResolution(resolution: ConflictResolution, projectRoot: string = defaultProjectRoot()): string {
  const issues = checkResolution(resolution);
  if (issues.length > 0) throw new ConflictResolutionError(resolution.id, issues);

  const filePath = resolutionPath(resolution.id, projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderResolution(resolution), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

export interface ConflictReport {
  /** Declared conflicts nobody has decided. Blocking: a person wrote these down deliberately. */
  unresolvedDeclared: Conflict[];
  /** Detected duplicates nobody has decided. Reported, not blocking — a heuristic that can fail CI gets deleted. */
  unresolvedDetected: Conflict[];
  resolved: Array<{ conflict: Conflict; resolution: ConflictResolution }>;
  /** Decisions about conflicts that no longer exist. Not an error: the fix worked. Worth listing so the files can be tidied. */
  staleResolutions: ConflictResolution[];
}

export function reportConflicts(kb: KnowledgeBase, resolutions: ConflictResolution[]): ConflictReport {
  const conflicts = detectConflicts(kb);
  const byId = new Map(resolutions.map((r) => [r.id, r]));
  const matched = new Set<string>();

  const unresolvedDeclared: Conflict[] = [];
  const unresolvedDetected: Conflict[] = [];
  const resolved: ConflictReport["resolved"] = [];

  for (const c of conflicts) {
    const resolution = byId.get(c.id);
    if (resolution) {
      matched.add(c.id);
      resolved.push({ conflict: c, resolution });
    } else if (c.declared) {
      unresolvedDeclared.push(c);
    } else {
      unresolvedDetected.push(c);
    }
  }

  return {
    unresolvedDeclared,
    unresolvedDetected,
    resolved,
    staleResolutions: resolutions.filter((r) => !matched.has(r.id)),
  };
}

/** What a person needs in front of them to decide, without opening the files. */
export function describeConflict(conflict: Conflict, kb: KnowledgeBase): string {
  const lines = [`${conflict.id} (${conflict.kind}): ${conflict.summary}`];
  for (const id of conflict.items) {
    const item = kb.get(id);
    lines.push(
      item
        ? `  - ${id} [${item.status}, owner ${item.owner}, v${item.version}] ${item.title}` +
            `\n      source: ${item.sources.map((s) => `${s.type}:${s.locator}`).join(", ")}`
        : `  - ${id} (not in the knowledge base)`,
    );
  }
  lines.push("  -> a person decides; record it with a resolution file in knowledge/_conflicts/");
  return lines.join("\n");
}
