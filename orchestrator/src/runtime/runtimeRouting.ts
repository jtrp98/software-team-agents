import type { AgentStage } from "../types.js";
import { getAgent } from "../agents/registry.js";
import { resolveAgentModel } from "../agents/agentModel.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { QaRiskSignals } from "../qa/mode.js";
import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "./runtimeRegistry.js";
import type { RuntimeAdapter, RuntimeProbe } from "./runtimeAdapter.js";
import { RUNTIME_SUPPORT, type RuntimeSupportLevel } from "./runtimeSupport.js";
import { resolveTierBinding } from "./tierRouting.js";
import type { ModelTierId, ModelTiers } from "./modelTiers.js";

/**
 * T-V5-040 — one explicit route.
 *
 * Three sources, in this order, and nothing else: the `--runtime`/`--model`
 * flags (level 1), an optional per-role `routing.by_role` entry (level 2), and
 * the named default runtime plus the role's frontmatter `model:` (level 4). The
 * level numbers are the historical ones so `routing_basis` in existing run logs
 * keeps its meaning; levels 3 (policy order) and 5 (previous-failure walking)
 * are gone along with execution modes, the handoff candidate chain and the
 * legacy `model_routing` spelling.
 *
 * A route resolves at most ONE candidate. When that candidate may not execute,
 * the route fails closed with the reason — it never substitutes another runtime.
 */
export type RoutingPrecedenceLevel = 1 | 2 | 4;

export interface RuntimeRouteCandidate {
  readonly runtime: RuntimeAdapter;
  readonly model?: string;
  /** True when `model` came from an operator-visible override (CLI flag / `routing.by_role`), not frontmatter (T-V4-CAST-001). */
  readonly modelExplicit?: boolean;
  /** Reasoning effort named alongside an explicit model in `routing.by_role` (T-V4-CAST-001). */
  readonly effort?: string;
  readonly reason: string;
}

/** The route decision, including a candidate refused before execution. */
export interface RuntimeRouteAttempt {
  readonly runtimeId: string;
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly modelExplicit?: boolean;
  readonly effort?: string;
  readonly reason: string;
  /** Evidence for a deterministic skip. Such an entry must never execute. */
  readonly skipReason?: string;
}

export interface RequestedRuntimeRoute {
  readonly runtimeId: string;
  readonly model?: string;
  readonly modelExplicit?: boolean;
  readonly effort?: string;
  readonly reason: string;
}

export interface RuntimeRoute {
  /** The decision record. Unlike `candidates`, this retains a deterministic skip as evidence. */
  readonly attempts: readonly RuntimeRouteAttempt[];
  readonly candidates: readonly RuntimeRouteCandidate[];
  readonly selected?: RuntimeRouteCandidate;
  /** Compatibility projection of `selected`; new callers should consume the candidate. */
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly requested: RequestedRuntimeRoute;
  /** Reasoning effort resolved for the selected candidate, when one was named explicitly (T-V4-CAST-001). */
  readonly effort?: string;
  readonly precedenceLevel: RoutingPrecedenceLevel;
  readonly diagnostics: readonly string[];
  /** Present whenever the candidate may not be executed. Callers must fail closed. */
  readonly error?: string;
}

export interface RuntimeRouteFlags {
  readonly runtime?: string;
  readonly model?: string;
}

export interface ResolveRuntimeRouteOptions {
  readonly role: string;
  readonly stage: AgentStage;
  readonly projectRoot: string;
  readonly registry: RuntimeRegistry;
  readonly defaultRuntimeId?: string;
  readonly config?: StaConfig | null;
  readonly flags?: RuntimeRouteFlags;
  readonly classification?: ClassificationResult;
  readonly riskSignals?: QaRiskSignals;
  readonly availability?: Readonly<Record<string, RuntimeProbe>>;
  /** True only when this stage has a canonical Target root with write access. */
  readonly hasTargetWrite?: boolean;
  readonly verifiedCapabilities?: Readonly<Record<string, ReadonlySet<RuntimeCapability>>>;
  /** A phase tier resolves model/effort through this route's existing precedence. */
  readonly tier?: { id: ModelTierId; table: ModelTiers };
}

interface CandidateSpec {
  readonly runtimeId: string;
  readonly model?: string;
  readonly modelExplicit?: boolean;
  readonly effort?: string;
  readonly reason: string;
}

/** Parse the compact `routing.by_role` `runtime:model` spelling. */
export function parseModelRoute(value: string): { runtimeId?: string; model: string } {
  const idx = value.indexOf(":");
  if (idx <= 0) return { model: value };
  return { runtimeId: value.slice(0, idx), model: value.slice(idx + 1) };
}

