import { RuntimeCapability, missingRequiredCapabilities } from "./runtimeCapabilities.js";
import type { RuntimeAdapter, RuntimeWorkspace } from "./runtimeAdapter.js";

/**
 * Checks what a runtime *claims* against what its actual installation shows
 * (T111).
 *
 * `RuntimeAdapter.capabilities` (T108) is deliberately documented as a
 * product-level claim, not a per-installation fact — a project that never ran
 * `sta init`, or deleted a hook, still gets an adapter reporting the same static
 * set. This module is the thing that reads the real project instead of trusting
 * the claim, so a gap shows up before a task depends on a guard that was never
 * actually wired — the exact fail-open failure `policies/security.md` §5d warns
 * hooks themselves are prone to.
 *
 * WHAT "VERIFIED" MEANS HERE
 *
 * Only claims this module can check *without spawning a real agent run* are
 * verified — reading `binding.dir`/`binding.guardConfigPath` through the
 * runtime's own `workspace`, the same way a run would see them. That is a
 * narrower bar than "this capability definitely works" (only an actual
 * `executeAgent` call proves that, and `RuntimeAgentResult.guards` already
 * reports it per-run — see `claudeCodeAdapter.ts`'s `guardReportFor`). It is
 * wide enough to catch the two failure modes that matter before a task ever
 * starts: a binding directory that doesn't exist, and a guard config file that
 * exists but doesn't actually wire the hook a claimed capability depends on.
 */

export interface CapabilityCheck {
  readonly capability: RuntimeCapability;
  /** What `RuntimeAdapter.capabilities` (T108) says, independent of installation. */
  readonly claimed: boolean;
  /** Whether this module could confirm the claim against the real project. `false` with `claimed: true` is the gap this task exists to surface. */
  readonly verified: boolean;
  /** Why `verified` is what it is — always present when `verified` is false and `claimed` is true, since that combination is the one a person has to act on. */
  readonly reason?: string;
}

export interface RuntimeCapabilityReport {
  readonly runtimeId: string;
  readonly available: boolean;
  readonly probeReason?: string;
  readonly checks: readonly CapabilityCheck[];
  /** `REQUIRED_RUNTIME_CAPABILITIES` (T108) this runtime neither claims nor has verified — the pipeline's own design assumes these, so an absence here is never merely informational. */
  readonly missingRequired: readonly RuntimeCapability[];
  /** Human-readable notes on what changes because of a gap above — what T112/a caller should do instead of pretending the capability is there. */
  readonly fallbacks: readonly string[];
}

/**
 * How to verify one guard-family capability against a runtime's real guard
 * config, beyond "the file exists" — a runtime-specific concern, because the
 * shape of that file (Claude Code's `settings.json` hooks array vs. anything
 * else) is not something this module can know generically. Keyed by runtime id
 * in `DEEP_GUARD_CHECKERS` below; a runtime with none registered falls back to
 * the generic "file exists and is non-empty" check, which is honest but shallow
 * — see `genericGuardCheck`.
 */
export type DeepGuardChecker = (
  workspace: RuntimeWorkspace,
  guardConfigPath: string,
) => Promise<{
  readonly verified: ReadonlySet<RuntimeCapability>;
  readonly reason?: string;
}>;

interface ClaudeSettingsHooks {
  hooks?: {
    PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
    PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
    Stop?: Array<{ hooks?: Array<{ command?: string }> }>;
    SubagentStop?: Array<{ hooks?: Array<{ command?: string }> }>;
  };
}

function commandsMention(entries: Array<{ hooks?: Array<{ command?: string }> }> | undefined, needle: string): boolean {
  if (!entries) return false;
  return entries.some((entry) => (entry.hooks ?? []).some((h) => (h.command ?? "").includes(needle)));
}

/**
 * Claude Code's `settings.json` hooks array, checked for the *specific* guard
 * scripts CLAUDE.md names — not just "an array with something in it". This is
 * the deepening HANDOFF_V1.md §20.3 flagged as still owed after T109: a
 * `PreToolUse` array that exists but doesn't mention
 * `block-path-permissions.js` was previously reported as enforced by the
 * per-run guard report (T108/T109), because that check only asked "is there a
 * hook array". This one asks "is the hook that actually implements the rule
 * in it".
 */
