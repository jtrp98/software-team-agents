import * as fs from "node:fs";
import * as path from "node:path";
import { payloadDigest, readTemplateManifest } from "../packaging/templateManifest.js";
import { resolveRoots } from "./roots.js";
import {
  isTargetInitialized,
  loadTargetConfig,
  readTargetManifest,
  type TargetConfig,
  type TargetManifest,
  type TargetStackConfig,
} from "./targetMeta.js";
import { devDerivedContent, pendingSyncEntries, planSync, type SyncPlanEntry } from "./syncEngine.js";
import {
  assetsForRole,
  detectWorkspaceKind,
  hasKnowledgeMarkers,
  resolveKnowledgeBinding,
  resolveTargetBinding,
  TargetBindingError,
  WORKSPACE_ROLE_LABEL,
  type KnowledgeBinding,
  type WorkspaceRole,
  type TargetBinding,
} from "./roleWorkspace.js";
import { classifySyncState, type SyncState } from "./version.js";
import { defaultInstallationConfigPath, loadInstallationConfig } from "../threeRepo/installation.js";
import { detectInstructionSurface, isNestedInstruction, type InstructionSurfaceEntry } from "../threeRepo/ownership.js";
import { targetStackWasHumanEdited } from "./targetProfile.js";
import { CLAUDE_SETTINGS_PATH, guardCoverage, guardCoverageIsPositive, inspectGuardWiring, type GuardCoverage } from "./guardSettings.js";
import { effectiveExecutionConfig, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";

/**
 * T-TARGET-10 + T-ROLE-18 — `software-team-agents status`: the whole
 * architecture in one read-only screen, in the language of the role whose
 * workspace it is run from. A BA sees their Knowledge workspace with Target
 * marked NOT REQUIRED; a DEV sees Target plus a validated Knowledge binding.
 */

export interface RuntimeReadiness {
  ready: boolean;
  detail: string;
}

export interface TargetStatus {
  targetRoot: string;
  frameworkRoot: string;
  frameworkVersion: string;
  /** Resolved or marker-detected role of this workspace, when determinable. */
  role?: WorkspaceRole;
  workspaceKind: ReturnType<typeof detectWorkspaceKind>;
  knowledgeRoot?: string;
  knowledgeBinding?: { knowledgeRoot: string; via: string };
  /** T-LV1 — BA-workspace only: the optional Target binding resolved from `target.path`, when one is set and valid; "invalid" carries the problem in targetRoot. Absent when unset (silent, never required). */
  targetBinding?: { targetRoot: string; via: string };
  targetId?: string;
  /** Cached deterministic Target profile; absent means not yet detected. */
  stack?: TargetStackConfig;
  stackProfileMismatch?: string;
  syncedVersion?: string;
  syncState: SyncState;
  /** Entries the current plan would write; unchanged and overridden paths are excluded. */
  syncChanges: SyncPlanEntry[];
  /** Same-version Framework payload difference; absent means unknown/not applicable. */
  frameworkPayloadSkew?: boolean;
  /** Managed paths whose on-disk content matches neither pristine nor shipped. */
  conflictCount: number;
  /**
   * T-WG9 — managed paths the project owned before the Framework ever synced
   * them (`untracked-file` collisions): sync leaves them alone, which keeps the
   * peace but can leave guards unwired. Reported per path so the prompt-setup
   * merge protocol can reconcile them; never a blocking condition.
   */
  projectOwnedPaths: string[];
  /** Complete read-only inventory of instructions that can affect this workspace. */
  instructionSurface: InstructionSurfaceEntry[];
  /** T-WG2 — agent-prompt files on disk belonging to the other workspace role. Never legitimate; sync --force removes them. */
  rosterDriftPaths: string[];
  managedFileCount: number;
  hooksInstalled: number;
  hooksRegistered: number;
  /**
   * T-WG1 — installation.yaml binds a Knowledge root (marker-complete) that was
   * never `init --role ba`'d there: every command past binding validation
   * succeeds, so nothing else notices the BA-workspace prompts don't exist anywhere
   * on the machine (F1 in workspace-guardrails-TASKS.md). Set to the bound
   * root's path when this applies; absent otherwise (unbound, or bound and
   * initialized).
   */
  knowledgeBoundButUninitialized?: string;
  claude: RuntimeReadiness;
  codex: RuntimeReadiness;
  opencode: RuntimeReadiness;
  /** V3 omission is healthy: the effective values reproduce pre-V3 behavior. */
  v3Configuration: { configured: boolean; detail: string };
}

export function v3ExecutionStatus(
  config: TargetConfig | undefined,
  staConfig?: StaConfig,
): TargetStatus["v3Configuration"] {
  const execution = config?.execution ?? staConfig?.execution;
  const effective = effectiveExecutionConfig(execution);
  const configured = Boolean(execution || staConfig?.routing || staConfig?.qa || staConfig?.verification);
  if (!configured) {
    return {
      configured: false,
      detail: "not configured — defaults apply (single / claude-code / deterministic gate enabled / paid fallback disabled)",
    };
  }
  return {
    configured: true,
    detail:
      `configured (mode=${effective.mode}, runner=${effective.runner}, ` +
      `handoff=${effective.allow_handoff ? "enabled" : "disabled"}, paid fallback=${effective.allow_paid_fallback ? "enabled" : "disabled"})`,
  };
}

function countFiles(dir: string, suffix: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

export function claudeReadiness(targetRoot: string, coverage?: GuardCoverage): RuntimeReadiness {
  const agents = countFiles(path.join(targetRoot, ".claude", "agents"), ".md");
  if (agents === 0) return { ready: false, detail: "no .claude/agents/*.md — run software-team-agents sync" };
  if (coverage) {
    if (coverage.level === "not-required") return { ready: true, detail: `${agents} agent(s); ${coverage.detail}` };
    if (coverage.level === "broken") return { ready: false, detail: `${coverage.detail} — run software-team-agents sync` };
    if (!guardCoverageIsPositive(coverage)) return { ready: false, detail: `unguarded — ${coverage.detail}` };
    return { ready: true, detail: `${agents} agent(s), ${coverage.detail}` };
  }
  const settingsPath = path.join(targetRoot, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return { ready: false, detail: "no .claude/settings.json — hooks unwired" };
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown[]> };
    const wired = ["PreToolUse", "Stop", "SubagentStop"].filter((event) => Array.isArray(settings.hooks?.[event]) && settings.hooks[event]!.length > 0);
    if (wired.length === 0) return { ready: false, detail: "settings.json wires no PreToolUse/Stop/SubagentStop hooks" };
    return { ready: true, detail: `${agents} agent(s), hooks wired (${wired.join(", ")})` };
  } catch (e) {
    return { ready: false, detail: `settings.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * T-V5-008 — bindings alone are not readiness. Counting `.codex/agents/*.toml`
 * and reporting READY is exactly the F-05 defect: a Codex session launches with
 * no guard of any kind. READY now requires a positive guard verdict too.
 */
export function codexReadiness(targetRoot: string, coverage: GuardCoverage): RuntimeReadiness {
  const md = countFiles(path.join(targetRoot, ".claude", "agents"), ".md");
  const toml = countFiles(path.join(targetRoot, ".codex", "agents"), ".toml");
  if (md === 0) return { ready: false, detail: "no agent sources synced yet — run software-team-agents sync" };
  if (toml < md) return { ready: false, detail: `${toml}/${md} bindings generated — run software-team-agents sync` };
  if (!guardCoverageIsPositive(coverage)) {
    return { ready: false, detail: `${toml} binding(s) match ${md} agent source(s), but UNGUARDED — ${coverage.detail}` };
  }
  return { ready: true, detail: `${toml} binding(s) match ${md} agent source(s)` };
}

/**
 * OpenCode readiness (T-OC5): bindings must be present and the sta-guards
 * plugin wired — OpenCode's headless default posture is allow-all (planning/v2
 * spike §7), so a workspace without the plugin would run unguarded. T-V5-008
 * moves the plugin half into the shared guard verdict and makes the partial
 * coverage explicit about which guards do and do not run here.
 */
export function opencodeReadiness(targetRoot: string, coverage: GuardCoverage): RuntimeReadiness {
  const md = countFiles(path.join(targetRoot, ".claude", "agents"), ".md");
  const agents = countFiles(path.join(targetRoot, ".opencode", "agent"), ".md");
  if (md === 0) return { ready: false, detail: "no agent sources synced yet — run software-team-agents sync" };
  if (agents < md) return { ready: false, detail: `${agents}/${md} bindings generated — run software-team-agents sync` };
  if (!guardCoverageIsPositive(coverage)) return { ready: false, detail: coverage.detail };
  return { ready: true, detail: `${agents} binding(s) match ${md} agent source(s); ${coverage.detail}` };
}

export function gatherStatus(options: { targetRoot?: string; templatesDir?: string; installationConfigPath?: string } = {}): TargetStatus {
  const roots = resolveRoots({ targetRoot: options.targetRoot });
  const templatesDir = options.templatesDir ?? path.join(roots.frameworkRoot, "templates");
  // The payload's own manifest decides what "installed" means — an explicit
  // templates dir (tests, unusual setups) outranks the ambient installation.
  const templateManifest = readTemplateManifest(templatesDir);
  const frameworkVersion = templateManifest.framework_version;
  const frameworkPayloadDigest = templateManifest.payload_digest ?? payloadDigest(templateManifest.files);
  const initialized = isTargetInitialized(roots.targetRoot);

  const config: TargetConfig | undefined = (() => {
    try {
      return loadTargetConfig(roots.targetRoot);
    } catch {
      return undefined;
    }
  })();
  const staConfig: StaConfig | undefined = (() => {
    try {
      return fs.existsSync(path.join(roots.targetRoot, ".sta", "config.yaml"))
        ? loadStaConfig(roots.targetRoot)
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const kind = detectWorkspaceKind(roots.targetRoot);
  const role: WorkspaceRole | undefined =
    config?.role ??
    (kind === "knowledge" ? "ba" : kind === "target" ? "dev" : undefined);

  let syncedVersion: string | undefined;
  let conflictCount = 0;
  let projectOwnedPaths: string[] = [];
  let rosterDriftPaths: string[] = [];
  let managedFileCount = 0;
  let syncState: SyncState = "NOT_INITIALIZED";
  let syncChanges: SyncPlanEntry[] = [];
  let frameworkPayloadSkew: boolean | undefined;
  let frameworkInstructionPaths = new Set<string>();
  let targetManifest: TargetManifest | undefined;
  if (initialized) {
    const manifest = readTargetManifest(roots.targetRoot);
    targetManifest = manifest;
    frameworkInstructionPaths = new Set(manifest.files.map((file) => file.path));
    syncedVersion = manifest.framework_version;
    if (manifest.framework_version === frameworkVersion && manifest.payload_digest !== undefined) {
      frameworkPayloadSkew = manifest.payload_digest !== frameworkPayloadDigest;
    }
    managedFileCount = manifest.files.length;
    try {
      const plan = planSync({
        targetRoot: roots.targetRoot,
        templatesDir,
        manifest,
        config,
        include: role ? assetsForRole(role) : undefined,
        role,
        // T-WG7 — a dev workspace's CLAUDE.md is judged against its rendered
        // bytes, so a healthy rendered workspace reports zero conflicts.
        derivedContent: devDerivedContent({
          targetRoot: roots.targetRoot,
          templatesDir,
          config,
          include: role ? assetsForRole(role) : undefined,
          installationConfigPath: options.installationConfigPath,
        })?.content,
      });
      const incompatible = classifySyncState(manifest.framework_version, frameworkVersion);
      syncChanges = pendingSyncEntries(plan);
      // Compatibility always wins: a cross-major payload must never be made to
      // look like a routine same-major update merely because the plan has work.
      syncState = incompatible ?? (syncChanges.length > 0 ? "OUTDATED" : "UP_TO_DATE");
      const conflicts = plan.conflicts;
      conflictCount = conflicts.length;
      projectOwnedPaths = conflicts.filter((c) => c.kind === "untracked-file").map((c) => c.path);
      rosterDriftPaths = conflicts.filter((c) => c.kind === "roster-drift").map((c) => c.path);
    } catch {
      // An unreadable payload must not make status crash. Preserve the
      // compatibility stop, but never claim freshness without a readable plan.
      syncState = classifySyncState(manifest.framework_version, frameworkVersion) ?? "OUTDATED";
    }
  }

  const guardWiring = inspectGuardWiring({ targetRoot: roots.targetRoot, templatesDir, manifest: targetManifest, config });
  if (!guardWiring.overridden && guardWiring.hooksInstalled > 0 && guardWiring.missingRegistrations.length === 0) {
    frameworkInstructionPaths.add(CLAUDE_SETTINGS_PATH);
  }

  // Knowledge picture depends on the role: required-and-validated for DEV,
  // informational for BA.
  let knowledgeBinding: KnowledgeBinding | undefined;
  if (role === "dev") {
    try {
      knowledgeBinding = resolveKnowledgeBinding({
        targetRoot: roots.targetRoot,
        configKnowledgePath: config?.knowledge?.path,
        installationConfigPath: options.installationConfigPath,
      });
    } catch (e) {
      knowledgeBinding = { knowledgeRoot: e instanceof Error ? e.message : String(e), via: "invalid" };
    }
  } else if (role === "ba") {
    try {
      knowledgeBinding = resolveKnowledgeBinding({ targetRoot: roots.targetRoot, installationConfigPath: options.installationConfigPath });
    } catch {
      knowledgeBinding = undefined;
    }
    // For BA the workspace itself IS the Knowledge root.
    knowledgeBinding = knowledgeBinding ?? { knowledgeRoot: roots.targetRoot, via: "workspace" };
  }

  // T-LV1 — BA-workspace-only, optional Target binding. Any resolution problem is
  // reported as "invalid" rather than thrown: status must never crash because
  // a Target binding is unset or wrong.
  let targetBinding: TargetBinding | undefined;
  if (role === "ba") {
    try {
      targetBinding = resolveTargetBinding({ knowledgeRoot: roots.targetRoot, configTargetPath: config?.target?.path });
    } catch (e) {
      if (e instanceof TargetBindingError) targetBinding = { targetRoot: e.message, via: "invalid" };
      else throw e;
    }
  }

  // T-WG1 — checked unconditionally (every status run, BA or DEV) against the
  // machine-wide installation binding, independent of this workspace's own
  // role: the whole point is to catch a Knowledge root nobody has ever
  // initialized, which is invisible from every other check here.
  let knowledgeBoundButUninitialized: string | undefined;
  try {
    const installed = loadInstallationConfig(options.installationConfigPath ?? defaultInstallationConfigPath());
    if (installed.knowledge_root && hasKnowledgeMarkers(installed.knowledge_root) && !isTargetInitialized(installed.knowledge_root)) {
      knowledgeBoundButUninitialized = installed.knowledge_root;
    }
  } catch {
    // No installation config, or unreadable — nothing to warn about.
  }

  return {
    targetRoot: roots.targetRoot,
    frameworkRoot: roots.frameworkRoot,
    frameworkVersion,
    role,
    workspaceKind: kind,
    knowledgeRoot: roots.knowledgeRoot,
    knowledgeBinding,
    targetBinding,
    targetId: config?.target_id,
    stack: config?.stack,
    stackProfileMismatch:
      config?.stack && targetStackWasHumanEdited(config.stack)
        ? "stack config differs from the last detected profile; human-edited values are authoritative"
        : undefined,
    syncedVersion,
    syncState,
    syncChanges,
    frameworkPayloadSkew,
    conflictCount,
    projectOwnedPaths,
    instructionSurface: detectInstructionSurface({
      targetRoot: roots.targetRoot,
      frameworkPaths: frameworkInstructionPaths,
    }),
    rosterDriftPaths,
    managedFileCount,
    hooksInstalled: guardWiring.hooksInstalled,
    hooksRegistered: guardWiring.hooksRegistered,
    knowledgeBoundButUninitialized,
    // T-V5-008 — every runtime's readiness is decided by the same verdict
    // function, so none of them can report READY without one.
    claude: claudeReadiness(roots.targetRoot, guardCoverage({ runtime: "claude", targetRoot: roots.targetRoot, wiring: guardWiring })),
    codex: codexReadiness(roots.targetRoot, guardCoverage({ runtime: "codex", targetRoot: roots.targetRoot })),
    opencode: opencodeReadiness(roots.targetRoot, guardCoverage({ runtime: "opencode", targetRoot: roots.targetRoot })),
    v3Configuration: v3ExecutionStatus(config, staConfig),
  };
}

export function renderStatus(status: TargetStatus): string {
  const lines: string[] = [];
  if (status.role) {
    lines.push(`Workspace role: ${WORKSPACE_ROLE_LABEL[status.role]} (${status.role})`);
    lines.push(`Workspace: ${status.role === "ba" ? "Knowledge" : "Target"}`);
  }
  lines.push(status.role === "ba" ? "Knowledge:" : "Target:");
  lines.push(`  ${status.targetRoot}${status.targetId ? ` (id: ${status.targetId})` : ""}`);
  if (status.role === "ba") {
    if (status.targetBinding && status.targetBinding.via !== "invalid") {
      lines.push("Target (optional, read-only):");
      lines.push(`  ${status.targetBinding.targetRoot} (via ${status.targetBinding.via})`);
    } else if (status.targetBinding && status.targetBinding.via === "invalid") {
      lines.push(`Target: NOT REQUIRED (optional; not needed for BA work) — configured target.path is invalid: ${status.targetBinding.targetRoot}`);
    } else {
      lines.push("Target: NOT REQUIRED (optional; not needed for BA work)");
    }
    if (status.knowledgeBinding && status.knowledgeBinding.via === "installation") {
      lines.push("Knowledge binding (informational):");
      lines.push(`  ${status.knowledgeBinding.knowledgeRoot}`);
    }
  }
  lines.push("Framework:");
  lines.push(`  ${status.frameworkRoot}`);
  lines.push(`  installed version: ${status.frameworkVersion}`);
  lines.push(`V3 config: ${status.v3Configuration.detail}`);
  if (status.role === "dev") {
    if (!status.knowledgeBinding) {
      lines.push("Knowledge: NOT BOUND — required for DEV (set knowledge.path in .agent-team/config.yaml)");
    } else if (status.knowledgeBinding.via === "invalid") {
      lines.push(`Knowledge: INVALID — ${status.knowledgeBinding.knowledgeRoot}`);
    } else {
      lines.push("Knowledge:");
      lines.push(`  ${status.knowledgeBinding.knowledgeRoot} (via ${status.knowledgeBinding.via}, read-only)`);
    }
  }
  lines.push("Sync:");
  lines.push(`  state: ${status.syncState}`);
  if (status.syncChanges.length > 0) {
    lines.push(`  managed updates available (${status.syncChanges.length}):`);
    for (const entry of status.syncChanges.slice(0, 10)) lines.push(`    ${entry.action}: ${entry.path}`);
    if (status.syncChanges.length > 10) lines.push(`    ... ${status.syncChanges.length - 10} more`);
    lines.push("    run `software-team-agents sync` to apply these managed updates");
  }
  if (status.frameworkPayloadSkew) {
    lines.push("  WARNING: installed Framework payload differs from the payload last synced at this same version");
  }
  if (status.syncState === "INCOMPATIBLE") {
    lines.push("  installed and synced Framework versions differ in major — review the changelog before re-syncing (sync --force)");
  }
  if (status.syncedVersion !== undefined) lines.push(`  synced Framework version: ${status.syncedVersion}`);
  if (status.role === "dev") {
    if (status.stack) {
      lines.push(`  Target stack: ${status.stack.profile} (${status.stack.package_manager}; ${status.stack.fingerprint})`);
      if (status.stackProfileMismatch) lines.push(`  WARNING: ${status.stackProfileMismatch}`);
    } else {
      lines.push("  Target stack: UNRESOLVED — run software-team-agents init --stack <name>");
    }
  }

  lines.push(`  managed files: ${status.managedFileCount}`);
  lines.push(`  Framework guard registrations: ${status.hooksRegistered}/${status.hooksInstalled} registered`);
  if (status.conflictCount > 0) lines.push(`  conflicts: ${status.conflictCount} — run software-team-agents sync to see them`);
  // T-WG9 — collision-aware reporting: paths the project owns are never a
  // blocking condition, but leaving them silent is how a workspace ends up
  // looking READY while its guards were never wired. Name each path and point
  // at the merge protocol.
  if (status.projectOwnedPaths.length > 0) {
    lines.push(`  project-owned paths left alone (${status.projectOwnedPaths.length}):`);
    for (const p of status.projectOwnedPaths) {
      const consequence = status.instructionSurface.find((entry) => entry.path === p)?.consequence;
      lines.push(`    ${p}${consequence ? ` — ${consequence}` : ""}`);
    }
    lines.push("    → reconcile via prompt-setup.md (\"Merging with the project's existing Claude setup\"), then claim them in .agent-team/config.yaml overrides");
  }
  if (status.instructionSurface.length > 0) {
    lines.push(`Instruction surface (${status.instructionSurface.length}):`);
    for (const entry of status.instructionSurface) {
      lines.push(
        `  ${entry.path} — owner=${entry.owner}, precedence=${entry.precedence}, Framework contribution=${entry.frameworkContributionPresent ? "present" : "absent"}` +
          (entry.consequence ? `; ${entry.consequence}` : ""),
      );
    }
  }
  const nestedInstructions = status.instructionSurface.filter(isNestedInstruction);
  if (nestedInstructions.length > 0) {
    lines.push(`WARNING: nested instructions may shadow or contradict the root bootstrap (${nestedInstructions.length}):`);
    for (const entry of nestedInstructions) lines.push(`  ${entry.path} — project-owned and read-only; review its effective scope`);
  }
  if (status.rosterDriftPaths.length > 0) {
    lines.push(`WARNING: roster drift — agent prompt(s) from another workspace role found here (${status.rosterDriftPaths.length}):`);
    for (const p of status.rosterDriftPaths) lines.push(`    ${p}`);
    lines.push("    → run `software-team-agents sync --force` to remove them (backed up first)");
  }
  if (status.knowledgeBoundButUninitialized) {
    lines.push(
      `WARNING: Knowledge root bound in installation.yaml (${status.knowledgeBoundButUninitialized}) has no .agent-team/config.yaml — the BA workspace role is not usable anywhere on this machine yet.`,
    );
    lines.push(`  fix: cd "${status.knowledgeBoundButUninitialized}" && software-team-agents init --role ba`);
  }
  lines.push(`Claude: ${status.claude.ready ? "READY" : "NOT READY"} — ${status.claude.detail}`);
  lines.push(`Codex: ${status.codex.ready ? "READY" : "NOT READY"} — ${status.codex.detail}`);
  lines.push(`OpenCode: ${status.opencode.ready ? "READY" : "NOT READY"} — ${status.opencode.detail}`);
  if (status.role !== "ba" && status.knowledgeRoot) lines.push(`Installation Knowledge root: ${status.knowledgeRoot}`);
  return lines.join("\n");
}
