import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest, sha256Of, type TemplateFileEntry, type TemplateManifest } from "../packaging/templateManifest.js";
import { BINDING_RENDERINGS } from "../runtime/bindingGenerator.js";
import { parseVersion } from "./version.js";
import {
  CLAUDE_MD_PATH,
  KNOWLEDGE_ROOT_INCLUDE_PATH,
  renderDevClaude,
  renderKnowledgeInclude,
  resolveDevKnowledgeRoot,
} from "./knowledgeRender.js";
import {
  assertManageablePath,
  TargetNotInitializedError,
  loadTargetConfig,
  readTargetManifest,
  writeTargetManifest,
  type TargetConfig,
  type TargetManifest,
} from "./targetMeta.js";
import { BA_LANE_AGENTS, type RoleName } from "./roleWorkspace.js";

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
 * `.codex/agents/<role>.toml` and `.opencode/agent/<role>.md` renderings are
 * generated from the just-synced `.claude/agents/<role>.md` sources (OFF10 M2:
 * one role definition, several renderings) rather than shipped as payload —
 * generated files are owned by declaring their derivation, and they can never
 * drift from their source.
 */

/** The generated-from-.claude rendering targets, with their sync-log wording. Declared in bindingGenerator (`BINDING_RENDERINGS`) so `checkBindings` verifies exactly what this engine generates. */
const DERIVED_RENDERINGS = BINDING_RENDERINGS.map((spec) => ({ ...spec, note: "generated from .claude/agents" }));

export type SyncAction = "add" | "update" | "restore" | "remove-stale" | "unchanged" | "override";

export interface SyncPlanEntry {
  action: SyncAction;
  path: string;
  note?: string;
}

