import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplateManifest } from "../packaging/templateManifest.js";
import { resolveRoots } from "./roots.js";
import {
  isTargetInitialized,
  loadTargetConfig,
  readTargetManifest,
  type TargetConfig,
} from "./targetMeta.js";
import { planSync } from "./syncEngine.js";
import { assetsForRole, detectWorkspaceKind, resolveKnowledgeBinding, ROLE_LABEL, type KnowledgeBinding, type RoleName } from "./roleWorkspace.js";
import { classifySyncState, type SyncState } from "./version.js";

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
  role?: RoleName;
  workspaceKind: ReturnType<typeof detectWorkspaceKind>;
  knowledgeRoot?: string;
  knowledgeBinding?: { knowledgeRoot: string; via: string };
  targetId?: string;
  syncedVersion?: string;
  syncState: SyncState;
  /** Managed paths whose on-disk content matches neither pristine nor shipped. */
  conflictCount: number;
  managedFileCount: number;
  claude: RuntimeReadiness;
  codex: RuntimeReadiness;
}

function countFiles(dir: string, suffix: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

export function claudeReadiness(targetRoot: string): RuntimeReadiness {
  const agents = countFiles(path.join(targetRoot, ".claude", "agents"), ".md");
  if (agents === 0) return { ready: false, detail: "no .claude/agents/*.md — run software-team-agents sync" };
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

export function codexReadiness(targetRoot: string): RuntimeReadiness {
  const md = countFiles(path.join(targetRoot, ".claude", "agents"), ".md");
  const toml = countFiles(path.join(targetRoot, ".codex", "agents"), ".toml");
  if (md === 0) return { ready: false, detail: "no agent sources synced yet — run software-team-agents sync" };
  if (toml < md) return { ready: false, detail: `${toml}/${md} bindings generated — run software-team-agents sync` };
  return { ready: true, detail: `${toml} binding(s) match ${md} agent source(s)` };
}

export function gatherStatus(options: { targetRoot?: string; templatesDir?: string; installationConfigPath?: string } = {}): TargetStatus {
  const roots = resolveRoots({ targetRoot: options.targetRoot });
  const templatesDir = options.templatesDir ?? path.join(roots.frameworkRoot, "templates");
  // The payload's own manifest decides what "installed" means — an explicit
  // templates dir (tests, unusual setups) outranks the ambient installation.
  const frameworkVersion = readTemplateManifest(templatesDir).framework_version;
  const initialized = isTargetInitialized(roots.targetRoot);

  const config: TargetConfig | undefined = (() => {
    try {
      return loadTargetConfig(roots.targetRoot);
    } catch {
      return undefined;
    }
  })();
  const kind = detectWorkspaceKind(roots.targetRoot);
  const role: RoleName | undefined =
    config?.role ??
    (kind === "knowledge" ? "ba" : kind === "target" ? "dev" : undefined);

  let syncedVersion: string | undefined;
  let conflictCount = 0;
  let managedFileCount = 0;
  let syncState: SyncState = "NOT_INITIALIZED";
  if (initialized) {
    const manifest = readTargetManifest(roots.targetRoot);
    syncedVersion = manifest.framework_version;
    managedFileCount = manifest.files.length;
    syncState = classifySyncState(manifest.framework_version, frameworkVersion);
    try {
      conflictCount = planSync({
        targetRoot: roots.targetRoot,
        templatesDir,
        manifest,
        config,
        include: role ? assetsForRole(role) : undefined,
      }).conflicts.length;
    } catch {
      // An unreadable payload must not make status crash; conflicts stay visible via version drift.
    }
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

  return {
    targetRoot: roots.targetRoot,
    frameworkRoot: roots.frameworkRoot,
    frameworkVersion,
    role,
    workspaceKind: kind,
    knowledgeRoot: roots.knowledgeRoot,
    knowledgeBinding,
    targetId: config?.target_id,
    syncedVersion,
    syncState,
    conflictCount,
    managedFileCount,
    claude: claudeReadiness(roots.targetRoot),
    codex: codexReadiness(roots.targetRoot),
  };
}

export function renderStatus(status: TargetStatus): string {
  const lines: string[] = [];
  if (status.role) {
    lines.push(`Role: ${ROLE_LABEL[status.role]} (${status.role})`);
    lines.push(`Workspace: ${status.role === "ba" ? "Knowledge" : "Target"}`);
  }
  lines.push(status.role === "ba" ? "Knowledge:" : "Target:");
  lines.push(`  ${status.targetRoot}${status.targetId ? ` (id: ${status.targetId})` : ""}`);
  if (status.role === "ba") {
    lines.push("Target: NOT REQUIRED (optional; not needed for BA work)");
    if (status.knowledgeBinding && status.knowledgeBinding.via === "installation") {
      lines.push("Knowledge binding (informational):");
      lines.push(`  ${status.knowledgeBinding.knowledgeRoot}`);
    }
  }
  lines.push("Framework:");
  lines.push(`  ${status.frameworkRoot}`);
  lines.push(`  installed version: ${status.frameworkVersion}`);
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
  if (status.syncState === "INCOMPATIBLE") {
    lines.push("  installed and synced Framework versions differ in major — review the changelog before re-syncing (sync --force)");
  }
  if (status.syncedVersion !== undefined) lines.push(`  synced Framework version: ${status.syncedVersion}`);
  lines.push(`  managed files: ${status.managedFileCount}`);
  if (status.conflictCount > 0) lines.push(`  conflicts: ${status.conflictCount} — run software-team-agents sync to see them`);
  lines.push(`Claude: ${status.claude.ready ? "READY" : "NOT READY"} — ${status.claude.detail}`);
  lines.push(`Codex: ${status.codex.ready ? "READY" : "NOT READY"} — ${status.codex.detail}`);
  if (status.role !== "ba" && status.knowledgeRoot) lines.push(`Installation Knowledge root: ${status.knowledgeRoot}`);
  return lines.join("\n");
}
