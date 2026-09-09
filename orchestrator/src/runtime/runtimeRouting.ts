import { AgentStage } from "../types.js";
import { resolveAgentEffort, resolveAgentModel } from "../agents/agentModel.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { QaRiskSignals } from "../qa/mode.js";
import {
  assessBusinessInput,
  type BusinessInputEvidence,
} from "../gates/businessInput.js";
import { StaConfigInvalidError, StaConfigMissingError, loadStaConfig, type StaConfig } from "../packaging/staConfig.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { DEFAULT_RUNTIME_ID, RuntimeRegistry } from "./runtimeRegistry.js";
import type { RuntimeAdapter, RuntimeProbe } from "./runtimeAdapter.js";
import { RUNTIME_SUPPORT, type RuntimeSupportLevel } from "./runtimeSupport.js";
import {
  loadModelTierPolicy,
  type ModelTierId,
  type ModelTierPolicy,
  type ModelTiers,
} from "./modelTiers.js";
import {
  formatModelPolicyBasis,
  ModelPolicyResolutionError,
  resolveEffectiveModelPolicy,
  type EffectiveModelPolicyResolution,
} from "./tierRouting.js";

/**
 * One explicit route.
 *
 * Runtime selection has three sources, in this order: `--runtime` (level 1),
 * flags (level 1), an optional per-role `routing.by_role` entry (level 2), and
 * the named default runtime / `routing.order` (level 4). Model/effort policy is
 * resolved independently as operator override → task Tier → role Tier → runtime
 * default; frontmatter is read only for a pre-V8 compatibility policy. The
 * level numbers are the historical ones so `routing_basis` in existing run logs
 * keeps its meaning; level 5 is gone along with the previous-failure walk and
 * the legacy `model_routing` spelling.
 *
 * Levels 1 and 2 resolve exactly ONE candidate and fail closed with the reason —
 * they never substitute another runtime. Level 4 resolves the operator's
 * `routing.order` as an ordered list; an entry the caller reports `UNAVAILABLE`
 * hands over to the next one. Nothing else moves a stage between runtimes.
 */
export type RoutingPrecedenceLevel = 1 | 2 | 4;

export interface RuntimeRouteCandidate {
  readonly runtime: RuntimeAdapter;
  readonly model?: string;
  /** True when the adapter must receive `model`, including a Tier-derived value. */
  readonly modelExplicit?: boolean;
  /** Effective reasoning effort from the same central policy resolver. */
  readonly effort?: string;
  readonly reason: string;
  readonly policyResolution: EffectiveModelPolicyResolution;
}

/** The route decision, including a candidate refused before execution. */
export interface RuntimeRouteAttempt {
  readonly runtimeId: string;
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly modelExplicit?: boolean;
  readonly effort?: string;
  readonly reason: string;
  readonly policyResolution?: EffectiveModelPolicyResolution;
  /** Evidence for a deterministic skip. Such an entry must never execute. */
  readonly skipReason?: string;
  /** True when the skip was an availability probe, so a caller can escalate as infrastructure rather than as a task failure. */
  readonly unavailable?: true;
}

export interface RequestedRuntimeRoute {
  readonly runtimeId: string;
  readonly model?: string;
  readonly modelExplicit?: boolean;
  readonly effort?: string;
  readonly reason: string;
  readonly policyResolution?: EffectiveModelPolicyResolution;
}

export interface RuntimeRoute {
  /** The decision record. Unlike `candidates`, this retains a deterministic skip as evidence. */
  readonly attempts: readonly RuntimeRouteAttempt[];
  /** Eligible candidates in the operator's order. `[0]` is `selected`; the rest are reachable only by an `UNAVAILABLE` hop. */
  readonly candidates: readonly RuntimeRouteCandidate[];
  readonly selected?: RuntimeRouteCandidate;
  /** Compatibility projection of `selected`; new callers should consume the candidate. */
  readonly runtime?: RuntimeAdapter;
  readonly model?: string;
  readonly requested: RequestedRuntimeRoute;
  /** Reasoning effort resolved for the selected candidate, when one was named explicitly. */
  readonly effort?: string;
  readonly precedenceLevel: RoutingPrecedenceLevel;
  readonly diagnostics: readonly string[];
  /** Present whenever the candidate may not be executed. Callers must fail closed. */
  readonly error?: string;
}

