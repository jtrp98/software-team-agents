import * as path from "node:path";
import { FRAMEWORK_PAYLOAD_ARTIFACTS, UNIVERSAL_DENY } from "../agents/pathPermissions.js";
import { FORBIDDEN_COMMANDS } from "../runtime/runtimeGuards.js";
import type { RuntimeAutonomy, RuntimeGuards, RuntimeWorkRoot } from "../runtime/runtimeAdapter.js";
import type { ResolvedLimits, ResolvedPermissions } from "./runStore.js";

/**
 * Action/capability policy for direct runs.
 *
 * Every check here asks "may this run take this action?", never "is the
 * caller this job title?". A run's permissions come from its request and are
 * narrowed by its parent's — a child can never hold more than the run that
 * started it. Which runtime a run uses, and whether it entered the tree as an
 * executor, decides nothing.
 *
 * Hard boundaries (refused): writing outside the granted workspace/paths,
 * escalating past the parent, delegating when the parent forbade it, the
 * recursion/budget limits, and the floor every run carries: no state-changing
 * git, no write to runtime state/VCS/framework payload, no hardcoded secret.
 * Declared side effects (deploys, migrations, force pushes, ...) need a human
 * approval before the run may start — see `execute.ts`.
 */

export interface Permissions {
  /** May change files in the workspace. Default: the parent's value; false at the root. */
  write?: boolean;
  /** Workspace-relative globs the run may write. Default: everything the parent could (`**` at the root). */
  writePaths?: readonly string[];
  /** May start child runs. Default: the parent's value; true at the root. */
  delegate?: boolean;
  /** Default: `edit` for a writing run, `read-only` otherwise — never above the parent's. */
  autonomy?: RuntimeAutonomy;
}

export interface ExecutionLimits {
  maxDepth?: number;
  maxChildren?: number;
  maxTotalRuns?: number;
  /** Per-run runtime timeout. */
  timeoutMs?: number;
}

export const DEFAULT_LIMITS: ResolvedLimits = Object.freeze({ maxDepth: 3, maxChildren: 8, maxTotalRuns: 25 });

export type PolicyRefusalCode =
  | "workspace_outside_parent"
  | "permission_escalation"
  | "delegation_not_permitted"
  | "write_guard_unavailable"
  | "invalid_permissions"
  | "max_depth_exceeded"
  | "max_children_exceeded"
  | "budget_exceeded";

