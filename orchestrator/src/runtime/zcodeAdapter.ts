import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canWritePath } from "../agents/pathPermissions.js";
import { zcodeCoverage } from "../targetcli/guardSettings.js";
import { renderZcodeManagedHooks } from "./bindingGenerator.js";
import { LocalWorkspace } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { SingleShotLifecycle } from "./singleShotLifecycle.js";
import type {
  ExecutorAttemptRef,
  ExecutorCancelOutcome,
  ExecutorEvidence,
  ExecutorPort,
  PreparedExecutorAttempt,
} from "./executorPort.js";
import type {
  RuntimeAgentRequest,
  RuntimeAgentResult,
  RuntimeAutonomy,
  RuntimeBinding,
  RuntimeGuardReport,
  RuntimeGuards,
  RuntimeProbe,
  RuntimeUsage,
  RuntimeWorkspace,
  SpawnSync,
} from "./runtimeAdapter.js";

/**
 * V13 TASK-015 — the governed `RuntimeAdapter` for ZCode.
 *
 * WHY HEADLESS, NOT A DESKTOP HANDOFF
 *
 *   The task record planned an explicit desktop handoff "if ZCode has no
 *   headless CLI". Tracing the real install (ZCode 3.14.3) found that it does:
 *   `resources/glm/zcode.cjs` is the ZCode agent CLI (`zcode 0.16.9`), a Node
 *   bundle with `-p/--prompt`, `--json`, `--cwd`, `--mode` and `--resume`, and
 *   its engine discovers the workspace's `.zcode/config.json` hooks. So STA
 *   spawns the attempt itself — the correlation between an attempt and its
 *   result is the process STA owns, not a callback a session could forge — and
 *   rides the same single-shot lifecycle as the other four adapters.
 *
 * WHAT WAS TRACED IN THE BUNDLE (source, not documentation)
 *
 *   - Installed layout: the CLI looks for its built-in provider config only
 *     next to its entry or in a dev-tree layout, so from an install it fails
 *     with "cannot locate CLI ZCode Built-in Provider Config". It honours
 *     `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
 *     (they must arrive together); this adapter supplies both from the install
 *     (`resources/config/provider/zcode-builtin.json`) and the user profile
 *     (`~/.zcode/v2/provider_config.json`) unless the caller already set them.
 *   - `--json` prints one summary object: `sessionId`, `traceId`, `response`,
 *     optional `usage`, `projection.{status,totalTokenCount,...}` and — only
 *     when project hooks were skipped — `workspaceHookTrust`.
 *   - Project hooks run headless only when their declaration digests are
 *     `trusted_persistent`; otherwise the engine emits `hook_run_blocked` and
 *     SKIPS them ("Workspace Hooks skipped"). `zcode hooks trust status --json`
 *     answers that before any spawn. Granting trust is a person's security
 *     decision (`zcode hooks trust review`), never this adapter's.
 *   - `--mode`: `plan` inspects only, `build` pauses for approval before
 *     changes, `edit` auto-applies edits, `yolo` is full access.
 *   - `-p` takes the prompt from argv only — no stdin channel was found.
 *
 * FAIL-CLOSED RULES (every one is a refusal before spawn, or an ERROR after)
 *
 *   - A guarded run (write-capable autonomy with write/deny/forbid rules)
 *     requires the synced `.zcode/config.json` AND every STA-managed hook
 *     trusted; anything less is refused before spawn — the engine would
 *     otherwise run the agent with those hooks silently skipped.
 *   - A result that reports `workspaceHookTrust` (hooks skipped anyway) on a
 *     guarded run is an ERROR with PRE_TOOL_GUARD unenforced.
 *   - Success is never the agent's word: exit 0, a parsed summary with a
 *     `sessionId`, and — for a guarded run — every file the work-root
 *     snapshots say changed must be writable under the run's own guard rules
 *     (`verifyRun`, evaluated by the shared lifecycle before it journals the
 *     attempt finished). A write outside the grant turns OK into ERROR.
 *   - No per-run model flag exists on the CLI, so an explicit model is refused
 *     rather than silently replaced by ZCode's configured one; same for effort.
 *   - A packet too long for the Windows command line is refused, never
 *     truncated.
 *
 * WHAT IS NOT CLAIMED
 *
 *   NAMED_AGENTS (the role definition is folded into the prompt, as Codex
 *   does), MODEL_SELECTION, POST_TOOL_GUARD / EXIT_GUARD / PER_AGENT_EXIT_GUARD
 *   (the Stop hook exists, but its continuation cap and headless behaviour are
 *   unverified — exit checks stay STA's post-hoc job), STRUCTURED_RESULT is
 *   claimed (the `--json` summary), COST_REPORTING is not (no cost field),
 *   INTERACTIVE_PROMPTS is not (`-p` is non-interactive). ZCode stays
 *   `experimental` and uncertified for unattended Target writes until real
 *   governed UAT and TASK-017/018/025 say otherwise.
 */