export interface RuntimeRouteFlags {
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
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
  /** Confirmed BA intake removes the need for an in-run interview; all other BA input keeps it. */
  readonly businessInput?: BusinessInputEvidence;
  readonly verifiedCapabilities?: Readonly<Record<string, ReadonlySet<RuntimeCapability>>>;
  /** Current V8 policy. Undefined loads model-tiers.yaml; null is an intentional absent-policy fixture. */
  readonly modelPolicy?: ModelTierPolicy | null;
  /** Optional canonical task Tier. */
  readonly taskTier?: string;
  /** False only when replaying an already-frozen persisted route. */
  readonly allowLegacyPolicyCompatibility?: boolean;
  /** Pre-V8 compatibility input; new callers use modelPolicy + taskTier. */
  readonly tier?: { id: ModelTierId; table: ModelTiers };
}

interface CandidateSpec {
  readonly runtimeId: string;
  readonly operatorModel?: string;
  readonly operatorEffort?: string;
  readonly reason: string;
}

/** Parse the compact `routing.by_role` `runtime:model` spelling. */
export function parseModelRoute(value: string): { runtimeId?: string; model: string } {
  const idx = value.indexOf(":");
  if (idx <= 0) return { model: value };
  return { runtimeId: value.slice(0, idx), model: value.slice(idx + 1) };
}

/**
 * Derive capability needs from the role plus the canonical Target access mode.
 *
 * `INTERACTIVE_PROMPTS` is keyed to a BA run that still needs an interview,
 * not merely to `AskUserQuestion` tool presence. Complete confirmed input is
 * normalized without another interview; incomplete or absent input preserves
 * the interactive fallback.
 *
 * The requirement is not inferred from
 * `AskUserQuestion` tool presence: `system-analyst`/`project-manager` also
 * carry that tool but their human gate is `sta approve`, not an in-run
 * question, so a runtime that cannot prompt still runs them headless as
 * designed. Only the interview itself is the stage's actual work.
 */
export function requiredCapabilitiesFor(
  stage: AgentStage,
  hasTargetWrite = false,
  businessInput?: BusinessInputEvidence,
): RuntimeCapability[] {
  const required: RuntimeCapability[] = [];
  const confirmedBaRun =
    stage === AgentStage.BUSINESS_ANALYST &&
    businessInput !== undefined &&
    assessBusinessInput(businessInput).canNormalizeWithoutInterview;
  if (stage === AgentStage.BUSINESS_ANALYST && !confirmedBaRun) {
    required.push(RuntimeCapability.INTERACTIVE_PROMPTS);
  }
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
): CandidateSpec | undefined {
  const byRole = config?.routing?.by_role?.[role];
  if (byRole === undefined) return undefined;
  if (typeof byRole === "string") {
    const parsed = parseModelRoute(byRole);
    return {
      runtimeId: parsed.runtimeId ?? defaultRuntimeId,
      operatorModel: parsed.model,
      reason: `routing.by_role selected "${byRole}" for role "${role}"`,
    };
  }
  return {
    runtimeId: byRole.runtime,
    operatorModel: byRole.model,
    operatorEffort: byRole.effort,
    reason: `routing.by_role selected runtime "${byRole.runtime}" for role "${role}"`,
  };
}

/**
 * Precedence level 4's candidate order. Absent (or a single entry) means the one
 * automatic candidate, and every downstream fail-closed path behaves as it did
 * before the key was read at all.
 */
