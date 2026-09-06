import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { LocalWorkspace } from "./localWorkspace.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
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
 * The `RuntimeAdapter` for Google Antigravity — binary `agy`, runtime id
 * `antigravity`, driven through its headless print mode.
 *
 * Every claim below traces to a transcript in
 * `planning/v6/v6-agy-spike-evidence.md` (agy 1.1.24, Windows 11); section
 * numbers in comments refer to that file. Nothing here is read off vendor
 * documentation.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 * - `PRE_TOOL_GUARD` / `POST_TOOL_GUARD` — the deny path itself is real and
 *   verified on 1.1.27 (§13), but agy reads hooks only from the machine-global
 *   `~/.gemini/config/hooks.json`; the `.agents/hooks.json` a workspace carries
 *   was never consulted in seven configurations across two versions. A guard
 *   that only exists if someone installed it on this particular machine is not
 *   a capability this runtime has, so none is declared and `runtimeExecutor`
 *   keeps refusing Target-write stages.
 * - `PROJECT_LEVEL_BINDING` — actively disproven, not merely unobserved (§13).
 *   `guardConfigPath` stays `null` for the same reason: a rendered file that the
 *   runtime never reads is not a mechanism.
 * - `EXIT_GUARD` / `PER_AGENT_EXIT_GUARD` — no `Stop` hook was exercised, and
 *   AGY documents one `Stop` event with no subagent counterpart regardless.
 * - `NAMED_AGENTS` — `agy agents` stayed `[]` under both project-scoped
 *   directory conventions tried, and `--agent <unknown>` applied no persona and
 *   printed no warning (§2). Role delivery folds the definition into the
 *   prompt, as `apiAdapter.ts` does.
 * - `COST_REPORTING` — the envelope's `usage` carries token counts only, with
 *   no cost field (§1b), so `RuntimeUsage.costUsd` stays undefined rather than
 *   claiming a run was free.
 * - `INTERACTIVE_PROMPTS` — `-p` is non-interactive.
 */

/** Runtime id, and the binary it drives. The two differ, so both are named once here. */
export const ANTIGRAVITY_RUNTIME_ID = "antigravity" as const;
export const ANTIGRAVITY_BINARY = "agy" as const;

const ANTIGRAVITY_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.MODEL_SELECTION,
  RuntimeCapability.STRUCTURED_RESULT,
];

/**
 * Envelope fingerprints that mean "the provider refused to serve" rather than
 * "the task failed" — deliberately EMPTY.
 *
 * The spike declined to exhaust the user's real subscription to capture a quota
 * or rate-limit response (§10), so no fingerprint for this runtime has ever been
 * observed. An invented pattern here would misclassify real task failures as
 * UNAVAILABLE and hand them a free retry budget, so the set stays empty until a
 * transcript fills it; every unrecognised failure keeps its ERROR
 * classification.
 */
export const AGY_PROVIDER_REFUSAL_FINGERPRINTS: readonly RegExp[] = [];

/** `--print-timeout` expiry has no distinct status — it is ERROR plus this message (§6). */
const AGY_TIMEOUT_MESSAGE = /timeout waiting for response/i;

/** A model whose name already carries its effort, or a Claude model, refuses `--effort` outright (§4). */
const EFFORT_INCOMPATIBLE_MODEL = /(^claude-)|(-(?:low|medium|high)$)/i;

/** Exactly the JSON envelope fields observed on `--output-format json` (§1b, §3, §6). */
interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  denied_actions?: Array<{ action?: string; display_name?: string }>;
}

export interface AntigravityAdapterOptions {
  /** Root of the target project — where `.claude/agents/<role>.md` is read from. */
  projectRoot: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: SpawnSync;
  /** Default per-run timeout in ms, overridable per request via `RuntimeAgentRequest.timeoutMs`. */
  timeoutMs?: number;
  /** Models this installation is known to reach (`agy models`). No default — no catalogue is invented. */
  models?: readonly string[];
}

export class AntigravityAdapter implements RuntimeAdapter {
  readonly id = ANTIGRAVITY_RUNTIME_ID;
  readonly displayName = "Antigravity";
  readonly binding: RuntimeBinding = {
    // No native agent store was demonstrated (§2), so the canonical role
    // definition is read here and folded into the prompt — the same shape
    // `apiAdapter.ts` uses, not a fourth rendering family.
    dir: ".claude",
    definitionPath: (role) => `.claude/agents/${role}.md`,
    guardConfigPath: null,
  };
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(ANTIGRAVITY_CAPABILITIES);
  readonly models: ReadonlySet<string>;
  readonly workspace: RuntimeWorkspace;

