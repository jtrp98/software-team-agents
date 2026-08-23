import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest, sha256Of, type TemplateFileEntry, type TemplateManifest } from "../packaging/templateManifest.js";
import { renderCodexBinding } from "../runtime/bindingGenerator.js";
import { parseVersion } from "./version.js";
import {
  assertManageablePath,
  TargetNotInitializedError,
  loadTargetConfig,
  readTargetManifest,
  writeTargetManifest,
  type TargetConfig,
  type TargetManifest,
} from "./targetMeta.js";

/**
 * T-TARGET-04 / T-TARGET-07 / T-TARGET-08 — Framework → Target sync.
 *
 * One direction, always: the Framework (`templates/`, built by build:templates)
 * is canonical; the Target receives. The engine diffs three hashes per managed
 * path — what the Framework ships now, what it shipped when this Target last
 * synced (the manifest's pristine hash), and what is actually on disk:
 *
 *   disk == shipped            already up to date          -> unchanged
 *   disk == pristine           untouched since last sync   -> update (backup first)
 *   otherwise                  someone edited it here      -> CONFLICT, never silent
 *
 * A path the previous manifest tracked that today's payload drops is stale:
 * removed only while still pristine, reported as a conflict once edited, so
 * cleanup can never destroy local work either. Files claimed through the
 * config's override list are skipped outright — ownership moved to the user.
 *
 * `.codex/agents/<role>.toml` renderings are generated from the just-synced
 * `.claude/agents/<role>.md` sources (OFF10 M2: one role definition, two
 * renderings) rather than shipped as payload — generated files are owned by
 * declaring their derivation, and they can never drift from their source.
 */

export type SyncAction = "add" | "update" | "restore" | "remove-stale" | "unchanged" | "override";

export interface SyncPlanEntry {
  action: SyncAction;
  path: string;
  note?: string;
}

export interface SyncConflict {
  path: string;
  /** user-modified: a tracked file was edited locally; untracked-file: the Target already owns this path; stale-modified: a dropped file carries edits. */
  kind: "user-modified" | "untracked-file" | "stale-modified";
  detail: string;
}

export interface SyncPlan {
  entries: SyncPlanEntry[];
  conflicts: SyncConflict[];
  frameworkVersion: string;
}

export interface SyncResult {
  performed: SyncPlanEntry[];
  skippedConflicts: SyncConflict[];
  previousVersion: string | undefined;
  frameworkVersion: string;
  backupDir: string | undefined;
}

function hashFile(abs: string): string {
  return sha256Of(fs.readFileSync(abs));
}

interface PlannedFile {
  entry?: SyncPlanEntry;
  conflict?: SyncConflict;
  /** Template-relative source to copy when applying; undefined = nothing to copy. */
  copyFromTemplates?: boolean;
  remove?: boolean;
}

function planPayloadFiles(
  targetRoot: string,
  templateManifest: TemplateManifest,
  oldFiles: ReadonlyMap<string, TemplateFileEntry>,
  overrides: ReadonlySet<string>,
): PlannedFile[] {
  const planned: PlannedFile[] = [];
  for (const file of templateManifest.files) {
    assertManageablePath(file.path);
    if (overrides.has(file.path)) {
      planned.push({ entry: { action: "override", path: file.path, note: "claimed by the project — sync leaves it alone" } });
      continue;
    }
    const dest = path.join(targetRoot, file.path);
    const tracked = oldFiles.get(file.path);
    if (!fs.existsSync(dest)) {
      planned.push(tracked ? { entry: { action: "restore", path: file.path }, copyFromTemplates: true } : { entry: { action: "add", path: file.path }, copyFromTemplates: true });
      continue;
    }
    const currentHash = hashFile(dest);
    if (currentHash === file.sha256) {
      planned.push({ entry: { action: "unchanged", path: file.path } });
      continue;
    }
    if (!tracked) {
      // Untracked file with different content: the Target owned this path before
      // the Framework ever did (its own CLAUDE.md, its own .claude/settings.json).
      planned.push({ conflict: { path: file.path, kind: "untracked-file", detail: "the project already has its own file at this managed path" } });
      continue;
    }
    if (currentHash === tracked.sha256) {
      planned.push({ entry: { action: "update", path: file.path }, copyFromTemplates: true });
      continue;
    }
    planned.push({ conflict: { path: file.path, kind: "user-modified", detail: "this Framework-managed file was edited locally after sync" } });
  }
  return planned;
}

