import type { AgentStage } from "../types.js";
import { getAgent } from "../agents/registry.js";
import { resolveAgentModel } from "../agents/agentModel.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "./runtimeRegistry.js";
import type { RuntimeAdapter } from "./runtimeAdapter.js";
import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";

/**
 * Which runtime and model a role actually runs on (T112) — T58's per-role model
 * choice, extended one step to also choose *which runtime reaches that model*,
 * per `runtimeRegistry.ts`'s own note on why that task needed rethinking: with
 * Claude Code and Codex claiming the same guard/agent mechanisms, "route by
 * capability" selects between identical candidates. The axis that actually
 * differs is which models each runtime can reach — so this is where T58's
 * frontmatter-driven model resolution (`agentModel.ts`) and `.sta/config.yaml`'s
 * `model_routing` (declared since T93, unread until now) finally meet a runtime
 * registry that can act on either.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not probe anything, and it does not call `RuntimeAdapter.executeAgent`
 * or `.probe()`. A routing decision has to be cheap enough to make on every
 * task, and an actual runtime run already reports its own availability
 * (`RuntimeRunStatus.UNAVAILABLE`) back through `runtimeExecutor.ts` — this
 * module answers "what should be tried", not "does it actually work right now".
 * A caller that wants T111's deeper, verified-against-installation picture can
 * pass it in via `verifiedCapabilities`; this module only degrades to the
 * static claim (`RuntimeAdapter.capabilities`) when nothing is passed.
 */

export class RuntimeRouteUnresolvedError extends Error {
  constructor(role: string, runtimeId: string) {
    super(`cannot route role "${role}": no runtime "${runtimeId}" is registered, and no fallback runtime is registered either`);
    this.name = "RuntimeRouteUnresolvedError";
  }
}

export interface RuntimeRoute {
  readonly runtime: RuntimeAdapter;
  readonly model?: string;
  /** Non-fatal notes on the decision — a config naming an unregistered runtime, a model the chosen runtime doesn't claim to reach, a capability this stage needs that the chosen runtime doesn't declare. Never silently dropped; a caller logs these. */
  readonly diagnostics: readonly string[];
}

/**
 * `.sta/config.yaml`'s `model_routing` value, extended without a schema change:
 * a plain model name (`"opus"`) still means "this model, on the default
 * runtime" exactly as T93 shipped it. A value with a colon (`"codex:o4-mini"`)
 * additionally names which runtime to route to — backward compatible because
 * every model name this framework has ever used (`opus`/`sonnet`/`haiku`/
 * `inherit`) contains no colon.
 */
export function parseModelRoute(value: string): { runtimeId?: string; model: string } {
  const idx = value.indexOf(":");
  if (idx <= 0) return { model: value };
  return { runtimeId: value.slice(0, idx), model: value.slice(idx + 1) };
}

/**
 * Capabilities a stage's own tool list implies it needs — derived from
 * `AGENT_REGISTRY` (T12) rather than a second, hand-maintained table, so a role
 * that stops using `AskUserQuestion` stops being flagged automatically instead
 * of by someone remembering to update a routing policy too.
 */
export function requiredCapabilitiesFor(stage: AgentStage): RuntimeCapability[] {
  const entry = getAgent(stage);
  const required: RuntimeCapability[] = [];
  if (entry.tools.includes("AskUserQuestion")) required.push(RuntimeCapability.INTERACTIVE_PROMPTS);
  return required;
}

export interface ResolveRuntimeRouteOptions {
  readonly role: string;
  readonly stage: AgentStage;
  readonly projectRoot: string;
  readonly registry: RuntimeRegistry;
  /** Runtime to use absent an override, and to fall back to when an override names one that isn't registered. Defaults to `DEFAULT_RUNTIME_ID` ("claude-code"). */
  readonly defaultRuntimeId?: string;
  /**
   * Pre-loaded `.sta/config.yaml`, for a caller that already has it (or a test
   * that wants to skip the filesystem). `undefined` (the default) loads it from
   * `projectRoot`; a missing or invalid file is not fatal to routing — it just
   * means no override exists, same as an empty `model_routing`.
   */
  readonly config?: StaConfig | null;
  /** T111's verified picture for a runtime, keyed by runtime id. When given for the chosen runtime, the capability check below uses it instead of the runtime's static claim. */
  readonly verifiedCapabilities?: Readonly<Record<string, ReadonlySet<RuntimeCapability>>>;
}

function loadConfigSafely(projectRoot: string, diagnostics: string[]): StaConfig | null {
  try {
    return loadStaConfig(projectRoot);
  } catch (e) {
    if (e instanceof StaConfigMissingError) return null;
    if (e instanceof StaConfigInvalidError) {
      diagnostics.push(`.sta/config.yaml could not be read (${e.message}) — routing proceeds as if model_routing were empty`);
      return null;
    }
    throw e;
  }
}

/**
 * The routing decision for one role: which runtime, and which model on it.
 *
 * Never silently routes to something unusable — an override naming an
 * unregistered runtime falls back to the default with a diagnostic rather than
 * throwing, because a stale `.sta/config.yaml` entry must not take a whole task
 * down. It only throws when *no* runtime can be resolved at all (neither the
 * override's nor the fallback's), which means the caller registered nothing —
 * a real misconfiguration, not a routing edge case.
 */
export function resolveRuntimeRoute(opts: ResolveRuntimeRouteOptions): RuntimeRoute {
  const diagnostics: string[] = [];
  const defaultId = opts.defaultRuntimeId ?? DEFAULT_RUNTIME_ID;
  const config = opts.config !== undefined ? opts.config : loadConfigSafely(opts.projectRoot, diagnostics);

  const override = config?.model_routing?.[opts.role];
  let runtimeId = defaultId;
  let model: string | undefined = resolveAgentModel(opts.projectRoot, opts.role) ?? undefined;

  if (override) {
    const parsed = parseModelRoute(override);
    if (parsed.runtimeId) runtimeId = parsed.runtimeId;
    model = parsed.model;
  }

  let runtime = opts.registry.tryGet(runtimeId);
  if (!runtime && runtimeId !== defaultId) {
    diagnostics.push(`model_routing named runtime "${runtimeId}" for role "${opts.role}", but it is not registered — falling back to "${defaultId}"`);
    runtimeId = defaultId;
    runtime = opts.registry.tryGet(defaultId);
  }
  if (!runtime) {
    throw new RuntimeRouteUnresolvedError(opts.role, runtimeId);
  }

  if (model && !runtime.models.has(model)) {
    diagnostics.push(
      `runtime "${runtime.id}" does not declare it can reach model "${model}" (declares: ${[...runtime.models].join(", ") || "none"}) — requesting it anyway; the run may fail`,
    );
  }

  const declaredOrVerified = opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities;
  const unmet = requiredCapabilitiesFor(opts.stage).filter((c) => !declaredOrVerified.has(c));
  if (unmet.length > 0) {
    diagnostics.push(
      `runtime "${runtime.id}" does not ${opts.verifiedCapabilities?.[runtime.id] ? "have verified" : "claim"} capabilities this stage needs: ${unmet.join(", ")} — it may not run as designed`,
    );
  }

  return { runtime, model, diagnostics };
}
