import * as fs from "node:fs";
import * as path from "node:path";
import { defaultInstallationConfigPath, loadInstallationConfig, canonicalPathForComparison } from "../threeRepo/installation.js";
import { resolveInstallationRoot } from "../threeRepo/rootSelector.js";
import { loadLocalTargetMapping, LocalTargetMappingError, type ResolvedLocalTarget } from "../threeRepo/localTargets.js";
import { loadTargetRegistry, targetById, TargetRegistryError } from "../threeRepo/targets.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { GUARD_TARGET_WORK_ROOTS_ENV, serializeGuardTargetWorkRoots, type GuardTargetWorkRoot } from "../agents/pathPermissions.js";
import { resolveWorkspaceRole } from "./roots.js";
import type { TargetConfig, TargetManifest } from "./targetMeta.js";

/**
 * The Role Workspace model.
 *
 *   > BA works in Knowledge. DEV works in Target. Framework powers both.
 *
 * A role decides WHERE execution happens and WHAT the Framework syncs there:
 *
 *   BA  workspace = knowledgeRoot   (Target never required)
 *   DEV workspace = targetRoot      (Knowledge binding is read context,
 *                                    resolved per session — never forced:
 *                                    V10 TASK-027)
 *
 * The Framework stays the only sync source in both directions — Framework →
 * Knowledge and Framework → Target, never Knowledge ⇄ Target: requirements
 * are not copied into apps, source is not copied into knowledge.
 */

/** Where an interactive workspace runs and which managed payload it receives. */
export type WorkspaceRole = "ba" | "dev";
export type WorkspaceRuntime = "claude" | "codex" | "opencode" | "antigravity";

/** The recorded set wins; a manifest with non-Claude renderings but no
 * recorded runtime config is conservatively treated as opt-in to the three runtimes that
 * predate the recorded-set field. `antigravity` is deliberately absent: no manifest old
 * enough to reach this branch can have been synced with it, so inferring it would demand
 * bindings the workspace was never given. */
export function runtimesForWorkspace(config: TargetConfig | undefined, manifest?: TargetManifest): readonly WorkspaceRuntime[] {
  if (config?.runtimes?.length) return config.runtimes;
  const legacyBindings = manifest?.files.some((file) =>
    file.path.startsWith(".codex/") || file.path.startsWith(".opencode/") || file.path.startsWith(".agents/"),
  );
  return legacyBindings ? ["claude", "codex", "opencode"] : ["claude"];
}

export const WORKSPACE_ROLE_LABEL: Record<WorkspaceRole, string> = {
  ba: "BA",
  dev: "DEV",
};

export const ROLE_WORKSPACE_KIND: Record<WorkspaceRole, "knowledge" | "target"> = {
  ba: "knowledge",
  dev: "target",
};

/**
 * One managed payload, not two.
 *
 * The split profiles existed to keep a Target checkout from carrying BA
 * prompts and a Knowledge checkout from carrying engineer payload. With a
 * single workspace both live in the same repository, and the BA profile's
 * omission of `contracts/` was the worst of it: the guard hook reads
 * `contracts/<role>.yaml` from the workspace root and fails open when it
 * cannot (V10 D7), so the profile that dropped them disabled the per-role
 * layer silently. Nothing filters the manifest now — `runTargetSync` takes no
 * `include` and materialises every managed file.
 */

// --- repository kind detection -----------------------------------------------

export type WorkspaceKind = "knowledge" | "target" | "ambiguous" | "unrecognized";

/**
 * Deliberately excludes `_docs/`: this framework writes `_docs/module/<name>/`
 * into TARGET repositories, so the folder exists in both roles by design and
 * cannot discriminate between them. Counting it made every app repo that owns a
 * docs folder — i.e. every target once its first module doc lands — come back
 * "ambiguous", forcing an explicit `--role` on a repository whose kind was never
 * actually in doubt. The markers left are Knowledge-only: `knowledge/` and
 * `targets.yaml` are both committed, so a Knowledge repository is recognised
 * from a fresh clone, before any `init`.
 */