export interface SyncConflict {
  path: string;
  /**
   * user-modified: a tracked file was edited locally; untracked-file: the
   * Target already owns this path; stale-modified: a dropped file carries
   * edits; roster-drift (T-WG2): an agent-prompt file on disk whose name
   * belongs to the OTHER role's lane — never legitimate here, regardless of
   * how it got there, so it is never treated as an ordinary foreign file.
   */
  kind: "user-modified" | "untracked-file" | "stale-modified" | "roster-drift";
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
  derivedContent?: ReadonlyMap<string, string>,
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
    // A dev-lane rendering replaces the shipped bytes at the same managed path:
    // compare against what sync actually writes, so a rendered workspace is
    // "unchanged" on re-sync instead of perpetually "user-modified".
    const derivedBytes = derivedContent?.get(file.path);
    if (derivedBytes !== undefined && currentHash === sha256Of(derivedBytes)) {
      planned.push({ entry: { action: "unchanged", path: file.path } });
      continue;
    }
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
  derivedContent?: ReadonlyMap<string, string>,
): PlannedFile[] {
  const newPathSet = new Set(templateManifest.files.map((f) => f.path));
  const planned: PlannedFile[] = [];
  for (const [relPath, tracked] of oldFiles) {
    if (newPathSet.has(relPath)) continue;
    if (relPath.startsWith(".codex/") || relPath.startsWith(".opencode/agent/")) continue; // derived renderings follow their agent sources automatically
    if (derivedContent?.has(relPath)) continue; // T-WG7 — regenerated below from the live binding, never stale
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

/** Where each runtime's agent-prompt rendering lives, keyed by its file extension. */
const AGENT_PROMPT_DIRS: readonly { dir: string; ext: string }[] = [
  { dir: ".claude/agents", ext: ".md" },
  { dir: ".codex/agents", ext: ".toml" },
  { dir: ".opencode/agent", ext: ".md" },
];

/**
 * T-WG2 — roster drift: an agent-prompt file physically present in a
 * role-declared workspace whose name belongs to the OTHER lane. This is
 * distinct from an ordinary foreign file: `planPayloadFiles`/`planStaleFiles`
 * only ever look at paths the CURRENT role's filtered manifest knows about
 * (`effectiveTemplateManifest`) or that this Target's own history tracked —
 * a hand-copied prompt that was never either is invisible to both, which is
 * exactly how the sb-compass incident's stray BA prompts survived undetected
 * (F2 in workspace-guardrails-TASKS.md). A name that isn't a known agent at
 * all (unrelated stray file) is deliberately left alone here — the existing
 * foreign-file policy already covers it.
 */
export function detectRosterDrift(options: { targetRoot: string; templatesDir: string; role: RoleName }): SyncConflict[] {
  const fullManifest = readTemplateManifest(options.templatesDir);
  const allAgentNames = new Set(
    fullManifest.files
      .filter((f) => f.path.startsWith(".claude/agents/") && f.path.endsWith(".md"))
      .map((f) => path.basename(f.path, ".md")),
  );
  const baAgents = new Set(BA_LANE_AGENTS);
  // dev: only a BA-lane name is drift. ba: any known engineer/reviewer name is
  // drift — everything the full roster knows about that isn't BA-lane.
  const foreignNames = options.role === "dev" ? baAgents : new Set([...allAgentNames].filter((n) => !baAgents.has(n)));

  const conflicts: SyncConflict[] = [];
  for (const spec of AGENT_PROMPT_DIRS) {
    const dirAbs = path.join(options.targetRoot, spec.dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(dirAbs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(spec.ext)) continue;
      const base = path.basename(name, spec.ext);
      if (!foreignNames.has(base)) continue;
      conflicts.push({
        path: path.posix.join(spec.dir, name),
        kind: "roster-drift",
        detail:
          `agent prompt "${base}" belongs to the ${options.role === "dev" ? "BA" : "engineer/reviewer"} lane, ` +
          `not this workspace's role (${options.role}) — never legitimate here regardless of how it arrived`,
      });
    }
  }
  return conflicts;
}

function overrideSet(config: TargetConfig | undefined): Set<string> {
  return new Set((config?.overrides ?? []).map((rel) => rel.replaceAll("\\", "/")));
}

/**
 * Whether a conflict may stop a run. Only a file the Framework tracks and the
 * user then edited qualifies (`user-modified`, `stale-modified`): writing it
 * would destroy work. An `untracked-file` never does — the Target owned that
 * path before the Framework ever did (its own CLAUDE.md, its own
 * .claude/settings.json), so sync skips it and reports it, and a workspace is
 * not broken for having one.
 *
 * This lives in one place on purpose: the rule was previously written inline in
 * `runTargetSync` and *not* applied by `workspacePreflight`, so `sync` accepted
 * a workspace that `dev` then refused to launch — the same workspace, two
 * verdicts. Every caller that gates on conflicts routes through here.
 */
export const isBlockingConflict = (conflict: SyncConflict): boolean => conflict.kind !== "untracked-file";

/** The conflicts that actually stop a run, in plan order. */
export const blockingConflicts = (plan: SyncPlan): SyncConflict[] => plan.conflicts.filter(isBlockingConflict);

/** Managed paths the project owns instead — reported, never blocking. */
export const projectOwnedPaths = (plan: SyncPlan): string[] =>
  plan.conflicts.filter((c) => !isBlockingConflict(c)).map((c) => c.path);

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
  /** T-WG2 — when supplied, plan also flags any on-disk agent-prompt file belonging to the other lane (see `detectRosterDrift`). Absent = no roster-drift scan (legacy/no-role workspaces keep prior behaviour exactly). */
  role?: RoleName;
  /**
   * T-WG7 — final bytes sync writes at otherwise-shipped paths (the dev lane's
   * rendered CLAUDE.md). Planning compares against these so a rendered
   * workspace is recognized as current; apply writes the mapped bytes instead
   * of copying the template file.
   */
  derivedContent?: ReadonlyMap<string, string>;
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
    ...planPayloadFiles(options.targetRoot, templateManifest, oldFiles, overrides, options.derivedContent),
    ...planStaleFiles(options.targetRoot, templateManifest, oldFiles, overrides, options.derivedContent),
  ];

  const conflicts = planned.map((p) => p.conflict).filter((c): c is SyncConflict => c !== undefined);
  if (options.role) {
    conflicts.push(...detectRosterDrift({ targetRoot: options.targetRoot, templatesDir: options.templatesDir, role: options.role }));
  }

  return {
    entries: planned.map((p) => p.entry).filter((e): e is SyncPlanEntry => e !== undefined),
    conflicts,
    frameworkVersion: templateManifest.framework_version,
  };
}

