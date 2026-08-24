import * as fs from "node:fs";
import * as path from "node:path";
import { defaultInstallationConfigPath, loadInstallationConfig } from "../threeRepo/installation.js";
import type { TemplateManifest } from "../packaging/templateManifest.js";

/**
 * T-ROLE-01 / T-ROLE-02 — the Role Workspace model.
 *
 *   > BA works in Knowledge. DEV works in Target. Framework powers both.
 *
 * A role decides WHERE execution happens and WHAT the Framework syncs there:
 *
 *   BA  workspace = knowledgeRoot   (Target never required)
 *   DEV workspace = targetRoot      (Knowledge required as read context)
 *
 * The Framework stays the only sync source in both directions —
 * Framework → Knowledge and Framework → Target, never Knowledge ⇄ Target
 * (T-ROLE-14/T-ROLE-15): requirements are not copied into apps, source is not
 * copied into knowledge.
 */

export type RoleName = "ba" | "dev";

export const ROLE_LABEL: Record<RoleName, string> = {
  ba: "BA",
  dev: "DEV",
};

export const ROLE_WORKSPACE_KIND: Record<RoleName, "knowledge" | "target"> = {
  ba: "knowledge",
  dev: "target",
};

/** Which agent prompts a role's workspace materializes. BA lanes don't carry engineer prompts; DEV carries the full roster. */
export const BA_LANE_AGENTS: readonly string[] = [
  "business-analyst",
  "system-analyst",
  "project-manager",
  "test-planner",
];

/**
 * T-ROLE-10 / T-ROLE-11 — role-aware managed-asset profiles over the template payload.
 *
 * Both roles get hooks + settings (the guards travel with every workspace),
 * skills (.claude/scripts), shared instructions, policies, and CLAUDE.md. They
 * differ in agent roster and in orchestrator-only payload (contracts,
 * workflows, stacks, layout/test-pyramid/escalation YAML) that only a DEV/Target
 * workspace needs because only there does the pipeline drive engineers.
 */
export function assetsForRole(role: RoleName): (relPath: string) => boolean {
  if (role === "dev") return () => true;
  const baAgents = new Set(BA_LANE_AGENTS);
  return (relPath) => {
    if (relPath === "CLAUDE.md") return true;
    if (relPath.startsWith(".claude/agents/")) {
      if (!relPath.endsWith(".md")) return false; // e.g. README fragments — none today, but stay strict
      return baAgents.has(path.basename(relPath, ".md"));
    }
    if (relPath.startsWith(".claude/hooks/") || relPath.startsWith(".claude/scripts/") || relPath.startsWith(".claude/shared/")) return true;
    if (relPath === ".claude/settings.json") return true;
    // OpenCode guards travel with every workspace, like the Claude hooks do:
    // the plugin is authored payload; `.opencode/agent/` files are derived at
    // sync time and never ship in the template payload at all.
    if (relPath.startsWith(".opencode/plugin/")) return true;
    if (relPath.startsWith("policies/")) return true;
    // contracts/, workflows/, stacks/, layout.yaml, escalation-policy.yaml,
    // test-pyramid.yaml — engineer-pipeline payload, not BA tooling.
    return false;
  };
}

/** The effective payload for a role: a copy of the manifest with excluded files removed. Stale detection then cleans anything a profile drop leaves behind. */
export function filterManifestForRole(manifest: TemplateManifest, role: RoleName): TemplateManifest {
  const include = assetsForRole(role);
  return { ...manifest, files: manifest.files.filter((f) => include(f.path)) };
}

// --- repository kind detection (T-ROLE-16) ---------------------------------

export type WorkspaceKind = "knowledge" | "target" | "ambiguous" | "unrecognized";

/**
 * Deliberately excludes `_docs/`: this framework writes `_docs/module/<name>/`
 * into TARGET repositories, so the folder exists in both roles by design and
 * cannot discriminate between them. Counting it made every app repo that owns a
 * docs folder — i.e. every target once its first module doc lands — come back
 * "ambiguous", forcing an explicit `--role` on a repository whose kind was never
 * actually in doubt. The three markers left are Knowledge-only.
 */
const KNOWLEDGE_MARKERS: readonly string[] = ["knowledge", "knowledge-policy.yaml", "targets.yaml"];
const APP_SOURCE_MARKERS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "go.mod",
  "Cargo.toml",
];

function hasDir(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function hasFile(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}

export function hasKnowledgeMarkers(dir: string): boolean {
  return KNOWLEDGE_MARKERS.some((m) => (m === "knowledge" ? hasDir(dir, m) : hasFile(dir, m)));
}

function hasAppSourceMarkers(dir: string): boolean {
  if (APP_SOURCE_MARKERS.some((m) => hasFile(dir, m))) return true;
  // .NET solutions/projects live as directories-of-files with distinctive extensions.
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"));
  } catch {
    return false;
  }
}