const ZCODE_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.PROJECT_LEVEL_BINDING,
  RuntimeCapability.STRUCTURED_RESULT,
  RuntimeCapability.ATTEMPT_RESUME,
  RuntimeCapability.ATTEMPT_CANCEL,
  RuntimeCapability.EVIDENCE_COLLECTION,
];

/** `RuntimeAutonomy` → the CLI's `--mode`, per the mode descriptions traced in the bundle. */
const ZCODE_MODE: Record<RuntimeAutonomy, string> = {
  "read-only": "plan",
  propose: "build",
  edit: "edit",
  full: "yolo",
};

/**
 * Windows caps a command line at 32 767 UTF-16 units. The packet rides argv
 * (no stdin surface exists), so leave room for the node path, the entry path
 * and the flags; a longer packet is refused rather than cut.
 */
const WINDOWS_PROMPT_BUDGET = 30_000;

/**
 * Stderr fingerprints of "the runtime could not be used" rather than "the task
 * failed" — seen live: the unconfigured-provider and request-signing failures.
 */
const ZCODE_UNAVAILABLE_PATTERN =
  /ClientRequestSigning|signing credential|Built-in Provider Config|无法定位 CLI|not logged in|login required|unauthori[sz]ed|forbidden|\b401\b|\b403\b|rate.?limit/i;

/** The hook trust state the engine requires before it runs a project hook headless. */
const TRUSTED = "trusted_persistent";

export interface ZcodeTrustItem {
  readonly event: string;
  readonly displayCommand: string;
  readonly configuredEnabled: boolean;
  readonly trustState: string;
  readonly hookDeclarationDigest?: string;
}

export interface ZcodeTrustStatus {
  readonly workspacePath?: string;
  readonly workspaceIdentity?: string;
  readonly bundleDigest?: string | null;
  readonly reasonCode?: string;
  readonly items: readonly ZcodeTrustItem[];
}

export interface ZcodeAdapterOptions {
  /** Root of the project — where `.claude/agents/<role>.md` (the folded role definition) lives. */
  projectRoot: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Path of the ZCode CLI entry (`zcode.cjs`). Default: `STA_ZCODE_CLI`, then the standard install locations. */
  cliEntry?: string;
  /** Node executable that runs the entry. Default: the Node running STA. */
  nodePath?: string;
  /** Default per-run timeout in ms, overridable per request. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: string;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; roots the lifecycle's attempt journal instead of the OS temp dir default. */
  journalRoot?: string;
}

/** The standard install locations of the bundled CLI entry, in lookup order. */
export function defaultZcodeCliCandidates(env: NodeJS.ProcessEnv, platform: string): string[] {
  const candidates: string[] = [];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Programs", "ZCode", "resources", "glm", "zcode.cjs"));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "ZCode", "resources", "glm", "zcode.cjs"));
  } else if (platform === "darwin") {
    candidates.push("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs");
  }
  return candidates;
}

export class ZcodeAdapter implements ExecutorPort {
  readonly id = "zcode";
  readonly displayName = "ZCode";
  readonly binding: RuntimeBinding = {
    dir: ".zcode",
    // ZCode aliases Claude's project conventions (`${CLAUDE_PROJECT_DIR}`,
    // the `.claude/hooks/*` scripts its config points at); the role
    // definition is the Claude-rendered one, folded into the prompt.
    definitionPath: (role) => `.claude/agents/${role}.md`,
    guardConfigPath: ".zcode/config.json",
  };
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(ZCODE_CAPABILITIES);
  /** No per-run model flag exists — nothing is reachable by name, so nothing is claimed. */
  readonly models: ReadonlySet<string> = new Set();
  readonly workspace: RuntimeWorkspace;

  private readonly spawn: SpawnSync;
  private readonly cliEntryOption?: string;
  private readonly nodePath: string;
  private readonly defaultTimeoutMs: number;
  private readonly platform: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly lifecycle: SingleShotLifecycle;

