import { spawnSync } from "node:child_process";
import type { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { resolveNpmCliScript } from "../runtime/npmCliResolver.js";
import { RUNTIME_SUPPORT, isUnattendedTargetWriteAllowed, isUnattendedTargetWriteCertified, type RuntimeId } from "../runtime/runtimeSupport.js";
import { POOL_RUNTIME_IDS, type PoolRuntimeId } from "./machineConfig.js";

/**
 * Runtime Connect — what the Runtime page and `sta doctor` show for each of
 * the four pool runtimes: installed, version, authentication, background
 * readiness, which roles STA may use it for, plus (merged in by the caller)
 * health.
 *
 * Read-only by construction: every check is a version/status query. Nothing
 * here logs a runtime in, edits its config or runs a task. Runtimes run the
 * way a person runs them — no Codex Windows sandbox (owner decision 2026-10-03).
 */

export type ConnectState = "NOT_INSTALLED" | "INSTALLED" | "AUTH_REQUIRED" | "CONNECTED" | "UNAVAILABLE" | "QUOTA_EXHAUSTED" | "ERROR";

export interface RuntimeConnectStatus {
  runtimeId: PoolRuntimeId;
  displayName: string;
  installed: boolean;
  version: string | null;
  authentication: "ok" | "required" | "unknown";
  authDetail: string | null;
  backgroundReady: boolean;
  /** Which roles STA may dispatch this runtime for, given its security boundary. */
  securityRoles: { commander: boolean; engineer: boolean; reviewer: boolean; qa: boolean };
  securityDetail: string;
  supportLevel: string;
  state: ConnectState;
  lastError: string | null;
  checkedAt: number;
  actions: Array<"connect" | "login" | "reconnect" | "test">;
  loginHint: string;
}

const DISPLAY: Record<PoolRuntimeId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "AGY (Antigravity)",
  zcode: "ZCode",
};

const LOGIN_HINT: Record<PoolRuntimeId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  antigravity: "agy   (sign in once interactively)",
  zcode: "open ZCode Desktop and configure the provider",
};

export interface CommandRunner {
  (command: string, args: readonly string[], timeoutMs?: number): { status: number | null; stdout: string; stderr: string; error?: string };
}

/** Runs a fixed CLI status command, resolving npm shims on Windows without a shell. */
export const defaultCommandRunner: CommandRunner = (command, args, timeoutMs = 15_000) => {
  const run = (file: string, argv: readonly string[]) => spawnSync(file, [...argv], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
  let proc = run(command, args);
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
    const resolved = resolveNpmCliScript(command);
    if (resolved) proc = run(resolved.file, [...resolved.prefixArgs, ...args]);
  }
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", ...(proc.error ? { error: proc.error.message } : {}) };
};

function authFor(runtimeId: PoolRuntimeId, runner: CommandRunner, probeReason: string | undefined): { authentication: RuntimeConnectStatus["authentication"]; detail: string | null } {
  if (runtimeId === "claude-code") {
    const result = runner("claude", ["auth", "status"]);
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
      return parsed.loggedIn ? { authentication: "ok", detail: `logged in (${parsed.authMethod ?? "unknown method"})` } : { authentication: "required", detail: "claude reports not logged in" };
    } catch {
      return { authentication: "unknown", detail: (result.error ?? result.stderr.trim()) || "could not read `claude auth status`" };
    }
  }
  if (runtimeId === "codex") {
    const result = runner("codex", ["login", "status"]);
    const text = `${result.stdout}\n${result.stderr}`;
    if (/logged in/i.test(text) && !/not logged in/i.test(text)) return { authentication: "ok", detail: text.trim().split("\n").find((line) => /logged in/i.test(line))?.trim() ?? "logged in" };
    if (/not logged in/i.test(text)) return { authentication: "required", detail: "codex reports not logged in" };
    return { authentication: "unknown", detail: result.error ?? "could not read `codex login status`" };
  }
  if (runtimeId === "zcode") {
    if (probeReason && /provider|api key|sign/i.test(probeReason)) return { authentication: "required", detail: probeReason };
    return { authentication: "unknown", detail: "ZCode's provider login is verified on its first run" };
  }
  return { authentication: "unknown", detail: "AGY has no non-interactive auth status command; verified on its first run" };
}

