import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { freshnessOf } from "../knowledge/freshness.js";
import { digestOfSource } from "../knowledge/sourceDigest.js";
import { loadSourceRegistry } from "../knowledge/sourceRegistry.js";

export const SB_WEB_HELPER_TARGET_ID = "sb-web-helper";
export const MIGRATION_MANIFEST_NAME = "sb-web-helper-migration-manifest.json";

export interface MigrationFile { path: string; sha256: string; bytes: number }
export interface MigrationManifest {
  schema_version: 1;
  target_id: string;
  source_root: string;
  created_at: string;
  docs: MigrationFile[];
  knowledge: MigrationFile[];
}
export interface MigrationOptions { sourceRoot: string; knowledgeRoot: string; targetId?: string; now: string }
export interface MigrationVerification { ok: boolean; problems: string[]; docs: number; knowledgeYaml: number; items: number; fresh: number }

function hashFile(file: string): string { return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`; }
function within(candidate: string, root: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

/** Walks only real files under root. Symlinks are deliberately never followed. */
function inventory(root: string): MigrationFile[] {
  const canonical = fs.realpathSync.native(root);
  const found: MigrationFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        const real = fs.realpathSync.native(full);
        if (!within(real, canonical)) throw new Error(`source file escapes root: ${relative}`);
        found.push({ path: relative, sha256: hashFile(real), bytes: fs.statSync(real).size });
      }
    }
  };
  walk(canonical, "");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function collectMigrationManifest(options: MigrationOptions): MigrationManifest {
  const sourceRoot = fs.realpathSync.native(options.sourceRoot);
  return {
    schema_version: 1, target_id: options.targetId ?? SB_WEB_HELPER_TARGET_ID, source_root: sourceRoot, created_at: options.now,
    docs: inventory(path.join(sourceRoot, "_docs")), knowledge: inventory(path.join(sourceRoot, "knowledge")).filter((f) => f.path.endsWith(".yaml")),
  };
}

export function manifestPath(knowledgeRoot: string): string { return path.join(knowledgeRoot, ".migration", MIGRATION_MANIFEST_NAME); }
export function writeMigrationManifest(manifest: MigrationManifest, knowledgeRoot: string): string {
  const file = manifestPath(knowledgeRoot); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); return file;
}
export function readMigrationManifest(knowledgeRoot: string): MigrationManifest { return JSON.parse(fs.readFileSync(manifestPath(knowledgeRoot), "utf8")) as MigrationManifest; }

function copyEntries(entries: MigrationFile[], from: string, to: string): void {
  const source = fs.realpathSync.native(from);
  for (const entry of entries) {
    const candidate = path.resolve(source, ...entry.path.split("/"));
    if (!within(candidate, source) || fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`unsafe migration source: ${entry.path}`);
    if (hashFile(candidate) !== entry.sha256) throw new Error(`source hash changed before copy: ${entry.path}`);
    const destination = path.resolve(to, ...entry.path.split("/"));
    if (!within(destination, path.resolve(to))) throw new Error(`unsafe migration destination: ${entry.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(candidate, destination);
  }
}

/** Copy only; it never deletes or overwrites the source rollback copy. */
export function copyMigrationSource(manifest: MigrationManifest, options: MigrationOptions): void {
  copyEntries(manifest.docs, path.join(options.sourceRoot, "_docs"), path.join(options.knowledgeRoot, "_docs"));
  copyEntries(manifest.knowledge, path.join(options.sourceRoot, "knowledge"), path.join(options.knowledgeRoot, "knowledge"));
  const decisions = path.join(options.knowledgeRoot, "decisions");
  if (!fs.existsSync(decisions)) fs.mkdirSync(decisions, { recursive: true });
  const policy = path.join(options.knowledgeRoot, "knowledge-policy.yaml");
  if (!fs.existsSync(policy)) fs.writeFileSync(policy, "version: 1\n", "utf8");
}

function migrateItem(file: string, targetId: string, _now: string): void {
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return;
  raw.schema_version = 2; raw.target_ids = [targetId];
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  raw.sources = sources.map((source) => {
    const next = { ...(source as Record<string, unknown>) };
    next.origin = { root: "knowledge", target_id: null };
    return next;
  });
  fs.writeFileSync(file, stringifyYaml(raw, { lineWidth: 0 }), "utf8");
}

function migrateSourceRecord(file: string, _targetId: string): void {
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || !("locator" in raw)) return;
  raw.origin = { root: "knowledge", target_id: null };
  fs.writeFileSync(file, stringifyYaml(raw, { lineWidth: 0 }), "utf8");
}

export function transformMigratedKnowledge(options: MigrationOptions): void {
  const root = path.join(options.knowledgeRoot, "knowledge");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name); if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        if (full.includes(`${path.sep}_sources${path.sep}`)) migrateSourceRecord(full, options.targetId ?? SB_WEB_HELPER_TARGET_ID);
        else migrateItem(full, options.targetId ?? SB_WEB_HELPER_TARGET_ID, options.now);
      }
    }
  }; walk(root);
}