  constructor(opts: ZcodeAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.cliEntryOption = opts.cliEntry;
    this.nodePath = opts.nodePath ?? process.execPath;
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.lifecycle = new SingleShotLifecycle(this.id, {
      run: (req) => this.executeAgent(req),
      sessionRefFrom: (result) => parseZcodeSummary(rawStdout(result))?.sessionId,
      verifyRun: (req, changedFiles) => verifyZcodeRunWrites(req, changedFiles),
      journalRoot: opts.journalRoot,
    });
  }

  prepare(req: RuntimeAgentRequest): Promise<PreparedExecutorAttempt> {
    return this.lifecycle.prepare(req);
  }
  execute(attempt: PreparedExecutorAttempt): Promise<RuntimeAgentResult> {
    return this.lifecycle.execute(attempt);
  }
  resume(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult> {
    return this.lifecycle.resume(ref);
  }
  cancel(ref: ExecutorAttemptRef): Promise<ExecutorCancelOutcome> {
    return this.lifecycle.cancel(ref);
  }
  collectResult(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult | null> {
    return this.lifecycle.collectResult(ref);
  }
  collectEvidence(ref: ExecutorAttemptRef): Promise<ExecutorEvidence> {
    return this.lifecycle.collectEvidence(ref);
  }

  /** The CLI entry this adapter drives, or null when no install is found. */
  cliEntry(): string | null {
    const explicit = this.cliEntryOption ?? this.env.STA_ZCODE_CLI;
    if (explicit) return fs.existsSync(explicit) ? explicit : null;
    return defaultZcodeCliCandidates(this.env, this.platform).find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  /**
   * The provider-config pair the installed CLI cannot find by itself. Caller
   * values win; both are set together or neither (the CLI's own rule).
   */
  private providerEnv(entry: string): Record<string, string> | { missing: string } {
    if (this.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && this.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) return {};
    const builtin = path.resolve(path.dirname(entry), "..", "config", "provider", "zcode-builtin.json");
    const home = this.env.USERPROFILE ?? this.env.HOME ?? os.homedir();
    const personal = path.join(home, ".zcode", "v2", "provider_config.json");
    if (!fs.existsSync(builtin)) return { missing: `built-in provider config not found at ${builtin}` };
    if (!fs.existsSync(personal)) return { missing: `personal provider config not found at ${personal} — open ZCode once and sign in` };
    return { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal };
  }

  private run(
    entry: string,
    args: string[],
    options: { cwd?: string; timeout: number; env?: Record<string, string>; maxBuffer?: number },
  ): SpawnSyncReturns<string> {
    return this.spawn(this.nodePath, [entry, ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env: { ...this.env, ...(options.env ?? {}) },
    });
  }

  async probe(): Promise<RuntimeProbe> {
    const entry = this.cliEntry();
    if (!entry) {
      return {
        available: false,
        reason: "ZCode CLI entry (resources/glm/zcode.cjs) not found — install ZCode, or point STA_ZCODE_CLI at the entry",
      };
    }
    const provider = this.providerEnv(entry);
    if ("missing" in provider) return { available: false, reason: String(provider.missing) };
    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.run(entry, ["--version"], { timeout: 20_000, env: provider, maxBuffer: 1024 * 1024 });
    } catch (e) {
      return { available: false, reason: String(e) };
    }
    if (proc.error) return { available: false, reason: proc.error.message };
    if (proc.status !== 0) return { available: false, reason: `\`zcode --version\` exited ${proc.status ?? "unknown"}` };
    const version = (proc.stdout ?? "").trim().split(/\s+/).pop() ?? "";
    return version ? { available: true, version } : { available: false, reason: "`zcode --version` printed no version" };
  }

  /** `zcode hooks trust status --workspace <cwd> --json`, parsed; an error string when it cannot be read. */
  inspectHookTrust(workspace: string): ZcodeTrustStatus | { error: string } {
    const entry = this.cliEntry();
    if (!entry) return { error: "ZCode CLI entry not found" };
    const provider = this.providerEnv(entry);
    if ("missing" in provider) return { error: String(provider.missing) };
    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.run(entry, ["hooks", "trust", "status", "--workspace", workspace, "--json"], {
        timeout: 60_000,
        env: provider,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      return { error: String(e) };
    }
    if (proc.error) return { error: proc.error.message };
    if (proc.status !== 0) return { error: `\`zcode hooks trust status\` exited ${proc.status ?? "unknown"}: ${(proc.stderr ?? "").trim().split("\n").slice(-2).join(" | ")}` };
    const parsed = parseZcodeTrustStatus(proc.stdout ?? "");
    return parsed ?? { error: "`zcode hooks trust status --json` printed no parsable trust record" };
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    const refuse = (diagnostics: string[], guards: RuntimeGuardReport = { enforced: [], unenforced: [] }, status: "ERROR" | "UNAVAILABLE" = "ERROR"): RuntimeAgentResult => ({
      status,
      exitCode: null,
      text: "",
      usage: {},
      guards,
      diagnostics,
    });

    const entry = this.cliEntry();
    if (!entry) return refuse(["ZCode CLI entry (resources/glm/zcode.cjs) not found — install ZCode, or point STA_ZCODE_CLI at the entry"], undefined, "UNAVAILABLE");
    const provider = this.providerEnv(entry);
    if ("missing" in provider) return refuse([String(provider.missing)], undefined, "UNAVAILABLE");

    let roleDefinition: string | null;
    try {
      roleDefinition = await this.workspace.readFile(req.definitionPath);
    } catch (e) {
      return refuse([`could not read role binding ${req.definitionPath}: ${String(e)}`]);
    }
    if (roleDefinition === null) {
      return refuse([
        `no role binding found at ${req.definitionPath} — ZCode has no named-agent selector, so the adapter folds that file into the prompt; regenerate bindings via sta init/sync`,
      ]);
    }

    if (req.model && req.modelExplicit) {
      return refuse([
        `refusing to run: the ZCode CLI has no per-run model flag, so explicit model "${req.model}" would be silently replaced by ZCode's configured model`,
      ]);
    }
    if (req.effort && req.effort !== "native") {
      return refuse([`refusing to run: the ZCode CLI exposes no effort control, so "${req.effort}" would be ignored rather than observed`]);
    }

    const prompt = `${stripFrontmatter(roleDefinition).trim()}\n\n---\n\n${req.prompt}`;
    if (this.platform === "win32" && prompt.length > WINDOWS_PROMPT_BUDGET) {
      return refuse([
        `refusing to run: the packet is ${prompt.length} chars and \`zcode -p\` takes it from argv only; Windows caps a command line near 32 767, ` +
          `so it would be truncated (budget ${WINDOWS_PROMPT_BUDGET}) — the adapter refuses rather than cut the packet`,
      ]);
    }

    const guarded = requiresPreToolGuard(req.guards, req.autonomy);
    if (guarded) {
      const coverage = zcodeCoverage(req.cwd);
      if (coverage.level === "unguarded") {
        return refuse([`refusing to run: ${coverage.detail}`], { enforced: [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] });
      }
      const trust = this.inspectHookTrust(req.cwd);
      if ("error" in trust) {
        return refuse(
          [`refusing to run: the workspace hook trust state could not be read (${trust.error}), so the guard hooks cannot be shown to run headless`],
          { enforced: [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] },
        );
      }
      const untrusted = untrustedManagedHooks(trust);
      if (untrusted.length > 0) {
        return refuse(
          [
            `refusing to run: ZCode skips untrusted project hooks headless, and ${untrusted.length} STA guard hook(s) are not ${TRUSTED} ` +
              `(${untrusted.join("; ")}) — a person reviews and grants trust with \`zcode hooks trust review --workspace ${JSON.stringify(req.cwd)}\``,
          ],
          { enforced: [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] },
        );
      }
    }

    const args = ["-p", prompt, "--json", "--cwd", req.cwd, "--mode", ZCODE_MODE[req.autonomy]];
    const baseGuards = guardReportFor(req.guards, guarded);

    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.run(entry, args, {
        cwd: req.cwd,
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        env: { ...provider, ...(req.env ?? {}), STA_ROLE: req.role },
      });
    } catch (e) {
      return refuse([`failed to spawn the ZCode CLI: ${String(e)}`], baseGuards, "UNAVAILABLE");
    }
    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        return { status: "TIMEOUT", exitCode: proc.status ?? null, text: "", usage: {}, guards: baseGuards, diagnostics: [`\`zcode -p\` for ${req.role} timed out: ${proc.error.message}`] };
      }
      return refuse([`failed to spawn the ZCode CLI: ${proc.error.message}`], baseGuards, "UNAVAILABLE");
    }

    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const exitCode = proc.status ?? null;
    const summary = parseZcodeSummary(stdout);
    const diagnostics: string[] = [];
    const tail = stderr.trim().split("\n").slice(-3).join(" | ");

    if (exitCode !== 0 && ZCODE_UNAVAILABLE_PATTERN.test(stderr)) {
      const cause = stderr.split("\n").find((line) => ZCODE_UNAVAILABLE_PATTERN.test(line))?.trim() ?? tail;
      diagnostics.push(`ZCode provider/auth failure: ${cause} | ${tail}`);
      return { status: "UNAVAILABLE", exitCode, text: "", usage: {}, guards: baseGuards, diagnostics, raw: { stdout, stderr } };
    }
    if (exitCode !== 0) diagnostics.push(`\`zcode -p\` exited ${exitCode}: ${tail || "no stderr"}`);

    let guards = baseGuards;
    let status: RuntimeAgentResult["status"] = exitCode === 0 ? "OK" : "ERROR";
    if (status === "OK" && !summary?.sessionId) {
      status = "ERROR";
      diagnostics.push("`zcode -p --json` exited 0 but printed no summary with a sessionId — no result is accepted without one");
    }
    if (summary?.hooksSkipped) {
      diagnostics.push(`ZCode skipped workspace hooks (${summary.hooksSkipped}) — the run was not guarded by them`);
      if (guarded) {
        guards = { enforced: [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD], reason: `workspace hooks skipped: ${summary.hooksSkipped}` };
        status = "ERROR";
      }
    }
    if (summary?.projectionStatus && /error|fail/i.test(summary.projectionStatus)) {
      status = "ERROR";
      diagnostics.push(`ZCode reported turn status "${summary.projectionStatus}"`);
    }

    return {
      status,
      exitCode,
      text: summary?.response ?? "",
      usage: summary?.usage ?? {},
      guards,
      diagnostics,
      raw: { stdout, stderr },
    };
  }
}

