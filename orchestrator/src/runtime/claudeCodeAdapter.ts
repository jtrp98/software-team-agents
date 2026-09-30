import { largeFilePolicyEnv, resolveLargeFilePolicyFromProject, summarizeReadLedger, type ReadLedgerSummary } from "../context/largeFile.js";
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { approvalChannelDir } from "../gates/humanChannelConfig.js";
import { LocalWorkspace } from "./localWorkspace.js";
import { startEgressAllowlistProxy, type StartEgressAllowlistProxy } from "./egressAllowlistProxy.js";
import { canonicalPath, permissionPathsFor, tomlString } from "./permissionPaths.js";
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
import { roleEnv, roleLabel } from "./runtimeAdapter.js";

/**
 * The spawn primitive lives on the port (`runtimeAdapter.ts`) so no adapter
 * depends on a sibling adapter's module. Re-exported here for tests and call
 * sites that import it from this file.
 */
export type { SpawnSync } from "./runtimeAdapter.js";

/**
 * The `RuntimeAdapter` for Claude Code: the `spawnSync("claude", ...)` call,
 * its JSON envelope, and its `STA_ROLE` environment variable, behind
 * the seam `runtimeAdapter.ts` defines instead of welded to
 * `agents/registry.ts` and `orchestrator.ts` directly.
 *
 * Everything that is this framework's business rather than Claude Code's —
 * assembling the prompt, slicing module docs, reading `qa.md`/`security.md`
 * back, mapping metrics — lives in `runtime/agentRunAssembly.ts` and is driven
 * by `runtime/runtimeExecutor.ts`, not by this file. This adapter only has to
 * answer: how does one run of one role actually happen on this machine, and
 * what did it cost.
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
 * The levels `claude --effort <level>` accepts. Verified against the installed
 * CLI's own `--help`, the same way `CLAUDE_CODE_MODELS` is scoped to what the
 * runtime can actually reach: an unreachable value is refused, never passed
 * through to be rejected downstream at an unknown quality.
 */
const CLAUDE_CODE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

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
  // V13 TASK-014 — the lifecycle this adapter actually implements through
  // `SingleShotLifecycle`: fresh-session resume from the persisted attempt
  // journal (Claude Code's headless `-p` runs have no mid-attempt restore to
  // resume into), honest cancel accounting, and evidence collection computed
  // from the run's own spawn and the work-root snapshots around it.
  RuntimeCapability.ATTEMPT_RESUME,
  RuntimeCapability.ATTEMPT_CANCEL,
  RuntimeCapability.EVIDENCE_COLLECTION,
];

/**
 * `RuntimeAutonomy` onto Claude Code's actual `--permission-mode` values
 * (`default`/`acceptEdits`/`plan`/`bypassPermissions`).
 *
 * `propose` -> `default` preserves the legacy executor's hardcoded
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

/**
 * V13 TASK-031 — the OS approval-isolation boundary for Claude Code.
 *
 * Claude Code's own `sandbox.*` settings are not a boundary here: on Windows
 * its sandbox is feature-gated off, and even when active it wraps only the Bash
 * tool — the built-in Read/Write/Edit tools run inside `claude.exe` with the
 * user's token (R14F spike: both read and wrote a decoy approval dir despite
 * `sandbox.filesystem.denyRead/denyWrite`). So the WHOLE `claude` process is
 * launched under Codex's Windows elevated restricted-token sandbox
 * (`codex sandbox`), with a per-run profile of the same shape the certified
 * Codex adapter uses: broad read, the canonical approval channel an exact
 * `deny`, writes only at packet-authorized paths plus this run's own
 * scratch dirs, and network OFF at the OS. The model API is reached only
 * through the adapter's loopback CONNECT proxy, which tunnels exactly
 * `api.anthropic.com:443` (`egressAllowlistProxy.ts`): with the profile's
 * VCS directory read-only this leaves no local or remote Git state change and
 * no other egress — the parity with Codex's network-disabled profile that
 * unattended Target writes require.
 *
 * Per-run home, never the user's: the elevated backend turns every write grant
 * into a persistent ACE for the shared sandbox group, so granting the real
 * `~/.claude` would let any later sandboxed process plant hooks the user's next
 * unsandboxed `claude` executes (R14F §Security side effect). The run gets a
 * fresh `CLAUDE_CONFIG_DIR`, `TEMP` and `CODEX_HOME` under one temp root that is
 * deleted after the run; the login therefore comes only from the environment a
 * person provisions (e.g. the long-lived token `claude setup-token` issues). The
 * adapter neither reads nor copies any credential — without one, claude fails
 * its own authentication and the run is an ERROR.
 *
 * Verified only on Windows; elsewhere the builder throws and the run is refused.
 */
