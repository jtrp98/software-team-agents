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
import type { SpawnSync } from "./claudeCodeAdapter.js";

/**
 * The `RuntimeAdapter` for Codex (T110) — the second target `runtimeAdapter.ts`
 * (T108) was designed against, written to prove the interface is not
 * Claude-Code-shaped in disguise.
 *
 * **THIS IS A PARTIAL, ASSUMPTION-HEAVY IMPLEMENTATION — READ BEFORE TRUSTING IT.**
 *
 * Nobody has run this adapter against a real `codex` install in this repo. Every
 * flag, exit-code convention, and capability claim below is either (a) publicly
 * documented Codex CLI behaviour as of this framework's knowledge cutoff, marked
 * with a confidence note, or (b) an explicit assumption mirroring
 * `claudeCodeAdapter.ts`'s shape where Codex's actual behaviour is unknown. The
 * user's own instruction for this task was explicit: mark this partial with
 * stated assumptions rather than making it look complete. T111 (capability
 * detection) is what turns "assumed" into "verified" once this runs against a
 * real installation — until then, treat every `capabilities` claim here as a
 * hypothesis, not a fact.
 *
 * WHAT IS REASONABLY CONFIDENT
 * - `codex exec "<prompt>"` runs one non-interactive turn and exits — the shape
 *   `executeAgent` needs (a single request in, a single result out).
 * - `--sandbox <read-only|workspace-write|danger-full-access>` and
 *   `--ask-for-approval <untrusted|on-failure|on-request|never>` are Codex's own
 *   permission axes — the closest thing it has to Claude Code's
 *   `--permission-mode`.
 * - `AGENTS.md` (and a project `.codex/config.toml`) are Codex's project-level,
 *   committed configuration — the `PROJECT_LEVEL_BINDING` capability is claimed
 *   on that basis alone, not on any guard mechanism.
 *
 * WHAT IS NOT CLAIMED, AND WHY
 * - `NAMED_AGENTS` — Codex has no confirmed `--agent <name>` flag that loads a
 *   role definition by reference the way Claude Code's subagents do. This
 *   adapter therefore reads the role's binding file itself (via `workspace`) and
 *   folds its content into the prompt text on every run — which is *exactly* the
 *   behaviour `runtimeCapabilities.ts`'s doc-comment says disqualifies the claim
 *   ("instead of needing the prompt passed inline on every run"). Do not flip
 *   this to `true` without a confirmed native mechanism.
 * - `PRE_TOOL_GUARD` / `POST_TOOL_GUARD` / `EXIT_GUARD` / `PER_AGENT_EXIT_GUARD`
 *   — no confirmed, generally-available hook mechanism equivalent to Claude
 *   Code's `PreToolUse`/`Stop`/`SubagentStop` array in `settings.json`. Some
 *   Codex builds are reported to run arbitrary notify commands, but the shape
 *   and reliability (including whether it fires at all under `codex exec`,
 *   which is what this framework spawns) is not something this task can verify
 *   without a real install. Claiming these would let a guard-dependent stage
 *   believe it is enforced when it silently is not — the exact fail-open failure
 *   `policies/security.md` §5d warns about. `binding.guardConfigPath` is `null`
 *   for the same reason (see its doc-comment in `runtimeAdapter.ts`: `null` is
 *   the honest answer that forces T111 to cover guards post-hoc).
 * - `STRUCTURED_RESULT` / `COST_REPORTING` — Codex's non-interactive output
 *   format (JSON event stream vs. plain text) was moving during this framework's
 *   research and is not pinned down here. This adapter treats stdout as opaque
 *   text and never claims cost/usage figures it cannot back up with a real
 *   parsed field.
 * - `INTERACTIVE_PROMPTS` — `codex exec` is explicitly non-interactive; a stage
 *   that needs to put a question to a person (`business-analyst`) cannot run
 *   through this adapter as designed. This is the same reasoning
 *   `runtimeCapabilities.ts`'s header already anticipated for `codex exec`.
 * - `models` — no default catalogue is declared. Guessing exact model ids here
 *   would be exactly the "เดายิงมั่ว" (wild guessing) the user ruled out; a
 *   caller that knows its installation's reachable models passes them via
 *   `CodexAdapterOptions.models`. Left empty, `RuntimeRegistry.reaching()`
 *   correctly reports that this runtime reaches nothing, rather than a fabricated
 *   answer that reaches everything.
 * - `PARALLEL_EXECUTION` — same as `claudeCodeAdapter.ts`: reserved for T35,
 *   unclaimed by any adapter yet.
 */

const CODEX_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.MODEL_SELECTION,
  RuntimeCapability.PROJECT_LEVEL_BINDING,
];

/** `RuntimeAutonomy` onto Codex's own sandbox/approval axes — assumption, unverified against a real install. See file header. */
const SANDBOX_MODE: Record<RuntimeAutonomy, string> = {
  "read-only": "read-only",
  propose: "workspace-write",
  edit: "workspace-write",
  full: "danger-full-access",
};

const APPROVAL_MODE: Record<RuntimeAutonomy, string> = {
  "read-only": "on-request",
  propose: "on-request",
  edit: "on-failure",
  full: "never",
};