const KNOWLEDGE_MARKERS: readonly string[] = ["knowledge", "targets.yaml"];
export const APP_SOURCE_MARKERS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Directory.Build.props",
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
    return fs.lstatSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}

export function hasKnowledgeMarkers(dir: string): boolean {
  return KNOWLEDGE_MARKERS.some((m) => (m === "knowledge" ? hasDir(dir, m) : hasFile(dir, m)));
}

/**
 * The recorded role of an already-initialised workspace. Once `init` has run,
 * the workspace *states* what it is; guessing from files is only necessary
 * before that. One reader, in `roots.ts` — the guard hook applies the same rule
 * to decide what this workspace may write, and two readers of one field are two
 * answers waiting to disagree.
 */
function recordedWorkspaceRole(dir: string): "ba" | "dev" | undefined {
  return resolveWorkspaceRole(dir) ?? undefined;
}

function hasAppSourceMarkers(dir: string): boolean {
  const hasDirectMarker = (candidate: string): boolean => {
    if (APP_SOURCE_MARKERS.some((m) => hasFile(candidate, m))) return true;
    try {
      return fs.readdirSync(candidate, { withFileTypes: true }).some(
        (entry) => !entry.isSymbolicLink() && entry.isFile() && (entry.name.endsWith(".sln") || entry.name.endsWith(".csproj")),
      );
    } catch {
      return false;
    }
  };
  if (hasDirectMarker(dir)) return true;
  const skip = new Set(["node_modules", ".git", "dist", ".workflow", ".next", "build"]);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(
      (entry) => !entry.isSymbolicLink() && entry.isDirectory() && !skip.has(entry.name) && hasDirectMarker(path.join(dir, entry.name)),
    );
  } catch {
    return false;
  }
}

/**
 * Classifies an initialized-or-not repository root for `init`.
 * Both marker families present (a legacy monorepo, this framework checkout)
 * or none → ambiguous/unrecognized, and init requires an explicit --role.
 *
 * A workspace that has already been initialised is classified by the role it
 * recorded, which outranks every marker: a DEV workspace that also carries
 * Knowledge-shaped files is `target`, not `ambiguous`, because a person
 * already answered that question at `init`. Markers are what classify a
 * repository that has never been initialised.
 */
export function detectWorkspaceKind(dir: string): WorkspaceKind {
  const recorded = recordedWorkspaceRole(dir);
  if (recorded) return recorded === "ba" ? "knowledge" : "target";
  const knowledge = hasKnowledgeMarkers(dir);
  const appSource = hasAppSourceMarkers(dir);
  if (knowledge && appSource) return "ambiguous";
  if (knowledge) return "knowledge";
  if (appSource) return "target";
  return "unrecognized";
}

/** What a workspace IS — the Knowledge workspace or a Target checkout — for display and
 * resolution branches that used to key on the recorded role. Markers classify an
 * uninitialized checkout; a legacy recorded role classifies an old one the markers
 * cannot place. It identifies the checkout; it never grants writes. */
export type WorkspaceShape = "knowledge" | "target" | "other";

export function workspaceShapeOf(kind: WorkspaceKind, recordedRole: WorkspaceRole | undefined): WorkspaceShape {
  if (kind === "knowledge") return "knowledge";
  if (kind === "target") return "target";
  if (recordedRole === "ba") return "knowledge";
  if (recordedRole === "dev") return "target";
  return "other";
}

// --- Knowledge binding -------------------------------------------------------