export const CLAUDE_ISOLATION_UNAVAILABLE = "CLAUDE_ISOLATION_UNAVAILABLE";
const CLAUDE_ISOLATION_PROFILE = "sta_run";
/** Workspace paths the agent may read but never rewrite: VCS state and the runtime bindings that carry its own guards. */
const ALWAYS_READ_ONLY_IN_WORKSPACE = [".git", ".claude", ".codex", ".agents"] as const;
/** The only hosts the egress proxy tunnels to. */
export const CLAUDE_EGRESS_HOSTS: readonly string[] = ["api.anthropic.com"];

/** The per-run directories granted to the wrapped process; all live under `root`, which the adapter deletes after the run. */
export interface ClaudeIsolationRunDirs {
  readonly root: string;
  readonly config: string;
  readonly temp: string;
  readonly codexHome: string;
}

export function claudeIsolationRunDirs(root: string): ClaudeIsolationRunDirs {
  return { root, config: path.join(root, "config"), temp: path.join(root, "tmp"), codexHome: path.join(root, "codex-home") };
}

/** Where per-run roots are created — exposed so the a1 preflight derives grants from the same base the spawn uses. */
export function claudeIsolationRunBase(): string {
  return os.tmpdir();
}

export interface ClaudeIsolationInvocation {
  /** `codex sandbox …` arguments, ending in `--`; the claude command line follows. */
  readonly sandboxArgs: readonly string[];
  /** Environment the wrapped process must receive (per-run homes). */
  readonly env: Readonly<Record<string, string>>;
  /** The canonical protected path the profile denies. */
  readonly protectedPath: string;
  /** Every absolute path the profile grants write to. */
  readonly writeGrants: readonly string[];
}

/**
 * The one builder both the spawn and the a1 preflight use, so the preflight
 * inspects exactly the grants the subsequent process receives.
 */
export function claudeIsolationInvocationFor(
  req: Pick<RuntimeAgentRequest, "cwd" | "autonomy" | "guards" | "workRoots">,
  runDirs: ClaudeIsolationRunDirs,
  protectedDir: string = approvalChannelDir(),
  platform: string = process.platform,
): ClaudeIsolationInvocation {
  if (platform !== "win32") {
    throw new Error(`the Codex-sandbox isolation wrapper is verified only on Windows (platform ${platform})`);
  }
  const cwd = path.resolve(req.cwd);
  const protectedPath = canonicalPath(protectedDir);
  const cwdWorkRoot = req.workRoots?.find((root) => path.resolve(root.path) === cwd);
  if (cwdWorkRoot?.access === "read") {
    throw new Error(`cwd ${cwd} is Target "${cwdWorkRoot.targetId}" bound read-only; refusing to turn it into a writable workspace root`);
  }

  const permissions = new Map<string, "read" | "write">();
  permissions.set(".", "read");
  const workspaceWrites: string[] = [];
  for (const pattern of req.autonomy === "read-only" ? [] : req.guards.writeAllow) {
    const expanded = permissionPathsFor(cwd, pattern);
    if (expanded.length === 0) {
      throw new Error(`write-allow pattern ${JSON.stringify(pattern)} cannot be represented safely because its wildcard parent does not exist`);
    }
    for (const allowed of expanded) permissions.set(allowed, "write");
  }
  for (const readOnly of ALWAYS_READ_ONLY_IN_WORKSPACE) permissions.set(readOnly, "read");
  for (const pattern of req.guards.writeDeny) {
    for (const denied of permissionPathsFor(cwd, pattern)) permissions.set(denied, "read");
  }
  for (const [relative, access] of permissions) if (access === "write") workspaceWrites.push(path.resolve(cwd, relative));

  const extraRoots = [...new Set((req.autonomy === "read-only" ? [] : req.workRoots ?? [])
    .filter((root) => root.access === "write")
    .map((root) => path.resolve(root.path))
    .filter((root) => root !== cwd))];
  const runWrites = [runDirs.config, runDirs.temp].map((dir) => path.resolve(dir));
  const absoluteWrites = [...extraRoots, ...runWrites];

  const workspaceEntries = [...permissions.entries()]
    .map(([permissionPath, access]) => `${tomlString(permissionPath)} = ${tomlString(access)}`)
    .join(", ");
  const filesystemEntries = [
    '":root" = "read"',
    `${tomlString(protectedPath)} = "deny"`,
    ...absoluteWrites.map((dir) => `${tomlString(dir)} = "write"`),
    `":workspace_roots" = { ${workspaceEntries} }`,
  ].join(", ");
  const profile = `{ filesystem = { ${filesystemEntries} }, network = { enabled = false } }`;
  return {
    sandboxArgs: [
      "sandbox",
      "-C",
      cwd,
      "-P",
      CLAUDE_ISOLATION_PROFILE,
      "-c",
      `permissions.${CLAUDE_ISOLATION_PROFILE}=${profile}`,
      "-c",
      'windows.sandbox="elevated"',
      "--",
    ],
    env: {
      CLAUDE_CONFIG_DIR: runDirs.config,
      TEMP: runDirs.temp,
      TMP: runDirs.temp,
      CODEX_HOME: runDirs.codexHome,
    },
    protectedPath,
    writeGrants: [...workspaceWrites, ...absoluteWrites],
  };
}

