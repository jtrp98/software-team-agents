import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentStage } from "../types.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { KnowledgeItem, SourceType } from "./knowledgeModel.js";
import { knowledgeDir } from "./knowledgeStore.js";
import { digestOfSource, parseLocator } from "./sourceDigest.js";
import { resolveSource } from "./sourceResolver.js";

/**
 * The raw-source registry — `knowledge/_sources/<SRC-id>.yaml`.
 *
 * WHY A SOURCE IS ITS OWN RECORD AND NOT JUST A FIELD ON AN ITEM
 *
 * A knowledge item already carries `sources[]`, and that answers "where did
 * this conclusion come from". It cannot answer the other half:
 *
 *   - what raw material has this project ingested at all?
 *   - which of it produced nothing yet? (the normal state mid-discovery — and
 *     invisible if the only record of a source is the item that cited it)
 *   - one file backs eleven items; has it changed since any of them were written?
 *
 * So the registry stores the material, the item stores the conclusion, and
 * `sources[].source_id` joins them: raw material and derived knowledge are
 * different things with different lifetimes, and a system that only records
 * the second cannot tell you the first went stale.
 *
 * Reserved directory, not a module: `_sources` is skipped by the item walk
 * (knowledgeStore.ts's RESERVED_DIRS), because a folder of source records and a
 * folder of items are indistinguishable from the outside and guessing wrong
 * reports the registry as a pile of malformed items.
 */

export const SOURCES_DIRNAME = "_sources";

export interface SourceRecord {
  schema_version: number;
  id: string;
  type: SourceType;
  locator: string;
  captured_at: string;
  captured_by: AgentStage;
  digest: string | null;
  origin?: { root: "knowledge" | "target" | "external"; target_id: string | null };
  note?: string;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "knowledge-source.schema.json",
);

export function sourcesDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(knowledgeDir(projectRoot), SOURCES_DIRNAME);
}

export function sourcePath(id: string, projectRoot: string = defaultProjectRoot()): string {
  return path.join(sourcesDir(projectRoot), `${id}.yaml`);
}