export interface KnowledgeBinding {
  /** Absolute, validated path of the bound Knowledge root. */
  knowledgeRoot: string;
  /** Where the binding came from — recovery advice names it. "invalid" carries the problem text in knowledgeRoot instead. */
  via: "workspace-config" | "installation" | "workspace" | "invalid";
  /** The selected root's name when an installation resolved the binding (DR §6
   * launch contract). Undefined in legacy single-repo mode — there is no name,
   * and a path riding alone is what marks the session unmanaged. */
  rootName?: string;
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
 * Resolves the Knowledge root a DEV workspace depends on.
 *
 * Since named roots (DR §3 rule 7) the legacy `.agent-team/config.yaml`
 * `knowledge.path` is a *compatibility assertion*, not a selector: the root
 * still comes from the installation's selected root, and a workspace-committed
 * path that no longer matches it is a drift the command refuses with a
 * migration message — the two files disagreeing about which Knowledge
 * repository is in play is exactly the "wrote into the wrong repo" failure
 * this framework exists to prevent.
 *
 * An installation file that exists but cannot be loaded throws (the old
 * "callers decide whether that is fatal" fallback let a broken installation
 * read as no Knowledge at all); only a *missing* installation file leaves the
 * legacy binding standing.
 */
export function resolveKnowledgeBinding(options: {
  targetRoot: string;
  configKnowledgePath?: string;
  installationConfigPath?: string;
  requestedRootName?: string;
}): KnowledgeBinding | undefined {
  const installationPath = options.installationConfigPath ?? defaultInstallationConfigPath();
  const installation = fs.existsSync(installationPath)
    ? loadInstallationConfig(installationPath)
    : undefined;
  const selected = installation
    ? resolveInstallationRoot(installation, options.requestedRootName)
    : undefined;

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
    const canonical = fs.realpathSync.native(resolved);
    if (selected && canonicalPathForComparison(canonical) !== canonicalPathForComparison(selected.path)) {
      throw new KnowledgeBindingError(
        `knowledge.path "${raw}" resolves to ${canonical}, which does not match the selected Knowledge root "${selected.name}" (${selected.path}) — ` +
          "knowledge.path is a compatibility assertion since named Knowledge roots; update .agent-team/config.yaml or rebind the installation (`sta configure knowledge-root`), never edit targets.yaml by hand",
      );
    }
    return { knowledgeRoot: canonical, via: "workspace-config", rootName: selected?.name };
  }

  if (!selected) return undefined;
  if (!looksLikeKnowledgeRoot(selected.path)) {
    throw new KnowledgeBindingError(
      `installation.yaml binds Knowledge root "${selected.path}" but it has no knowledge/targets.yaml/knowledge-policy.yaml markers — re-run \`sta configure knowledge-root <path>\` with the real Knowledge repo`,
    );
  }
  // DR §6 launch contract: the launcher hands the child the realpath'd
  // canonical path, so hooks and prompts compare against the same string the
  // filesystem answers for.
  const candidate = fs.realpathSync.native(selected.path);
  if (isSameOrNested(candidate, options.targetRoot)) return undefined;
  return { knowledgeRoot: candidate, via: "installation", rootName: selected.name };
}

// --- Target binding ----------------------------------------------------------

export interface TargetBinding {
  /** Absolute, validated path of the bound Target root. */
  targetRoot: string;
  /** Where the binding came from — recovery advice names it. "invalid" carries the problem text in targetRoot instead. */
  via: "local-mapping" | "invalid";
  /** The Target's stable identity when the binding resolved by `target_id`. */
  targetId?: string;
}

export class TargetBindingError extends Error {}

function looksLikeTargetRoot(candidate: string): boolean {
  return hasAppSourceMarkers(candidate);
}

/**
 * Resolves the Target root a BA workspace may optionally read from. Identity
 * travels in the shared config (`target_id`), and the machine path is
 * resolved per machine through the `.workflow/targets.local.yaml` +
 * `targets.yaml` join `threeRepo/localTargets.ts` already owns — reusing
 * `loadLocalTargetMapping` and `targetById`, not a second resolver. There is
 * no committed-path fallback: a workspace still carrying the removed
 * `target.path` resolves to no binding here, and `targetMeta.removedTargetPath()`
 * is what lets `status` report the leftover with its fix rather than leaving
 * it mysterious.
 *
 * Like Knowledge for DEV, a Target binding is never required for BA: with no
 * `target_id` set this returns undefined silently. Every other failure mode
 * throws TargetBindingError so a caller can report it — callers never treat
 * that as fatal, they only decide how to describe it.
 */
