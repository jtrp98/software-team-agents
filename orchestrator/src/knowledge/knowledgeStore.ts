import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import {
  type KnowledgeItem,
  KnowledgeItemError,
  checkKnowledgeItem,
  validateKnowledgeItem,
} from "./knowledgeModel.js";

/**
 * Where knowledge lives on disk, and the rules for putting it there (T61).
 *
 * SOURCE OF TRUTH = YAML FILES IN THE REPO, GIT AS TRANSPORT
 *
 * The first design put this in `.workflow/knowledge.db`, and the question that
 * killed it was "how does that sync when we are on different machines?" —
 * SQLite has no answer: committed, it is a binary blob git cannot merge; not
 * committed, it is not shared, which is the problem V1.1 exists to solve.
 * Files in the repo pick the storage that matches the constraints already
 * enforced here — agents can write files and cannot run git — and they make
 * review a pull request instead of a UI somebody has to build.
 *
 * ONE FILE PER ITEM
 *
 * `knowledge/<module>/<kind>/<ID>.yaml`. A conflict then happens only when two
 * people really did edit the same item: BA adding REQ-012 while DEV edits
 * BE-014 touches two files and merges clean. `decisions/*.md` already works
 * this way, and the by-product is free per-item history (`git log` on the
 * file). One file per *kind* would put every edit in the repo through the same
 * few files, which is the opposite trade.
 *
 * NO INDEX, NO CACHE
 *
 * Files are read into memory and queried there (knowledgeBase.ts). `taskStore.ts`
 * already stated the reason this repo does not keep derived copies: a stored
 * derivation is a second source of truth waiting to disagree with the first —
 * and an index derived from files git just merged is exactly a cache nobody
 * knows is stale. If measurement ever shows this is slow (T116 is the task
 * that measures), an index that rebuilds from the files is still available.
 */

export const KNOWLEDGE_DIRNAME = "knowledge";

/**
 * Folder for items with `module: null` — ADRs, project-wide domain terms. A
 * literal name rather than dumping them at `knowledge/<kind>/`, so that every
 * item sits at the same depth and one walk finds all of them.
 */
export const PROJECT_WIDE_DIR = "_project";

/**
 * Top-level directories under `knowledge/` that hold something other than
 * items, and so are skipped by the item walk. Reserved rather than discovered:
 * a module folder and a bookkeeping folder look identical from the outside,
 * and guessing wrong means either losing a module's items or reporting the
 * registry as forty malformed items.
 *
 * `_adoption` stays on the list after T-V5-041 removed the subsystem that wrote
 * it: any workspace that ran the import still has the directory on disk, and
 * dropping it here would make the item walk read those bookkeeping files as a
 * module's items.
 */
export const RESERVED_DIRS = ["_sources", "_conflicts", "_bootstrap", "_human-input", "_adoption", "_roles"] as const;

export function knowledgeDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, KNOWLEDGE_DIRNAME);
}

/** The one place an item may live, derived from the item itself — so the path is never a second opinion about what the file holds. */
export function relativePathFor(item: Pick<KnowledgeItem, "id" | "kind" | "module">): string {
  return `${item.module ?? PROJECT_WIDE_DIR}/${item.kind}/${item.id}.yaml`;
}

export function pathFor(
  item: Pick<KnowledgeItem, "id" | "kind" | "module">,
  projectRoot: string = defaultProjectRoot(),
): string {
  return path.join(knowledgeDir(projectRoot), ...relativePathFor(item).split("/"));
}

/** Every `*.yaml` under `knowledge/`, as forward-slashed paths relative to it, sorted. */
export function listKnowledgeFiles(projectRoot: string = defaultProjectRoot()): string[] {
  const root = knowledgeDir(projectRoot);
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (prefix === "" && (RESERVED_DIRS as readonly string[]).includes(entry.name)) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) found.push(rel);
    }
  };

  walk(root, "");
  return found.sort();
}

/**
 * A conflict marker left in a file is caught by name rather than as a YAML
 * parse error, because "unexpected token at line 14" sends the reader looking
 * for a typo when the actual instruction is "finish the merge".
 */
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

