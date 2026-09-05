import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRoots } from "./roots.js";
import { detectWorkspaceKind, assetsForRole, type WorkspaceRole, type WorkspaceKind } from "./roleWorkspace.js";
import type { WorkspaceRuntime } from "./roleWorkspace.js";
import {
  defaultTargetConfig,
  isTargetInitialized,
  loadTargetConfig,
  readTargetManifest,
  writeTargetConfig,
} from "./targetMeta.js";
import { runTargetSync, type SyncResult } from "./syncEngine.js";
import { planTargetProfile } from "./targetProfile.js";

/**
 * `software-team-agents init`, run from inside a Role Workspace (a Target repo
 * for DEV, the Knowledge repo for BA).
 *
 * Detects what kind of repository it is standing in when no role is recorded
 * yet (Knowledge markers → ba; app-source markers → dev; both/neither → an
 * explicit --role is required), records identity + role in
 * `.agent-team/config.yaml`, and materializes the role's managed-asset profile
 * through the safe sync engine.
 *
 * Idempotent by construction: re-running re-runs sync (which only ever writes
 * what the manifest proves pristine), and config.yaml is written once and then
 * only ever read — a second init can never reset a target_id, an override list,
 * or a role. Application/Knowledge content is never touched.
 */

export interface TargetInitOptions {
  targetRoot?: string;
  templatesDir?: string;
  now: string;
  force?: boolean;
  /** Explicit role override; detection is skipped when given. */
  role?: WorkspaceRole;
  /** Explicit stack selection for ambiguous or unsupported Target evidence. */
  stack?: string;
  /** Explicit runtime bindings selected by repeatable `init --runtime`. */
  runtimes?: readonly WorkspaceRuntime[];
  /** Machine-wide installation.yaml override (tests); forwarded to the sync engine's DEV-workspace binding resolution. */
  installationConfigPath?: string;
  /** Injectable prerequisite probe; init reports failures but does not refuse. */
  probe?: (runtime: WorkspaceRuntime) => { available: boolean; detail?: string };
}

/** One environment-facing preflight vocabulary, shared by `init` and launch. */
export interface PrerequisiteCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export function probeRuntime(runtime: WorkspaceRuntime): { available: boolean; detail?: string } {
  const result = spawnSync(runtime, ["--version"], { encoding: "utf8", shell: process.platform === "win32", timeout: 15_000 });
  if (result.error || result.status !== 0) return { available: false, detail: `"${runtime} --version" failed` };
  return { available: true, detail: (result.stdout ?? "").trim().split("\n")[0] };
}

export function environmentPrerequisites(
  runtime: WorkspaceRuntime,
  probe: (runtime: WorkspaceRuntime) => { available: boolean; detail?: string } = probeRuntime,
): readonly PrerequisiteCheck[] {
  const result = probe(runtime);
  return [{
    name: `Runtime (${runtime})`,
    ok: result.available,
    detail: result.detail ?? (result.available ? "available" : `${runtime} is unavailable`),
    fix: `install ${runtime} and make sure it is on PATH`,
  }];
}

export interface TargetInitResult {
  targetRoot: string;
  frameworkRoot: string;
  knowledgeRoot?: string;
  frameworkVersion: string;
  role: WorkspaceRole;
  /** How the role was decided. */
  roleVia: "flag" | "config" | "detected";
  detectedKind: WorkspaceKind;
  /** True when this run created .agent-team/config.yaml; false when it already existed. */
  createdConfig: boolean;
  wasInitialized: boolean;
  prerequisites: readonly PrerequisiteCheck[];
  sync: SyncResult;
}

export class AmbiguousWorkspaceError extends Error {}

export function runTargetInit(options: TargetInitOptions): TargetInitResult {
  const roots = resolveRoots({ targetRoot: options.targetRoot });
  const templatesDir = options.templatesDir ?? path.join(roots.frameworkRoot, "templates");
  const wasInitialized = isTargetInitialized(roots.targetRoot);
  const previousManifest = wasInitialized ? readTargetManifest(roots.targetRoot) : undefined;

  const existingConfig = loadTargetConfig(roots.targetRoot);
  const createdConfig = existingConfig === undefined;

  // Role resolution order: explicit flag > recorded config > marker detection.
  let role: WorkspaceRole | undefined = options.role;
  let roleVia: TargetInitResult["roleVia"] = role ? "flag" : "config";
  if (!role) role = existingConfig?.role as WorkspaceRole | undefined;
  const detectedKind = detectWorkspaceKind(roots.targetRoot);
  if (!role) {
    if (detectedKind === "knowledge") {
      role = "ba";
      roleVia = "detected";
    } else if (detectedKind === "target") {
      role = "dev";
      roleVia = "detected";
    } else {
      throw new AmbiguousWorkspaceError(
        detectedKind === "ambiguous"
          ? `"${roots.targetRoot}" looks like both a Knowledge repo and an application repository — say which one this workspace is with --role ba or --role dev`
          : `"${roots.targetRoot}" has neither Knowledge markers (knowledge/, targets.yaml) nor application-source markers (package.json, ...) — say what this workspace is with --role ba or --role dev`,
      );
    }
  }

  let config = existingConfig ?? defaultTargetConfig(path.basename(roots.targetRoot), options.now, role);
  // A new DEV config is not written until deterministic stack resolution has
  // succeeded. This preserves init's existing "nothing on refusal" contract.
  if (createdConfig && role === "dev") {
    const profile = planTargetProfile({
      targetRoot: roots.targetRoot,
      templatesDir,
      explicitProfile: options.stack,
      now: options.now,
    });
    config = { ...config, stack: profile.stack };
  }
  if (options.runtimes?.length) {
    // Claude remains the base runtime; additional selections materialise their
    // own bindings. The explicit list is the only operation that narrows a
    // legacy workspace's conservative all-runtime compatibility default.
    config = { ...config, runtimes: [...new Set<WorkspaceRuntime>(["claude", ...options.runtimes])] };
  }
  if (createdConfig || options.runtimes?.length) writeTargetConfig(roots.targetRoot, config);

  const sync = runTargetSync({
    targetRoot: roots.targetRoot,
    templatesDir,
    include: assetsForRole(role),
    role,
    manifest: previousManifest,
    config,
    installationConfigPath: options.installationConfigPath,
    now: options.now,
    force: options.force,
    explicitStack: options.stack,
  });

  const runtime = options.runtimes?.at(-1) ?? "claude";
  return {
    targetRoot: roots.targetRoot,
    frameworkRoot: roots.frameworkRoot,
    knowledgeRoot: roots.knowledgeRoot,
    frameworkVersion: sync.frameworkVersion,
    role,
    roleVia,
    detectedKind,
    createdConfig,
    wasInitialized,
    prerequisites: environmentPrerequisites(runtime, options.probe),
    sync,
  };
}