function rawStdout(result: RuntimeAgentResult): string {
  const raw = result.raw as { stdout?: unknown } | undefined;
  return raw && typeof raw.stdout === "string" ? raw.stdout : "";
}

/** A read-only mode makes write/command denial non-operative; every writable mode needs the guard hooks. */
function requiresPreToolGuard(requested: RuntimeGuards, autonomy: RuntimeAutonomy): boolean {
  return autonomy !== "read-only" &&
    (requested.writeAllow.length > 0 || requested.writeDeny.length > 0 || requested.forbidCommands.length > 0);
}

function guardReportFor(requested: RuntimeGuards, guarded: boolean): RuntimeGuardReport {
  const wantsExit = requested.exitChecks.length > 0;
  if (!guarded && !wantsExit) return { enforced: [], unenforced: [] };
  const unenforced = wantsExit ? [RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD] : [];
  return {
    enforced: guarded ? [RuntimeCapability.PRE_TOOL_GUARD] : [],
    unenforced,
    ...(wantsExit ? { reason: "ZCode's headless Stop-hook behaviour is unverified — exit checks run post-hoc in STA" } : {}),
  };
}

/** Strip a leading `---` YAML frontmatter block; the body is the role's instructions. */
function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/**
 * The STA-managed hooks the trust record must show trusted, named by event and
 * guard script — derived from the one rendering of `.zcode/config.json`, so a
 * hook added to the payload is automatically required here too.
 */
