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

export type RoutingPrecedenceLevel = 1 | 2 | 3 | 4 | 5;
export type RoutingMode = "single" | "manual" | "auto";

export interface RuntimeRouteCandidate {
  readonly runtime: RuntimeAdapter;
  readonly model?: string;
  readonly reason: string;
}

export interface RequestedRuntimeRoute {
  readonly runtimeId: string;
  readonly model?: string;
  readonly reason: string;
}

export interface RuntimeRoute {
  readonly candidates: readonly RuntimeRouteCandidate[];
  readonly selected?: RuntimeRouteCandidate;
  /** Compatibility projection of `selected`; new callers should consume the candidate. */
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly requested: RequestedRuntimeRoute;
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
}

interface CandidateSpec {
  readonly runtimeId: string;
  readonly model?: string;
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
): { spec?: CandidateSpec; legacyModelRouting: boolean } {
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
          reason: `manual routing.by_role selected "${byRole}" for role "${role}"`,
        },
        legacyModelRouting: false,
      };
    }
    return {
      spec: {
        runtimeId: byRole.runtime,
        model: byRole.model ?? frontmatterModel,
        reason: `manual routing.by_role selected runtime "${byRole.runtime}" for role "${role}"`,
      },
      legacyModelRouting: false,
    };
  }
  if (legacy !== undefined) {
    const parsed = parseModelRoute(legacy);
    return {
      spec: {
        runtimeId: parsed.runtimeId ?? defaultRuntimeId,
        model: parsed.model,
        reason: `manual model_routing selected "${legacy}" for role "${role}"`,
      },
      legacyModelRouting: true,
    };
  }
  return { legacyModelRouting: false };
}

