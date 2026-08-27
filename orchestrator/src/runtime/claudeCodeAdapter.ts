import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LocalWorkspace } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import type {
  RuntimeAdapter,
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
 * The spawn primitive now lives on the port (`runtimeAdapter.ts`) so no adapter
 * depends on a sibling adapter's module. Re-exported here for the tests and
 * call sites that historically imported it from this file.
 */
export type { SpawnSync } from "./runtimeAdapter.js";

/**
 * The `RuntimeAdapter` for Claude Code (T109) — the Claude-Code-specific half
 * that `agents/claudeCliExecutor.ts` used to hold before T108 split it. This is
 * that file's `spawnSync("claude", ...)` call, its JSON envelope, and its
 * `AGENTCLAUDE_ROLE` environment variable, now behind the seam `runtimeAdapter.ts`
 * defines instead of welded to `agents/registry.ts` and `orchestrator.ts` directly.
 *
 * Everything that is this framework's business rather than Claude Code's —
 * assembling the prompt, slicing module docs, reading `review.md`/`security.md`
 * back, mapping metrics — already moved to `runtime/agentRunAssembly.ts` in T108
 * and is driven by `runtime/runtimeExecutor.ts`, not by this file. This adapter
 * only has to answer: how does one run of one role actually happen on this
 * machine, and what did it cost.
 */

/**
 * A way to invoke a CLI whose bare name `spawnSync` cannot execute on this machine.
 *
 * The resolver now lives in the neutral `npmCliResolver.ts` (no adapter may
 * depend on a sibling provider's module); re-exported here for the tests and
 * call sites that historically imported it from this file.
 */
export type { CommandResolver, ResolvedCommand } from "./npmCliResolver.js";
export { resolveNpmCliScript } from "./npmCliResolver.js";
import { resolveNpmCliScript as resolveNpmCliScriptImpl, type CommandResolver } from "./npmCliResolver.js";

/**
 * Claude Code's subagent frontmatter accepts these four `model:` values
 * (CLAUDE.md's model table uses `sonnet`/`opus`; `haiku`/`inherit` are documented
 * options nothing in this repo's own agents currently uses). Not literal API
 * model ids — `RuntimeAdapter.models` is scoped to what a role's frontmatter may
 * name, which is the only thing this adapter is ever asked to reach.
 */
const CLAUDE_CODE_MODELS: readonly string[] = ["opus", "sonnet", "haiku", "inherit"];

/**
 * What the Claude Code product claims, independent of any one project's
 * installation. `PARALLEL_EXECUTION` is deliberately absent — reserved for T35's
 * file-level locking work, which nothing here relies on yet.
 */
const CLAUDE_CODE_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.NAMED_AGENTS,
  RuntimeCapability.MODEL_SELECTION,
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.POST_TOOL_GUARD,
  RuntimeCapability.EXIT_GUARD,
  RuntimeCapability.PER_AGENT_EXIT_GUARD,
  RuntimeCapability.PROJECT_LEVEL_BINDING,
  RuntimeCapability.STRUCTURED_RESULT,
  RuntimeCapability.COST_REPORTING,
  RuntimeCapability.INTERACTIVE_PROMPTS,
];

/**
 * `RuntimeAutonomy` onto Claude Code's actual `--permission-mode` values
 * (`default`/`acceptEdits`/`plan`/`bypassPermissions`).
 *
 * `propose` -> `default` preserves `claudeCliExecutor.ts`'s old hardcoded
 * `"manual"` default exactly: `createRuntimeExecutor` also defaults `autonomy` to
 * `"propose"`, so an unconfigured caller sees identical behaviour to before this
 * task. `read-only` maps to `plan` as the closest available mode — Claude Code has
 * no flag that guarantees zero file changes short of restricting tools, which is
 * outside what this interface's four-value `autonomy` field can express; a caller
 * that genuinely needs that guarantee still has to combine this with `guards`.
 */