export function resolveTargetBinding(options: {
  knowledgeRoot: string;
  configTargetId?: string;
  /** Needed to validate the local mapping's overlap rule; defaults to this CLI's own checkout. */
  frameworkRoot?: string;
}): TargetBinding | undefined {
  if (!options.configTargetId) return undefined;
  return resolveTargetById(options.configTargetId, options);
}

/** Identity → machine path, through the one Target-location mechanism this framework has. */
function resolveTargetById(targetId: string, options: { knowledgeRoot: string; frameworkRoot?: string }): TargetBinding {
  let registry;
  try {
    registry = loadTargetRegistry(options.knowledgeRoot);
  } catch (error) {
    throw new TargetBindingError(
      `cannot resolve Target "${targetId}" by id: ${error instanceof Error ? error.message : String(error)} — Target identities live in targets.yaml in the Knowledge root`,
    );
  }
  try {
    targetById(registry, targetId);
  } catch (error) {
    if (error instanceof TargetRegistryError) {
      throw new TargetBindingError(`${error.message} — register it in targets.yaml before binding it by target_id`);
    }
    throw error;
  }
  let mapping: ResolvedLocalTarget[];
  try {
    mapping = loadLocalTargetMapping(options.knowledgeRoot, registry, options.frameworkRoot ?? defaultProjectRoot());
  } catch (error) {
    if (error instanceof LocalTargetMappingError) {
      throw new TargetBindingError(
        `Target "${targetId}" has no usable local mapping: ${error.message} — record this machine's checkout under .workflow/targets.local.yaml in the Knowledge root`,
      );
    }
    throw error;
  }
  const entry = mapping.find((candidate) => candidate.target_id === targetId);
  if (!entry) {
    throw new TargetBindingError(
      `no local mapping for Target "${targetId}" — add "${targetId}:" with this machine's path under targets: in .workflow/targets.local.yaml in the Knowledge root`,
    );
  }
  // loadLocalTargetMapping already ran assertStandaloneRepositoryRoot and the
  // overlap rules; looksLikeTargetRoot is the one check it does not own.
  if (!looksLikeTargetRoot(entry.path)) {
    throw new TargetBindingError(
      `"${entry.path}" (Target "${targetId}" from .workflow/targets.local.yaml) is not a Target repository ` +
        "(no package.json/pyproject.toml/... application markers) — fix its mapping path",
    );
  }
  return { targetRoot: entry.path, via: "local-mapping", targetId };
}

/**
 * Every Target this machine maps, as read-only guard identification for one
 * interactive session (V10 TASK-023).
 *
 * `access: "read"` for all of them is the recorded answer to the write-scope
 * question, not a default: a person types in an interactive session, so it
 * carries no `STA_ROLE`, and a guard with no role skips every per-role layer
 * it has. Granting write there would leave a Target defended by the universal
 * floor alone. Writing a Target stays the orchestrated path's job, where a
 * stage is named and `packet.scope.allow` bounds it.
 *
 * The session's own workspace is excluded: it is writable through the session
 * root, and listing it here would refuse every write the session exists to make.
 *
 * Returns [] when no mapping resolves — an unmapped machine is the normal case
 * for a workspace that never bound a Target, never an error.
 */
