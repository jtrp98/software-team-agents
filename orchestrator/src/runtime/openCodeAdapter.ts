import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { LocalWorkspace } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import {
  resolveNpmCliScript,
  type CommandResolver,
} from "./npmCliResolver.js";
import type {
  RuntimeAdapter,
  RuntimeAgentRequest,
  RuntimeAgentResult,
  RuntimeBinding,
  RuntimeGuardReport,
  RuntimeGuards,
  RuntimeProbe,
  RuntimeUsage,
  RuntimeWorkspace,
  SpawnSync,
} from "./runtimeAdapter.js";

/**
 * The `RuntimeAdapter` for OpenCode — the third runtime behind the seam
 * `runtimeAdapter.ts` defines.
 *
 * Unlike `codexAdapter.ts`, this implementation is **spike-backed**: every flag,
 * event shape, and capability claim below was exercised against a real
 * OpenCode 1.18.21 install on Windows, not read off documentation:
 *
 * - `opencode run --agent <role> --format json "<prompt>"` runs one headless
 *   turn and exits; stdout is an NDJSON event stream whose `text` events carry
 *   the message and whose final `step_finish` carries tokens and cost.
 * - `-m provider/model` selects the model per run, `--variant <effort>` sets
 *   reasoning effort. This adapter's convention: `req.model` may carry either
 *   `provider/model` or `provider/model#effort`; a `#effort` suffix becomes
 *   `--variant`.
 * - Named agents load natively from `.opencode/agent/<role>.md` — no prompt
 *   folding needed, unlike Codex.
 * - The binding's declarative `permission:` block plus the auto-loaded
 *   `.opencode/plugin/sta-guards.js` plugin are the enforcement half of this
 *   framework's guards. The spike proved OpenCode's headless default posture is
 *   allow-all, so those two layers are what makes a run guarded at all; the
 *   adapter reports honestly which of them it could verify per run.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 * - `EXIT_GUARD` / `PER_AGENT_EXIT_GUARD` — no Stop-hook equivalent has been
 *   verified under `opencode run`. Exit checks stay the orchestrator's post-hoc
 *   job on this runtime, and every run that requests them is told so via
 *   `RuntimeGuardReport.unenforced`.
 * - `INTERACTIVE_PROMPTS` — `opencode run` is non-interactive; stages that put
 *   a question to a person cannot run here as designed.
 * - `PARALLEL_EXECUTION` — unclaimed by every adapter.
 * - `models` — no catalogue is invented. A caller that knows what its
 *   installation reaches passes `models` in options; left empty,
 *   `RuntimeRegistry.reaching()` answers nothing rather than a fabricated
 *   everything.
 */

const OPENCODE_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.NAMED_AGENTS,
  RuntimeCapability.MODEL_SELECTION,
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.POST_TOOL_GUARD,
  RuntimeCapability.PROJECT_LEVEL_BINDING,
  RuntimeCapability.STRUCTURED_RESULT,
  RuntimeCapability.COST_REPORTING,
];

/**
 * Stderr fingerprints of provider/auth failures observed on the spike (free
 * model behind the gateway): `Error: Provider finish_reason: network_error`,
 * exit 1. These mean "the runtime could not be used", not "the task failed" —
 * mapping them to UNAVAILABLE keeps the task's retry budget intact.
 */
const PROVIDER_FAILURE_PATTERN = /provider finish_reason|network_error|unauthorized|forbidden|\b401\b|\b403\b|rate.?limit/i;

export interface OpenCodeAdapterOptions {
  /** Root of the target project — where `.opencode/agent/<role>.md` lives. */
  projectRoot: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Default per-run timeout in ms, overridable per request via `RuntimeAgentRequest.timeoutMs`. */
  timeoutMs?: number;
  /** Models this installation is known to reach. No default — see file header. */
  models?: readonly string[];
  /** Injectable for tests; defaults to the shared npm-shim resolver. */
  resolveCommand?: CommandResolver;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: string;
}

export class OpenCodeAdapter implements RuntimeAdapter {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly binding: RuntimeBinding = {
    dir: ".opencode",
    definitionPath: (role) => `.opencode/agent/${role}.md`,
    // The sta-guards plugin IS this runtime's guard wiring: generated into the
    // project, auto-loaded by OpenCode, denying tool calls by throwing. When it
    // is missing the adapter reports guards unenforced instead of pretending.
    guardConfigPath: ".opencode/plugin/sta-guards.js",
  };
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(OPENCODE_CAPABILITIES);
  readonly models: ReadonlySet<string>;
  readonly workspace: RuntimeWorkspace;