export function managedZcodeHooks(): { event: string; script: string }[] {
  const rendered = renderZcodeManagedHooks();
  const out: { event: string; script: string }[] = [];
  for (const [event, registrations] of Object.entries(rendered.events)) {
    for (const registration of registrations) {
      for (const hook of registration.hooks) {
        const script = hook.args[hook.args.length - 1]?.split("/").pop();
        if (script) out.push({ event, script });
      }
    }
  }
  return out;
}

/** Managed hooks that are absent, disabled, or not persistently trusted — one line each. */
export function untrustedManagedHooks(status: ZcodeTrustStatus): string[] {
  const problems: string[] = [];
  for (const { event, script } of managedZcodeHooks()) {
    const item = status.items.find((candidate) => candidate.event === event && candidate.displayCommand.replace(/\\/g, "/").endsWith(`/.claude/hooks/${script}`));
    if (!item) problems.push(`${event} ${script}: not declared`);
    else if (!item.configuredEnabled) problems.push(`${event} ${script}: disabled`);
    else if (item.trustState !== TRUSTED) problems.push(`${event} ${script}: ${item.trustState}`);
  }
  return problems;
}

/** Tolerant reader over `zcode hooks trust status --json`. */
export function parseZcodeTrustStatus(stdout: string): ZcodeTrustStatus | null {
  const value = parseJsonObject(stdout);
  if (!value || !Array.isArray(value.items)) return null;
  const items: ZcodeTrustItem[] = [];
  for (const raw of value.items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.event !== "string" || typeof item.displayCommand !== "string" || typeof item.trustState !== "string") continue;
    items.push({
      event: item.event,
      displayCommand: item.displayCommand,
      configuredEnabled: item.configuredEnabled === true,
      trustState: item.trustState,
      ...(typeof item.hookDeclarationDigest === "string" ? { hookDeclarationDigest: item.hookDeclarationDigest } : {}),
    });
  }
  return {
    ...(typeof value.workspacePath === "string" ? { workspacePath: value.workspacePath } : {}),
    ...(typeof value.workspaceIdentity === "string" ? { workspaceIdentity: value.workspaceIdentity } : {}),
    ...(typeof value.bundleDigest === "string" ? { bundleDigest: value.bundleDigest } : {}),
    ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    items,
  };
}