export function resolveSessionTargetWorkRoots(options: {
  knowledgeRoot: string;
  workspaceRoot: string;
  frameworkRoot?: string;
}): GuardTargetWorkRoot[] {
  let mapping: ResolvedLocalTarget[];
  try {
    const registry = loadTargetRegistry(options.knowledgeRoot);
    mapping = loadLocalTargetMapping(options.knowledgeRoot, registry, options.frameworkRoot ?? defaultProjectRoot());
  } catch {
    return [];
  }
  const own = canonicalOrResolved(options.workspaceRoot);
  return mapping
    .filter((entry) => canonicalOrResolved(entry.path) !== own)
    .map((entry) => ({ targetId: entry.target_id, path: entry.path, access: "read" as const }));
}

function canonicalOrResolved(candidate: string): string {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return path.resolve(candidate);
  }
}

// --- write policy wiring -----------------------------------------------------

/**
 * Environment for launching an interactive runtime session.
 *
 * One workspace now carries the whole payload, so what a session may write is
 * no longer a property of which command opened it. The rule is the session
 * root and nothing else: STA_WRITABLE_WORK_ROOTS stays an EXPLICITLY EMPTY
 * list — never inherited from the user's shell — and every other repository on
 * the machine is read-only from here.
 *
 * Bound Targets ride on STA_TARGET_WORK_ROOTS in the same shape the
 * orchestrated path uses, all `access: "read"`. That channel is identification,
 * not a grant: it is what lets the guard refuse a Target write by name instead
 * of by path (V10 TASK-023/024). Writing a Target belongs to an orchestrated
 * stage, which arrives with a role and a bounded packet scope; an interactive
 * session has neither.
 *
 * STA_KNOWLEDGE_ROOT and STA_TARGET_ROOT name the read-only context a prompt
 * or hook may need, so nothing has to hard-code a machine-specific path. Both
 * stay absent when nothing resolved. Since named roots (DR §5 env/launch row)
 * the Knowledge selection is path + `STA_KNOWLEDGE_ROOT_NAME` as one unit: the
 * launcher strips any inherited shell values so the child can only ever see
 * the selection resolved here. The name is the managed-session marker, so a
 * name without a path refuses the launch; a path without a name is the legacy
 * single-repo contract (DR §6 — an unbound invocation keeps the old rules).
 */
export function launchEnv(
  role: WorkspaceRole,
  existingEnv: NodeJS.ProcessEnv = process.env,
  knowledgeRoot?: string,
  targetRoot?: string,
  contextCommand?: string,
  targetWorkRoots: readonly GuardTargetWorkRoot[] = [],
  knowledgeRootName?: string,
): NodeJS.ProcessEnv {
  // `role` is part of the signature so call sites state which command opened
  // the session; it no longer decides anything about write scope.
  void role;
  if (knowledgeRootName !== undefined && !knowledgeRoot) {
    throw new Error(
      `incomplete Knowledge-root selection: STA_KNOWLEDGE_ROOT_NAME "${knowledgeRootName}" arrived without STA_KNOWLEDGE_ROOT — refusing to launch`,
    );
  }
  const env: NodeJS.ProcessEnv = { ...existingEnv };
  delete env.STA_KNOWLEDGE_ROOT;
  delete env.STA_KNOWLEDGE_ROOT_NAME;
  return {
    ...env,
    STA_WRITABLE_WORK_ROOTS: "[]",
    ...(targetWorkRoots.length > 0 ? { [GUARD_TARGET_WORK_ROOTS_ENV]: serializeGuardTargetWorkRoots(targetWorkRoots) } : {}),
    ...(knowledgeRoot && knowledgeRootName !== undefined ? { STA_KNOWLEDGE_ROOT: knowledgeRoot, STA_KNOWLEDGE_ROOT_NAME: knowledgeRootName } : {}),
    ...(knowledgeRoot && knowledgeRootName === undefined ? { STA_KNOWLEDGE_ROOT: knowledgeRoot } : {}),
    ...(targetRoot ? { STA_TARGET_ROOT: targetRoot } : {}),
    ...(contextCommand ? { STA_CONTEXT_CMD: contextCommand } : {}),
  };
}