/**
 * Upstream statuses observed in this CLI's own envelope when the provider
 * refused to serve. Each was captured from a real `claude -p` run, never taken
 * from vendor documentation; the set stays closed for that reason, so a status
 * nobody has seen keeps today's ERROR classification rather than being guessed
 * into UNAVAILABLE.
 */
const PROVIDER_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

interface ClaudeCliJsonResult {
  is_error?: boolean;
  /** `"api_error"` when the run ended on an upstream HTTP failure rather than on the task. */
  terminal_reason?: string;
  /** The upstream HTTP status, present only alongside `terminal_reason: "api_error"`. */
  api_error_status?: number;
  /** The session this turn ran in — the native session reference the lifecycle records as evidence. */
  session_id?: string;
  result?: string;
  /** `"error_max_turns"` when the run stopped at `--max-turns`. */
  subtype?: string;
  /** Model turns the run took, as the CLI counts them. */
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  /** Present on ordinary `--json-schema` runs; Claude Code 2.1.268 omits it when `--agent` is also used. */
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
   * OFF10 M6 — when set, every run passes `--json-schema`. The envelope's
   * `structured_output` lands on `RuntimeAgentResult.structured`; for the
   * observed Claude Code 2.1.268 `--agent` omission, an exact JSON `result` is
   * accepted only after the same schema validates locally. **Off by default**:
   * the pipeline's prompt contract promises agents a free-form
   * summary ("the orchestrator reads … not a special reply format"), so flipping
   * this on is a caller decision (e.g. a QA03 hardening pass), never a side
   * effect of using this adapter.
   */
  outputSchema?: Record<string, unknown>;
  /** Injectable for tests; roots the lifecycle's attempt journal instead of the OS temp dir default. */
  journalRoot?: string;
  /**
   * Injectable for tests; defaults to the real loopback allowlist proxy. The
   * OS profile keeps network disabled either way, so no value here can widen
   * a run's egress — a fake only decides whether the API is reachable.
   */
  startEgressProxy?: StartEgressAllowlistProxy;
}

export class ClaudeCodeAdapter implements ExecutorPort {
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
  private readonly outputValidator?: ValidateFunction;
  private readonly outputSchemaError?: string;
  private readonly startEgressProxy: StartEgressAllowlistProxy;
  /** V13 TASK-014 — the lifecycle port, over this adapter's one spawn-and-parse implementation. */
  private readonly lifecycle: SingleShotLifecycle;

  constructor(opts: ClaudeCodeAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.resolveCommand = opts.resolveCommand ?? resolveNpmCliScriptImpl;
    this.platform = opts.platform ?? process.platform;
    this.outputSchema = opts.outputSchema;
    this.startEgressProxy = opts.startEgressProxy ?? startEgressAllowlistProxy;
    if (this.outputSchema) {
      try {
        this.outputValidator = new Ajv({ allErrors: true, strict: true }).compile(this.outputSchema);
      } catch (error) {
        this.outputSchemaError = String(error);
      }
    }
    this.lifecycle = new SingleShotLifecycle(this.id, {
      run: (req) => this.executeAgent(req),
      sessionRefFrom: (result) => {
        const envelope = result.raw as ClaudeCliJsonResult | undefined;
        return typeof envelope?.session_id === "string" && envelope.session_id.length > 0 ? envelope.session_id : undefined;
      },
      journalRoot: opts.journalRoot,
    });
  }