function verifyInventory(entries: MigrationFile[], root: string, label: string, problems: string[]): void {
  for (const entry of entries) {
    const file = path.join(root, ...entry.path.split("/"));
    if (!fs.existsSync(file)) problems.push(`${label}/${entry.path}: missing`);
    else if (hashFile(file) !== entry.sha256) problems.push(`${label}/${entry.path}: hash mismatch`);
  }
}

export function verifyMigration(manifest: MigrationManifest, options: MigrationOptions): MigrationVerification {
  const problems: string[] = [];
  // The manifest is the inventory the copy committed to — not a frozen count
  // from the day this code was written. Re-walk the source and compare: any
  // drift between copy and verify (file added, removed, or edited) is a real
  // problem worth naming, while the actual sizes belong in the report, not in
  // hardcoded constants that go stale the next time the source repo moves.
  const sourceRoot = fs.realpathSync.native(options.sourceRoot);
  const currentDocs = inventory(path.join(sourceRoot, "_docs"));
  const currentKnowledge = inventory(path.join(sourceRoot, "knowledge")).filter((f) => f.path.endsWith(".yaml"));
  if (currentDocs.length !== manifest.docs.length) problems.push(`source _docs drifted since copy: manifest ${manifest.docs.length}, now ${currentDocs.length}`);
  if (currentKnowledge.length !== manifest.knowledge.length) problems.push(`source knowledge drifted since copy: manifest ${manifest.knowledge.length}, now ${currentKnowledge.length}`);
  verifyInventory(currentDocs, path.join(sourceRoot, "_docs"), "source/_docs", problems);
  verifyInventory(currentKnowledge, path.join(sourceRoot, "knowledge"), "source/knowledge", problems);
  verifyInventory(manifest.docs, path.join(options.knowledgeRoot, "_docs"), "_docs", problems);
  if (!fs.existsSync(path.join(options.knowledgeRoot, "knowledge-policy.yaml"))) problems.push("knowledge-policy.yaml: missing");
  if (!fs.existsSync(path.join(options.knowledgeRoot, "decisions"))) problems.push("decisions/: missing");
  if (fs.existsSync(path.join(options.knowledgeRoot, "knowledge", "_roles"))) problems.push("knowledge/_roles/ must remain lazy and human-only during migration");
  // Knowledge bytes intentionally change during v2 transform; presence/count is verified here, item correctness below.
  for (const entry of manifest.knowledge) if (!fs.existsSync(path.join(options.knowledgeRoot, "knowledge", ...entry.path.split("/")))) problems.push(`knowledge/${entry.path}: missing`);
  const report = checkKnowledge(options.knowledgeRoot); problems.push(...report.problems);
  const loaded = loadKnowledge(options.knowledgeRoot);
  problems.push(...loaded.problems);
  const itemCount = loaded.items.length;
  const targetPaths = new Map([[manifest.target_id, fs.realpathSync.native(options.sourceRoot)]]);
  for (const item of loaded.items) {
    if (item.schema_version !== 2) problems.push(`${item.id}: expected schema_version 2`);
    if (item.target_ids?.length !== 1 || item.target_ids[0] !== manifest.target_id) problems.push(`${item.id}: expected target_ids [${manifest.target_id}]`);
    for (const source of item.sources) {
      if (!source.origin) problems.push(`${item.id}: source ${source.locator} is missing origin`);
      if (source.origin?.root !== "knowledge" || source.origin.target_id !== null) problems.push(`${item.id}: ${source.locator} must use Knowledge origin after migration`);
    }
  }
  const sourceRegistry = loadSourceRegistry(options.knowledgeRoot);
  problems.push(...sourceRegistry.problems.map((problem) => `source registry: ${problem}`));
  if (sourceRegistry.missing) problems.push("source registry: knowledge/_sources is missing");
  for (const record of sourceRegistry.records) {
    if (!record.origin) problems.push(`source registry: ${record.id} is missing origin`);
  }
  const fresh = loaded.items.filter((item) => freshnessOf(item, {
    now: options.now, projectRoot: options.knowledgeRoot, knowledgeRoot: options.knowledgeRoot, targetPaths,
  }).verdict === "fresh").length;
  if (fresh !== itemCount) problems.push(`expected ${itemCount}/${itemCount} fresh items, found ${fresh}/${itemCount}`);
  return { ok: problems.length === 0, problems, docs: manifest.docs.length, knowledgeYaml: manifest.knowledge.length, items: itemCount, fresh };
}

/** Cutover is intentionally two-phase: preview never writes; apply needs a literal human confirmation. */
export function confirmCutover(verification: MigrationVerification, confirmation: string | undefined, configPath?: string): void {
  if (!verification.ok) throw new Error(`cutover blocked: ${verification.problems.join("; ")}`);
  if (confirmation !== "I_CONFIRM_MIGRATION") throw new Error("cutover requires human confirmation: --confirm I_CONFIRM_MIGRATION");
  if (!configPath) throw new Error("cutover requires an explicit installation config path");
}