  private readonly spawn: SpawnSync;
  private readonly defaultTimeoutMs: number;
  private readonly resolveCommand: CommandResolver;
  private readonly platform: string;

  constructor(opts: OpenCodeAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.models = new Set(opts.models ?? []);
    this.resolveCommand = opts.resolveCommand ?? resolveNpmCliScript;
    this.platform = opts.platform ?? process.platform;
  }

  async probe(): Promise<RuntimeProbe> {
    let proc: SpawnSyncReturns<string>;
    try {
      ({ proc } = this.spawnResolved("opencode", ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }));
    } catch (e) {
      return { available: false, reason: String(e) };
    }
    if (proc.error) return { available: false, reason: proc.error.message };
    if (proc.status !== 0) return { available: false, reason: `\`opencode --version\` exited ${proc.status ?? "unknown"}` };
    const version = (proc.stdout ?? "").trim();
    return { available: true, version };
  }

  /**
   * One spawn plus the single npm-shim retry allowed on Windows — same shape as
   * `claudeCodeAdapter.ts`'s, driven by the shared neutral resolver.
   */
  private spawnResolved(
    command: string,
    args: string[],
    options: Parameters<SpawnSync>[2],
  ): { proc: SpawnSyncReturns<string>; resolvedThrough: string | null } {
    const proc = this.spawn(command, args, options);
    const code = proc.error ? (proc.error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT" || this.platform !== "win32") return { proc, resolvedThrough: null };
    const resolved = this.resolveCommand(command);
    if (!resolved) return { proc, resolvedThrough: null };
    return { proc: this.spawn(resolved.file, [...resolved.prefixArgs, ...args], options), resolvedThrough: resolved.file };
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    // Fail fast with recovery advice when the role's rendering is missing —
    // OpenCode would otherwise fall back to its default agent silently (the
    // spike's nastiest finding), so a missing binding must never reach spawn.
    const definitionExists = await this.workspace.exists(req.definitionPath).catch(() => false);
    if (!definitionExists) {
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards: { enforced: [], unenforced: [] },
        diagnostics: [
          `no role binding found at ${req.definitionPath} — \`opencode run --agent\` would silently fall back to OpenCode's default agent; regenerate bindings via sta init/sync`,
        ],
      };
    }

    const guards = await this.guardReportFor(req.guards);

    const args = ["run", "--format", "json", "--agent", req.role];
    // `provider/model#effort` → `-m provider/model --variant effort` (spike-verified flags).
    if (req.model) {
      const hashIndex = req.model.indexOf("#");
      if (hashIndex === -1) {
        args.push("-m", req.model);
      } else {
        args.push("-m", req.model.slice(0, hashIndex), "--variant", req.model.slice(hashIndex + 1));
      }
    }
    // Autonomy rides on the binding's rendered permission block and the
    // sta-guards plugin — `opencode run` exposes no per-run permission axis
    // besides the dangerous `--auto`, which this adapter never passes. A
    // request whose guards exceed what the binding declares surfaces below as
    // `unenforced`, not as a silent gap.
    args.push(req.prompt);

    let proc: SpawnSyncReturns<string>;
    let resolvedThrough: string | null = null;
    try {
      ({ proc, resolvedThrough } = this.spawnResolved("opencode", args, {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...req.env, AGENTCLAUDE_ROLE: req.role },
      }));
    } catch (e) {
      return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics: [`failed to spawn \`opencode\`: ${String(e)}`] };
    }

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const diagnostics = [`\`opencode\` binary not found: ${proc.error.message}`];
        if (resolvedThrough === null && this.platform === "win32") {
          diagnostics.push(
            "on Windows an npm-installed `opencode` is a .cmd/.ps1 shim spawnSync cannot execute; no resolvable entry was found — install the native build or expose a real executable on PATH",
          );
        }
        return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics };
      }
      if (code === "ETIMEDOUT") {
        return { status: "TIMEOUT", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`\`opencode run --agent ${req.role}\` timed out: ${proc.error.message}`] };
      }
      return { status: "UNAVAILABLE", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`failed to spawn \`opencode\`: ${proc.error.message}`] };
    }

    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const exitCode = proc.status ?? null;
    const parsed = parseOpenCodeJsonl(stdout);

    const diagnostics: string[] = [];
    if (req.workRoots && req.workRoots.length > 0) {
      diagnostics.push(
        `${req.workRoots.length} work root(s) ride on AGENTCLAUDE_WRITABLE_WORK_ROOTS + the sta-guards plugin — opencode run exposes no OS-level per-directory sandbox grant`,
      );
    }
    // Provider/auth failures are the runtime being unusable, not the task failing.
    if (exitCode !== 0 && PROVIDER_FAILURE_PATTERN.test(stderr)) {
      diagnostics.push(`provider/auth failure: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
      return { status: "UNAVAILABLE", exitCode, text: "", usage: parsed.usage, guards, diagnostics, raw: { stdout, stderr } };
    }
    if (exitCode !== 0) {
      diagnostics.push(`\`opencode run\` exited ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" | ") || "no stderr"}`);
    }

    return {
      status: exitCode === 0 ? "OK" : "ERROR",
      exitCode,
      text: parsed.text,
      usage: parsed.usage,
      model: parsed.model,
      guards,
      diagnostics,
      raw: { stdout, stderr },
    };
  }

  /**
   * Honest per-run guard accounting. Enforced = the mechanisms this runtime
   * actually has and this project actually ships: the binding's permission
   * frontmatter plus the sta-guards plugin (checked on disk). Exit checks have
   * no verified mechanism on OpenCode and are always reported unenforced so
   * T111/T-OC7 covers them post-hoc.
   */
  private async guardReportFor(requested: RuntimeGuards): Promise<RuntimeGuardReport> {
    const wantsPreToolGuard =
      requested.writeAllow.length > 0 || requested.writeDeny.length > 0 || requested.forbidCommands.length > 0;
    const wantsExitGuard = requested.exitChecks.length > 0;
    if (!wantsPreToolGuard && !wantsExitGuard) return { enforced: [], unenforced: [] };

    let pluginPresent = false;
    try {
      pluginPresent = (await this.workspace.exists(this.binding.guardConfigPath!)) ?? false;
    } catch {
      pluginPresent = false;
    }
    const enforced = pluginPresent ? [RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.POST_TOOL_GUARD] : [];
    const unenforced: RuntimeCapability[] = [];
    if (wantsPreToolGuard && !pluginPresent) {
      unenforced.push(RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.POST_TOOL_GUARD);
    }
    if (wantsExitGuard) unenforced.push(RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD);
    const reason = !pluginPresent
      ? `${this.binding.guardConfigPath} is missing — OpenCode enforces nothing declaratively beyond the binding's own permission block; restore it via sta init/sync`
      : wantsExitGuard
        ? "OpenCode has no verified Stop-hook equivalent under `opencode run` — exit checks run post-hoc in the orchestrator"
        : undefined;
    return { enforced, unenforced, ...(reason ? { reason } : {}) };
  }
}