export const claudeCodeDeepGuardCheck: DeepGuardChecker = async (workspace, guardConfigPath) => {
  const raw = await workspace.readFile(guardConfigPath);
  if (raw === null) {
    return { verified: new Set(), reason: `${guardConfigPath} not found in this workspace` };
  }
  let settings: ClaudeSettingsHooks;
  try {
    settings = JSON.parse(raw) as ClaudeSettingsHooks;
  } catch {
    return { verified: new Set(), reason: `${guardConfigPath} is not valid JSON` };
  }

  const verified = new Set<RuntimeCapability>();
  const gaps: string[] = [];

  if (commandsMention(settings.hooks?.PreToolUse, "block-path-permissions.js")) {
    verified.add(RuntimeCapability.PRE_TOOL_GUARD);
  } else {
    gaps.push("no PreToolUse hook runs block-path-permissions.js");
  }
  if (commandsMention(settings.hooks?.PostToolUse, "")) {
    // Any wired PostToolUse hook counts — this framework ships none by design
    // (CLAUDE.md's hook table has no PostToolUse entry), so an empty/absent
    // array here is the expected, honest state, not a parse failure.
    verified.add(RuntimeCapability.POST_TOOL_GUARD);
  } else {
    gaps.push("no PostToolUse hook is wired (this framework does not ship one — see CLAUDE.md's hook table)");
  }
  if (commandsMention(settings.hooks?.Stop, "require-green-before-stop.js") || commandsMention(settings.hooks?.Stop, "block-secret-leak.js")) {
    verified.add(RuntimeCapability.EXIT_GUARD);
  } else {
    gaps.push("no Stop hook runs require-green-before-stop.js or block-secret-leak.js");
  }
  if (commandsMention(settings.hooks?.SubagentStop, "require-green-before-stop.js") || commandsMention(settings.hooks?.SubagentStop, "block-secret-leak.js")) {
    verified.add(RuntimeCapability.PER_AGENT_EXIT_GUARD);
  } else {
    gaps.push("no SubagentStop hook runs require-green-before-stop.js or block-secret-leak.js");
  }

  return { verified, reason: gaps.length > 0 ? gaps.join("; ") : undefined };
};

/** The shallow fallback for any runtime without a registered deep checker: the guard config file exists and has *some* content. Cannot confirm which specific guard it wires — that is exactly why a deep checker is worth writing per runtime as its real shape becomes known. */
const genericGuardCheck: DeepGuardChecker = async (workspace, guardConfigPath) => {
  const raw = await workspace.readFile(guardConfigPath);
  if (raw === null || raw.trim().length === 0) {
    return { verified: new Set(), reason: `${guardConfigPath} not found or empty in this workspace` };
  }
  return {
    verified: new Set(),
    reason: `${guardConfigPath} exists but this runtime has no deep guard checker registered — cannot confirm which guard capability it actually wires (file presence alone is not proof)`,
  };
};

const DEEP_GUARD_CHECKERS: Record<string, DeepGuardChecker> = {
  "claude-code": claudeCodeDeepGuardCheck,
};

const GUARD_CAPABILITIES: readonly RuntimeCapability[] = [
  RuntimeCapability.PRE_TOOL_GUARD,
  RuntimeCapability.POST_TOOL_GUARD,
  RuntimeCapability.EXIT_GUARD,
  RuntimeCapability.PER_AGENT_EXIT_GUARD,
];

/**
 * Runs every check this module can make without spawning a real agent, and
 * reports claim-vs-verified per capability plus what a caller (T112, or a
 * person reading `sta --check-runtime`-style output) should fall back to.
 *
 * `deepGuardCheckers` is injectable, layered over `DEEP_GUARD_CHECKERS`, so a
 * caller can register one for a runtime this file doesn't know about yet
 * without editing it.
 */
