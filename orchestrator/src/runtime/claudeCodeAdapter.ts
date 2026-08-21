import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
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
} from "./runtimeAdapter.js";

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

export type SpawnSync = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    encoding: "utf8";
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
) => SpawnSyncReturns<string>;

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

interface ClaudeCliJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
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

  constructor(opts: ClaudeCodeAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
  }

  async probe(): Promise<RuntimeProbe> {
    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.spawn("claude", ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
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
      req.prompt,
    ];

    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.spawn("claude", args, {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        // T15: the one way a PreToolUse hook can know which agent is writing.
        env: { ...process.env, ...req.env, AGENTCLAUDE_ROLE: req.role },
      });
    } catch (e) {
      // A spawn that throws outright — not one that returns with `.error` set —
      // means the runtime itself could not be reached, never a task failure.
      return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [`failed to spawn \`claude\`: ${String(e)}`] };
    }

    const guards = await guardReportFor(this.workspace, this.binding.guardConfigPath!, req.guards);

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics: [`\`claude\` binary not found: ${proc.error.message}`] };
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
      raw: cli,
    };
  }
}