/** Derive capability needs from the role plus the canonical Target access mode. */
export function requiredCapabilitiesFor(stage: AgentStage, hasTargetWrite = false): RuntimeCapability[] {
  const entry = getAgent(stage);
  const required: RuntimeCapability[] = [];
  if (entry.tools.includes("AskUserQuestion")) required.push(RuntimeCapability.INTERACTIVE_PROMPTS);
  if (hasTargetWrite) required.push(RuntimeCapability.PRE_TOOL_GUARD);
  return required;
}

function loadConfigSafely(projectRoot: string, diagnostics: string[]): StaConfig | null {
  try {
    return loadStaConfig(projectRoot);
  } catch (error) {
    if (error instanceof StaConfigMissingError) return null;
    if (error instanceof StaConfigInvalidError) {
      diagnostics.push(`.sta/config.yaml could not be read (${error.message}) — routing proceeds as if no routing configuration exists`);
      return null;
    }
    throw error;
  }
}

function supportLevel(runtimeId: string): RuntimeSupportLevel {
  return runtimeId in RUNTIME_SUPPORT
    ? RUNTIME_SUPPORT[runtimeId as keyof typeof RUNTIME_SUPPORT].level
    : "unsupported";
}

function automaticReason(opts: ResolveRuntimeRouteOptions, runtimeId: string): string {
  const risks = Object.entries(opts.riskSignals ?? {}).filter(([, enabled]) => enabled).map(([name]) => name);
  const classification = opts.classification?.level ?? "unreported";
  return `automatic selection kept default runtime "${runtimeId}" (classification=${classification}, risk=${risks.join(",") || "none"})`;
}

/** Precedence level 2 — the optional per-role entry. Absent = no level-2 route. */
function byRoleRoute(
  config: StaConfig | null,
  role: string,
  defaultRuntimeId: string,
  frontmatterModel: string | undefined,
): CandidateSpec | undefined {
  const byRole = config?.routing?.by_role?.[role];
  if (byRole === undefined) return undefined;
  if (typeof byRole === "string") {
    const parsed = parseModelRoute(byRole);
    return {
      runtimeId: parsed.runtimeId ?? defaultRuntimeId,
      model: parsed.model,
      modelExplicit: true,
      reason: `routing.by_role selected "${byRole}" for role "${role}"`,
    };
  }
  return {
    runtimeId: byRole.runtime,
    model: byRole.model ?? frontmatterModel,
    modelExplicit: byRole.model !== undefined,
    effort: byRole.effort,
    reason: `routing.by_role selected runtime "${byRole.runtime}" for role "${role}"`,
  };
}

function unresolved(
  requested: RequestedRuntimeRoute,
  precedenceLevel: RoutingPrecedenceLevel,
  diagnostics: readonly string[],
  error: string,
  candidates: readonly RuntimeRouteCandidate[] = [],
  attempts: readonly RuntimeRouteAttempt[] = [],
): RuntimeRoute {
  return { attempts, candidates, selected: undefined, runtime: undefined, model: undefined, requested, precedenceLevel, diagnostics, error };
}

/**
 * Resolve the one runtime/model this stage may run on. This function never
 * probes or executes; callers supply cached availability and must refuse
 * `error`.
 */