export async function detectRuntimeCapabilities(
  adapter: RuntimeAdapter,
  opts: { deepGuardCheckers?: Record<string, DeepGuardChecker> } = {},
): Promise<RuntimeCapabilityReport> {
  const claimed = adapter.capabilities;
  const probe = await adapter.probe();

  if (!probe.available) {
    const checks: CapabilityCheck[] = [...claimed].map((capability) => ({
      capability,
      claimed: true,
      verified: false,
      reason: `runtime "${adapter.id}" is unavailable: ${probe.reason ?? "no reason given"}`,
    }));
    return {
      runtimeId: adapter.id,
      available: false,
      probeReason: probe.reason,
      checks,
      missingRequired: missingRequiredCapabilities(new Set()),
      fallbacks: [`"${adapter.id}" cannot be used at all right now — route around it (T112) or fail closed rather than assuming any claimed capability holds`],
    };
  }

  const verified = new Set<RuntimeCapability>();
  const reasons = new Map<RuntimeCapability, string>();

  const bindingPresent = await existsSafely(adapter.workspace, adapter.binding.dir);
  if (bindingPresent) {
    verified.add(RuntimeCapability.PROJECT_LEVEL_BINDING);
  } else {
    reasons.set(RuntimeCapability.PROJECT_LEVEL_BINDING, `binding directory ${adapter.binding.dir} not found in this workspace`);
  }
  // NAMED_AGENTS rides on the same binding directory: this module has no role
  // name to probe a specific definition file with, so "the binding a role would
  // be addressed inside actually exists" is the strongest generic check
  // available. A per-role check (does this exact role's file exist) belongs to
  // whoever is about to run that role, not to a project-wide capability sweep.
  if (bindingPresent && claimed.has(RuntimeCapability.NAMED_AGENTS)) {
    verified.add(RuntimeCapability.NAMED_AGENTS);
  } else if (claimed.has(RuntimeCapability.NAMED_AGENTS)) {
    reasons.set(RuntimeCapability.NAMED_AGENTS, `binding directory ${adapter.binding.dir} not found — cannot confirm a role definition could be loaded from it`);
  }

  if (adapter.binding.guardConfigPath === null) {
    for (const cap of GUARD_CAPABILITIES) {
      if (claimed.has(cap)) reasons.set(cap, `runtime "${adapter.id}" declares no guard config path — nothing to verify a claim against`);
    }
  } else {
    const checker = { ...DEEP_GUARD_CHECKERS, ...opts.deepGuardCheckers }[adapter.id] ?? genericGuardCheck;
    const deep = await checker(adapter.workspace, adapter.binding.guardConfigPath);
    for (const cap of deep.verified) verified.add(cap);
    if (deep.reason) {
      for (const cap of GUARD_CAPABILITIES) {
        if (claimed.has(cap) && !deep.verified.has(cap)) reasons.set(cap, deep.reason);
      }
    }
  }

  // Everything else claimed that this module has no independent way to check
  // (MODEL_SELECTION, STRUCTURED_RESULT, COST_REPORTING, INTERACTIVE_PROMPTS,
  // PARALLEL_EXECUTION) is left unverified rather than rubber-stamped — a claim
  // this module cannot check is not the same as a claim it confirmed.
  for (const cap of claimed) {
    if (!verified.has(cap) && !reasons.has(cap)) {
      reasons.set(cap, "not independently checkable without a real agent run — claim only, not verified");
    }
  }

  const checks: CapabilityCheck[] = [...claimed].map((capability) => ({
    capability,
    claimed: true,
    verified: verified.has(capability),
    reason: verified.has(capability) ? undefined : reasons.get(capability),
  }));

  const missingRequired = missingRequiredCapabilities(verified);
  const fallbacks: string[] = [];
  if (missingRequired.includes(RuntimeCapability.NAMED_AGENTS)) {
    fallbacks.push("no verified named-agent loading — a role's own prompt must be folded into the request text on every run instead of addressed by name (this is what codexAdapter.ts already does)");
  }
  if (missingRequired.includes(RuntimeCapability.PRE_TOOL_GUARD) || missingRequired.includes(RuntimeCapability.EXIT_GUARD)) {
    fallbacks.push("no verified in-band guard enforcement — the write-scope and exit-check rules this pipeline assumes are not confirmed active; treat this runtime's output as unenforced until a person re-checks the guard wiring");
  }
  if (missingRequired.includes(RuntimeCapability.STRUCTURED_RESULT)) {
    fallbacks.push("no verified structured result — cost/usage logging and machine-parsed status for this runtime cannot be trusted beyond exit code and raw text");
  }

  return {
    runtimeId: adapter.id,
    available: true,
    checks,
    missingRequired,
    fallbacks,
  };
}

async function existsSafely(workspace: RuntimeWorkspace, relPath: string): Promise<boolean> {
  try {
    return await workspace.exists(relPath);
  } catch {
    return false;
  }
}
