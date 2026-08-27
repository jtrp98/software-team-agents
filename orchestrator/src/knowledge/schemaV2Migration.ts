import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateKnowledgeItem, type KnowledgeItem } from "./knowledgeModel.js";
import { knowledgeDir, listKnowledgeFiles } from "./knowledgeStore.js";
import { loadTargetRegistry } from "../threeRepo/targets.js";

export interface SchemaV2MigrationOptions {
  knowledgeRoot: string;
  dryRun: boolean;
  now: string;
  /** Explicit module association supplied by an embedding caller. */
  moduleTargets?: Readonly<Record<string, readonly string[]>>;
}

export interface SchemaV2ItemChange {
  path: string;
  id: string;
  changes: readonly ("schema_version" | "origin" | "target_ids")[];
  target_ids: string[];
}

export interface SchemaV2MigrationReport {
  dry_run: boolean;
  scanned: number;
  changed: number;
  items: SchemaV2ItemChange[];
  backup_manifest: string | null;
  first_freshness_sweep: "baseline-not-a-finding";
  note: string;
}

interface BackupEntry { path: string; sha256: string; bytes: number; before_base64: string }
interface BackupManifest {
  schema_version: 1;
  migration: "knowledge-schema-v2";
  created_at: string;
  entries: BackupEntry[];
  first_freshness_sweep: "baseline-not-a-finding";
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function knownTargetIds(root: string): Set<string> {
  try { return new Set(loadTargetRegistry(root).targets.map((target) => target.target_id)); }
  catch { return new Set(); }
}

function targetIdsFor(item: KnowledgeItem, known: ReadonlySet<string>, associations: SchemaV2MigrationOptions["moduleTargets"]): string[] {
  const found = new Set<string>(item.target_ids ?? []);
  for (const source of item.sources) if (source.origin?.root === "target" && source.origin.target_id) found.add(source.origin.target_id);
  if (item.kind === "task" && item.payload.target_id) found.add(item.payload.target_id);
  if (item.repo && known.has(item.repo)) found.add(item.repo);
  if (item.module) for (const targetId of associations?.[item.module] ?? []) found.add(targetId);
  return [...found].filter((id) => known.size === 0 || known.has(id)).sort();
}

function migrateOne(item: KnowledgeItem, targetIds: string[]): { next: KnowledgeItem; changes: SchemaV2ItemChange["changes"] } {
  const changes: Array<"schema_version" | "origin" | "target_ids"> = [];
  if (item.schema_version !== 2) changes.push("schema_version");
  if (item.target_ids === undefined || JSON.stringify(item.target_ids) !== JSON.stringify(targetIds)) changes.push("target_ids");
  if (item.sources.some((source) => source.origin === undefined)) changes.push("origin");
  const next = {
    ...item,
    schema_version: 2,
    target_ids: targetIds,
    sources: item.sources.map((source) => source.origin ? source : { ...source, origin: { root: "knowledge" as const, target_id: null } }),
  } as KnowledgeItem;
  return { next, changes };
}

function protectedFields(item: KnowledgeItem): string {
  return JSON.stringify({ body: item.body, payload: item.payload, status: item.status, owner: item.owner, version: item.version });
}

/** Opt-in, idempotent schema migration. Classification data is added; item meaning and lifecycle never move. */
export function migrateKnowledgeSchemaV2(options: SchemaV2MigrationOptions): SchemaV2MigrationReport {
  const root = knowledgeDir(options.knowledgeRoot);
  const known = knownTargetIds(options.knowledgeRoot);
  const pending: Array<{ change: SchemaV2ItemChange; next: KnowledgeItem; abs: string; before: Buffer }> = [];
  const files = listKnowledgeFiles(options.knowledgeRoot);
  for (const rel of files) {
    const abs = path.join(root, ...rel.split("/"));
    const before = fs.readFileSync(abs);
    const item = validateKnowledgeItem(parseYaml(before.toString("utf8")), rel);
    const { next, changes } = migrateOne(item, targetIdsFor(item, known, options.moduleTargets));
    if (changes.length === 0) continue;
    if (protectedFields(next) !== protectedFields(item)) throw new Error(`${rel}: migration changed a protected item field`);
    validateKnowledgeItem(next, rel);
    pending.push({ change: { path: rel, id: item.id, changes, target_ids: next.target_ids ?? [] }, next, abs, before });
  }

  let backupManifest: string | null = null;
  if (!options.dryRun && pending.length > 0) {
    const stamp = options.now.replace(/[:.]/g, "-");
    const backupDir = path.join(options.knowledgeRoot, ".migration", "knowledge-schema-v2", stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    const manifest: BackupManifest = {
      schema_version: 1,
      migration: "knowledge-schema-v2",
      created_at: options.now,
      entries: pending.map(({ change, before }) => ({ path: change.path, sha256: sha256(before), bytes: before.length, before_base64: before.toString("base64") })),
      first_freshness_sweep: "baseline-not-a-finding",
    };
    backupManifest = path.join(backupDir, "manifest.json");
    fs.writeFileSync(backupManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const entry of pending) {
      const tmp = `${entry.abs}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, stringifyYaml(entry.next, { lineWidth: 0 }), "utf8");
      fs.renameSync(tmp, entry.abs);
    }
  }

  return {
    dry_run: options.dryRun,
    scanned: files.length,
    changed: pending.length,
    items: pending.map((entry) => entry.change),
    backup_manifest: backupManifest,
    first_freshness_sweep: "baseline-not-a-finding",
    note: "The first post-migration freshness sweep is a baseline, not a finding; review later deltas against it.",
  };
}