/**
 * Tolerant reader over `opencode run --format json`'s NDJSON stream (shapes
 * verified on the spike; anything absent stays undefined per the absent ≠ 0
 * invariant). Never throws on a line it cannot parse. Text parts concatenate in
 * arrival order — the model may split its reply across several parts.
 */
export function parseOpenCodeJsonl(stdout: string): { text: string; usage: RuntimeUsage; model?: string; finishReason?: string } {
  const texts: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let costUsd: number | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = event.part as Record<string, unknown> | undefined;
    if (!part || typeof part !== "object") continue;
    if (event.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (event.type === "step_finish") {
      if (typeof part.reason === "string") finishReason = part.reason;
      if (typeof part.cost === "number") costUsd = part.cost;
      const tokens = part.tokens as Record<string, unknown> | undefined;
      if (tokens && typeof tokens === "object") {
        if (typeof tokens.input === "number") inputTokens = tokens.input;
        if (typeof tokens.output === "number") outputTokens = tokens.output;
        const cache = tokens.cache as Record<string, unknown> | undefined;
        if (cache && typeof cache === "object" && typeof cache.read === "number") cachedInputTokens = cache.read;
      }
    }
    if (typeof part.model === "string" && part.model.length > 0) model = part.model;
  }
  return {
    text: texts.join(""),
    usage:
      inputTokens !== undefined || outputTokens !== undefined || cachedInputTokens !== undefined || costUsd !== undefined
        ? { inputTokens, outputTokens, cachedInputTokens, costUsd }
        : {},
    model,
    finishReason,
  };
}