export class PolicyRefusal extends Error {
  constructor(readonly code: PolicyRefusalCode, message: string) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

const AUTONOMY_ORDER: readonly RuntimeAutonomy[] = ["read-only", "propose", "edit", "full"];
const rank = (a: RuntimeAutonomy): number => AUTONOMY_ORDER.indexOf(a);
const ANYWHERE = "**";

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The run's workspace: explicit, else the parent's, else `fallback`. A child may narrow its parent's workspace, never leave it. */
export function resolveWorkspace(requested: string | undefined, parentWorkspace: string | null, fallback: string): string {
  const workspace = path.resolve(requested ?? parentWorkspace ?? fallback);
  if (parentWorkspace !== null && !isInside(workspace, parentWorkspace)) {
    throw new PolicyRefusal(
      "workspace_outside_parent",
      `workspace ${workspace} is outside the parent run's workspace ${parentWorkspace}`,
    );
  }
  return workspace;
}

/**
 * The Target roots a run may write besides its workspace, already resolved to
 * mapped Targets (`execute.ts`). A root run takes what it was granted; a child
 * defaults to its parent's roots and may only narrow them — a root its parent
 * was never given is an escalation, exactly like a write path. Writing a
 * Target requires a writing run, and a role: the guard applies that role's
 * contract and stack rules to every Target path, and refuses a Target write
 * that has none.
 */
export function resolveWorkRoots(
  requested: readonly RuntimeWorkRoot[] | undefined,
  parent: { workRoots?: readonly RuntimeWorkRoot[] } | null,
  workspace: string,
  write: boolean,
  role: string | undefined,
): RuntimeWorkRoot[] {
  const inherited = parent?.workRoots ?? [];
  let roots: readonly RuntimeWorkRoot[];
  if (requested === undefined) {
    roots = write ? inherited : [];
  } else if (parent) {
    const outside = requested.filter((root) => !inherited.some((own) => path.resolve(own.path) === path.resolve(root.path)));
    if (outside.length > 0) {
      throw new PolicyRefusal(
        "permission_escalation",
        `writable Target ${outside.map((root) => root.targetId).join(", ")} exceeds the parent run's grant (${inherited.map((root) => root.targetId).join(", ") || "none"})`,
      );
    }
    roots = requested;
  } else {
    roots = requested;
  }
  if (roots.length === 0) return [];
  if (!write) throw new PolicyRefusal("invalid_permissions", "a writable Target needs a writing run");
  if (!role) {
    throw new PolicyRefusal(
      "invalid_permissions",
      "a writable Target needs a role: the guard applies that role's contract and stack rules to every Target path, and refuses a Target write without one",
    );
  }
  for (const root of roots) {
    if (!path.isAbsolute(root.path)) throw new PolicyRefusal("invalid_permissions", `writable Target ${root.targetId} must be an absolute path`);
    if (isInside(path.resolve(root.path), workspace) || isInside(workspace, path.resolve(root.path))) {
      throw new PolicyRefusal(
        "invalid_permissions",
        `writable Target ${root.targetId} (${root.path}) overlaps the run's workspace ${workspace} — a Target is a separate repository`,
      );
    }
  }
  return roots.map((root) => ({ targetId: root.targetId, path: path.resolve(root.path), access: "write" as const }));
}

export function resolvePermissions(
  requested: Permissions = {},
  parent: { permissions: ResolvedPermissions; workspace: string } | null,
  workspace: string,
  /** The run writes Target roots: its workspace then defaults to read-only rather than `**`. */
  writesTargets = false,
): ResolvedPermissions {
  const p = parent?.permissions ?? null;
  const write = requested.write ?? p?.write ?? false;
  const delegate = requested.delegate ?? p?.delegate ?? true;
  if (p && write && !p.write) {
    throw new PolicyRefusal("permission_escalation", "a child run cannot write: its parent run is read-only");
  }

  let writePaths: readonly string[] = [];
  if (write) {
    const parentUnrestricted = !p || p.writePaths.includes(ANYWHERE);
    if (parentUnrestricted) {
      writePaths = requested.writePaths ?? (writesTargets ? [] : [ANYWHERE]);
    } else {
      // A path-restricted parent's grant is only ever re-used, never re-derived:
      // same workspace, and only globs the parent itself was given.
      if (path.resolve(workspace) !== path.resolve(parent!.workspace)) {
        throw new PolicyRefusal("permission_escalation", "a child of a path-restricted run must write in the same workspace");
      }
      writePaths = requested.writePaths ?? p!.writePaths;
      const outside = writePaths.filter((glob) => !p!.writePaths.includes(glob));
      if (outside.length > 0) {
        throw new PolicyRefusal("permission_escalation", `write paths ${outside.join(", ")} exceed the parent run's grant (${p!.writePaths.join(", ")})`);
      }
    }
    for (const glob of writePaths) {
      if (path.isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) {
        throw new PolicyRefusal("invalid_permissions", `write path ${JSON.stringify(glob)} must be relative to the workspace and stay inside it`);
      }
    }
    if (writePaths.length === 0 && !writesTargets) throw new PolicyRefusal("invalid_permissions", "a writing run needs at least one write path");
  }

  const ceiling = p ? rank(p.autonomy) : rank("full");
  const natural = write ? "edit" : "read-only";
  let autonomy: RuntimeAutonomy;
  if (requested.autonomy !== undefined) {
    if (!AUTONOMY_ORDER.includes(requested.autonomy)) {
      throw new PolicyRefusal("invalid_permissions", `unknown autonomy ${JSON.stringify(requested.autonomy)}`);
    }
    if (rank(requested.autonomy) > ceiling) {
      throw new PolicyRefusal("permission_escalation", `autonomy "${requested.autonomy}" exceeds the parent run's "${p!.autonomy}"`);
    }
    autonomy = requested.autonomy;
  } else {
    autonomy = AUTONOMY_ORDER[Math.min(rank(natural), ceiling)];
  }
  if (!write && autonomy !== "read-only") {
    throw new PolicyRefusal("invalid_permissions", `autonomy "${autonomy}" lets a run change files; grant write or use read-only`);
  }
  if (write && autonomy === "read-only") {
    throw new PolicyRefusal("invalid_permissions", "a writing run cannot be read-only");
  }
  return { write, writePaths, delegate, autonomy };
}

/** Limits are fixed by the root; a child may tighten them, never loosen them. */
export function resolveLimits(requested: ExecutionLimits = {}, parent: ResolvedLimits | null): ResolvedLimits {
  const base = parent ?? DEFAULT_LIMITS;
  const pick = (want: number | undefined, ceiling: number, name: string): number => {
    if (want === undefined) return ceiling;
    if (!Number.isInteger(want) || want < 0) throw new PolicyRefusal("invalid_permissions", `${name} must be a non-negative integer`);
    return parent ? Math.min(want, ceiling) : want;
  };
  const timeoutMs = requested.timeoutMs ?? parent?.timeoutMs;
  return {
    maxDepth: pick(requested.maxDepth, base.maxDepth, "maxDepth"),
    maxChildren: pick(requested.maxChildren, base.maxChildren, "maxChildren"),
    maxTotalRuns: pick(requested.maxTotalRuns, base.maxTotalRuns, "maxTotalRuns"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * The runtime-facing guard set for a run's permissions. The deny floor and
 * the command ban are the same ones every workflow stage carries.
 */
export function guardsFor(permissions: ResolvedPermissions): RuntimeGuards {
  return {
    writeAllow: permissions.write ? permissions.writePaths : [],
    writeDeny: [...new Set([...UNIVERSAL_DENY, ...FRAMEWORK_PAYLOAD_ARTIFACTS])],
    forbidCommands: FORBIDDEN_COMMANDS,
    exitChecks: permissions.write ? ["no-hardcoded-secret"] : [],
  };
}