export function resolveRuntimeRoute(opts: ResolveRuntimeRouteOptions): RuntimeRoute {
  const diagnostics: string[] = [];
  const defaultRuntimeId = opts.defaultRuntimeId ?? DEFAULT_RUNTIME_ID;
  const config = opts.config !== undefined ? opts.config : loadConfigSafely(opts.projectRoot, diagnostics);
  const frontmatterModel = resolveAgentModel(opts.projectRoot, opts.role) ?? undefined;

  const flagPresent = opts.flags?.runtime !== undefined || opts.flags?.model !== undefined;
  const byRole = byRoleRoute(config, opts.role, defaultRuntimeId, frontmatterModel);

  let precedenceLevel: RoutingPrecedenceLevel;
  let spec: CandidateSpec;
  if (flagPresent) {
    precedenceLevel = 1;
    const runtimeId = opts.flags?.runtime ?? config?.execution?.runner ?? defaultRuntimeId;
    spec = {
      runtimeId,
      model: opts.flags?.model ?? frontmatterModel,
      modelExplicit: opts.flags?.model !== undefined,
      reason: `explicit CLI flag selected runtime "${runtimeId}"${opts.flags?.model ? ` and model "${opts.flags.model}"` : ""}`,
    };
  } else if (byRole) {
    precedenceLevel = 2;
    spec = byRole;
  } else {
    precedenceLevel = 4;
    const runtimeId = config?.execution?.runner ?? defaultRuntimeId;
    // `modelExplicit: false` is stated, not omitted: a frontmatter default is a
    // reported non-override (T-V4-CAST-001), and adapters read the field.
    spec = { runtimeId, model: frontmatterModel, modelExplicit: false, reason: automaticReason(opts, runtimeId) };
  }

  // Tier resolution is a source for model/effort, never a further precedence
  // level. A direct model override retains its existing explicit priority.
  if (opts.tier && !spec.modelExplicit) {
    const binding = resolveTierBinding(opts.tier.table, opts.tier.id, spec.runtimeId);
    if (binding !== null) {
      spec = {
        ...spec,
        model: binding.model,
        effort: binding.effort,
        modelExplicit: true,
        reason: `${spec.reason}; phase tier ${opts.tier.id} resolved for ${spec.runtimeId}`,
      };
    }
  }

  const requested: RequestedRuntimeRoute = {
    runtimeId: spec.runtimeId,
    model: spec.model,
    modelExplicit: spec.modelExplicit,
    effort: spec.effort,
    reason: spec.reason,
  };

  if (opts.registry.ids().length === 0) {
    return unresolved(requested, precedenceLevel, diagnostics, "no runtime is registered; refusing to default silently");
  }

  const attempts: RuntimeRouteAttempt[] = [];
  const supportOptIns = new Set(config?.routing?.allow_below_supported ?? []);
  const required = requiredCapabilitiesFor(opts.stage, opts.hasTargetWrite ?? false);
  const runtime = opts.registry.tryGet(spec.runtimeId);
  const base = { model: spec.model, modelExplicit: spec.modelExplicit, effort: spec.effort, reason: spec.reason };
  if (!runtime) {
    const skipReason = `runtime "${spec.runtimeId}" is not registered`;
    diagnostics.push(skipReason);
    attempts.push({ runtimeId: spec.runtimeId, ...base, skipReason });
  } else {
    const probe = opts.availability?.[runtime.id];
    if (probe?.available === false) {
      diagnostics.push(`runtime "${runtime.id}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`);
    }
    const level = supportLevel(runtime.id);
    const declaredOrVerified = opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities;
    const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
    const evidence = opts.verifiedCapabilities?.[runtime.id] ? "verified" : "declared";
    if (unmet.length > 0) {
      diagnostics.push(`runtime "${runtime.id}" lacks ${evidence} capabilities required by this stage: ${unmet.join(", ")}`);
    }
    // Only the automatic default is gated on support level; a runtime the
    // operator named explicitly is their call.
    if (precedenceLevel === 4 && level !== "supported" && !supportOptIns.has(runtime.id)) {
      const skipReason = `runtime "${runtime.id}" support level "${level}" is below "supported"; automatic routing requires routing.allow_below_supported to name this runtime`;
      diagnostics.push(skipReason);
      attempts.push({ runtimeId: runtime.id, runtime, ...base, skipReason });
    } else if (unmet.length > 0 && (opts.hasTargetWrite ?? false)) {
      attempts.push({
        runtimeId: runtime.id,
        runtime,
        ...base,
        skipReason: `runtime "${runtime.id}" lacks ${evidence} capabilities required by this stage: ${unmet.join(", ")}`,
      });
    } else {
      attempts.push({ runtimeId: runtime.id, runtime, ...base });
    }
  }

  const capable: RuntimeRouteCandidate[] = attempts
    .filter((attempt): attempt is RuntimeRouteAttempt & { runtime: RuntimeAdapter } => !!attempt.runtime && !attempt.skipReason)
    .map((attempt) => ({ runtime: attempt.runtime, model: attempt.model, modelExplicit: attempt.modelExplicit, effort: attempt.effort, reason: attempt.reason }));

  for (const candidate of capable) {
    if (candidate.model && !candidate.runtime.models.has(candidate.model)) {
      diagnostics.push(
        `runtime "${candidate.runtime.id}" does not declare it can reach model "${candidate.model}" (declares: ${[...candidate.runtime.models].join(", ") || "none"}) — requesting it anyway; the run may fail`,
      );
    }
  }

  const selected = capable.find((candidate) => candidate.runtime.id === spec.runtimeId);
  if (!selected) {
    const probe = opts.availability?.[spec.runtimeId];
    const level = supportLevel(spec.runtimeId);
    let error: string;
    if (probe?.available === false) {
      error = `runtime "${spec.runtimeId}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`;
    } else if (precedenceLevel === 4 && level !== "supported" && !supportOptIns.has(spec.runtimeId)) {
      error = `refusing to auto-route to runtime "${spec.runtimeId}" at support level "${level}" without per-runtime opt-in`;
    } else if (opts.hasTargetWrite) {
      const declaredOrVerified = runtime
        ? (opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities)
        : new Set<RuntimeCapability>();
      const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
      error = `runtime "${spec.runtimeId}" cannot enforce a pre-tool workspace guard for Target write access; refusing route with missing required capability: ${unmet.join(", ") || "unknown"}`;
    } else {
      error = `no eligible candidate remains for requested runtime "${spec.runtimeId}"`;
    }
    return unresolved(requested, precedenceLevel, diagnostics, error, capable, attempts);
  }

  return {
    attempts,
    candidates: capable,
    selected,
    runtime: selected.runtime,
    model: selected.model,
    effort: selected.effort,
    requested,
    precedenceLevel,
    diagnostics,
  };
}
