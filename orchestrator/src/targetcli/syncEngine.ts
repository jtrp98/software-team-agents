import * as fs from "node:fs";
import * as path from "node:path";
import { payloadDigest, readTemplateManifest, sha256Of, type TemplateFileEntry, type TemplateManifest } from "../packaging/templateManifest.js";
import { BINDING_RENDERINGS, COMMAND_RENDERINGS, derivedRenderingIgnorePaths, isAgentBindingRendering, loadCommandGuardrails, listCommands, renderAgentsPointer } from "../runtime/bindingGenerator.js";
import { parseVersion } from "./version.js";
import {
  CLAUDE_MD_PATH,
  GITIGNORE_PATH,
  gitignoreAlreadyCovers,
  inspectBootstrapBlock,
  inspectGitignoreBlock,
  KNOWLEDGE_ROOT_INCLUDE_PATH,
  MANAGED_GITIGNORE_PATHS,
  renderGitignoreBlock,
  renderKnowledgeInclude,
  renderWorkspaceClaude,
  resolveDevKnowledgeRoot,
} from "./knowledgeRender.js";
import {
  assertManageablePath,
  TargetNotInitializedError,
  isUserOverridden,
  loadTargetConfig,
  readTargetManifest,
  writeTargetManifest,
  writeTargetConfig,
  type TargetConfig,
  type TargetManifest,
  type TargetStackConfig,
} from "./targetMeta.js";
import { CLAUDE_SETTINGS_PATH, mergeFrameworkGuards } from "./guardSettings.js";
import { BA_WORKSPACE_AGENTS, resolveTargetBinding, runtimesForWorkspace, type WorkspaceRole, type WorkspaceRuntime } from "./roleWorkspace.js";
import { missingInstructionConsequence } from "../threeRepo/ownership.js";
import { planTargetProfile } from "./targetProfile.js";
import { renderStackDigest, STACK_DIGEST_RELATIVE_PATH } from "../profile/stackDigest.js";

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
const DERIVED_RENDERINGS = BINDING_RENDERINGS.filter(isAgentBindingRendering).map((spec) => ({ ...spec, note: "generated from .claude/agents" }));
export const AGENTS_MD_PATH = "AGENTS.md";
/** Same for the prompt-shortcut renderings (`.opencode/commands`, `.agents/skills`), generated from `.claude/commands`. */
const DERIVED_COMMAND_RENDERINGS = COMMAND_RENDERINGS.map((spec) => ({ ...spec, note: "generated from .claude/commands" }));

function runtimeForRenderingDir(dir: string): WorkspaceRuntime {
  return dir.startsWith(".codex/") || dir.startsWith(".agents/") ? "codex" : "opencode";
}

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
   * edits; malformed-framework-block: marker corruption that no force mode may
   * guess at; unmergeable-settings: project JSON cannot be safely merged;
   * roster-drift (T-WG2): an agent-prompt file on disk whose name
   * belongs to the OTHER workspace role — never legitimate here, regardless of
   * how it got there, so it is never treated as an ordinary foreign file.
   */
  kind: "user-modified" | "untracked-file" | "stale-modified" | "roster-drift" | "malformed-framework-block" | "unmergeable-settings";
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
  stackProfile?: TargetStackConfig;
  stackProfileMismatch?: string;
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
  templatesDir: string,
  templateManifest: TemplateManifest,
  oldFiles: ReadonlyMap<string, TemplateFileEntry>,
  overrides: ReadonlySet<string>,
  oldBlockHashes: ReadonlyMap<string, string>,
  derivedContent?: ReadonlyMap<string, string>,
  confirmAgentsPointer = false,
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
    if (file.path === CLAUDE_SETTINGS_PATH && !tracked) {
      const merged = mergeFrameworkGuards(
        fs.readFileSync(dest, "utf8"),
        fs.readFileSync(path.join(templatesDir, ...file.path.split("/")), "utf8"),
      );
      if (!merged.ok) {
        planned.push({
          conflict: {
            path: file.path,
            kind: "unmergeable-settings",
            detail:
              `${merged.error}; recovery: fix/merge the JSON manually, claim ${CLAUDE_SETTINGS_PATH} in .agent-team/config.yaml overrides, ` +
              "or re-run with --force to replace it after backup",
          },
        });
      } else {
        planned.push({
          entry: {
            action: merged.changed ? "update" : "unchanged",
            path: file.path,
            note: merged.changed ? "merge missing Framework guard registrations" : "project-owned settings with all Framework guards registered",
          },
        });
      }
      continue;
    }
    const currentHash = hashFile(dest);
    // A DEV-workspace rendering replaces the shipped bytes at the same managed path:
    // compare against what sync actually writes, so a rendered workspace is
    // "unchanged" on re-sync instead of perpetually "user-modified".
    const derivedBytes = derivedContent?.get(file.path);
    if (file.path === AGENTS_MD_PATH && derivedBytes !== undefined && confirmAgentsPointer && isProvableStaleAgentsDuplicate(targetRoot)) {
      planned.push({ entry: { action: currentHash === sha256Of(derivedBytes) ? "unchanged" : "update", path: file.path, note: "explicitly confirmed reduction of a provable CLAUDE.md duplicate" } });
      continue;
    }
    if ((file.path === CLAUDE_MD_PATH || file.path === AGENTS_MD_PATH) && derivedBytes !== undefined) {
      const current = fs.readFileSync(dest, "utf8");
      const currentBlock = inspectBootstrapBlock(current);
      if (currentBlock.state === "malformed") {
        planned.push({
          conflict: {
            path: file.path,
            kind: "malformed-framework-block",
            detail: `${currentBlock.detail}; file left untouched — restore the latest backup or repair the marker pair manually`,
          },
        });
        continue;
      }
      const renderedBlock = inspectBootstrapBlock(derivedBytes);
      if (renderedBlock.state !== "valid") throw new Error(`rendered ${file.path} has no valid Framework bootstrap block`);
      const expectedHash = sha256Of(renderedBlock.block);
      const previousBlockHash = oldBlockHashes.get(file.path);
      // Whole-file tracked CLAUDE.md stays Framework-managed. Only a file with
      // no whole-file entry (or an existing block entry) takes block semantics.
      if (!tracked || previousBlockHash !== undefined) {
        if (currentBlock.state === "absent") {
          planned.push(
            previousBlockHash
              ? { conflict: { path: file.path, kind: "user-modified", detail: "the Framework bootstrap block was removed; restore it from backup or re-run with --force" } }
              : { entry: { action: "update", path: file.path, note: "inject delimited Framework bootstrap block" } },
          );
          continue;
        }
        const currentBlockHash = sha256Of(currentBlock.block);
        if (previousBlockHash === undefined) {
          planned.push(
            currentBlockHash === expectedHash
              ? { entry: { action: "unchanged", path: file.path, note: "project-owned prose with current Framework block" } }
              : { conflict: { path: file.path, kind: "user-modified", detail: "an untracked sta:bootstrap block already exists with different bytes; restore/remove it manually before sync" } },
          );
        } else if (currentBlockHash !== previousBlockHash && currentBlockHash !== expectedHash) {
          planned.push({
            conflict: {
              path: file.path,
              kind: "user-modified",
              detail: "the project edited inside the Framework bootstrap markers; restore the block from backup or re-run with --force",
            },
          });
        } else {
          planned.push({ entry: { action: currentBlockHash === expectedHash ? "unchanged" : "update", path: file.path, note: "Framework bootstrap block only; project prose preserved" } });
        }
        continue;
      }
    }
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
      planned.push({
        conflict: {
          path: file.path,
          kind: "untracked-file",
          detail:
            missingInstructionConsequence(targetRoot, file.path) ??
            "the project already has its own file at this managed path",
        },
      });
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
    if (relPath === AGENTS_MD_PATH) {
      planned.push({ entry: { action: "override", path: relPath, note: "AGENTS.md is never automatically deleted; retained for manual/reversible cleanup" } });
      continue;
    }
    if (relPath.startsWith(".codex/") || relPath.startsWith(".opencode/agent/") || relPath.startsWith(".opencode/commands/") || relPath.startsWith(".agents/skills/")) continue; // derived renderings follow their sources automatically
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