function planStaleFiles(
  targetRoot: string,
  templateManifest: TemplateManifest,
  oldFiles: ReadonlyMap<string, TemplateFileEntry>,
  overrides: ReadonlySet<string>,
): PlannedFile[] {
  const newPathSet = new Set(templateManifest.files.map((f) => f.path));
  const planned: PlannedFile[] = [];
  for (const [relPath, tracked] of oldFiles) {
    if (newPathSet.has(relPath)) continue;
    if (relPath.startsWith(".codex/")) continue; // derived renderings follow their agent sources automatically
    if (overrides.has(relPath)) {
      planned.push({ entry: { action: "override", path: relPath, note: "dropped by the Framework, kept because the project claimed it" } });
      continue;
    }
    const abs = path.join(targetRoot, relPath);
    if (!fs.existsSync(abs)) continue; // gone already — nothing to clean
    if (hashFile(abs) === tracked.sha256) {
      planned.push({ entry: { action: "remove-stale", path: relPath }, remove: true });
    } else {
      planned.push({ conflict: { path: relPath, kind: "stale-modified", detail: "the Framework no longer manages this file, but the local copy has been edited" } });
    }
  }
  return planned;
}

function overrideSet(config: TargetConfig | undefined): Set<string> {
  return new Set((config?.overrides ?? []).map((rel) => rel.replaceAll("\\", "/")));
}

export class TargetSyncConflictError extends Error {
  constructor(public readonly plan: SyncPlan) {
    super(
      `${plan.conflicts.length} conflicted file(s) — nothing was written. ` +
        "Re-run with --force to keep the Framework version (local copies are backed up first), " +
        "claim the files under .agent-team/config.yaml overrides, or revert the local edits.",
    );
  }
}

/** Cross-major downgrade (or any major jump backwards) without --force. */
export class TargetDowngradeBlockedError extends Error {
  constructor(previousVersion: string, newVersion: string) {
    super(
      `refusing to downgrade this workspace from Framework ${previousVersion} to ${newVersion} — different majors are incompatible by default. ` +
        "Re-run with --force only after reviewing the older version's implications; local copies of overwritten files are backed up.",
    );
  }
}

export interface PlanSyncOptions {
  targetRoot: string;
  templatesDir: string;
  /** Existing manifest; absent = first sync (everything is either new or untracked). */
  manifest?: TargetManifest;
  config?: TargetConfig;
  /** Role asset profile (T-ROLE-09/10/11): only matching payload paths are planned, tracked, and cleaned. Absent = full payload. */
  include?: (relPath: string) => boolean;
}

/** The payload this sync actually manages, after the role profile filter. */
function effectiveTemplateManifest(options: PlanSyncOptions): TemplateManifest {
  const manifest = readTemplateManifest(options.templatesDir);
  if (!options.include) return manifest;
  return { ...manifest, files: manifest.files.filter((f) => options.include!(f.path)) };
}

/** Pure planner: reads both sides, writes nothing. */
export function planSync(options: PlanSyncOptions): SyncPlan {
  const templateManifest = effectiveTemplateManifest(options);
  const oldFiles = new Map((options.manifest?.files ?? []).map((f) => [f.path, f]));
  const overrides = overrideSet(options.config);

  const planned = [
    ...planPayloadFiles(options.targetRoot, templateManifest, oldFiles, overrides),
    ...planStaleFiles(options.targetRoot, templateManifest, oldFiles, overrides),
  ];

  return {
    entries: planned.map((p) => p.entry).filter((e): e is SyncPlanEntry => e !== undefined),
    conflicts: planned.map((p) => p.conflict).filter((c): c is SyncConflict => c !== undefined),
    frameworkVersion: templateManifest.framework_version,
  };
}