export interface CodexAdapterOptions {
  /** Root of the target project — where `.codex/agents/<role>.md` and `_docs/` live. */
  projectRoot: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Default per-run timeout in ms, overridable per request via `RuntimeAgentRequest.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Models this installation is known to reach. No default — see file header.
   * `RuntimeRegistry.reaching()` answers nothing for this runtime until a caller
   * states what its own Codex installation/config can actually reach.
   */
  models?: readonly string[];
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly binding: RuntimeBinding = {
    // `.codex` mirrors `.claude`'s shape as this framework's own committed
    // binding — not a native Codex concept. See file header: NAMED_AGENTS is not
    // claimed, so this directory exists only so the framework has one place to
    // put the role definitions this adapter folds into the prompt itself.
    dir: ".codex",
    definitionPath: (role) => `.codex/agents/${role}.md`,
    // No confirmed project-level guard-wiring file for Codex. `null` is the
    // deliberate, honest answer `runtimeAdapter.ts` documents for exactly this
    // situation — T111 must cover these guards post-hoc, not assume them.
    guardConfigPath: null,
  };
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(CODEX_CAPABILITIES);
  readonly models: ReadonlySet<string>;
  readonly workspace: RuntimeWorkspace;

  private readonly spawn: SpawnSync;
  private readonly defaultTimeoutMs: number;

  constructor(opts: CodexAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.models = new Set(opts.models ?? []);
  }

  async probe(): Promise<RuntimeProbe> {
    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.spawn("codex", ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    } catch (e) {
      return { available: false, reason: String(e) };
    }
    if (proc.error) return { available: false, reason: proc.error.message };
    if (proc.status !== 0) return { available: false, reason: `\`codex --version\` exited ${proc.status ?? "unknown"}` };
    return { available: true, version: (proc.stdout ?? "").trim() };
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    // No guard mechanism is claimed (see file header), so any requested guard
    // axis is reported unenforced up front — never silently dropped.
    const guards = noGuardMechanismReport(req.guards);

    // NAMED_AGENTS is not claimed: there is no flag to hand Codex a role by
    // reference, so the role's own binding content is read and folded into the
    // prompt on every run instead.
    let roleDefinition: string | null;
    try {
      roleDefinition = await this.workspace.readFile(req.definitionPath);
    } catch (e) {
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards,
        diagnostics: [`could not read role binding ${req.definitionPath}: ${String(e)}`],
      };
    }
    if (roleDefinition === null) {
      return {
        status: "ERROR",
        exitCode: null,
        text: "",
        usage: {},
        guards,
        diagnostics: [
          `no role binding found at ${req.definitionPath} — Codex has no native named-agent mechanism, ` +
            `so this adapter needs that file to fold into the prompt (see codexAdapter.ts header)`,
        ],
      };
    }

    const prompt = `${roleDefinition}\n\n---\n\n${req.prompt}`;
    const args = [
      "exec",
      "--sandbox",
      SANDBOX_MODE[req.autonomy],
      "--ask-for-approval",
      APPROVAL_MODE[req.autonomy],
      prompt,
    ];

    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.spawn("codex", args, {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: req.timeoutMs ?? this.defaultTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        // T15's channel, same as `claudeCodeAdapter.ts` — set unconditionally
        // since it costs nothing if the runtime never asks a guard to read it.
        env: { ...process.env, ...req.env, AGENTCLAUDE_ROLE: req.role },
      });
    } catch (e) {
      return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics: [`failed to spawn \`codex\`: ${String(e)}`] };
    }

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { status: "UNAVAILABLE", exitCode: null, text: "", usage: {}, guards, diagnostics: [`\`codex\` binary not found: ${proc.error.message}`] };
      }
      if (code === "ETIMEDOUT") {
        return { status: "TIMEOUT", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`\`codex exec\` timed out: ${proc.error.message}`] };
      }
      return { status: "ERROR", exitCode: proc.status ?? null, text: "", usage: {}, guards, diagnostics: [`\`codex\` errored: ${proc.error.message}`] };
    }

    // STRUCTURED_RESULT is not claimed: stdout is treated as opaque text, never
    // parsed as an envelope this adapter cannot back up. Usage/cost are always
    // absent (undefined, never a fabricated 0 — see `RuntimeUsage.costUsd`'s
    // own doc-comment on why 0 would be a false claim).
    const usage: RuntimeUsage = {};
    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const failed = proc.status !== 0;

    return {
      status: failed ? "ERROR" : "OK",
      exitCode: proc.status ?? null,
      text: failed ? (stderr || stdout) : stdout,
      usage,
      // Codex's non-interactive output format is not pinned down (see file
      // header) — never claim a model the adapter did not actually parse back.
      model: undefined,
      guards,
      diagnostics: [
        "codexAdapter.ts is a partial implementation — usage/cost/model are not parsed from a confirmed envelope; see the file header for what is and isn't verified",
      ],
      raw: { stdout, stderr },
    };
  }
}

/** Every requested guard axis is unenforced, because no guard mechanism is claimed at all (`binding.guardConfigPath` is `null`). */
function noGuardMechanismReport(requested: RuntimeGuards): RuntimeGuardReport {
  const wantsPreToolGuard = requested.writeAllow.length > 0 || requested.writeDeny.length > 0 || requested.forbidCommands.length > 0;
  const wantsExitGuard = requested.exitChecks.length > 0;
  if (!wantsPreToolGuard && !wantsExitGuard) return { enforced: [], unenforced: [] };
  const unenforced = [
    ...(wantsPreToolGuard ? [RuntimeCapability.PRE_TOOL_GUARD] : []),
    ...(wantsExitGuard ? [RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD] : []),
  ];
  return {
    enforced: [],
    unenforced,
    reason: "codexAdapter.ts claims no guard mechanism (binding.guardConfigPath is null) — see file header for why",
  };
}