  private readonly spawn: SpawnSync;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AntigravityAdapterOptions) {
    this.workspace = new LocalWorkspace({ root: opts.projectRoot });
    this.spawn = opts.spawnSync ?? (nodeSpawnSync as unknown as SpawnSync);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60_000;
    this.models = new Set(opts.models ?? []);
  }

  async probe(): Promise<RuntimeProbe> {
    let proc: SpawnSyncReturns<string>;
    try {
      proc = this.spawn(ANTIGRAVITY_BINARY, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    } catch (e) {
      return { available: false, reason: String(e) };
    }
    if (proc.error) return { available: false, reason: proc.error.message };
    if (proc.status !== 0) return { available: false, reason: `\`${ANTIGRAVITY_BINARY} --version\` exited ${proc.status ?? "unknown"}` };
    return { available: true, version: (proc.stdout ?? "").trim() };
  }

  async executeAgent(req: RuntimeAgentRequest): Promise<RuntimeAgentResult> {
    const guards = guardReportFor(req.guards);

    let roleDefinition: string | null;
    try {
      roleDefinition = await this.workspace.readFile(req.definitionPath);
    } catch (e) {
      return fail("UNAVAILABLE", guards, [`cannot read role binding ${req.definitionPath}: ${String(e)}`]);
    }
    if (!roleDefinition?.trim()) {
      return fail("ERROR", guards, [
        `no role binding found at ${req.definitionPath} — \`${ANTIGRAVITY_BINARY} -p\` has no named-agent store to fall back on, so the run would execute with no role at all`,
      ]);
    }

    const diagnostics: string[] = [];
    const args = ["-p", `${roleDefinition.trim()}\n\n${req.prompt}`, "--output-format", "json"];

    if (req.model && req.modelExplicit) {
      // `RuntimeAgentRequest.modelExplicit` contracts for refusal over
      // pass-through. A declared catalogue is the only thing that can prove a
      // model is unreachable; with none, `agy` refuses it itself (§3).
      if (this.models.size > 0 && !this.models.has(req.model)) {
        return fail("ERROR", guards, [
          `\`${ANTIGRAVITY_BINARY}\` does not reach model "${req.model}" (declares: ${[...this.models].join(", ")}) — refusing rather than passing it through`,
        ]);
      }
      args.push("--model", req.model);
    }
    if (req.effort) {
      const model = req.modelExplicit ? req.model : undefined;
      if (model && EFFORT_INCOMPATIBLE_MODEL.test(model)) {
        diagnostics.push(`dropped --effort ${req.effort}: model "${model}" carries its own effort selector and \`agy\` refuses the combination`);
      } else {
        args.push("--effort", req.effort);
      }
    }
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    args.push("--print-timeout", `${Math.max(1, Math.round(timeoutMs / 1000))}s`);

    let proc: SpawnSyncReturns<string>;
    try {
      // No npm-shim retry: `agy` is a single native PE32+ executable with no
      // `.cmd` wrapper (§11), unlike the Node-based CLIs on the same machine.
      proc = this.spawn(ANTIGRAVITY_BINARY, args, {
        cwd: req.cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...req.env, AGENTCLAUDE_ROLE: req.role },
      });
    } catch (e) {
      return fail("UNAVAILABLE", guards, [`failed to spawn \`${ANTIGRAVITY_BINARY}\`: ${String(e)}`]);
    }

    if (proc.error) {
      const code = (proc.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        return fail("TIMEOUT", guards, [`\`${ANTIGRAVITY_BINARY} -p\` timed out: ${proc.error.message}`], proc.status ?? null);
      }
      return fail("UNAVAILABLE", guards, [`failed to spawn \`${ANTIGRAVITY_BINARY}\`: ${proc.error.message}`]);
    }

    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const exitCode = proc.status ?? null;
    const envelope = parseAgyEnvelope(stdout);
    const usage = usageFrom(envelope);

    if (req.workRoots && req.workRoots.length > 0) {
      diagnostics.push(
        `${req.workRoots.length} work root(s) ride on AGENTCLAUDE_WRITABLE_WORK_ROOTS alone — no \`${ANTIGRAVITY_BINARY}\` hook dispatch has been observed to read it`,
      );
    }
    if (envelope === null) {
      // Argument-parsing failures never reach a turn and emit plain text on
      // stderr even under `--output-format json` (§7).
      diagnostics.push(`no JSON envelope on stdout: ${lastLines(stderr) || lastLines(stdout) || "no output"}`);
      return fail(exitCode === 0 ? "ERROR" : "UNAVAILABLE", guards, diagnostics, exitCode, { stdout, stderr });
    }
    if (envelope.denied_actions && envelope.denied_actions.length > 0) {
      diagnostics.push(
        `\`${ANTIGRAVITY_BINARY}\` headless permission layer auto-denied: ${envelope.denied_actions.map((a) => a.display_name ?? a.action ?? "unknown").join(", ")}`,
      );
    }
    if (envelope.error && AGY_TIMEOUT_MESSAGE.test(envelope.error)) {
      return { status: "TIMEOUT", exitCode, text: "", usage, guards, diagnostics: [...diagnostics, envelope.error], raw: envelope };
    }
    const refusal = envelope.error && AGY_PROVIDER_REFUSAL_FINGERPRINTS.some((p) => p.test(envelope.error!));
    if (refusal) {
      return { status: "UNAVAILABLE", exitCode, text: "", usage, guards, diagnostics: [...diagnostics, `provider refused to serve: ${envelope.error}`], raw: envelope };
    }

    // A large-prompt run can return `SUCCESS` with an empty response and every
    // usage counter at zero — indistinguishable from a real empty answer by
    // `status` alone (§11). Treating that as OK would record a turn that never
    // happened, so the counters decide, not the status word.
    const ranNothing =
      envelope.status === "SUCCESS" &&
      (envelope.response ?? "") === "" &&
      (envelope.usage?.total_tokens ?? 0) === 0 &&
      (envelope.duration_seconds ?? 0) === 0;
    if (ranNothing) {
      return fail(
        "ERROR",
        guards,
        [...diagnostics, `\`${ANTIGRAVITY_BINARY}\` reported SUCCESS with an empty response and zero usage — the turn did not run (oversized prompt is the known cause)`],
        exitCode,
        envelope,
      );
    }

    if (exitCode !== 0 || envelope.status !== "SUCCESS") {
      diagnostics.push(`\`${ANTIGRAVITY_BINARY} -p\` status ${envelope.status ?? "unknown"} (exit ${exitCode}): ${envelope.error ?? lastLines(stderr) ?? "no message"}`);
    }

    return {
      status: exitCode === 0 && envelope.status === "SUCCESS" ? "OK" : "ERROR",
      exitCode,
      text: envelope.response ?? "",
      usage,
      guards,
      diagnostics,
      raw: envelope,
    };
  }
}