export interface ApplySyncOptions extends PlanSyncOptions {
  now: string;
  force?: boolean;
}

/** The Target's own manifest, when one exists. Absent = first sync. */
export function existingTargetManifest(targetRoot: string): TargetManifest | undefined {
  try {
    return readTargetManifest(targetRoot);
  } catch (e) {
    if (e instanceof TargetNotInitializedError) return undefined;
    throw e;
  }
}

/**
 * Plans, then — when there are no conflicts or `--force` accepts them — applies:
 * every overwritten/removed file is copied into `.agent-team/backups/<ts>/`
 * first, and the fresh manifest records the new pristine hashes plus the
 * Framework version, so the next run can again tell an untouched file from an
 * edited one.
 *
 * Manifest and config default to what the Target has on disk, so a caller that
 * just says "sync this directory" still diffs against reality rather than
 * against nothing.
 */
export function runTargetSync(options: ApplySyncOptions): SyncResult {
  const manifest = options.manifest ?? existingTargetManifest(options.targetRoot);
  const config = options.config ?? loadTargetConfig(options.targetRoot);
  const plan = planSync({ ...options, manifest, config });
  const oldFiles = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const templateManifest = effectiveTemplateManifest(options);

  // Stale derived renderings are decided up front (before any write), so a
  // locally-edited one stops the run exactly like any other conflict: the roles
  // that will exist after this sync are known from today's agent payload.
  const survivingRoles = new Set(
    templateManifest.files
      .filter((f) => f.path.startsWith(".claude/agents/") && f.path.endsWith(".md"))
      .map((f) => path.basename(f.path, ".md")),
  );
  for (const [relPath, tracked] of oldFiles) {
    if (!relPath.startsWith(".codex/agents/") || !relPath.endsWith(".toml")) continue;
    const role = path.basename(relPath, ".toml");
    if (survivingRoles.has(role)) continue; // regenerated below from its source
    const abs = path.join(options.targetRoot, relPath);
    if (!fs.existsSync(abs)) continue;
    if (hashFile(abs) === tracked.sha256) {
      plan.entries.push({ action: "remove-stale", path: relPath, note: "generated rendering of a removed agent" });
    } else {
      plan.conflicts.push({
        path: relPath,
        kind: "stale-modified",
        detail: "this generated file's agent source was removed, but the local copy has been edited",
      });
    }
  }
  // Only tracked-but-edited (and stale-modified) files block the run; a
  // pre-existing foreign file never does — it is skipped and reported below.
  const blockingConflicts = plan.conflicts.filter((c) => c.kind !== "untracked-file");
  if (blockingConflicts.length > 0 && !options.force) throw new TargetSyncConflictError(plan);

  // Destructive downgrade guard: moving a workspace backwards across a major
  // boundary changes managed assets in ways older content may not survive —
  // it is allowed, but only ever explicitly.
  const previousVersion = manifest?.framework_version;
  const majorOf = (version: string | undefined): number | undefined => {
    try {
      return parseVersion(version ?? "").major;
    } catch {
      return undefined; // unparseable versions fall through to the ordinary path
    }
  };
  const from = majorOf(previousVersion);
  const to = majorOf(templateManifest.framework_version);
  if (!options.force && from !== undefined && to !== undefined && to < from) {
    throw new TargetDowngradeBlockedError(previousVersion!, templateManifest.framework_version);
  }
  // Two conflict kinds, two behaviours: a locally-modified tracked file is
  // overwritten only when --force accepts it; a pre-existing foreign file is
  // NEVER written — the Target owned that path first, so it is skipped and
  // reported instead, and stays out of the manifest.
  const forcedOver = new Set(
    options.force ? plan.conflicts.filter((c) => c.kind !== "untracked-file").map((c) => c.path) : [],
  );
  const foreign = new Set(plan.conflicts.filter((c) => c.kind === "untracked-file").map((c) => c.path));

  let backupDir: string | undefined;
  const backup = (relPath: string): void => {
    const src = path.join(options.targetRoot, relPath);
    if (!fs.existsSync(src)) return;
    if (!backupDir) {
      backupDir = path.join(options.targetRoot, ".agent-team", "backups", options.now.replace(/[:.]/g, "-"));
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const dest = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  const performed: SyncPlanEntry[] = [];
  const managedEntries: TemplateFileEntry[] = [];

  for (const file of templateManifest.files) {
    if (foreign.has(file.path)) {
      performed.push({ action: "override", path: file.path, note: "the project already owns this path — sync left it alone" });
      continue; // never claimed, never written
    }
    if (forcedOver.has(file.path)) {
      // Forced over a conflict: same mechanics as an update, including the backup.
      backup(file.path);
      const dest = path.join(options.targetRoot, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(options.templatesDir, file.path), dest);
      performed.push({ action: "update", path: file.path, note: "forced over local modifications (backed up)" });
      managedEntries.push(file);
      continue;
    }
    const plannedFor = plan.entries.find((e) => e.path === file.path);
    if (!plannedFor) continue;
    if (plannedFor.action === "add" || plannedFor.action === "restore") {
      const dest = path.join(options.targetRoot, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(options.templatesDir, file.path), dest);
      performed.push(plannedFor);
    } else if (plannedFor.action === "update") {
      backup(file.path);
      fs.copyFileSync(path.join(options.templatesDir, file.path), path.join(options.targetRoot, file.path));
      performed.push(plannedFor);
    } else {
      performed.push(plannedFor); // unchanged / override — reported, not written
    }
    managedEntries.push(file);
  }

  // Derived renderings: regenerate from the just-synced agent sources. They carry
  // no independent authorship, so they never conflict with the Framework — but a
  // foreign pre-existing file at the destination stays untouched and unclaimed.
  const regeneratedCodex = new Set<string>();
  for (const agentFile of templateManifest.files.filter((f) => f.path.startsWith(".claude/agents/") && f.path.endsWith(".md"))) {
    const role = path.basename(agentFile.path, ".md");
    const sourceAbs = path.join(options.targetRoot, ".claude", "agents", `${role}.md`);
    if (!fs.existsSync(sourceAbs)) continue;
    const rendered = renderCodexBinding(fs.readFileSync(sourceAbs, "utf8"));
    const relPath = path.posix.join(".codex", "agents", `${role}.toml`);
    const dest = path.join(options.targetRoot, relPath);
    const entry: TemplateFileEntry = { path: relPath, sha256: sha256Of(rendered), size_bytes: Buffer.byteLength(rendered) };
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered, "utf8");
      performed.push({ action: "add", path: relPath, note: "generated from .claude/agents" });
    } else if (hashFile(dest) !== entry.sha256) {
      const oursBefore = manifest?.files.some((f) => f.path === relPath);
      if (oursBefore || options.force) {
        backup(relPath);
        fs.writeFileSync(dest, rendered, "utf8");
        performed.push({ action: "update", path: relPath, note: "regenerated from .claude/agents" });
      } else {
        continue; // leave the stranger's file alone, don't claim it
      }
    }
    regeneratedCodex.add(relPath);
    managedEntries.push(entry);
  }

  // Stale cleanup — only paths this Target's own manifest proves we manage(d).
  for (const plannedFor of plan.entries.filter((e) => e.action === "remove-stale")) {
    const abs = path.join(options.targetRoot, plannedFor.path);
    const tracked = manifest?.files.find((f) => f.path === plannedFor.path);
    if (!tracked || !fs.existsSync(abs)) continue;
    backup(plannedFor.path);
    fs.rmSync(abs);
    performed.push(plannedFor);
  }

  const freshManifest: TargetManifest = {
    schema_version: 1,
    framework_version: templateManifest.framework_version,
    installed_at: manifest?.installed_at ?? options.now,
    updated_at: options.now,
    files: managedEntries,
  };
  writeTargetManifest(options.targetRoot, freshManifest);

  return {
    performed,
    skippedConflicts: plan.conflicts,
    previousVersion,
    frameworkVersion: templateManifest.framework_version,
    backupDir,
  };
}
