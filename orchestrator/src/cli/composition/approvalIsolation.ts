import * as fs from "node:fs";
import * as path from "node:path";
import { approvalChannelDir } from "../../gates/humanChannelConfig.js";
import { CodexAdapter, codexPermissionInvocationFor, codexPermissionPathsFor } from "../../runtime/codexAdapter.js";
import type { RuntimeAdapter, RuntimeAgentRequest } from "../../runtime/runtimeAdapter.js";

/** Resolve existing junctions/symlinks, including the nearest existing parent of a new file. */
function canonicalPath(input: string): string {
  const absolute = path.resolve(input);
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve existing ancestor of ${absolute}`);
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, absolute));
}

function intersects(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Production dispatch preflight for the human-selected a1 boundary. Only the
 * concrete Codex adapter currently emits an OS permission profile. Hook and
 * shell-text guards from the other four adapters are not isolation evidence.
 * The same profile builder is used by CodexAdapter.executeAgent, so these are
 * the exact grants the subsequent spawn will receive.
 */
export function approvalIsolationDenial(
  runtime: RuntimeAdapter,
  req: RuntimeAgentRequest,
  protectedDir?: string,
): string | null {
  if (!(runtime instanceof CodexAdapter)) {
    return `APPROVAL_ISOLATION_UNAVAILABLE: runtime "${runtime.id}" has no verified OS read/write boundary for the approval channel`;
  }
  try {
    const protectedPath = canonicalPath(protectedDir ?? approvalChannelDir());
    const invocation = codexPermissionInvocationFor(req, protectedPath);
    const args = invocation.args;
    const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);
    if (!args.includes("--strict-config") || args.includes("--sandbox") ||
        !configs.includes('default_permissions="sta_run"') ||
        (process.platform === "win32" && !configs.includes('windows.sandbox="elevated"')) ||
        !configs.some((item) => item?.startsWith("permissions.sta_run=") &&
          item.includes('\":root\" = \"read\"') &&
          item.includes(`${JSON.stringify(protectedPath)} = "deny"`))) {
      return "APPROVAL_ISOLATION_UNAVAILABLE: Codex spawn lacks a native approval-channel read/write deny";
    }

    const grants = req.autonomy === "read-only" ? [] : [
      ...req.guards.writeAllow.flatMap((pattern) => codexPermissionPathsFor(req.cwd, pattern).map((relative) => path.resolve(req.cwd, relative))),
      ...(req.workRoots ?? []).filter((root) => root.access === "write").map((root) => path.resolve(root.path)),
    ];
    for (const grant of grants) {
      const grantedPath = canonicalPath(grant);
      if (intersects(grantedPath, protectedPath) || intersects(protectedPath, grantedPath)) {
        return `APPROVAL_ISOLATION_UNAVAILABLE: a Codex write grant overlaps the approval channel`;
      }
    }
    return null;
  } catch (error) {
    return `APPROVAL_ISOLATION_UNAVAILABLE: cannot verify native boundary: ${String(error)}`;
  }
}