/**
 * T-V5-006 — the managed `.gitignore` block. The framework writes the
 * version-control decision for its machine-local paths (`.workflow/`,
 * `.agent-team/backups/`) into a marked block of the workspace's `.gitignore`
 * — the same marker-block ownership model CLAUDE.md/AGENTS.md already use, so
 * sync updates it, conflicts surface like any other edited block, and status
 * plans it like any other managed contribution. The file itself stays
 * project-owned: everything outside the markers is never read for planning and
 * never written.
 *
 * A path the project already ignores is not listed again — the block says so
 * in a comment instead. Base entries live in {@link MANAGED_GITIGNORE_PATHS}
 * (knowledgeRender.ts); T-V5-018 adds the derived rendering directories from
    if (relPath.startsWith(".codex/") || relPath.startsWith(".opencode/agent/") || relPath.startsWith(".opencode/commands/") || relPath.startsWith(".agents/skills/")) continue; // derived renderings follow their sources automatically
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

/**
 * T-V5-006 — the managed `.gitignore` block. The framework writes the
 * version-control decision for its machine-local paths (`.workflow/`,
 * `.agent-team/backups/`) into a marked block of the workspace's `.gitignore`
 * — the same marker-block ownership model CLAUDE.md/AGENTS.md already use, so
 * sync updates it, conflicts surface like any other edited block, and status
 * plans it like any other managed contribution. The file itself stays
 * project-owned: everything outside the markers is never read for planning and
 * never written.
 *
 * A path the project already ignores is not listed again — the block says so
 * in a comment instead. Base entries live in {@link MANAGED_GITIGNORE_PATHS}
 * (knowledgeRender.ts); T-V5-018 adds the derived rendering directories from
 * the rendering declarations, which is safe exactly because every sync
 * regenerates them (verified by `--check-bindings`).
 */
const GITIGNORE_BLOCK_ENTRIES: readonly string[] = [...MANAGED_GITIGNORE_PATHS, ...derivedRenderingIgnorePaths()];