const PERMISSION_MODE: Record<RuntimeAutonomy, string> = {
  "read-only": "plan",
  propose: "default",
  edit: "acceptEdits",
  full: "bypassPermissions",
};

/**
 * Renders a request's guards as Claude Code `--disallowedTools` permission
 * rules — the OFF10 M4 hard layer beside the hooks.
 *
 * WHY THIS LAYER EXISTS
 *
 * Anthropic's own hooks reference states the hook filter is best-effort and
 * that hard allow/deny belongs to the *permission system* (OFF02 S4). Until now
 * a contract's deny globs reached a run only through env + PreToolUse hooks,
 * i.e. only through the best-effort layer. The same rules expressed here ride
 * the documented flag surface: tool rules are removed from availability before
 * permissions are ever evaluated, so `Write(.git/**)` denies harder than any
 * hook can. The mapping is deliberately mechanical:
 *
 *   writeDeny glob      → `Write(<glob>)` + `Edit(<glob>)`  (the file-mutating tools)
 *   forbidCommands cmd  → `Bash(<cmd> *)`                   (any shell use of it)
 *
 * The universal deny floor is already merged into `writeDeny` by
 * `contractGuards`, so floor and role-specific denies travel together. Hooks
 * stay wired exactly as they were — this layer narrows what can even be
 * attempted; it does not replace the backstop or the orchestrator-side guard
 * verification.
 */
export function disallowRulesFromGuards(guards: RuntimeGuards): string[] {
  const rules = new Set<string>();
  for (const glob of guards.writeDeny) {
    if (glob.length === 0) continue;
    rules.add(`Write(${glob})`);
    rules.add(`Edit(${glob})`);
  }
  for (const command of guards.forbidCommands) {
    const name = command.trim();
    if (name.length === 0) continue;
    rules.add(`Bash(${name} *)`);
  }
  return [...rules];
}

interface ClaudeCliJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  /** OFF10 M6 — present only when the run passed `--json-schema`. */
  structured_output?: unknown;
}

function parseCliOutput(raw: string): { value: ClaudeCliJsonResult; parseFailed: boolean } {
  try {
    return { value: JSON.parse(raw) as ClaudeCliJsonResult, parseFailed: false };
  } catch {
    return { value: {}, parseFailed: true };
  }
}

interface ClaudeSettingsHooks {
  hooks?: {
    PreToolUse?: unknown[];
    Stop?: unknown[];
    SubagentStop?: unknown[];
  };
}

/**
 * What this *run* actually had wired, read from `.claude/settings.json` in the
 * workspace the agent ran in — not from this adapter's static `capabilities`
 * claim, which says what the product can do, not what a given project installed.
 * Only checked for the guard axes this particular request asked for: a run with
 * an empty `exitChecks` was never promised an exit guard, so it has nothing to be
 * unenforced about.
 */
