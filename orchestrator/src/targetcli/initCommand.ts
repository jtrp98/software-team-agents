import * as path from "node:path";
import { resolveRoots } from "./roots.js";
import { detectWorkspaceKind, assetsForRole, type RoleName, type WorkspaceKind } from "./roleWorkspace.js";
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
 * T-TARGET-03 + T-ROLE-16 — `software-team-agents init`, run from inside a Role
 * Workspace (a Target repo for DEV, the Knowledge repo for BA).
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
  /** Explicit role override (T-ROLE-16); detection is skipped when given. */
  role?: RoleName;
  /** Explicit stack selection for ambiguous or unsupported Target evidence. */
  stack?: string;
  /** Machine-wide installation.yaml override (tests); forwarded to the sync engine's dev-lane binding resolution. */
  installationConfigPath?: string;
}

export interface TargetInitResult {
  targetRoot: string;
  frameworkRoot: string;
  knowledgeRoot?: string;
  frameworkVersion: string;
  role: RoleName;
  /** How the role was decided. */
  roleVia: "flag" | "config" | "detected";
  detectedKind: WorkspaceKind;
  /** True when this run created .agent-team/config.yaml; false when it already existed. */
  createdConfig: boolean;
  wasInitialized: boolean;
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
  let role: RoleName | undefined = options.role;
  let roleVia: TargetInitResult["roleVia"] = role ? "flag" : "config";
  if (!role) role = existingConfig?.role as RoleName | undefined;
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
  if (createdConfig) writeTargetConfig(roots.targetRoot, config);

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
    sync,
  };
}