  // V13 TASK-014 — the lifecycle port, delegating to the shared single-shot
  // implementation over `executeAgent`. `executeAgent` itself stays the
  // unchanged single-shot seam `RuntimeAdapter` has always exposed.
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
    if (this.outputSchema && !this.outputValidator) {
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards: { enforced: [], unenforced: [] },
        diagnostics: [`refusing to run: invalid structured-output schema: ${this.outputSchemaError ?? "unknown schema error"}`],
      };
    }
    // req.model is turned into `--model` ONLY when the caller marks it an
    // operator-visible override (`req.modelExplicit`) — the `--model` CLI flag or
    // `.sta/config.yaml` routing. Absent that, the subagent's own
    // `.claude/agents/<role>.md` frontmatter governs and nothing is passed:
    // passing both risks the frontmatter and the flag disagreeing, and the drop
    // exists to prevent exactly that unless a person asked for it.
    const modelDiagnostics: string[] = [];
    let overrideModel: string | undefined;
    if (req.modelExplicit && req.model) {
      if (!this.models.has(req.model)) {
        return {
          status: "ERROR",
          exitCode: null,
          text: "",
          usage: {},
          guards: { enforced: [], unenforced: [] },
          diagnostics: [
            `refusing to run: model "${req.model}" is not one Claude Code accepts ` +
              `(${[...this.models].join(", ")}) — fix --model or the .sta/config.yaml routing entry ` +
              `rather than passing an unknown model through to the runtime`,
          ],
        };
      }
      overrideModel = req.model;
    }
    // `req.effort` is never a frontmatter default — the executor fills it only
    // from a cast tier or a `routing.by_role` entry — so it is always an
    // operator-visible choice and does not need `modelExplicit` to be honoured.
    let overrideEffort: string | undefined;
    if (req.effort) {
      if (!CLAUDE_CODE_EFFORTS.includes(req.effort)) {
        return {
          status: "ERROR",
          exitCode: null,
          text: "",
          usage: {},
          guards: { enforced: [], unenforced: [] },
          diagnostics: [
            `refusing to run: reasoning effort "${req.effort}" is not one Claude Code accepts ` +
              `(${CLAUDE_CODE_EFFORTS.join(", ")}) — fix model-tiers.yaml's anthropic cell or the ` +
              `.sta/config.yaml routing entry rather than passing an unknown effort through to the runtime`,
          ],
        };
      }
      overrideEffort = req.effort;
    }
    const args = [
      "-p",
      // A direct run with no persona runs Claude Code's default agent.
      ...(req.role ? ["--agent", req.role] : []),
      "--output-format",
      "json",
      "--permission-mode",
      PERMISSION_MODE[req.autonomy],
    ];
    // Override-only: with no explicit request this pushes nothing (see above).
    if (overrideModel) args.push("--model", overrideModel);
    if (overrideEffort) args.push("--effort", overrideEffort);
    // Runaway-loop ceiling (runtime/turnLimits.ts). `--max-turns` is a hidden
    // but parsed print-mode option (verified on Claude Code 2.1.283: a
    // non-numeric value is rejected by its own option parser).
    if (req.maxTurns !== undefined && Number.isSafeInteger(req.maxTurns) && req.maxTurns > 0) args.push("--max-turns", String(req.maxTurns));
    // Contract denies as hard permission rules, not just hook backstops.
    // Empty guards ⇒ no flag, keeping the no-guard request shape unchanged.
    //
    // The rules ride the `--disallowedTools=<rules>` EQUALS form on purpose.
    // claude v2.1.241 parses the space form greedily and swallows the next
    // positional. The prompt itself is deliberately sent on stdin below: on
    // Windows a production context can exceed the native command-line limit,
    // while `claude -p` accepts its default text input from stdin.
    const disallowRules = disallowRulesFromGuards(req.guards);
    if (disallowRules.length > 0) args.push(`--disallowedTools=${disallowRules.join(",")}`);
    // Only when a schema was requested — default runs stay free-form.
    if (this.outputSchema) args.push("--json-schema", JSON.stringify(this.outputSchema));

    // TASK-031: the whole claude process runs inside the per-run OS isolation
    // wrapper; there is no unwrapped spawn path.
    let runDirs: ClaudeIsolationRunDirs;
    let isolation: ClaudeIsolationInvocation;
    try {
      runDirs = claudeIsolationRunDirs(fs.mkdtempSync(path.join(claudeIsolationRunBase(), "sta-claude-run-")));
    } catch (error) {
      return { status: "ERROR", exitCode: null, text: "", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [...modelDiagnostics, `${CLAUDE_ISOLATION_UNAVAILABLE}: cannot create the per-run home: ${String(error)}`] };
    }
    const cleanupRun = () => {
      try {
        fs.rmSync(runDirs.root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of an adapter-owned temporary directory
      }
    };
    try {
      for (const dir of [runDirs.config, runDirs.temp, runDirs.codexHome]) fs.mkdirSync(dir, { recursive: true });
      isolation = claudeIsolationInvocationFor(req, runDirs, undefined, this.platform);
    } catch (error) {
      cleanupRun();
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards: { enforced: [], unenforced: [] },
        diagnostics: [...modelDiagnostics, `${CLAUDE_ISOLATION_UNAVAILABLE}: refusing to spawn claude without its OS isolation profile — ${String(error)}`],
      };
    }
    let egress: { url: string; stop(): void };
    try {
      egress = await this.startEgressProxy(CLAUDE_EGRESS_HOSTS, runDirs.root);
    } catch (error) {
      cleanupRun();
      return { status: "ERROR", exitCode: null, text: "", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [...modelDiagnostics, `${CLAUDE_ISOLATION_UNAVAILABLE}: cannot start the egress allowlist proxy — ${String(error)}`] };
    }
    // Large File Context Policy: the guard hook reads its thresholds from these
    // and appends one metadata line per file read to the per-run ledger, which
    // is read back below before the run directory is removed.
    const readLedgerPath = path.join(runDirs.temp, "sta-read-ledger.jsonl");
    const largeFileEnv = { ...largeFilePolicyEnv(resolveLargeFilePolicyFromProject(req.bindingRoot ?? req.cwd)), STA_READ_LEDGER: readLedgerPath };
    const runEnv = { ...process.env, ...largeFileEnv, ...req.env };
    const egressEnv = {
      HTTPS_PROXY: egress.url,
      HTTP_PROXY: egress.url,
      NO_PROXY: "",
      // Telemetry/update hosts are not on the allowlist; turn their traffic off rather than let it fail.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    // The inner command must be a real executable: the wrapper cannot retry an npm shim.
    const inner = (this.platform === "win32" ? this.resolveCommand("claude") : null) ?? { file: "claude", prefixArgs: [] };

    let proc: SpawnSyncReturns<string>;
    let resolvedThrough: string | null = null;
    let reads: ReadLedgerSummary | undefined;
    try {
      ({ proc, resolvedThrough } = this.spawnResolved("codex", [...isolation.sandboxArgs, inner.file, ...inner.prefixArgs, ...args], {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        input: req.prompt,
        // STA_ROLE is the one way a PreToolUse hook can know which agent is writing.
        env: { ...runEnv, ...isolation.env, ...egressEnv, ...roleEnv(req.role) },
      }));
      try {
        reads = summarizeReadLedger(fs.readFileSync(readLedgerPath, "utf8"));
      } catch {
        reads = undefined; // no guard ran, or it read nothing: absent, not zero
      }
    } catch (e) {
      // A spawn that throws outright — not one that returns with `.error` set —
      // means the runtime itself could not be reached, never a task failure.
      return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [...modelDiagnostics, `failed to spawn the isolated \`claude\`: ${String(e)}`] };
    } finally {
      egress.stop();
      cleanupRun();
    }

    const guards = await guardReportFor(this.workspace, this.binding.guardConfigPath!, req.guards);

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // ENOENT here is the wrapper: the isolated claude runs inside `codex sandbox`.
        const diagnostics = [...modelDiagnostics, `\`codex\` (the OS isolation wrapper for claude) not found: ${proc.error.message}`];
        if (resolvedThrough === null && this.platform === "win32") {
          diagnostics.push(
            "on Windows an npm-installed `codex` is a .cmd/.ps1 shim spawnSync cannot execute; no resolvable entry was found — install the native build or expose a real executable on PATH",
          );
        }
        return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics };
      }
      if (code === "ETIMEDOUT") {
        return { status: "TIMEOUT", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [...modelDiagnostics, `\`claude --agent ${roleLabel(req.role)}\` timed out: ${proc.error.message}`] };
      }
      return { status: "ERROR", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [...modelDiagnostics, `\`claude\` errored: ${proc.error.message}`] };
    }

    const { value: cli, parseFailed } = parseCliOutput(proc.stdout ?? "");
    const diagnostics = [
      ...modelDiagnostics,
      ...(parseFailed ? ["could not parse `claude`'s stdout as JSON — usage/cost are unknown for this run"] : []),
    ];
    const usage: RuntimeUsage = {
      inputTokens: cli.usage?.input_tokens,
      outputTokens: cli.usage?.output_tokens,
      cachedInputTokens: cli.usage?.cache_read_input_tokens,
      // T-V8-012: `planning/v4/benchmark`'s per-model usage recovery is the
      // evidence this field is real and was previously omitted — see
      // `build-metrics.mjs`'s `raw_access_decision` note.
      cacheCreationInputTokens: cli.usage?.cache_creation_input_tokens,
      costUsd: cli.total_cost_usd,
    };

    // A refusal to serve is not a task failure: collapsing it into ERROR spends
    // the task's retry budget and can trigger recovery for something the task
    // did nothing to cause. Keyed on the envelope's own structured fields, so a
    // task that merely mentions "429" in its output cannot reach this branch.
    if (cli.is_error === true && cli.terminal_reason === "api_error" && typeof cli.api_error_status === "number" && PROVIDER_REFUSAL_STATUSES.has(cli.api_error_status)) {
      return {
        status: "UNAVAILABLE",
        exitCode: proc.status ?? null,
        text: "",
        usage,
        guards,
        diagnostics: [...diagnostics, `\`claude\` provider refused to serve (HTTP ${cli.api_error_status}): ${cli.result ?? "no message"}`],
        raw: cli,
      };
    }

    let structured: unknown;
    let structuredFailed = false;
    if (this.outputSchema && this.outputValidator) {
      let candidate = cli.structured_output;
      let recoveredFromResult = false;
      if (candidate === undefined && typeof cli.result === "string") {
        try {
          candidate = JSON.parse(cli.result.trim()) as unknown;
          recoveredFromResult = true;
        } catch {
          // A schema-requested run must return machine-readable JSON. Deliberately
          // do not strip Markdown fences or scrape a JSON-looking substring: that
          // would turn free-form prose into a trusted structured result.
        }
      }
      if (candidate === undefined) {
        structuredFailed = true;
        diagnostics.push("`claude --json-schema` returned no structured_output and its result was not exact JSON");
      } else if (!this.outputValidator(candidate)) {
        structuredFailed = true;
        const details = (this.outputValidator.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
          .join("; ");
        diagnostics.push(`structured output failed local schema validation${details ? `: ${details}` : ""}`);
      } else {
        structured = candidate;
        if (recoveredFromResult) {
          diagnostics.push(
            "`claude --agent` omitted structured_output; recovered the exact JSON result and validated it locally against the requested schema",
          );
        }
      }
    }

    const maxTurnsReached = cli.subtype === "error_max_turns";
    if (maxTurnsReached) {
      diagnostics.push(
        `stopped at the stage's turn limit (--max-turns ${req.maxTurns ?? "?"}, ${cli.num_turns ?? "?"} turns taken) — a runaway guard, not a task verdict; ` +
          "inspect why the stage looped (repeated reads/retries), or raise max_turns for this role in .sta/config.yaml if the work genuinely needs more",
      );
    }
    const cliFailed = proc.status !== 0 || cli.is_error === true || structuredFailed || maxTurnsReached;
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
      // M6: present only on schema-requested runs where the CLI delivered an
      // envelope value or exact JSON result that passed local validation. A
      // stray envelope field on a free-form run cannot masquerade as one.
      structured,
      raw: cli,
      ...(typeof cli.num_turns === "number" ? { turns: cli.num_turns } : {}),
      ...(maxTurnsReached ? { maxTurnsReached } : {}),
      ...(reads ? { reads } : {}),
    };
  }
}
