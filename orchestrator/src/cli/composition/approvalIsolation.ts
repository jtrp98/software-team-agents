import * as path from "node:path";
import { approvalChannelDir } from "../../gates/humanChannelConfig.js";
import {
  ClaudeCodeAdapter,
  claudeIsolationInvocationFor,
  claudeIsolationRunBase,
  claudeIsolationRunDirs,
} from "../../runtime/claudeCodeAdapter.js";
import { CodexAdapter, codexPermissionInvocationFor, codexPermissionPathsFor } from "../../runtime/codexAdapter.js";
import { canonicalPath } from "../../runtime/permissionPaths.js";
import type { RuntimeAdapter, RuntimeAgentRequest } from "../../runtime/runtimeAdapter.js";

function intersects(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlapsProtected(grants: readonly string[], protectedPath: string): boolean {
  return grants.some((grant) => {
    const grantedPath = canonicalPath(grant);
    return intersects(grantedPath, protectedPath) || intersects(protectedPath, grantedPath);
  });
}

function profileDeniesProtected(configs: readonly (string | undefined)[], profileName: string, protectedPath: string): boolean {
  return configs.some((item) => item?.startsWith(`permissions.${profileName}=`) &&
    item.includes('\":root\" = \"read\"') &&
    item.includes(`${JSON.stringify(protectedPath)} = "deny"`));
}

function codexDenial(req: RuntimeAgentRequest, protectedPath: string): string | null {
  const invocation = codexPermissionInvocationFor(req, protectedPath);
  const args = invocation.args;
  const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);
  if (!args.includes("--strict-config") || args.includes("--sandbox") ||
      !configs.includes('default_permissions="sta_run"') ||
      (process.platform === "win32" && !configs.includes('windows.sandbox="elevated"')) ||
      !profileDeniesProtected(configs, "sta_run", protectedPath)) {
    return "APPROVAL_ISOLATION_UNAVAILABLE: Codex spawn lacks a native approval-channel read/write deny";
  }
  const grants = req.autonomy === "read-only" ? [] : [
    ...req.guards.writeAllow.flatMap((pattern) => codexPermissionPathsFor(req.cwd, pattern).map((relative) => path.resolve(req.cwd, relative))),
    ...(req.workRoots ?? []).filter((root) => root.access === "write").map((root) => path.resolve(root.path)),
  ];
  return overlapsProtected(grants, protectedPath)
    ? "APPROVAL_ISOLATION_UNAVAILABLE: a Codex write grant overlaps the approval channel"
    : null;
}

/**
 * TASK-031: Claude Code runs whole-process inside `codex sandbox` (Windows
 * elevated backend). The per-run root is created at spawn time under
 * `claudeIsolationRunBase()`; a representative root under that same base
 * yields the same grant shape, so overlap is judged on the real base.
 */
function claudeCodeDenial(req: RuntimeAgentRequest, protectedPath: string): string | null {
  const runDirs = claudeIsolationRunDirs(path.join(claudeIsolationRunBase(), "sta-claude-run-preflight"));
  const invocation = claudeIsolationInvocationFor(req, runDirs, protectedPath);
  const args = invocation.sandboxArgs;
  const configs = args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]] : []);
  if (args[0] !== "sandbox" || args[args.length - 1] !== "--" ||
      args[args.indexOf("-P") + 1] !== "sta_run" ||
      !configs.includes('windows.sandbox="elevated"') ||
      invocation.protectedPath !== protectedPath ||
      !profileDeniesProtected(configs, "sta_run", protectedPath) ||
      !configs.some((item) => item?.startsWith("permissions.sta_run=") && item.endsWith("network = { enabled = false } }"))) {
    return "APPROVAL_ISOLATION_UNAVAILABLE: Claude Code spawn lacks the OS isolation wrapper's approval-channel read/write deny or OS network lock";
  }
  return overlapsProtected(invocation.writeGrants, protectedPath)
    ? "APPROVAL_ISOLATION_UNAVAILABLE: a Claude Code write grant overlaps the approval channel"
    : null;
}

/**
 * Production dispatch preflight for the human-selected a1 boundary. Only
 * concrete adapters that spawn under a verified OS permission profile pass:
 * the Codex headless adapter (native profile) and, since TASK-031, Claude Code
 * wrapped whole-process in Codex's Windows sandbox. Hook and shell-text guards
 * are not isolation evidence, so Antigravity, OpenCode and ZCode stay refused.
 * Each check uses the same builder the adapter's spawn uses, so these are the
 * exact grants the subsequent process receives.
 */
export function approvalIsolationDenial(
  runtime: RuntimeAdapter,
  req: RuntimeAgentRequest,
  protectedDir?: string,
): string | null {
  const isCodex = runtime instanceof CodexAdapter;
  const isClaudeCode = runtime instanceof ClaudeCodeAdapter;
  if (!isCodex && !isClaudeCode) {
    return `APPROVAL_ISOLATION_UNAVAILABLE: runtime "${runtime.id}" has no verified OS read/write boundary for the approval channel`;
  }
  try {
    const protectedPath = canonicalPath(protectedDir ?? approvalChannelDir());
    return isCodex ? codexDenial(req, protectedPath) : claudeCodeDenial(req, protectedPath);
  } catch (error) {
    return `APPROVAL_ISOLATION_UNAVAILABLE: cannot verify native boundary: ${String(error)}`;
  }
}