function planGitignoreBlock(
  targetRoot: string,
  oldBlockHashes: ReadonlyMap<string, string>,
  overrides: ReadonlySet<string>,
): PlannedFile {
  if (overrides.has(GITIGNORE_PATH)) {
    return { entry: { action: "override", path: GITIGNORE_PATH, note: "claimed by the project — sync leaves it alone" } };
  }
  const abs = path.join(targetRoot, GITIGNORE_PATH);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
  if (current === undefined) {
    return { entry: { action: "add", path: GITIGNORE_PATH, note: "write managed .gitignore block" } };
  }
  const inspected = inspectGitignoreBlock(current);
  if (inspected.state === "malformed") {
    return {
      conflict: {
        path: GITIGNORE_PATH,
        kind: "malformed-framework-block",
        detail: `${inspected.detail}; file left untouched — restore the latest backup or repair the marker pair manually`,
      },
    };
  }
  if (inspected.state === "absent") {
    return { entry: { action: "update", path: GITIGNORE_PATH, note: "append managed .gitignore block; project rules preserved" } };
  }
  const expectedBlock = renderGitignoreBlock(
    GITIGNORE_BLOCK_ENTRIES.filter((managedPath) => gitignoreAlreadyCovers(inspected.outside, managedPath)),
    GITIGNORE_BLOCK_ENTRIES,
  );
  const expectedHash = sha256Of(expectedBlock);
  const currentHash = sha256Of(inspected.block);
  const previousHash = oldBlockHashes.get(GITIGNORE_PATH);
  if (previousHash === undefined) {
    return currentHash === expectedHash
      ? { entry: { action: "unchanged", path: GITIGNORE_PATH, note: "project file already carries the current Framework block" } }
      : { conflict: { path: GITIGNORE_PATH, kind: "user-modified", detail: "an untracked sta:gitignore block already exists with different bytes; restore/remove it manually before sync" } };
  }
  if (currentHash !== previousHash && currentHash !== expectedHash) {
    return {
      conflict: {
        path: GITIGNORE_PATH,
        kind: "user-modified",
        detail: "the project edited inside the Framework .gitignore markers; restore the block from backup or re-run with --force",
      },
    };
  }
  return { entry: { action: currentHash === expectedHash ? "unchanged" : "update", path: GITIGNORE_PATH, note: "Framework .gitignore block only; project rules preserved" } };
}

/**
 * A project-owned CLAUDE.md is not a managed file, so its Framework block is
 * absent from `oldFiles`. When a later payload no longer supplies CLAUDE.md,
 * plan removal of that block through the ordinary stale lifecycle instead of
 * leaving an orphaned contribution behind.
 *
 * The `.gitignore` block is exempt: it is not payload-derived, so it can never
 * go stale no matter what the template payload does.
 */
function planStaleFrameworkBlocks(
  targetRoot: string,
  templateManifest: TemplateManifest,
  oldBlockHashes: ReadonlyMap<string, string>,
  overrides: ReadonlySet<string>,
): PlannedFile[] {
  const newPathSet = new Set(templateManifest.files.map((file) => file.path));
  const planned: PlannedFile[] = [];
  for (const [relPath, trackedHash] of oldBlockHashes) {
    if (relPath === GITIGNORE_PATH || relPath === AGENTS_MD_PATH) continue;
    if (newPathSet.has(relPath)) continue;
    if (overrides.has(relPath)) {
      planned.push({ entry: { action: "override", path: relPath, note: "Framework block kept because the project claimed this path" } });
      continue;
    }
    const abs = path.join(targetRoot, relPath);
    if (!fs.existsSync(abs)) continue;
    const inspected = inspectBootstrapBlock(fs.readFileSync(abs, "utf8"));
    if (inspected.state === "malformed") {
      planned.push({
        conflict: {
          path: relPath,
          kind: "malformed-framework-block",
          detail: `${inspected.detail}; file left untouched — restore the latest backup or repair the marker pair manually`,
        },
      });
    } else if (inspected.state === "absent") {
      // The user already removed precisely the Framework-owned range. Forget
      // the stale manifest record without touching the project file.
      continue;
    } else if (sha256Of(inspected.block) === trackedHash) {
      planned.push({ entry: { action: "remove-stale", path: relPath, note: "remove obsolete Framework bootstrap block" }, remove: true });
    } else {
      planned.push({
        conflict: {
          path: relPath,
          kind: "stale-modified",
          detail: "the Framework no longer supplies this block, but its marked bytes were edited; restore from backup or remove the marker pair manually",
        },
      });
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
 * role-declared workspace whose name belongs to the OTHER workspace role. This is
 * distinct from an ordinary foreign file: `planPayloadFiles`/`planStaleFiles`
 * only ever look at paths the CURRENT role's filtered manifest knows about
 * (`effectiveTemplateManifest`) or that this Target's own history tracked —
 * a hand-copied prompt that was never either is invisible to both, which is
 * exactly how the sb-compass incident's stray BA prompts survived undetected
 * (F2 in workspace-guardrails-TASKS.md). A name that isn't a known agent at
 * all (unrelated stray file) is deliberately left alone here — the existing
 * foreign-file policy already covers it.
 */
export function detectRosterDrift(options: { targetRoot: string; templatesDir: string; role: WorkspaceRole }): SyncConflict[] {
  const fullManifest = readTemplateManifest(options.templatesDir);
  const allAgentNames = new Set(
    fullManifest.files
      .filter((f) => f.path.startsWith(".claude/agents/") && f.path.endsWith(".md"))
      .map((f) => path.basename(f.path, ".md")),
  );
  const baAgents = new Set(BA_WORKSPACE_AGENTS);
  // dev: only a BA-workspace name is drift. ba: any known engineer/reviewer name is
  // drift — everything the full roster knows about that isn't assigned to BA workspaces.
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
          `agent prompt "${base}" belongs to the ${options.role === "dev" ? "BA" : "engineer/reviewer"} workspace role, ` +
          `not this workspace's role (${options.role}) — never legitimate here regardless of how it arrived`,
      });
    }
  }
  return conflicts;
}