export interface ZcodeSummary {
  readonly sessionId?: string;
  readonly response?: string;
  readonly usage: RuntimeUsage;
  readonly projectionStatus?: string;
  /** The skip reason code when the engine reports project hooks were skipped for this run. */
  readonly hooksSkipped?: string;
}

/**
 * Tolerant reader over the `--json` summary object (fields traced in the
 * bundle's headless runner). Absent usage counters stay undefined — absent ≠ 0.
 */
export function parseZcodeSummary(stdout: string): ZcodeSummary | null {
  const value = parseJsonObject(stdout);
  if (!value) return null;
  const usageRaw = value.usage && typeof value.usage === "object" ? (value.usage as Record<string, unknown>) : {};
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) if (typeof usageRaw[key] === "number") return usageRaw[key] as number;
    return undefined;
  };
  const inputTokens = num("inputTokens", "input_tokens", "promptTokens");
  const outputTokens = num("outputTokens", "output_tokens", "completionTokens");
  const cachedInputTokens = num("cachedInputTokens", "cacheReadTokens", "cache_read_input_tokens");
  const projection = value.projection && typeof value.projection === "object" ? (value.projection as Record<string, unknown>) : {};
  const trust = value.workspaceHookTrust && typeof value.workspaceHookTrust === "object" ? (value.workspaceHookTrust as Record<string, unknown>) : null;
  return {
    ...(typeof value.sessionId === "string" && value.sessionId.length > 0 ? { sessionId: value.sessionId } : {}),
    ...(typeof value.response === "string" ? { response: value.response } : {}),
    usage:
      inputTokens !== undefined || outputTokens !== undefined || cachedInputTokens !== undefined
        ? { inputTokens, outputTokens, cachedInputTokens }
        : {},
    ...(typeof projection.status === "string" ? { projectionStatus: projection.status } : {}),
    ...(trust ? { hooksSkipped: typeof trust.reasonCode === "string" ? trust.reasonCode : "unknown" } : {}),
  };
}

/** The whole output as one JSON object, or the last line that parses as one. */
function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const asObject = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = asObject(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = asObject(lines[i]!);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The post-run write check `verifyRun` hands the lifecycle: every file the
 * work-root snapshots say a write-capable run changed must be writable under
 * that run's own guard rules (an empty grant writes nothing), and such a run
 * whose writes could not be snapshotted is not verified at all — fail closed.
 * A read-only run must change nothing.
 */
export function verifyZcodeRunWrites(req: RuntimeAgentRequest, changedFiles: readonly string[] | undefined): string[] {
  const readOnly = req.autonomy === "read-only";
  if (changedFiles === undefined) {
    return readOnly ? [] : ["the run's writes could not be snapshotted (work root is not a usable git checkout), so they cannot be verified against the grant"];
  }
  const multiRoot = (req.workRoots?.length ?? 0) > 1;
  const violations: string[] = [];
  for (const key of changedFiles) {
    const file = multiRoot && key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    if (readOnly) {
      violations.push(`${file} changed during a read-only run that may change nothing`);
      continue;
    }
    const decision = canWritePath({ write: [...req.guards.writeAllow], deny: [...req.guards.writeDeny], read: [] }, file);
    if (!decision.allowed) violations.push(`${file} was written outside the grant: ${decision.reason}`);
  }
  return violations;
}