export function securityRolesFor(runtimeId: string): RuntimeConnectStatus["securityRoles"] & { detail: string } {
  const writes = isUnattendedTargetWriteAllowed(runtimeId);
  const detail = isUnattendedTargetWriteCertified(runtimeId)
    ? "runs directly with your own login; pre-tool hooks guard Target writes — certified for unattended Target writes"
    : writes ? (runtimeId === "codex"
      ? "runs directly with your own login; adapter-owned PreToolUse hooks check patch paths before execution, with mandatory post-run scope and exit checks — unattended Target writes remain uncertified"
      : "runs directly with your own login; engineer writes are checked after the run — violations reject the attempt but are not prevented or undone")
    : "runs directly with your own login; no pre-tool write guard — STA uses it for commander, review and QA, never to write a Target";
  return { commander: true, engineer: writes, reviewer: true, qa: true, detail };
}

/**
 * Detect every pool runtime. Synchronous by design (it shells out to status
 * commands); the Core service runs it in a child process so its HTTP loop never
 * blocks on a slow CLI.
 */
export async function detectRuntimes(registry: RuntimeRegistry, runner: CommandRunner = defaultCommandRunner, now = Date.now()): Promise<RuntimeConnectStatus[]> {
  registry.invalidateProbe();
  const results: RuntimeConnectStatus[] = [];
  for (const runtimeId of POOL_RUNTIME_IDS) {
    const probe = registry.has(runtimeId) ? await registry.probe(runtimeId) : { available: false, reason: "adapter not registered" };
    const installed = probe.available;
    const auth = installed ? authFor(runtimeId, runner, probe.reason) : { authentication: "unknown" as const, detail: null };
    const security = securityRolesFor(runtimeId);
    let state: ConnectState;
    if (!installed) state = /not found|ENOENT|not recognized|no such file/i.test(probe.reason ?? "") ? "NOT_INSTALLED" : "UNAVAILABLE";
    else if (auth.authentication === "required") state = "AUTH_REQUIRED";
    else state = "CONNECTED";
    const actions: RuntimeConnectStatus["actions"] = ["connect", "test"];
    if (state === "AUTH_REQUIRED" || auth.authentication === "unknown") actions.push("login");
    if (state !== "NOT_INSTALLED") actions.push("reconnect");
    results.push({
      runtimeId,
      displayName: DISPLAY[runtimeId],
      installed,
      version: probe.version ?? null,
      authentication: auth.authentication,
      authDetail: auth.detail,
      backgroundReady: installed,
      securityRoles: { commander: security.commander, engineer: security.engineer, reviewer: security.reviewer, qa: security.qa },
      securityDetail: security.detail,
      supportLevel: RUNTIME_SUPPORT[runtimeId as RuntimeId]?.level ?? "unsupported",
      state,
      lastError: installed ? null : probe.reason ?? null,
      checkedAt: now,
      actions,
      loginHint: LOGIN_HINT[runtimeId],
    });
  }
  return results;
}

/**
 * Runtimes that cannot run unattended right now for a reason the Core can see
 * before launching anything — handed to the routing overlay so a run skips
 * them instead of failing on them.
 */
export function knownUnavailable(statuses: readonly RuntimeConnectStatus[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const status of statuses) {
    if (status.state === "NOT_INSTALLED") out[status.runtimeId] = `NOT_INSTALLED: ${status.lastError ?? "not installed"}`;
    else if (status.state === "AUTH_REQUIRED") out[status.runtimeId] = `AUTH_REQUIRED: ${status.authDetail ?? "login required"}`;
  }
  return out;
}