export interface ApplySyncOptions extends PlanSyncOptions {
  now: string;
  force?: boolean;
  /** Machine-wide installation.yaml override (tests); defaults to the real one when resolving a dev workspace's Knowledge binding. */
  installationConfigPath?: string;
}

/**
 * T-WG7 — the dev-lane derived bytes this sync would write: the rendered
 * CLAUDE.md keyed by its managed path, plus the resolved root it was rendered
 * against. Undefined for non-dev workspaces or when no binding resolves.
 */
export function devDerivedContent(options: {
  targetRoot: string;
  templatesDir: string;
  config?: TargetConfig;
  include?: (relPath: string) => boolean;
  installationConfigPath?: string;
}): { content: Map<string, string>; knowledgeRoot: string } | undefined {
  const config = options.config;
  const knowledgeRoot = resolveDevKnowledgeRoot({
    targetRoot: options.targetRoot,
    config,
    installationConfigPath: options.installationConfigPath,
  });
  if (!knowledgeRoot) return undefined;
  const manifest = readTemplateManifest(options.templatesDir);
  const files = options.include ? manifest.files.filter((f) => options.include!(f.path)) : manifest.files;
  if (!files.some((f) => f.path === CLAUDE_MD_PATH)) return undefined;
  const base = fs.readFileSync(path.join(options.templatesDir, CLAUDE_MD_PATH), "utf8");
  const content = new Map<string, string>([
    [CLAUDE_MD_PATH, renderDevClaude(base, knowledgeRoot)],
    // In the map so planStaleFiles treats it as regenerated (never stale) and
    // a role flip later cleans it up through the ordinary stale path.
    [KNOWLEDGE_ROOT_INCLUDE_PATH, renderKnowledgeInclude(knowledgeRoot)],
  ]);
  return { content, knowledgeRoot };
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
  const derived = devDerivedContent({
    targetRoot: options.targetRoot,
    templatesDir: options.templatesDir,
    config,
    include: options.include,
    installationConfigPath: options.installationConfigPath,
  });
  const derivedContent = derived?.content;
  const plan = planSync({ ...options, manifest, config, derivedContent });
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
  for (const spec of DERIVED_RENDERINGS) {
    for (const [relPath, tracked] of oldFiles) {
      if (!relPath.startsWith(`${spec.dir}/`) || !relPath.endsWith(spec.fileExtension)) continue;
      const role = path.basename(relPath, spec.fileExtension);
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
  }
  // Only tracked-but-edited (and stale-modified) files block the run; a
  // pre-existing foreign file never does — it is skipped and reported below.
  if (blockingConflicts(plan).length > 0 && !options.force) throw new TargetSyncConflictError(plan);

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
    if (derivedContent?.has(file.path)) {
      continue; // T-WG7 — written after the loop from rendered bytes, with rendered-hash tracking
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
    if (plannedFor.action === "override") {
      // Claimed via config `overrides:` — same semantics as `foreign` above:
      // never written, so never tracked. Recording the template's hash for a
      // file sync deliberately left alone would assert the Framework's content
      // is on disk when the project's is, and un-claiming the path later would
      // then mislabel the project's own file as "edited after sync".
      performed.push(plannedFor);
      continue;
    }
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
      performed.push(plannedFor); // unchanged — already identical, nothing to write
    }
    managedEntries.push(file);
  }

  // Derived renderings: regenerate from the just-synced agent sources. They carry
  // no independent authorship, so they never conflict with the Framework — but a
  // foreign pre-existing file at the destination stays untouched and unclaimed.
  for (const spec of DERIVED_RENDERINGS) {
    for (const agentFile of templateManifest.files.filter((f) => f.path.startsWith(".claude/agents/") && f.path.endsWith(".md"))) {
      const role = path.basename(agentFile.path, ".md");
      const sourceAbs = path.join(options.targetRoot, ".claude", "agents", `${role}.md`);
      if (!fs.existsSync(sourceAbs)) continue;
      const rendered = spec.render(fs.readFileSync(sourceAbs, "utf8"));
      const relPath = path.posix.join(spec.dir, `${role}${spec.fileExtension}`);
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
      managedEntries.push(entry);
    }
  }

  // T-WG7 — dev-lane rendering of CLAUDE.md plus its generated include. Planned
  // against rendered hashes above, so this mirrors the DERIVED_RENDERINGS
  // mechanics: a conflict already stopped the run before any write, otherwise
  // add/update/unchanged with a backup of whatever gets replaced. A project-
  // owned (foreign) CLAUDE.md stays untouched; the include is still written —
  // it names the binding, it claims nothing the project authored.
  if (derived) {
    const rendered = derivedContent!.get(CLAUDE_MD_PATH)!;
    const claudeEntry: TemplateFileEntry = { path: CLAUDE_MD_PATH, sha256: sha256Of(rendered), size_bytes: Buffer.byteLength(rendered) };
    const claudeAbs = path.join(options.targetRoot, CLAUDE_MD_PATH);
    if (!foreign.has(CLAUDE_MD_PATH)) {
      if (!fs.existsSync(claudeAbs)) {
        fs.writeFileSync(claudeAbs, rendered, "utf8");
        performed.push({ action: "add", path: CLAUDE_MD_PATH, note: "rendered for the dev lane (Knowledge binding)" });
      } else if (hashFile(claudeAbs) !== claudeEntry.sha256) {
        backup(CLAUDE_MD_PATH);
        fs.writeFileSync(claudeAbs, rendered, "utf8");
        performed.push({ action: "update", path: CLAUDE_MD_PATH, note: "re-rendered for the dev lane (Knowledge binding)" });
      } else {
        performed.push({ action: "unchanged", path: CLAUDE_MD_PATH });
      }
      managedEntries.push(claudeEntry);
    }
    const includeContent = derivedContent!.get(KNOWLEDGE_ROOT_INCLUDE_PATH)!;
    const includeEntry: TemplateFileEntry = { path: KNOWLEDGE_ROOT_INCLUDE_PATH, sha256: sha256Of(includeContent), size_bytes: Buffer.byteLength(includeContent) };
    const includeAbs = path.join(options.targetRoot, KNOWLEDGE_ROOT_INCLUDE_PATH);
    fs.mkdirSync(path.dirname(includeAbs), { recursive: true });
    if (!fs.existsSync(includeAbs)) {
      fs.writeFileSync(includeAbs, includeContent, "utf8");
      performed.push({ action: "add", path: KNOWLEDGE_ROOT_INCLUDE_PATH, note: "generated from the Knowledge binding" });
    } else if (hashFile(includeAbs) !== includeEntry.sha256) {
      backup(KNOWLEDGE_ROOT_INCLUDE_PATH);
      fs.writeFileSync(includeAbs, includeContent, "utf8");
      performed.push({ action: "update", path: KNOWLEDGE_ROOT_INCLUDE_PATH, note: "regenerated from the Knowledge binding" });
    } else {
      performed.push({ action: "unchanged", path: KNOWLEDGE_ROOT_INCLUDE_PATH });
    }
    managedEntries.push(includeEntry);
  }

  // T-WG2 — roster drift has no template source to sync from (the file was
  // never this role's to receive), so --force removes it outright, backed up
  // first like any other forced conflict. Without --force it already stopped
  // the run above via blockingConflicts.
  if (options.force) {
    for (const conflict of plan.conflicts.filter((c) => c.kind === "roster-drift")) {
      const abs = path.join(options.targetRoot, conflict.path);
      if (!fs.existsSync(abs)) continue;
      backup(conflict.path);
      fs.rmSync(abs);
      performed.push({ action: "remove-stale", path: conflict.path, note: "roster drift — agent prompt from another lane" });
    }
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