/**
 * Classifies an initialized-or-not repository root for `init`.
 * Both marker families present (a legacy monorepo, this framework checkout)
 * or none → ambiguous/unrecognized, and init requires an explicit --role.
 */
export function detectWorkspaceKind(dir: string): WorkspaceKind {
  const knowledge = hasKnowledgeMarkers(dir);
  const appSource = hasAppSourceMarkers(dir);
  if (knowledge && appSource) return "ambiguous";
  if (knowledge) return "knowledge";
  if (appSource) return "target";
  return "unrecognized";
}

// --- Knowledge binding (T-ROLE-06) -----------------------------------------

export interface KnowledgeBinding {
  /** Absolute, validated path of the bound Knowledge root. */
  knowledgeRoot: string;
  /** Where the binding came from — recovery advice names it. "invalid" carries the problem text in knowledgeRoot instead. */
  via: "workspace-config" | "installation" | "workspace" | "invalid";
}

export class KnowledgeBindingError extends Error {}

function looksLikeKnowledgeRoot(candidate: string): boolean {
  return hasKnowledgeMarkers(candidate);
}

function isSameOrNested(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return na === nb || na.startsWith(`${nb}${path.sep}`) || nb.startsWith(`${na}${path.sep}`);
}

/**
 * Resolves the Knowledge root a DEV workspace depends on:
 * `.agent-team/config.yaml` `knowledge.path` first (repo-relative binding,
 * committed with the target), then the machine-wide installation binding.
 * Fail-closed with actionable recovery when nothing valid resolves (T-ROLE-08).
 */
export function resolveKnowledgeBinding(options: {
  targetRoot: string;
  configKnowledgePath?: string;
  installationConfigPath?: string;
}): KnowledgeBinding | undefined {
  if (options.configKnowledgePath) {
    const raw = options.configKnowledgePath;
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(options.targetRoot, raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new KnowledgeBindingError(
        `Knowledge root not found: "${raw}" resolves to ${resolved} — fix knowledge.path in .agent-team/config.yaml, or clone the team's Knowledge repo there`,
      );
    }
    if (!looksLikeKnowledgeRoot(resolved)) {
      throw new KnowledgeBindingError(
        `"${resolved}" is not a Knowledge repository (no knowledge/, targets.yaml or knowledge-policy.yaml) — point knowledge.path at the repo cloned from the team's Knowledge remote`,
      );
    }
    if (isSameOrNested(resolved, options.targetRoot)) {
      throw new KnowledgeBindingError(`Knowledge root must be separate from the Target — "${raw}" resolves inside the workspace`);
    }
    return { knowledgeRoot: fs.realpathSync.native(resolved), via: "workspace-config" };
  }

  try {
    const config = loadInstallationConfig(options.installationConfigPath ?? defaultInstallationConfigPath());
    const candidate = config.knowledge_root;
    if (candidate && looksLikeKnowledgeRoot(candidate) && !isSameOrNested(candidate, options.targetRoot)) {
      return { knowledgeRoot: candidate, via: "installation" };
    }
    if (candidate && !looksLikeKnowledgeRoot(candidate)) {
      throw new KnowledgeBindingError(
        `installation.yaml binds Knowledge root "${candidate}" but it has no knowledge/targets.yaml/knowledge-policy.yaml markers — re-run \`sta configure knowledge-root <path>\` with the real Knowledge repo`,
      );
    }
    return undefined;
  } catch (e) {
    if (e instanceof KnowledgeBindingError) throw e;
    return undefined; // no installation config — treated like any other missing optional binding here; callers decide whether that is fatal
  }
}

// --- write policy wiring (T-ROLE-12 / T-ROLE-13) ----------------------------

/**
 * Environment for launching a role's runtime session. The guards
 * (.claude/hooks/block-outside-repo.js) allow writes under the session root
 * plus AGENTCLAUDE_WRITABLE_WORK_ROOTS — so the policy is enforced by giving
 * each launch exactly its own workspace and an EXPLICITLY EMPTY extra-roots
 * list (never inherited from the user's shell):
 *
 *   BA  → writable: knowledgeRoot only. Target/Framework writes fail closed.
 *   DEV → writable: targetRoot only. Knowledge/Framework writes fail closed.
 */
export function launchEnv(role: RoleName, existingEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The role is part of the signature so call sites state whose policy they
  // launch under; today both roles enforce the same shape — own workspace
  // writable, zero cross-root grants — via cwd plus this explicit empty list.
  void role;
  return {
    ...existingEnv,
    AGENTCLAUDE_WRITABLE_WORK_ROOTS: "[]",
  };
}