function orderedRuntimeIds(config: StaConfig | null, diagnostics: string[]): string[] | undefined {
  const order = config?.routing?.order;
  if (!order || order.length === 0) return undefined;
  const deduped = [...new Set(order)];
  const runner = config?.execution?.runner;
  if (runner !== undefined && deduped[0] !== runner) {
    diagnostics.push(
      `routing.order starts at "${deduped[0]}" while execution.runner names "${runner}" — the order wins at precedence level 4`,
    );
  }
  return deduped;
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
  const frontmatterEffort = resolveAgentEffort(opts.projectRoot, opts.role) ?? undefined;

  const flagPresent = opts.flags?.runtime !== undefined || opts.flags?.model !== undefined || opts.flags?.effort !== undefined;
  const byRole = byRoleRoute(config, opts.role, defaultRuntimeId);

  let precedenceLevel: RoutingPrecedenceLevel;
  let specs: CandidateSpec[];
  if (flagPresent) {
    precedenceLevel = 1;
    const runtimeId = opts.flags?.runtime ?? config?.execution?.runner ?? defaultRuntimeId;
    specs = [{
      runtimeId,
      operatorModel: opts.flags?.model,
      operatorEffort: opts.flags?.effort,
      reason: `explicit CLI flag selected runtime "${runtimeId}"${opts.flags?.model ? ` and model "${opts.flags.model}"` : ""}`,
    }];
  } else if (byRole) {
    precedenceLevel = 2;
    specs = [byRole];
  } else {
    precedenceLevel = 4;
    const ordered = orderedRuntimeIds(config, diagnostics);
    const runtimeIds = ordered ?? [config?.execution?.runner ?? defaultRuntimeId];
    specs = runtimeIds.map((runtimeId, index) => ({
      runtimeId,
      reason: index === 0
        ? automaticReason(opts, runtimeId)
        : `routing.order position ${index + 1} selected runtime "${runtimeId}" as a fallback`,
    }));
  }

  let modelPolicy: ModelTierPolicy | null;
  try {
    modelPolicy = opts.tier
      ? { tiers: opts.tier.table, roleDefaults: {}, legacyRoleDefaults: true }
      : opts.modelPolicy !== undefined
        ? opts.modelPolicy
        : loadModelTierPolicy(opts.projectRoot);
  } catch (error) {
    const head = specs[0]!;
    const requested = { runtimeId: head.runtimeId, model: head.operatorModel, effort: head.operatorEffort, reason: head.reason };
    const message = `model policy could not be read: ${error instanceof Error ? error.message : String(error)}`;
    diagnostics.push(message);
    return unresolved(requested, precedenceLevel, diagnostics, message);
  }

  const taskTier = opts.taskTier ?? opts.tier?.id;
  let resolvedSpecs: Array<CandidateSpec & EffectiveModelPolicyResolution>;
  try {
    resolvedSpecs = specs.map((spec) => ({
      ...spec,
      ...resolveEffectiveModelPolicy({
        role: opts.role,
        runtimeId: spec.runtimeId,
        policy: modelPolicy,
        taskTier,
        operatorModel: spec.operatorModel,
        operatorEffort: spec.operatorEffort,
        legacyFrontmatterModel: frontmatterModel,
        legacyFrontmatterEffort: frontmatterEffort,
        allowLegacyCompatibility: opts.allowLegacyPolicyCompatibility,
      }),
    }));
  } catch (error) {
    const head = specs[0]!;
    const requested = { runtimeId: head.runtimeId, model: head.operatorModel, effort: head.operatorEffort, reason: head.reason };
    const message = error instanceof ModelPolicyResolutionError ? error.message : String(error);
    diagnostics.push(message);
    return unresolved(requested, precedenceLevel, diagnostics, message);
  }

  for (const spec of resolvedSpecs) diagnostics.push(...spec.diagnostics);

  const head = resolvedSpecs[0]!;
  const requested: RequestedRuntimeRoute = {
    runtimeId: head.runtimeId,
    model: head.model,
    modelExplicit: head.modelExplicit,
    effort: head.effort,
    reason: `${head.reason}; ${formatModelPolicyBasis(head)}`,
    policyResolution: head,
  };

  if (opts.registry.ids().length === 0) {
    return unresolved(requested, precedenceLevel, diagnostics, "no runtime is registered; refusing to default silently");
  }

  const attempts: RuntimeRouteAttempt[] = [];
  const supportOptIns = new Set(config?.routing?.allow_below_supported ?? []);
  const required = requiredCapabilitiesFor(
    opts.stage,
    opts.hasTargetWrite ?? false,
    opts.businessInput,
  );
  // With nowhere to walk to, a probe-unavailable candidate stays selected so the
  // executor still classifies it `UNAVAILABLE` and escalates with the probe's
  // own reason. Skipping it here would downgrade that to a plain route error.
  const walkable = specs.length > 1;
  for (const spec of resolvedSpecs) {
    const runtime = opts.registry.tryGet(spec.runtimeId);
    const base = {
      model: spec.model,
      modelExplicit: spec.modelExplicit,
      effort: spec.effort,
      reason: `${spec.reason}; ${formatModelPolicyBasis(spec)}`,
      policyResolution: spec,
    };
    if (!runtime) {
      const skipReason = `runtime "${spec.runtimeId}" is not registered`;
      diagnostics.push(skipReason);
      attempts.push({ runtimeId: spec.runtimeId, ...base, skipReason });
      continue;
    }
    const probe = opts.availability?.[runtime.id];
    const unavailable = probe?.available === false
      ? `runtime "${runtime.id}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`
      : undefined;
    if (unavailable) diagnostics.push(unavailable);
    const level = supportLevel(runtime.id);
    const declaredOrVerified = opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities;
    const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
    const evidence = opts.verifiedCapabilities?.[runtime.id] ? "verified" : "declared";
    if (unmet.length > 0) {
      diagnostics.push(`runtime "${runtime.id}" lacks ${evidence} capabilities required by this stage: ${unmet.join(", ")}`);
    }
    // Only the automatic default is gated on support level; a runtime the
    // operator named explicitly is their call.
    if (walkable && unavailable) {
      attempts.push({ runtimeId: runtime.id, runtime, ...base, skipReason: unavailable, unavailable: true });
    } else if (precedenceLevel === 4 && level !== "supported" && !supportOptIns.has(runtime.id)) {
      const skipReason = `runtime "${runtime.id}" support level "${level}" is below "supported"; automatic routing requires routing.allow_below_supported to name this runtime`;
      diagnostics.push(skipReason);
      attempts.push({ runtimeId: runtime.id, runtime, ...base, skipReason });
    } else if (unmet.length > 0) {
      // Unconditional on hasTargetWrite: a stage's capability need (Target-write's
      // PRE_TOOL_GUARD, business-analyst's INTERACTIVE_PROMPTS) always disqualifies
      // a candidate here. What differs is what happens next — walkable, this is a
      // hop to the next entry; not walkable, it falls through to the refusal below.
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
    .filter((attempt): attempt is RuntimeRouteAttempt & { runtime: RuntimeAdapter; policyResolution: EffectiveModelPolicyResolution } => !!attempt.runtime && !!attempt.policyResolution && !attempt.skipReason)
    .map((attempt) => ({
      runtime: attempt.runtime,
      model: attempt.model,
      modelExplicit: attempt.modelExplicit,
      effort: attempt.effort,
      reason: attempt.reason,
      policyResolution: attempt.policyResolution,
    }));

  const unsupportedPolicyCandidate = capable.find((candidate) => {
    if (candidate.model && !candidate.runtime.models.has(candidate.model)) {
      const detail = `runtime "${candidate.runtime.id}" does not declare it can reach model "${candidate.model}" (declares: ${[...candidate.runtime.models].join(", ") || "none"})`;
      if (candidate.policyResolution.modelBasis.startsWith("task-tier:") || candidate.policyResolution.modelBasis.startsWith("role-default-tier:")) {
        diagnostics.push(`${detail}; refusing unsupported model-tier cell`);
        return true;
      } else {
        diagnostics.push(`${detail} — requesting the explicit/legacy value anyway; the adapter must validate it`);
      }
    }
    return false;
  });
  if (unsupportedPolicyCandidate) {
    const error = `model-tier policy resolved unsupported model "${unsupportedPolicyCandidate.model}" for runtime "${unsupportedPolicyCandidate.runtime.id}"; refusing route`;
    return unresolved(requested, precedenceLevel, diagnostics, error, [], attempts);
  }

  const selected = capable[0];
  if (!selected) {
    const probe = opts.availability?.[head.runtimeId];
    const level = supportLevel(head.runtimeId);
    const runtime = opts.registry.tryGet(head.runtimeId);
    let error: string;
    if (walkable) {
      // Exhaustion is a stop, not a loop: every entry is named with why it was
      // refused, so the operator does not have to re-derive the walk.
      error = `routing.order is exhausted — no configured runtime could be used: ${
        attempts.map((attempt) => `${attempt.runtimeId} (${attempt.skipReason ?? "no reason recorded"})`).join("; ")
      }`;
    } else if (probe?.available === false) {
      error = `runtime "${head.runtimeId}" is unavailable: ${probe.reason ?? "no unavailability reason was reported"}`;
    } else if (precedenceLevel === 4 && level !== "supported" && !supportOptIns.has(head.runtimeId)) {
      error = `refusing to auto-route to runtime "${head.runtimeId}" at support level "${level}" without per-runtime opt-in`;
    } else if (required.length > 0) {
      const declaredOrVerified = runtime
        ? (opts.verifiedCapabilities?.[runtime.id] ?? runtime.capabilities)
        : new Set<RuntimeCapability>();
      const unmet = required.filter((capability) => !declaredOrVerified.has(capability));
      // Two capabilities land here today and are worded differently on purpose,
      // mirroring runtimeExecutor.ts's Target-write gate: a missing PRE_TOOL_GUARD
      // is a guard gap (unsafe to run at all), a missing INTERACTIVE_PROMPTS is not
      // — this candidate just cannot do the stage's actual work.
      error = unmet.includes(RuntimeCapability.PRE_TOOL_GUARD)
        ? `runtime "${head.runtimeId}" cannot enforce a pre-tool workspace guard for Target write access; refusing route with missing required capability: ${unmet.join(", ")}`
        : `runtime "${head.runtimeId}" cannot run this stage: missing required capability ${unmet.join(", ") || "unknown"}`;
    } else {
      error = `no eligible candidate remains for requested runtime "${head.runtimeId}"`;
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