function unresolved(
  requested: RequestedRuntimeRoute,
  precedenceLevel: RoutingPrecedenceLevel,
  diagnostics: readonly string[],
  error: string,
  candidates: readonly RuntimeRouteCandidate[] = [],
): RuntimeRoute {
  return { candidates, selected: undefined, runtime: undefined, model: undefined, requested, precedenceLevel, diagnostics, error };
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

  let precedenceLevel: RoutingPrecedenceLevel;
  let specs: CandidateSpec[];
  let legacyModelRouting = false;
  if (flagPresent) {
    precedenceLevel = 1;
    specs = [{
      runtimeId: opts.flags?.runtime ?? defaultRuntimeId,
      model: opts.flags?.model ?? frontmatterModel,
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

  const requestedSpec = specs[0] ?? {
    runtimeId: defaultRuntimeId,
    model: frontmatterModel,
    reason: automaticReason(opts, defaultRuntimeId),
  };
  const requested: RequestedRuntimeRoute = {
    runtimeId: requestedSpec.runtimeId,
    model: requestedSpec.model,
    reason: requestedSpec.reason,
  };

  if (opts.registry.ids().length === 0) {
    return unresolved(requested, precedenceLevel, diagnostics, "no runtime is registered; refusing to default silently");
  }

  if (opts.availability && opts.registry.ids().every((id) => opts.availability?.[id]?.available === false)) {
    for (const id of opts.registry.ids()) {
      const reason = opts.availability[id]?.reason ?? "no unavailability reason was reported";
      diagnostics.push(`runtime "${id}" is unavailable: ${reason}`);
    }
    return unresolved(requested, precedenceLevel, diagnostics, "no registered runtime is available; refusing to default silently");
  }

  // The legacy model_routing contract explicitly fell back from an unknown id
  // to the configured default with a diagnostic. Preserve that compatibility
  // path; new flag/by_role routes fail closed instead.
  if (legacyModelRouting && !opts.registry.has(specs[0]!.runtimeId) && specs[0]!.runtimeId !== defaultRuntimeId) {
    diagnostics.push(`model_routing named runtime "${specs[0]!.runtimeId}" for role "${opts.role}", but it is not registered — falling back to "${defaultRuntimeId}"`);
    specs = [{
      runtimeId: defaultRuntimeId,
      model: specs[0]!.model,
      reason: `compatibility fallback to "${defaultRuntimeId}" because model_routing named an unregistered runtime`,
    }];
  }

  // A past automatic attempt that is explicitly recorded UNAVAILABLE unlocks
  // level 5 candidates for Phase 4 to consume. Production Phase 3 supplies no
  // previousFailures and therefore never executes this fallback path.
  const selectedProbe = opts.availability?.[specs[0]?.runtimeId ?? ""];
  const selectedUnavailable = selectedProbe?.available === false;
  const priorUnavailable = opts.previousFailures?.some(
    (failure) => failure.runtimeId === specs[0]?.runtimeId && failure.status === "UNAVAILABLE",
  );
  if (precedenceLevel === 4 && selectedUnavailable && priorUnavailable && opts.allowHandoff) {
    const failedIds = new Set(opts.previousFailures?.filter((failure) => failure.status === "UNAVAILABLE").map((failure) => failure.runtimeId));
    specs = subscriptionFirstRuntimeIds(opts.registry, defaultRuntimeId, config?.routing?.order)
      .filter((runtimeId) => !failedIds.has(runtimeId))
      .map((runtimeId, index) => ({
        runtimeId,
        model: frontmatterModel,
        reason: `fallback candidate ${index + 1} after runtime "${requested.runtimeId}" was unavailable`,
      }));
    precedenceLevel = 5;
  }

  const registered: RuntimeRouteCandidate[] = [];
  for (const spec of specs) {
    const runtime = opts.registry.tryGet(spec.runtimeId);
    if (!runtime) {
      diagnostics.push(`runtime "${spec.runtimeId}" is not registered`);
      continue;
    }
    registered.push({ runtime, model: spec.model, reason: spec.reason });
  }
  if (registered.length === 0) {
    return unresolved(requested, precedenceLevel, diagnostics, `requested runtime "${specs[0]?.runtimeId ?? requested.runtimeId}" is not registered`);
  }

  const available = registered.filter((candidate) => {
    const probe = opts.availability?.[candidate.runtime.id];
    if (!probe || probe.available) return true;
    diagnostics.push(`runtime "${candidate.runtime.id}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`);
    return false;
  });

  const supportOptIns = new Set(config?.routing?.allow_below_supported ?? []);
  const supported = available.filter((candidate) => {
    if (precedenceLevel < 3) return true; // explicit flag/manual choice is itself direct consent
    const level = supportLevel(candidate.runtime.id);
    if (level === "supported" || supportOptIns.has(candidate.runtime.id)) return true;
    diagnostics.push(
      `runtime "${candidate.runtime.id}" support level "${level}" is below "supported"; automatic routing requires routing.allow_below_supported to name this runtime`,
    );
    return false;
  });

  const required = requiredCapabilitiesFor(opts.stage, opts.hasTargetWrite ?? false);
  const capable = supported.filter((candidate) => {
    const declaredOrVerified = opts.verifiedCapabilities?.[candidate.runtime.id] ?? candidate.runtime.capabilities;
    const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
    if (unmet.length === 0) return true;
    const evidence = opts.verifiedCapabilities?.[candidate.runtime.id] ? "verified" : "declared";
    const message = `runtime "${candidate.runtime.id}" lacks ${evidence} capabilities required by this stage: ${unmet.join(", ")}`;
    diagnostics.push(message);
    return !(opts.hasTargetWrite ?? false);
  });

  for (const candidate of capable) {
    if (candidate.model && !candidate.runtime.models.has(candidate.model)) {
      diagnostics.push(
        `runtime "${candidate.runtime.id}" does not declare it can reach model "${candidate.model}" (declares: ${[...candidate.runtime.models].join(", ") || "none"}) — requesting it anyway; the run may fail`,
      );
    }
  }

  const intendedRuntimeId = specs[0]?.runtimeId ?? requested.runtimeId;
  const selected = capable.find((candidate) => candidate.runtime.id === intendedRuntimeId);
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
    return unresolved(requested, precedenceLevel, diagnostics, error, capable);
  }

  return {
    candidates: capable,
    selected,
    runtime: selected.runtime,
    model: selected.model,
    requested,
    precedenceLevel,
    diagnostics,
  };
}