function overrideSet(config: TargetConfig | undefined, targetRoot?: string, candidatePaths: readonly string[] = []): Set<string> {
  const overrides = new Set((config?.overrides ?? []).map((rel) => rel.replaceAll("\\", "/")));
  if (targetRoot) {
    for (const relPath of candidatePaths) {
      if (isUserOverridden(targetRoot, relPath, config)) overrides.add(relPath);
    }
  }
  return overrides;
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

/** Entries a normal sync would write, in deterministic plan order. */
export const pendingSyncEntries = (plan: SyncPlan): SyncPlanEntry[] =>
  plan.entries.filter((entry) => entry.action !== "unchanged" && entry.action !== "override");

export class TargetSyncConflictError extends Error {
  constructor(public readonly plan: SyncPlan) {
    super(
      `${plan.conflicts.length} conflicted file(s) — nothing was written. ` +
        `${plan.conflicts.map((conflict) => `${conflict.path}: ${conflict.detail}`).join("; ")}. ` +
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
  /** T-WG2 — when supplied, plan also flags any on-disk agent-prompt file belonging to the other workspace role (see `detectRosterDrift`). Absent = no roster-drift scan (legacy/no-role workspaces keep prior behaviour exactly). */
  role?: WorkspaceRole;
  /**
   * T-WG7 — final bytes sync writes at otherwise-shipped paths (the DEV workspace's
   * rendered CLAUDE.md). Planning compares against these so a rendered
   * workspace is recognized as current; apply writes the mapped bytes instead
   * of copying the template file.
   */
  derivedContent?: ReadonlyMap<string, string>;
  /** Explicitly shrink a provable AGENTS.md duplicate to the generated pointer. --force never implies this. */
  confirmAgentsPointer?: boolean;
}

function isProvableStaleAgentsDuplicate(targetRoot: string): boolean {
  const agents = path.join(targetRoot, AGENTS_MD_PATH);
  const claude = path.join(targetRoot, CLAUDE_MD_PATH);
  if (!fs.existsSync(agents) || !fs.existsSync(claude)) return false;
  const a = inspectBootstrapBlock(fs.readFileSync(agents, "utf8"));
  const c = inspectBootstrapBlock(fs.readFileSync(claude, "utf8"));
  if (a.state === "malformed" || c.state === "malformed") return false;
  const aOutside = (a.state === "valid" ? a.outside : fs.readFileSync(agents, "utf8")).replace(/\r\n/g, "\n");
  const cOutside = (c.state === "valid" ? c.outside : fs.readFileSync(claude, "utf8")).replace(/\r\n/g, "\n");
  return aOutside === cOutside;
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
  const oldBlockHashes = new Map((options.manifest?.framework_blocks ?? []).map((block) => [block.path, block.sha256]));
  const candidatePaths = [...templateManifest.files.map((file) => file.path), ...oldFiles.keys(), ...oldBlockHashes.keys()];
  const overrides = overrideSet(options.config, options.targetRoot, candidatePaths);

  const planned = [
    ...planPayloadFiles(options.targetRoot, options.templatesDir, templateManifest, oldFiles, overrides, oldBlockHashes, options.derivedContent, options.confirmAgentsPointer),
    ...planStaleFiles(options.targetRoot, templateManifest, oldFiles, overrides, options.derivedContent),
    ...planStaleFrameworkBlocks(options.targetRoot, templateManifest, oldBlockHashes, overrides),
    planGitignoreBlock(options.targetRoot, oldBlockHashes, overrides),
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
  /** Explicit resolution for an ambiguous/unrecognized Target profile. */
  explicitStack?: string;
}

/**
 * T-WG7/T-V3-06 — workspace-role-derived bytes this sync would write. The same
 * CLAUDE.md renderer serves DEV and BA; the Knowledge include remains DEV-only,
 * and a DEV stack digest is rendered from the resolved Target profile.
 */
export function devDerivedContent(options: {
  targetRoot: string;
  templatesDir: string;
  config?: TargetConfig;
  include?: (relPath: string) => boolean;
  installationConfigPath?: string;
}): { content: Map<string, string>; boundRoot?: string } | undefined {
  const config = options.config;
  if (!config?.role) return undefined;
  let boundRoot: string | undefined;
  if (config.role === "dev") {
    boundRoot = resolveDevKnowledgeRoot({
      targetRoot: options.targetRoot,
      config,
      installationConfigPath: options.installationConfigPath,
    });
  } else {
    try {
      boundRoot = resolveTargetBinding({ knowledgeRoot: options.targetRoot, configTargetPath: config.target?.path })?.targetRoot;
    } catch {
      boundRoot = undefined;
    }
  }
  const manifest = readTemplateManifest(options.templatesDir);
  const files = options.include ? manifest.files.filter((f) => options.include!(f.path)) : manifest.files;
  const content = new Map<string, string>();
  if (files.some((f) => f.path === CLAUDE_MD_PATH)) {
    const base = fs.readFileSync(path.join(options.templatesDir, CLAUDE_MD_PATH), "utf8");
    content.set(CLAUDE_MD_PATH, renderWorkspaceClaude(base, { role: config.role, workspaceRoot: options.targetRoot, boundRoot }));
  }
  if (files.some((f) => f.path === AGENTS_MD_PATH) && content.has(CLAUDE_MD_PATH)) {
    content.set(AGENTS_MD_PATH, renderAgentsPointer(content.get(CLAUDE_MD_PATH)!));
  }
  if (config.role === "dev" && files.some((f) => f.path === STACK_DIGEST_RELATIVE_PATH)) {
    content.set(STACK_DIGEST_RELATIVE_PATH, renderStackDigest(config.stack));
  }
  if (config.role === "dev" && boundRoot) {
    // In the map so planStaleFiles treats it as regenerated (never stale) and
    // a role flip later cleans it up through the ordinary stale path.
    content.set(KNOWLEDGE_ROOT_INCLUDE_PATH, renderKnowledgeInclude(boundRoot));
  }
  return content.size > 0 ? { content, boundRoot } : undefined;
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
  const completeTemplateManifest = readTemplateManifest(options.templatesDir);
  const manifest = options.manifest ?? existingTargetManifest(options.targetRoot);
  const originalConfig = options.config ?? loadTargetConfig(options.targetRoot);
  const profilePlan = (options.role ?? originalConfig?.role) === "dev"
    ? planTargetProfile({
        targetRoot: options.targetRoot,
        templatesDir: options.templatesDir,
        existing: originalConfig?.stack,
        explicitProfile: options.explicitStack,
        now: options.now,
      })
    : undefined;
  const config = profilePlan && originalConfig ? { ...originalConfig, stack: profilePlan.stack } : originalConfig;
  // A direct engine caller without workspace metadata is the historical
  // framework-fixture contract: render every family. Real init/sync calls
  // always supply config or a manifest, where T-V5-007's selected set applies.
  const activeRuntimes = config || manifest
    ? new Set(runtimesForWorkspace(config, manifest))
    : new Set<WorkspaceRuntime>(["claude", "codex", "opencode"]);
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
    if (!activeRuntimes.has(runtimeForRenderingDir(spec.dir))) continue;
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
  // Command renderings follow the same rule, one level removed: a generated
  // file is stale when its command's `.md` source no longer ships. The name
  // is the first segment under the family dir (`.agents/skills/<name>/...`
  // nests, `.opencode/commands/<name>.md` doesn't).
  const survivingCommands = new Set(
    templateManifest.files
      .filter((f) => f.path.startsWith(".claude/commands/") && f.path.endsWith(".md") && !f.path.slice(".claude/commands/".length).includes("/"))
      .map((f) => path.basename(f.path, ".md")),
  );
  for (const spec of DERIVED_COMMAND_RENDERINGS) {
    if (!activeRuntimes.has(runtimeForRenderingDir(spec.dir))) continue;
    for (const [relPath, tracked] of oldFiles) {
      if (!relPath.startsWith(`${spec.dir}/`)) continue;
      const underDir = relPath.slice(spec.dir.length + 1);
      const command = underDir.includes("/") ? underDir.split("/")[0]! : path.basename(underDir);
      if (!command || survivingCommands.has(command)) continue;
      const abs = path.join(options.targetRoot, relPath);
      if (!fs.existsSync(abs)) continue;
      if (hashFile(abs) === tracked.sha256) {
        plan.entries.push({ action: "remove-stale", path: relPath, note: "generated rendering of a removed command" });
      } else {
        plan.conflicts.push({
          path: relPath,
          kind: "stale-modified",
          detail: "this generated file's command source was removed, but the local copy has been edited",
        });
      }
    }
  }
  // An explicit runtime narrowing removes only renderings the manifest proves
  // pristine. A locally edited binding is a normal stale conflict — never a
  // silent deletion — exactly like every other profile drop.
  const unselectedPrefixes = [
    ...DERIVED_RENDERINGS.filter((spec) => !activeRuntimes.has(runtimeForRenderingDir(spec.dir))).map((spec) => `${spec.dir}/`),
    ...DERIVED_COMMAND_RENDERINGS.filter((spec) => !activeRuntimes.has(runtimeForRenderingDir(spec.dir))).map((spec) => `${spec.dir}/`),
  ];
  for (const [relPath, tracked] of oldFiles) {
    if (!unselectedPrefixes.some((prefix) => prefix.endsWith("/") ? relPath.startsWith(prefix) : relPath === prefix)) continue;
    const abs = path.join(options.targetRoot, relPath);
    if (!fs.existsSync(abs)) continue;
    if (hashFile(abs) === tracked.sha256) {
      plan.entries.push({ action: "remove-stale", path: relPath, note: "binding for an unselected runtime" });
    } else {
      plan.conflicts.push({ path: relPath, kind: "stale-modified", detail: "binding belongs to a runtime no longer selected, but local bytes were edited" });
    }
  }
  // Only tracked-but-edited (and stale-modified) files block the run; a
  // pre-existing foreign file never does — it is skipped and reported below.
  // Marker corruption is never forceable: there is no safe byte range to own.
  if (plan.conflicts.some((conflict) => conflict.kind === "malformed-framework-block")) {
    throw new TargetSyncConflictError(plan);
  }
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
  // Profile persistence occurs only after every preflight stop above. An
  // ambiguous/unknown/family-changing tree, or an ordinary sync conflict,
  // therefore cannot partially update config.yaml.
  if (profilePlan?.changed && config) writeTargetConfig(options.targetRoot, config);
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
      // T-V5-013 — file bytes and their pristine-hash baseline are one
      // snapshot. Without the old manifest, restoring the files would make the
      // next plan compare them against the post-sync hashes.
      if (manifest) {
        fs.copyFileSync(path.join(options.targetRoot, ".agent-team", "manifest.json"), path.join(backupDir, "manifest.json"));
      }
    }
    const dest = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  const performed: SyncPlanEntry[] = [];
  const managedEntries: TemplateFileEntry[] = [];
  const frameworkBlocks: { path: string; sha256: string }[] = [];

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
    if (file.path === CLAUDE_SETTINGS_PATH && !oldFiles.has(file.path) && fs.existsSync(path.join(options.targetRoot, file.path))) {
      const dest = path.join(options.targetRoot, file.path);
      const current = fs.readFileSync(dest, "utf8");
      const merged = mergeFrameworkGuards(current, fs.readFileSync(path.join(options.templatesDir, ...file.path.split("/")), "utf8"));
      if (!merged.ok || merged.content === undefined) throw new Error(`settings merge reached apply after preflight: ${merged.error ?? "no merged content"}`);
      if (merged.changed) {
        backup(file.path);
        fs.writeFileSync(dest, merged.content, "utf8");
        performed.push({ action: "update", path: file.path, note: "merged Framework guards; project settings byte-preserved" });
      } else {
        performed.push(plannedFor);
      }
      continue; // project-owned file: contribution is recomputed, never whole-file tracked
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

  // T-V3-04 — stack.md is shipped as a managed path but its Target bytes are
  // derived from that Target's resolved stack config, never from prompt prose.
  // The ordinary planner still owns conflict/override decisions and compares
  // against these exact bytes before this write phase runs.
  const stackDigest = derivedContent?.get(STACK_DIGEST_RELATIVE_PATH);
  if (stackDigest !== undefined) {
    const relPath = STACK_DIGEST_RELATIVE_PATH;
    const plannedFor = plan.entries.find((entry) => entry.path === relPath);
    const entry: TemplateFileEntry = {
      path: relPath,
      sha256: sha256Of(stackDigest),
      size_bytes: Buffer.byteLength(stackDigest),
    };
    if (foreign.has(relPath)) {
      // Already reported by the main payload loop; project-owned bytes stay unclaimed.
    } else if (plannedFor?.action === "override") {
      performed.push(plannedFor);
    } else if (plannedFor || forcedOver.has(relPath)) {
      const dest = path.join(options.targetRoot, ...relPath.split("/"));
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, stackDigest, "utf8");
        performed.push(plannedFor ?? { action: "add", path: relPath });
      } else if (hashFile(dest) !== entry.sha256) {
        backup(relPath);
        fs.writeFileSync(dest, stackDigest, "utf8");
        performed.push({ action: "update", path: relPath, note: forcedOver.has(relPath) ? "forced over local modifications (backed up)" : "rendered from the resolved Target profile" });
      } else {
        performed.push(plannedFor ?? { action: "unchanged", path: relPath });
      }
      managedEntries.push(entry);
    }
  }

  // Derived renderings: regenerate from the just-synced agent sources. They carry
  // no independent authorship, so they never conflict with the Framework — but a
  // foreign pre-existing file at the destination stays untouched and unclaimed.
  for (const spec of DERIVED_RENDERINGS) {
    if (!activeRuntimes.has(runtimeForRenderingDir(spec.dir))) continue;
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

  // Command renderings: regenerate from the just-synced `.claude/commands`
  // sources with the same mechanics as the agent renderings above — generated
  // bytes carry no independent authorship, a foreign pre-existing file stays
  // untouched and unclaimed. Guardrails come from the synced `_shared/` file,
  // so what lands here is exactly what `--check-bindings` will re-derive.
  const commandNames = listCommands(path.join(options.targetRoot, ".claude", "commands"));
  if (commandNames.length > 0) {
    let guardrailsRules: string;
    try {
      guardrailsRules = loadCommandGuardrails(options.targetRoot);
    } catch {
      guardrailsRules = ""; // a broken include fails loudly in checkBindings; sync still lands the payload
    }
    if (guardrailsRules !== "") {
      for (const spec of DERIVED_COMMAND_RENDERINGS) {
        if (!activeRuntimes.has(runtimeForRenderingDir(spec.dir))) continue;
        for (const name of commandNames) {
          let rendered: Map<string, string>;
          try {
            rendered = spec.render(name, fs.readFileSync(path.join(options.targetRoot, ".claude", "commands", `${name}.md`), "utf8"), guardrailsRules);
          } catch {
            continue; // unparseable source — checkBindings reports it, sync doesn't invent content
          }
          for (const [rel, bytes] of rendered) {
            const relPath = path.posix.join(spec.dir, rel);
            const dest = path.join(options.targetRoot, ...relPath.split("/"));
            const entrySha = sha256Of(bytes);
            const entry: TemplateFileEntry = { path: relPath, sha256: entrySha, size_bytes: Buffer.byteLength(bytes) };
            if (!fs.existsSync(dest)) {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, bytes, "utf8");
              performed.push({ action: "add", path: relPath, note: spec.note });
            } else if (hashFile(dest) !== entrySha) {
              const oursBefore = manifest?.files.some((f) => f.path === relPath);
              if (oursBefore || options.force) {
                backup(relPath);
                fs.writeFileSync(dest, bytes, "utf8");
                performed.push({ action: "update", path: relPath, note: `regenerated (${spec.note})` });
              } else {
                continue; // leave the stranger's file alone, don't claim it
              }
            }
            managedEntries.push(entry);
          }
        }
      }
    }
  }

  // T-WG7/T-V3-06 — workspace-role rendering of CLAUDE.md. A pre-existing project file
  // receives only the delimited block and is tracked by the block hash below;
  // a Framework-created file remains whole-file managed. Both paths were
  // planned against these exact rendered bytes before any write.
  if (derivedContent?.has(CLAUDE_MD_PATH)) {
    const rendered = derivedContent!.get(CLAUDE_MD_PATH)!;
    const claudeEntry: TemplateFileEntry = { path: CLAUDE_MD_PATH, sha256: sha256Of(rendered), size_bytes: Buffer.byteLength(rendered) };
    const claudeAbs = path.join(options.targetRoot, CLAUDE_MD_PATH);
    const plannedClaude = plan.entries.find((entry) => entry.path === CLAUDE_MD_PATH);
    const claudeOverridden = overrideSet(config).has(CLAUDE_MD_PATH);
    const previousBlock = manifest?.framework_blocks?.find((block) => block.path === CLAUDE_MD_PATH);
    const projectOwnedClaude = previousBlock !== undefined || (!oldFiles.has(CLAUDE_MD_PATH) && fs.existsSync(claudeAbs));
    const renderedBlock = inspectBootstrapBlock(rendered);
    if (renderedBlock.state !== "valid") throw new Error("rendered CLAUDE.md has no valid Framework bootstrap block");
    if (claudeOverridden) {
      performed.push({ action: "override", path: CLAUDE_MD_PATH, note: "explicit user choice in .agent-team/config.yaml — bootstrap block skipped" });
    } else if (projectOwnedClaude) {
      const current = fs.readFileSync(claudeAbs, "utf8");
      const inspected = inspectBootstrapBlock(current);
      if (inspected.state === "malformed") throw new Error("malformed bootstrap block reached apply after preflight");
      const outside = inspected.state === "valid" ? inspected.outside : current;
      const next = renderedBlock.block + outside;
      if (next !== current) {
        backup(CLAUDE_MD_PATH);
        fs.writeFileSync(claudeAbs, next, "utf8");
        performed.push({ action: "update", path: CLAUDE_MD_PATH, note: "Framework bootstrap block updated; project prose byte-preserved" });
      } else {
        performed.push({ action: "unchanged", path: CLAUDE_MD_PATH, note: plannedClaude?.note });
      }
      frameworkBlocks.push({ path: CLAUDE_MD_PATH, sha256: sha256Of(renderedBlock.block) });
    } else {
      if (!fs.existsSync(claudeAbs)) {
        fs.writeFileSync(claudeAbs, rendered, "utf8");
        performed.push({ action: "add", path: CLAUDE_MD_PATH, note: "rendered with the Framework bootstrap block" });
      } else if (hashFile(claudeAbs) !== claudeEntry.sha256) {
        backup(CLAUDE_MD_PATH);
        fs.writeFileSync(claudeAbs, rendered, "utf8");
        performed.push({ action: "update", path: CLAUDE_MD_PATH, note: "re-rendered with the Framework bootstrap block" });
      } else {
        performed.push({ action: "unchanged", path: CLAUDE_MD_PATH });
      }
      managedEntries.push(claudeEntry);
    }
    const includeContent = derivedContent!.get(KNOWLEDGE_ROOT_INCLUDE_PATH);
    if (includeContent !== undefined) {
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
  }

  // T-V3-07 — the Codex root pointer follows the same ownership split as
  // CLAUDE.md. Absent files become whole-file managed pointers; existing
  // project files receive only the delimited block. A whole-file reduction is
  // possible only for an exact CLAUDE.md duplicate and the dedicated explicit
  // confirmation option; --force does not broaden that authority.
  // AGENTS.md is the shared bootstrap pointer, not a Codex binding. Only the
  // `.agents/` skill directory is runtime-specific.
  if (derivedContent?.has(AGENTS_MD_PATH)) {
    const rendered = derivedContent.get(AGENTS_MD_PATH)!;
    const relPath = AGENTS_MD_PATH;
    const abs = path.join(options.targetRoot, relPath);
    const entry: TemplateFileEntry = { path: relPath, sha256: sha256Of(rendered), size_bytes: Buffer.byteLength(rendered) };
    const overridden = overrideSet(config).has(relPath);
    const previousBlock = manifest?.framework_blocks?.find((block) => block.path === relPath);
    const confirmedReduction = options.confirmAgentsPointer === true && isProvableStaleAgentsDuplicate(options.targetRoot);
    const projectOwned = !confirmedReduction && (previousBlock !== undefined || (!oldFiles.has(relPath) && fs.existsSync(abs)));
    const renderedBlock = inspectBootstrapBlock(rendered);
    if (renderedBlock.state !== "valid") throw new Error("rendered AGENTS.md has no valid Framework bootstrap block");
    if (overridden) {
      performed.push({ action: "override", path: relPath, note: "explicit user choice in .agent-team/config.yaml — bootstrap block skipped" });
    } else if (projectOwned) {
      const current = fs.readFileSync(abs, "utf8");
      const inspected = inspectBootstrapBlock(current);
      if (inspected.state === "malformed") throw new Error("malformed AGENTS.md bootstrap block reached apply after preflight");
      const next = renderedBlock.block + (inspected.state === "valid" ? inspected.outside : current);
      if (next !== current) {
        backup(relPath);
        fs.writeFileSync(abs, next, "utf8");
        performed.push({ action: "update", path: relPath, note: "Framework bootstrap block updated; project bytes preserved" });
      } else {
        performed.push({ action: "unchanged", path: relPath, note: "project-owned bytes with current Framework block" });
      }
      frameworkBlocks.push({ path: relPath, sha256: sha256Of(renderedBlock.block) });
    } else if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, rendered, "utf8");
      performed.push({ action: "add", path: relPath, note: "generated pointer to CLAUDE.md" });
      managedEntries.push(entry);
    } else if (hashFile(abs) !== entry.sha256) {
      backup(relPath);
      fs.writeFileSync(abs, rendered, "utf8");
      performed.push({ action: "update", path: relPath, note: confirmedReduction ? "confirmed reduction to generated pointer (backed up)" : "regenerated pointer" });
      managedEntries.push(entry);
    } else {
      performed.push({ action: "unchanged", path: relPath });
      managedEntries.push(entry);
    }
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
      performed.push({ action: "remove-stale", path: conflict.path, note: "roster drift — agent prompt from another workspace role" });
    }
  }

  // T-V5-006 — apply the single managed contribution to the project-owned
  // `.gitignore`. Only the marked range is ours: bytes outside it are retained
  // verbatim, and the hash recorded below lets the next sync detect a hand edit
  // rather than replacing it. A file without a final newline receives the
  // block before its original bytes so no project byte is altered just to make
  // room for a marker line.
  const plannedGitignore = plan.entries.find((entry) => entry.path === GITIGNORE_PATH);
  if (plannedGitignore?.action === "override") {
    performed.push(plannedGitignore);
  } else if (plannedGitignore) {
    const gitignoreAbs = path.join(options.targetRoot, GITIGNORE_PATH);
    const current = fs.existsSync(gitignoreAbs) ? fs.readFileSync(gitignoreAbs, "utf8") : undefined;
    const inspected = current === undefined ? { state: "absent" as const } : inspectGitignoreBlock(current);
    // A malformed/user-modified block cannot reach apply unless --force was
    // requested. Even then it remains a conflict by design, so this guards an
    // impossible state rather than guessing at project-owned text.
    if (inspected.state !== "valid" && inspected.state !== "absent") {
      throw new Error("malformed .gitignore block reached apply after preflight");
    }
    const outside = inspected.state === "valid" ? inspected.outside : (current ?? "");
    const block = renderGitignoreBlock(
      GITIGNORE_BLOCK_ENTRIES.filter((managedPath) => gitignoreAlreadyCovers(outside, managedPath)),
      GITIGNORE_BLOCK_ENTRIES,
    );
    const next = inspected.state === "valid"
      ? current!.replace(inspected.block, block)
      : current === undefined || current === ""
        ? block
        : current.endsWith("\n")
          ? `${current}${block}`
          : `${block}${current}`;
    if (next !== current) {
      if (current !== undefined) backup(GITIGNORE_PATH);
      fs.writeFileSync(gitignoreAbs, next, "utf8");
      performed.push({ ...plannedGitignore, action: current === undefined ? "add" : "update" });
    } else {
      performed.push({ ...plannedGitignore, action: "unchanged" });
    }
    frameworkBlocks.push({ path: GITIGNORE_PATH, sha256: sha256Of(block) });
  }

  // Stale block cleanup — remove only the delimited range that the block hash
  // proves we last wrote. The backup contains the complete pre-removal file.
  const staleFrameworkBlockPaths = new Set(
    (manifest?.framework_blocks ?? [])
      .map((block) => block.path)
      .filter((relPath) => !templateManifest.files.some((file) => file.path === relPath)),
  );
  for (const plannedFor of plan.entries.filter((entry) => entry.action === "remove-stale" && staleFrameworkBlockPaths.has(entry.path))) {
    const abs = path.join(options.targetRoot, plannedFor.path);
    if (!fs.existsSync(abs)) continue;
    const current = fs.readFileSync(abs, "utf8");
    const inspected = inspectBootstrapBlock(current);
    if (inspected.state !== "valid") continue; // preflight already refused malformed input
    backup(plannedFor.path);
    fs.writeFileSync(abs, inspected.outside, "utf8");
    performed.push(plannedFor);
  }

  // Stale cleanup — only paths this Target's own manifest proves we manage(d).
  for (const plannedFor of plan.entries.filter((e) => e.action === "remove-stale")) {
    if (staleFrameworkBlockPaths.has(plannedFor.path)) continue;
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
    // Framework identity is the complete built payload, not this workspace
    // role's selected subset. Otherwise BA and DEV would record different
    // identities for the same checkout and status would report false skew.
    payload_digest: completeTemplateManifest.payload_digest ?? payloadDigest(completeTemplateManifest.files),
    ...(frameworkBlocks.length > 0 ? { framework_blocks: frameworkBlocks } : {}),
  };
  writeTargetManifest(options.targetRoot, freshManifest);

  return {
    performed,
    skippedConflicts: plan.conflicts,
    previousVersion,
    frameworkVersion: templateManifest.framework_version,
    backupDir,
    stackProfile: profilePlan?.stack,
    stackProfileMismatch: profilePlan?.mismatch,
  };
}
