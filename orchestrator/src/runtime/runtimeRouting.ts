import type { AgentStage } from "../types.js";
import { getAgent } from "../agents/registry.js";
import { resolveAgentModel } from "../agents/agentModel.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { QaRiskSignals } from "../qa/mode.js";
import { subscriptionFirstRuntimeIds } from "../routing/routingPolicy.js";
import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "./runtimeRegistry.js";
import type { RuntimeAdapter, RuntimeProbe, RuntimeRunStatus } from "./runtimeAdapter.js";
import { RUNTIME_SUPPORT, type RuntimeSupportLevel } from "./runtimeSupport.js";
import { resolveTierBinding } from "./tierRouting.js";
import type { ModelTierId, ModelTiers } from "./modelTiers.js";

export type RoutingPrecedenceLevel = 1 | 2 | 3 | 4 | 5;
export type RoutingMode = "single" | "manual" | "auto";

export interface RuntimeRouteCandidate {
  readonly runtime: RuntimeAdapter;
  readonly model?: string;
  /** True when `model` came from an operator-visible override (CLI flag / `.sta/config.yaml` routing), not frontmatter (T-V4-CAST-001). */
  readonly modelExplicit?: boolean;
  /** Reasoning effort named alongside an explicit model in `.sta/config.yaml` routing (T-V4-CAST-001). */
  readonly effort?: string;
  readonly reason: string;
}

/** One ordered route decision, including candidates refused before execution. */
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
  /** Complete ordered plan. Unlike candidates, this retains deterministic skips as evidence. */
  readonly attempts: readonly RuntimeRouteAttempt[];
  readonly candidates: readonly RuntimeRouteCandidate[];
  readonly selected?: RuntimeRouteCandidate;
  /** Compatibility projection of `selected`; new callers should consume the candidate. */
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly requested: RequestedRuntimeRoute;
  /** Reasoning effort resolved for the selected candidate, when one was named explicitly (T-V4-CAST-001). */
  readonly effort?: string;
  readonly mode: RoutingMode;
  readonly allowHandoff: boolean;
  readonly precedenceLevel: RoutingPrecedenceLevel;
  readonly diagnostics: readonly string[];
  /** Present whenever no candidate may be executed. Callers must fail closed. */
  readonly error?: string;
}

export interface RuntimeRouteFlags {
  readonly runtime?: string;
  readonly model?: string;
}

export interface PreviousRuntimeFailure {
  readonly runtimeId: string;
  readonly status: RuntimeRunStatus;
  readonly reason?: string;
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
  readonly previousFailures?: readonly PreviousRuntimeFailure[];
  readonly mode?: RoutingMode;
  readonly allowHandoff?: boolean;
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

export class RuntimeRouteUnresolvedError extends Error {
  constructor(role: string, reason: string) {
    super(`cannot route role "${role}": ${reason}`);
    this.name = "RuntimeRouteUnresolvedError";
  }
}

/** Parse the legacy `model_routing` and compact `routing.by_role` spelling. */
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
      diagnostics.push(`.sta/config.yaml could not be read (${error.message}) — routing proceeds as if no V3 routing configuration exists`);
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
  return `automatic selection kept default runtime "${runtimeId}" (mode=${opts.mode ?? "single"}, classification=${classification}, risk=${risks.join(",") || "none"})`;
}

function manualRoute(
  config: StaConfig | null,
  role: string,
  defaultRuntimeId: string,
  frontmatterModel: string | undefined,
  diagnostics: string[],
): { spec?: CandidateSpec; legacyModelRouting: boolean; explicitRuntime: boolean; explicitModel: boolean } {
  const byRole = config?.routing?.by_role?.[role];
  const legacy = config?.model_routing?.[role];
  if (byRole !== undefined) {
    if (legacy !== undefined) diagnostics.push(`routing.by_role for role "${role}" takes precedence over model_routing`);
    if (typeof byRole === "string") {
      const parsed = parseModelRoute(byRole);
      return {
        spec: {
          runtimeId: parsed.runtimeId ?? defaultRuntimeId,
          model: parsed.model,
          modelExplicit: true,
          reason: `manual routing.by_role selected "${byRole}" for role "${role}"`,
        },
        legacyModelRouting: false,
        explicitRuntime: parsed.runtimeId !== undefined,
        explicitModel: true,
      };
    }
    return {
      spec: {
        runtimeId: byRole.runtime,
        model: byRole.model ?? frontmatterModel,
        modelExplicit: byRole.model !== undefined,
        effort: byRole.effort,
        reason: `manual routing.by_role selected runtime "${byRole.runtime}" for role "${role}"`,
      },
      legacyModelRouting: false,
      explicitRuntime: true,
      explicitModel: byRole.model !== undefined,
    };
  }
  if (legacy !== undefined) {
    const parsed = parseModelRoute(legacy);
    return {
      spec: {
        runtimeId: parsed.runtimeId ?? defaultRuntimeId,
        model: parsed.model,
        modelExplicit: true,
        reason: `manual model_routing selected "${legacy}" for role "${role}"`,
      },
      legacyModelRouting: true,
      explicitRuntime: parsed.runtimeId !== undefined,
      explicitModel: true,
    };
  }
  return { legacyModelRouting: false, explicitRuntime: false, explicitModel: false };
}