export class SourceRecordError extends Error {
  constructor(
    public readonly label: string,
    public readonly issues: string[],
  ) {
    super(`${label} is not a usable source record:\n- ${issues.join("\n- ")}`);
    this.name = "SourceRecordError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

export function checkSourceRecord(data: unknown): string[] {
  const validate = validator();
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => {
    const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
    return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
  });
}

/**
 * A stable id for a locator, so two runs that ingest the same file agree on
 * which record it is without a lookup table. `_docs/module/sales-crm/design.md`
 * becomes `SRC-_docs-module-sales-crm-design.md` — long, but readable in a
 * directory listing, which a hash would not be.
 */
export function sourceIdFor(locator: string): string {
  const slug = locator
    .replace(/#.*$/, "") // a line range identifies a slice, not a different source
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `SRC-${slug === "" ? "unknown" : slug}`;
}

/** The locator half of an item's source ref, with any `#L10-L24` slice removed — what a registry record is keyed on. */
export function baseLocator(locator: string): string {
  return locator.replace(/#.*$/, "");
}

export function readSourceFile(filePath: string, label = filePath): SourceRecord {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new SourceRecordError(label, [`no file at ${filePath}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new SourceRecordError(label, [`is not valid YAML: ${(e as Error).message}`]);
  }

  const problems = checkSourceRecord(parsed);
  if (problems.length > 0) throw new SourceRecordError(label, problems);
  return parsed as SourceRecord;
}

export interface SourceRegistryLoadResult {
  records: SourceRecord[];
  problems: string[];
  missing: boolean;
}

export function loadSourceRegistry(projectRoot: string = defaultProjectRoot()): SourceRegistryLoadResult {
  const dir = sourcesDir(projectRoot);
  if (!fs.existsSync(dir)) return { records: [], problems: [], missing: true };

  const records: SourceRecord[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const label = `${SOURCES_DIRNAME}/${name}`;
    let record: SourceRecord;
    try {
      record = readSourceFile(path.join(dir, name), label);
    } catch (e) {
      problems.push(e instanceof SourceRecordError ? e.message : `${label}: ${String(e)}`);
      continue;
    }

    if (`${record.id}.yaml` !== name) {
      problems.push(`${label}: declares id "${record.id}", so it belongs at ${SOURCES_DIRNAME}/${record.id}.yaml`);
      continue;
    }
    const previous = seen.get(record.id);
    if (previous) {
      problems.push(`${label}: id "${record.id}" is already declared by ${previous}`);
      continue;
    }
    seen.set(record.id, label);
    records.push(record);
  }

  return { records, problems, missing: false };
}

export function renderSourceRecord(record: SourceRecord): string {
  const ordered: Record<string, unknown> = {
    schema_version: record.schema_version,
    id: record.id,
    type: record.type,
    locator: record.locator,
    captured_at: record.captured_at,
    captured_by: record.captured_by,
    digest: record.digest,
    origin: record.origin,
  };
  if (record.note !== undefined) ordered.note = record.note;
  return stringifyYaml(ordered, { lineWidth: 0 });
}

export function writeSourceRecord(record: SourceRecord, projectRoot: string = defaultProjectRoot()): string {
  const problems = checkSourceRecord(record);
  if (problems.length > 0) throw new SourceRecordError(record.id, problems);

  const filePath = sourcePath(record.id, projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, renderSourceRecord(record), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Registry indexed both ways, because both questions get asked: "what is
 * SRC-x" and "is the file I just read already registered".
 */
export class SourceRegistry {
  private readonly byId = new Map<string, SourceRecord>();
  private readonly byLocator = new Map<string, SourceRecord>();

  constructor(readonly records: SourceRecord[] = []) {
    for (const record of records) {
      this.byId.set(record.id, record);
      this.byLocator.set(baseLocator(record.locator), record);
    }
  }

  static load(projectRoot: string = defaultProjectRoot()): SourceRegistry {
    return new SourceRegistry(loadSourceRegistry(projectRoot).records);
  }

  get(id: string): SourceRecord | null {
    return this.byId.get(id) ?? null;
  }

  /** Ignores any `#L10-L24` slice: two items citing different lines of one file cite one source. */
  forLocator(locator: string): SourceRecord | null {
    return this.byLocator.get(baseLocator(locator)) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}

export interface RegistryCrossCheck {
  problems: string[];
  /**
   * Registered material whose digest no longer matches what is on disk.
   * Freshness checks the digest each *item* recorded; this checks the one the
   * *source* recorded, which is what tells you a file eleven items rest on has
   * moved without having to ask all eleven.
   *
   * Reported as a note rather than an error: files change, that is what files
   * do. What matters is that somebody can see which ones.
   */
  staleSources: string[];
  /**
   * Registered material nothing has been derived from yet. Not a problem —
   * during discovery this is the queue, and calling it an error would make the
   * check red exactly when it is working. Reported so it can be worked through.
   */
  underived: SourceRecord[];
  /**
   * Item source refs that name a locator no record covers. Also not a problem:
   * a source can be cited without being registered. Reported because a project
   * that means to track provenance wants the list.
   */
  unregisteredLocators: string[];
}

/**
 * The half of the check that needs both files: items point at sources, sources
 * do not point back. A `source_id` that resolves to nothing is a real error —
 * it is a claim of provenance that cannot be followed.
 *
 * `projectRoot` is optional: without it the material itself is not re-read, and
 * `staleSources` comes back empty because nothing was checked — the same
 * arrangement `freshnessOf()` uses, and for the same reason. Silently reporting
 * every source as current when none were examined would be worse than saying
 * nothing.
 */
export function crossCheckRegistry(
  items: KnowledgeItem[],
  registry: SourceRegistry,
  projectRoot?: string,
  targetPaths: ReadonlyMap<string, string> = new Map(),
): RegistryCrossCheck {
  const problems: string[] = [];
  const referenced = new Set<string>();
  const unregistered = new Set<string>();

  for (const item of items) {
    for (const ref of item.sources) {
      if (ref.source_id) {
        const record = registry.get(ref.source_id);
        if (!record) {
          problems.push(`${item.id}: cites source "${ref.source_id}", which is not in ${SOURCES_DIRNAME}/`);
          continue;
        }
        referenced.add(record.id);
        if (baseLocator(ref.locator) !== baseLocator(record.locator)) {
          problems.push(
            `${item.id}: cites ${record.id} but names locator "${ref.locator}", while the record says "${record.locator}" — ` +
              "one of the two is pointing at the wrong material",
          );
        }
        if (item.schema_version >= 2 && (!record.origin || !ref.origin)) {
          problems.push(`${item.id}: v2 source ${record.id} requires origin on both item and source registry records`);
        } else if (item.schema_version >= 2 && record.origin && ref.origin &&
          (record.origin.root !== ref.origin.root || record.origin.target_id !== ref.origin.target_id)) {
          problems.push(`${item.id}: source ${record.id} origin does not match its source reference`);
        }
        continue;
      }
      const byLocator = registry.forLocator(ref.locator);
      if (byLocator) referenced.add(byLocator.id);
      else unregistered.add(baseLocator(ref.locator));
    }
  }

  const staleSources: string[] = [];
  if (projectRoot !== undefined) {
    for (const record of registry.records) {
      if (record.digest === null) continue; // a person, a conversation, a directory: nothing to hash
      if (record.origin) {
        const resolved = resolveSource(record, projectRoot, targetPaths);
        if (resolved.state === "external" || resolved.state === "unavailable") continue;
        // Same fragment rule as freshnessOf: resolved.path drops any #L window
        // the locator named, so re-attach it before hashing.
        const { from, to } = parseLocator(record.locator);
        const window = from === undefined ? "" : to === undefined || to === from ? `#L${from}` : `#L${from}-L${to}`;
        if (resolved.state !== "resolved" || digestOfSource(`${resolved.path}${window}`, ".") !== record.digest) staleSources.push(record.id);
      } else if (digestOfSource(record.locator, projectRoot) !== record.digest) staleSources.push(record.id);
    }
  }

  return {
    problems,
    staleSources: staleSources.sort(),
    underived: registry.records.filter((r) => !referenced.has(r.id)),
    unregisteredLocators: [...unregistered].sort(),
  };
}