/**
 * Nothing is enforced in-band on this runtime, so every requested guard family
 * is reported unenforced with a reason the orchestrator can act on. The
 * accounting is what keeps the gap loud rather than silent.
 */
function guardReportFor(requested: RuntimeGuards): RuntimeGuardReport {
  const wantsPreTool = requested.writeAllow.length > 0 || requested.writeDeny.length > 0 || requested.forbidCommands.length > 0;
  const wantsExit = requested.exitChecks.length > 0;
  if (!wantsPreTool && !wantsExit) return { enforced: [], unenforced: [] };
  const unenforced: RuntimeCapability[] = [];
  if (wantsPreTool) unenforced.push(RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.POST_TOOL_GUARD);
  if (wantsExit) unenforced.push(RuntimeCapability.EXIT_GUARD, RuntimeCapability.PER_AGENT_EXIT_GUARD);
  return {
    enforced: [],
    unenforced,
    reason:
      "agy reads PreToolUse hooks only from the machine-global ~/.gemini/config/hooks.json; the workspace's own .agents/hooks.json is never consulted, so writes, git and exit checks are covered post-hoc by the orchestrator and the QA round, never by this runtime",
  };
}

function fail(
  status: RuntimeAgentResult["status"],
  guards: RuntimeGuardReport,
  diagnostics: string[],
  exitCode: number | null = null,
  raw?: unknown,
): RuntimeAgentResult {
  return { status, exitCode, text: "", usage: {}, guards, diagnostics, ...(raw === undefined ? {} : { raw }) };
}

function usageFrom(envelope: AgyEnvelope | null): RuntimeUsage {
  const usage = envelope?.usage;
  if (!usage) return {};
  const mapped: RuntimeUsage = {
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
    cachedInputTokens: numberOrUndefined(usage.cache_read_tokens),
  };
  return mapped.inputTokens === undefined && mapped.outputTokens === undefined && mapped.cachedInputTokens === undefined ? {} : mapped;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ");
}

/**
 * Tolerant reader over `agy --output-format json`. Also accepts a
 * `--output-format stream-json` transcript by taking the last `result` event's
 * payload, since both carry the identical envelope shape (§1c). Returns `null`
 * when stdout holds no envelope at all — a real state (§7) that must not be
 * confused with an envelope full of zeros.
 */
export function parseAgyEnvelope(stdout: string): AgyEnvelope | null {
  let envelope: AgyEnvelope | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.event === "result" && parsed.result !== null && typeof parsed.result === "object") {
      envelope = parsed.result as AgyEnvelope;
      continue;
    }
    if (parsed.event !== undefined) continue;
    envelope = parsed as AgyEnvelope;
  }
  return envelope;
}