async function guardReportFor(
  workspace: RuntimeWorkspace,
  guardConfigPath: string,
  requested: RuntimeGuards,
): Promise<RuntimeGuardReport> {
  const wantsPreToolGuard = requested.writeAllow.length > 0 || requested.writeDeny.length > 0 || requested.forbidCommands.length > 0;
  const wantsExitGuard = requested.exitChecks.length > 0;
  if (!wantsPreToolGuard && !wantsExitGuard) return { enforced: [], unenforced: [] };

  let raw: string | null;
  try {
    raw = await workspace.readFile(guardConfigPath);
  } catch {
    raw = null;
  }
  if (raw === null) {
    const unenforced = [
      ...(wantsPreToolGuard ? [RuntimeCapability.PRE_TOOL_GUARD] : []),
      ...(wantsExitGuard ? [RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD] : []),
    ];
    return { enforced: [], unenforced, reason: `no ${guardConfigPath} found in this workspace — guard wiring absent` };
  }

  let settings: ClaudeSettingsHooks;
  try {
    settings = JSON.parse(raw) as ClaudeSettingsHooks;
  } catch {
    const unenforced = [
      ...(wantsPreToolGuard ? [RuntimeCapability.PRE_TOOL_GUARD] : []),
      ...(wantsExitGuard ? [RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD] : []),
    ];
    return { enforced: [], unenforced, reason: `${guardConfigPath} is not valid JSON — cannot confirm guard wiring` };
  }

  const hasHooks = (name: "PreToolUse" | "Stop" | "SubagentStop") => Array.isArray(settings.hooks?.[name]) && settings.hooks![name]!.length > 0;

  const enforced: RuntimeCapability[] = [];
  const unenforced: RuntimeCapability[] = [];
  if (wantsPreToolGuard) (hasHooks("PreToolUse") ? enforced : unenforced).push(RuntimeCapability.PRE_TOOL_GUARD);
  if (wantsExitGuard) {
    (hasHooks("Stop") ? enforced : unenforced).push(RuntimeCapability.EXIT_GUARD);
    (hasHooks("SubagentStop") ? enforced : unenforced).push(RuntimeCapability.PER_AGENT_EXIT_GUARD);
  }
  return {
    enforced,
    unenforced,
    reason: unenforced.length > 0 ? `${guardConfigPath} has no hook wired for: ${unenforced.join(", ")}` : undefined,
  };
}