/** Reads one item, or throws. A half-understood item is worse than none: everything downstream treats these as facts. */
export function readKnowledgeFile(filePath: string, label = filePath): KnowledgeItem {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new KnowledgeItemError(label, [`no file at ${filePath}`]);
  }

  if (CONFLICT_MARKER.test(raw)) {
    throw new KnowledgeItemError(label, [
      "contains an unresolved git conflict marker — two edits to this item have not been merged yet",
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new KnowledgeItemError(label, [`is not valid YAML: ${(e as Error).message}`]);
  }

  return validateKnowledgeItem(parsed, label);
}

export interface KnowledgeLoadResult {
  items: KnowledgeItem[];
  /** One entry per unusable file. Collected, never thrown: one bad file must not hide the other forty. */
  problems: string[];
  /** True when `knowledge/` does not exist at all — a normal state before anything has been captured. */
  missing: boolean;
}

/**
 * Loads every item under `knowledge/`. Also enforces that a file sits at the
 * path its own contents imply, the same "the filename is the identity" rule
 * `decisionLog.ts` applies to ADRs — a REQ-003 hiding in another module's
 * folder is findable by a walk and by nothing else.
 */
export function loadKnowledge(projectRoot: string = defaultProjectRoot()): KnowledgeLoadResult {
  const root = knowledgeDir(projectRoot);
  if (!fs.existsSync(root)) return { items: [], problems: [], missing: true };

  const items: KnowledgeItem[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();

  for (const rel of listKnowledgeFiles(projectRoot)) {
    let item: KnowledgeItem;
    try {
      item = readKnowledgeFile(path.join(root, ...rel.split("/")), rel);
    } catch (e) {
      problems.push(e instanceof KnowledgeItemError ? e.message : `${rel}: ${String(e)}`);
      continue;
    }

    const expected = relativePathFor(item);
    if (expected !== rel) {
      problems.push(`${rel}: declares id "${item.id}" (kind ${item.kind}, module ${item.module ?? "-"}), so it belongs at ${expected}`);
      continue;
    }

    // v2 identity is module/id. The same bare ID in two delivery modules is
    // valid and must remain discoverable as an ambiguous bare lookup.
    const key = `${item.module ?? PROJECT_WIDE_DIR}/${item.id}`;
    const previous = seen.get(key);
    if (previous) {
      problems.push(`${rel}: qualified id "${key}" is already declared by ${previous}`);
      continue;
    }
    seen.set(key, rel);
    items.push(item);
  }

  return { items, problems, missing: false };
}

export class KnowledgeVersionConflictError extends Error {
  constructor(
    public readonly id: string,
    public readonly onDisk: number,
    public readonly incoming: number,
  ) {
    super(
      `${id}: the copy on disk is version ${onDisk} and this edit says version ${incoming} — ` +
        "a changed item must be exactly one version ahead of what it replaces. Re-read the file, " +
        "re-apply the edit on top of it, then bump.",
    );
    this.name = "KnowledgeVersionConflictError";
  }
}

/**
 * Key-order-independent serialisation. An item read back from YAML carries the
 * file's key order, an item built in memory carries the constructor's, and a
 * plain JSON.stringify would call those two different content — which would
 * turn every rewrite into a false conflict.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Everything except the fields that legitimately differ between an item and its own rewrite:
 * `version`/`updated_at` move on every accepted write, and `sources[].captured_at` moves on every
 * re-derivation — each run stamps the moment it read the source file, while `sources[].digest` is
 * the part that detects a changed document. Comparing captured_at made every re-run see
 * "different" against what the previous run had just written, so an approved item came back as a
 * conflict forever and `unchanged` could never happen across runs.
 */
function contentOf(item: KnowledgeItem): string {
  const { version: _version, updated_at: _updatedAt, ...rest } = item;
  if (Array.isArray(rest.sources)) {
    // Blank the capture stamp rather than deleting it: SourceRef requires the
    // field, and an equal constant compares equal across every run.
    rest.sources = rest.sources.map((s) => ("captured_at" in s ? { ...s, captured_at: "" } : s));
  }
  return stableStringify(rest);
}

/**
 * Whether two items say the same thing, ignoring `version`/`updated_at` — the
 * same comparison `writeKnowledgeItem` makes to decide whether a version bump is
 * required. Exported because a caller that re-derives an item from its source
 * (discovery, T74-T79) has to ask "did anything actually move" *before* writing,
 * and it must ask with this function rather than its own: a second definition of
 * "same content" would disagree with the one the write path enforces, and then
 * every re-run would either bump for nothing or fail the version check.
 */
export function sameKnowledgeContent(a: KnowledgeItem, b: KnowledgeItem): boolean {
  return contentOf(a) === contentOf(b);
}

function orderedForYaml(item: KnowledgeItem): Record<string, unknown> {
  // Written in the order a person reads it: identity, then state, then
  // provenance, then the kind-specific half, then the prose last because it is
  // the only part that runs to many lines.
  return {
    schema_version: item.schema_version,
    id: item.id,
    kind: item.kind,
    title: item.title,
    version: item.version,
    status: item.status,
    owner: item.owner,
    module: item.module,
    repo: item.repo,
    target_ids: item.target_ids,
    sensitive: item.sensitive,
    created_at: item.created_at,
    updated_at: item.updated_at,
    sources: item.sources,
    relations: item.relations,
    payload: item.payload,
    body: item.body,
  };
}

export function renderKnowledgeItem(item: KnowledgeItem): string {
  return stringifyYaml(orderedForYaml(item), { lineWidth: 0 });
}

export interface WriteOptions {
  /**
   * Skip the version check. For seeding a fresh `knowledge/` from artifacts,
   * where there is nothing on disk to be a version behind. Never for an edit —
   * the check is the only thing standing between two concurrent edits and one
   * of them disappearing.
   */
  force?: boolean;
}

/**
 * Writes one item to the one path it belongs at, refusing an edit that is not
 * exactly one version ahead of what is already there.
 *
 * The version is not bookkeeping: when two people edit the same item they both
 * bump the same line, so git reports a conflict on `version` itself rather than
 * merging two different edits into a plausible-looking third. This check is the
 * local half of that — it catches the same mistake before it reaches git.
 */
export function writeKnowledgeItem(
  item: KnowledgeItem,
  projectRoot: string = defaultProjectRoot(),
  options: WriteOptions = {},
): string {
  const problems = checkKnowledgeItem(item);
  if (problems.length > 0) throw new KnowledgeItemError(item.id, problems);

  const filePath = pathFor(item, projectRoot);

  if (!options.force && fs.existsSync(filePath)) {
    const existing = readKnowledgeFile(filePath, relativePathFor(item));
    const changed = contentOf(existing) !== contentOf(item);
    if (changed && item.version !== existing.version + 1) {
      throw new KnowledgeVersionConflictError(item.id, existing.version, item.version);
    }
    if (!changed && item.version !== existing.version) {
      throw new KnowledgeVersionConflictError(item.id, existing.version, item.version);
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Temp file + rename: a reader never sees a half-written item, and a crash
  // mid-write leaves the previous version intact rather than a truncated one.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderKnowledgeItem(item), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}