function unresolved(
  requested: RequestedRuntimeRoute,
  mode: RoutingMode,
  allowHandoff: boolean,
  precedenceLevel: RoutingPrecedenceLevel,
  diagnostics: readonly string[],
  error: string,
  candidates: readonly RuntimeRouteCandidate[] = [],
  attempts: readonly RuntimeRouteAttempt[] = [],
): RuntimeRoute {
  return { attempts, candidates, selected: undefined, runtime: undefined, model: undefined, requested, mode, allowHandoff, precedenceLevel, diagnostics, error };
}

/**
 * Resolve an ordered V3 runner/model candidate list. This function never probes
 * or executes; callers supply cached availability and must refuse `error`.
 * Candidate walking after an execution-time UNAVAILABLE result remains Phase 4.
 */
export function resolveRuntimeRoute(opts: ResolveRuntimeRouteOptions): RuntimeRoute {
  const diagnostics: string[] = [];
  const defaultRuntimeId = opts.defaultRuntimeId ?? DEFAULT_RUNTIME_ID;
  const config = opts.config !== undefined ? opts.config : loadConfigSafely(opts.projectRoot, diagnostics);
  const frontmatterModel = resolveAgentModel(opts.projectRoot, opts.role) ?? undefined;

  const flagPresent = opts.flags?.runtime !== undefined || opts.flags?.model !== undefined;
  const manual = manualRoute(config, opts.role, defaultRuntimeId, frontmatterModel, diagnostics);
  const policyPresent = config?.routing?.strategy !== undefined || config?.routing?.order !== undefined;
  // Pre-V3 model_routing remains an inferred Manual route. With no such
  // legacy entry and no execution block, the named default is Single.
  const recordedUnavailable = opts.previousFailures?.some((failure) => failure.status === "UNAVAILABLE") ?? false;
  const mode: RoutingMode = opts.mode ?? config?.execution?.mode ??
    (manual.spec ? "manual" : policyPresent || (opts.allowHandoff === true && recordedUnavailable) ? "auto" : "single");
  const allowHandoff = mode === "auto" && (opts.allowHandoff ?? config?.execution?.allow_handoff ?? true);

  let precedenceLevel: RoutingPrecedenceLevel;
  let specs: CandidateSpec[];
  let legacyModelRouting = false;
  if (mode === "single") {
    precedenceLevel = flagPresent ? 1 : 4;
    const runtimeId = opts.flags?.runtime ?? config?.execution?.runner ?? defaultRuntimeId;
    specs = [{
      runtimeId,
      model: opts.flags?.model ?? frontmatterModel,
      modelExplicit: opts.flags?.model !== undefined,
      reason: flagPresent
        ? `explicit CLI flag selected runtime "${runtimeId}"${opts.flags?.model ? ` and model "${opts.flags.model}"` : ""}`
        : automaticReason({ ...opts, mode }, runtimeId),
    }];
  } else if (mode === "manual") {
    precedenceLevel = flagPresent ? 1 : 2;
    if (flagPresent) {
      specs = [{
        runtimeId: opts.flags?.runtime ?? "",
        model: opts.flags?.model,
        modelExplicit: opts.flags?.model !== undefined,
        reason: `explicit CLI flag selected manual runtime "${opts.flags?.runtime ?? "(unnamed)"}"${opts.flags?.model ? ` and model "${opts.flags.model}"` : ""}`,
      }];
    } else if (manual.spec) {
      specs = [manual.spec];
      legacyModelRouting = manual.legacyModelRouting;
    } else {
      const requested = { runtimeId: defaultRuntimeId, model: frontmatterModel, reason: `Manual mode has no route for role "${opts.role}"` };
      return unresolved(requested, mode, allowHandoff, precedenceLevel, diagnostics, `Manual mode requires routing.by_role or model_routing to explicitly name a runner and model for role "${opts.role}"`);
    }
    const strictManual = opts.mode === "manual" || config?.execution?.mode === "manual";
    const explicitRuntime = flagPresent ? opts.flags?.runtime !== undefined : manual.explicitRuntime;
    const explicitModel = flagPresent ? opts.flags?.model !== undefined : manual.explicitModel;
    if (strictManual && (!explicitRuntime || !explicitModel)) {
      const requested = { runtimeId: specs[0]?.runtimeId || defaultRuntimeId, model: specs[0]?.model, reason: specs[0]?.reason ?? "manual route" };
      return unresolved(requested, mode, allowHandoff, precedenceLevel, diagnostics, `Manual mode may use only an explicitly named runner and model for role "${opts.role}"`);
    }
  } else if (flagPresent) {
    precedenceLevel = 1;
    specs = [{
      runtimeId: opts.flags?.runtime ?? defaultRuntimeId,
      model: opts.flags?.model ?? frontmatterModel,
      modelExplicit: opts.flags?.model !== undefined,
      reason: `explicit CLI flag selected runtime "${opts.flags?.runtime ?? defaultRuntimeId}"${opts.flags?.model ? ` and model "${opts.flags.model}"` : ""}`,
    }];
  } else if (manual.spec) {
    precedenceLevel = 2;
    specs = [manual.spec];
    legacyModelRouting = manual.legacyModelRouting;
  } else if (policyPresent) {
    precedenceLevel = 3;
    specs = subscriptionFirstRuntimeIds(opts.registry, defaultRuntimeId, config?.routing?.order).map((runtimeId, index) => ({
      runtimeId,
      model: frontmatterModel,
      reason: `routing policy "${config?.routing?.strategy ?? "explicit-order"}" placed runtime "${runtimeId}" at position ${index + 1}`,
    }));
  } else {
    precedenceLevel = 4;
    specs = [{ runtimeId: defaultRuntimeId, model: frontmatterModel, reason: automaticReason(opts, defaultRuntimeId) }];
  }

  if (mode === "auto" && allowHandoff) {
    const ordered = subscriptionFirstRuntimeIds(opts.registry, defaultRuntimeId, config?.routing?.order);
    // Explicit opt-in makes the paid adapter the final fallback even when a
    // subscription-only order was configured before that adapter existed.
    if (config?.execution?.allow_paid_fallback && opts.registry.has("paid-api") && !ordered.includes("paid-api")) {
      ordered.push("paid-api");
    }
    const present = new Set(specs.map((spec) => spec.runtimeId));
    for (const runtimeId of ordered) {
      if (present.has(runtimeId)) continue;
      specs.push({
        runtimeId,
        model: frontmatterModel,
        reason: `Auto mode fallback candidate after requested runtime "${specs[0]?.runtimeId ?? defaultRuntimeId}"`,
      });
      present.add(runtimeId);
    }
  }

  // Tier resolution is a source for model/effort, never a sixth precedence
  // level. A direct model override retains its existing explicit priority.
  if (opts.tier) {
    specs = specs.map((spec) => {
      if (spec.modelExplicit) return spec;
      const binding = resolveTierBinding(opts.tier!.table, opts.tier!.id, spec.runtimeId);
      return binding === null
        ? spec
        : { ...spec, model: binding.model, effort: binding.effort, modelExplicit: true, reason: `${spec.reason}; phase tier ${opts.tier!.id} resolved for ${spec.runtimeId}` };
    });
  }

  const requestedSpec = specs[0] ?? {
    runtimeId: defaultRuntimeId,
    model: frontmatterModel,
    reason: automaticReason(opts, defaultRuntimeId),
  };
  const requested: RequestedRuntimeRoute = {
    runtimeId: requestedSpec.runtimeId,
    model: requestedSpec.model,
    modelExplicit: requestedSpec.modelExplicit,
    effort: requestedSpec.effort,
    reason: requestedSpec.reason,
  };

  if (opts.registry.ids().length === 0) {
    return unresolved(requested, mode, allowHandoff, precedenceLevel, diagnostics, "no runtime is registered; refusing to default silently");
  }

  // The legacy model_routing contract explicitly fell back from an unknown id
  // to the configured default with a diagnostic. Preserve that compatibility
  // path; new flag/by_role routes fail closed instead.
  if (legacyModelRouting && !opts.registry.has(specs[0]!.runtimeId) && specs[0]!.runtimeId !== defaultRuntimeId) {
    diagnostics.push(`model_routing named runtime "${specs[0]!.runtimeId}" for role "${opts.role}", but it is not registered — falling back to "${defaultRuntimeId}"`);
    specs = [{
      runtimeId: defaultRuntimeId,
      model: specs[0]!.model,
      modelExplicit: specs[0]!.modelExplicit,
      effort: specs[0]!.effort,
      reason: `compatibility fallback to "${defaultRuntimeId}" because model_routing named an unregistered runtime`,
    }];
  }

  // Only recorded UNAVAILABLE attempts unlock precedence 5. ERROR/TIMEOUT are
  // deliberately ignored and can never move the runtime.
  const failedIds = new Set(
    opts.previousFailures?.filter((failure) => failure.status === "UNAVAILABLE").map((failure) => failure.runtimeId),
  );
  if (mode === "auto" && allowHandoff && precedenceLevel === 4 && failedIds.has(specs[0]?.runtimeId ?? "")) {
    specs = specs.filter((spec) => !failedIds.has(spec.runtimeId));
    precedenceLevel = 5;
  }

  const attempts: RuntimeRouteAttempt[] = [];
  const supportOptIns = new Set(config?.routing?.allow_below_supported ?? []);
  const required = requiredCapabilitiesFor(opts.stage, opts.hasTargetWrite ?? false);
  for (const spec of specs) {
    const runtime = opts.registry.tryGet(spec.runtimeId);
    if (!runtime) {
      const skipReason = `runtime "${spec.runtimeId}" is not registered`;
      diagnostics.push(skipReason);
      attempts.push({ runtimeId: spec.runtimeId, model: spec.model, modelExplicit: spec.modelExplicit, effort: spec.effort, reason: spec.reason, skipReason });
      continue;
    }
    const probe = opts.availability?.[runtime.id];
    if (probe?.available === false) {
      diagnostics.push(`runtime "${runtime.id}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`);
    }
    const level = supportLevel(runtime.id);
    const paidOptIn = runtime.id === "paid-api" && config?.execution?.allow_paid_fallback === true;
    if (precedenceLevel >= 3 && level !== "supported" && !supportOptIns.has(runtime.id) && !paidOptIn) {
      const skipReason = `runtime "${runtime.id}" support level "${level}" is below "supported"; automatic routing requires routing.allow_below_supported to name this runtime`;
      diagnostics.push(skipReason);
      attempts.push({ runtimeId: runtime.id, runtime, model: spec.model, modelExplicit: spec.modelExplicit, effort: spec.effort, reason: spec.reason, skipReason });
      continue;
    }
    const declaredOrVerified = opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities;
    const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
    if (unmet.length > 0) {
      const evidence = opts.verifiedCapabilities?.[runtime.id] ? "verified" : "declared";
      const message = `runtime "${runtime.id}" lacks ${evidence} capabilities required by this stage: ${unmet.join(", ")}`;
      diagnostics.push(message);
      if (opts.hasTargetWrite ?? false) {
        attempts.push({ runtimeId: runtime.id, runtime, model: spec.model, modelExplicit: spec.modelExplicit, effort: spec.effort, reason: spec.reason, skipReason: message });
        continue;
      }
    }
    attempts.push({ runtimeId: runtime.id, runtime, model: spec.model, modelExplicit: spec.modelExplicit, effort: spec.effort, reason: spec.reason });
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

  const intendedRuntimeId = specs[0]?.runtimeId ?? requested.runtimeId;
  const selected = allowHandoff
    ? capable[0]
    : capable.find((candidate) => candidate.runtime.id === intendedRuntimeId);
  if (!selected) {
    const probe = opts.availability?.[intendedRuntimeId];
    const level = supportLevel(intendedRuntimeId);
    let error: string;
    if (probe?.available === false) {
      error = `runtime "${intendedRuntimeId}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`;
    } else if (precedenceLevel >= 3 && level !== "supported" && !supportOptIns.has(intendedRuntimeId)) {
      error = `refusing to auto-route to runtime "${intendedRuntimeId}" at support level "${level}" without per-runtime opt-in`;
    } else if (opts.hasTargetWrite) {
      const runtime = opts.registry.tryGet(intendedRuntimeId);
      const declaredOrVerified = runtime
        ? (opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities)
        : new Set<RuntimeCapability>();
      const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
      error = `runtime "${intendedRuntimeId}" cannot enforce a pre-tool workspace guard for Target write access; refusing route with missing required capability: ${unmet.join(", ") || "unknown"}`;
    } else {
      error = `no eligible candidate remains for requested runtime "${intendedRuntimeId}"`;
    }
    return unresolved(requested, mode, allowHandoff, precedenceLevel, diagnostics, error, capable, attempts);
  }

  return {
    attempts,
    candidates: capable,
    selected,
    runtime: selected.runtime,
    model: selected.model,
    effort: selected.effort,
    requested,
    mode,
    allowHandoff,
    precedenceLevel,
    diagnostics,
  };
}