export interface ClaudeCodeAdapterOptions {
  /** Root of the target project — where `.claude/agents/<role>.md` and `_docs/` live. */
  projectRoot: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Default per-run timeout in ms, overridable per request via `RuntimeAgentRequest.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Injectable for tests; defaults to `resolveNpmCliScript`. Only consulted when
   * `platform` is win32 and a spawn came back ENOENT — the one case where the
   * bare command name is known-unusable rather than merely absent.
   */
  resolveCommand?: CommandResolver;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: string;
  /**
   * OFF10 M6 — when set, every run passes `--json-schema` and the envelope's
   * `structured_output` lands on `RuntimeAgentResult.structured`. **Off by
   * default**: the pipeline's prompt contract promises agents a free-form
   * summary ("the orchestrator reads … not a special reply format"), so flipping
   * this on is a caller decision (e.g. a QA03 hardening pass), never a side
   * effect of using this adapter.
   */
  outputSchema?: Record<string, unknown>;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly binding: RuntimeBinding = {
    dir: ".claude",
    definitionPath: (role) => `.claude/agents/${role}.md`,
    guardConfigPath: ".claude/settings.json",
  };
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(CLAUDE_CODE_CAPABILITIES);
  readonly models: ReadonlySet<string> = new Set(CLAUDE_CODE_MODELS);
  readonly workspace: RuntimeWorkspace;

  private readonly spawn: SpawnSync;
  private readonly defaultTimeoutMs: number;
  private readonly resolveCommand: CommandResolver;
  private readonly platform: string;
  private readonly outputSchema?: Record<string, unknown>;

  constructor(opts: ClaudeCodeAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.resolveCommand = opts.resolveCommand ?? resolveNpmCliScriptImpl;
    this.platform = opts.platform ?? process.platform;
    this.outputSchema = opts.outputSchema;
  }

  /**
   * One spawn, plus the single retry it is allowed: on Windows an ENOENT from a
   * bare command name usually means "npm shim", not "not installed" — resolve
   * the shim's real entry script and try once more. Any other error (or a
   * resolver that finds nothing) returns the first result untouched, so every
   * existing status mapping below behaves exactly as before.
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

  async probe(): Promise<RuntimeProbe> {
    let proc: SpawnSyncReturns<string>;
    try {
      ({ proc } = this.spawnResolved("claude", ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }));
    } catch (e) {
      return { available: false, reason: String(e) };
    }
    if (proc.error) return { available: false, reason: proc.error.message };
    if (proc.status !== 0) return { available: false, reason: `\`claude --version\` exited ${proc.status ?? "unknown"}` };
    return { available: true, version: (proc.stdout ?? "").trim() };
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    // req.model is deliberately not turned into a `--model` flag here: the
    // subagent's own `.claude/agents/<role>.md` frontmatter already selects a
    // model, and passing both risks the two disagreeing. T112 is where a genuine
    // per-run override gets designed, once it decides whether that means editing
    // the frontmatter or finally using this flag.
    const args = [
      "-p",
      "--agent",
      req.role,
      "--output-format",
      "json",
      "--permission-mode",
      PERMISSION_MODE[req.autonomy],
    ];
    // M4: contract denies as hard permission rules, not just hook backstops.
    // Empty guards ⇒ no flag, keeping the no-guard request shape unchanged.
    //
    // The rules ride the `--disallowedTools=<rules>` EQUALS form on purpose.
    // claude v2.1.241 parses the space form greedily and swallows the next
    // positional. The prompt itself is deliberately sent on stdin below: on
    // Windows a production context can exceed the native command-line limit,
    // while `claude -p` accepts its default text input from stdin.
    const disallowRules = disallowRulesFromGuards(req.guards);
    if (disallowRules.length > 0) args.push(`--disallowedTools=${disallowRules.join(",")}`);
    // M6: only when a schema was requested — default runs stay free-form.
    if (this.outputSchema) args.push("--json-schema", JSON.stringify(this.outputSchema));

    let proc: SpawnSyncReturns<string>;
    let resolvedThrough: string | null = null;
    try {
      ({ proc, resolvedThrough } = this.spawnResolved("claude", args, {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        input: req.prompt,
        // T15: the one way a PreToolUse hook can know which agent is writing.
        env: { ...process.env, ...req.env, AGENTCLAUDE_ROLE: req.role },
      }));
    } catch (e) {
      // A spawn that throws outright — not one that returns with `.error` set —
      // means the runtime itself could not be reached, never a task failure.
      return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [`failed to spawn \`claude\`: ${String(e)}`] };
    }

    const guards = await guardReportFor(this.workspace, this.binding.guardConfigPath!, req.guards);

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const diagnostics = [`\`claude\` binary not found: ${proc.error.message}`];
        if (resolvedThrough === null && this.platform === "win32") {
          diagnostics.push(
            "on Windows an npm-installed `claude` is a .cmd/.ps1 shim spawnSync cannot execute; no resolvable entry was found — install the native build or expose a real executable on PATH",
          );
        }
        return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics };
      }
      if (code === "ETIMEDOUT") {
        return { status: "TIMEOUT", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`\`claude --agent ${req.role}\` timed out: ${proc.error.message}`] };
      }
      return { status: "ERROR", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`\`claude\` errored: ${proc.error.message}`] };
    }

    const { value: cli, parseFailed } = parseCliOutput(proc.stdout ?? "");
    const diagnostics = parseFailed ? ["could not parse `claude`'s stdout as JSON — usage/cost are unknown for this run"] : [];
    const usage: RuntimeUsage = {
      inputTokens: cli.usage?.input_tokens,
      outputTokens: cli.usage?.output_tokens,
      cachedInputTokens: cli.usage?.cache_read_input_tokens,
      costUsd: cli.total_cost_usd,
    };

    const cliFailed = proc.status !== 0 || cli.is_error === true;
    return {
      status: cliFailed ? "ERROR" : "OK",
      exitCode: proc.status ?? null,
      text: cli.result ?? proc.stderr ?? "",
      usage,
      // Claude Code's `-p --output-format json` envelope does not report which
      // model actually ran, so this stays undefined and the caller falls back to
      // the model it configured (`runtimeExecutor.ts`'s `metricsFrom`).
      model: undefined,
      guards,
      diagnostics,
      // M6: present only on schema-requested runs where the CLI delivered one —
      // a stray envelope field on a free-form run must not masquerade as a
      // schema-validated document.
      structured: this.outputSchema ? cli.structured_output : undefined,
      raw: cli,
    };
  }
}
