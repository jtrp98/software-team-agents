import {
  MODEL_TIER_IDS,
  RUNTIME_DEFAULT_TIER,
  type ModelTierCamp,
  type ModelTierId,
  type ModelTierPolicy,
  type ModelTiers,
  type RoleDefaultTier,
} from "./modelTiers.js";

/** The four ADR-022 camps map to existing runtime ids; this is not a second registry. */
export const CAMP_RUNTIME_IDS: Readonly<Record<ModelTierCamp, string>> = {
  anthropic: "claude-code",
  openai: "codex",
  google: "antigravity",
  zai: "opencode",
};

export function campForRuntime(runtimeId: string): ModelTierCamp | null {
  return (Object.entries(CAMP_RUNTIME_IDS) as Array<[ModelTierCamp, string]>).find(([, id]) => id === runtimeId)?.[0] ?? null;
}

/** Repeated table cells are the human-authored, deterministic ladder collapse. */
export function resolveTierBinding(tiers: ModelTiers, tier: ModelTierId, runtimeId: string) {
  const camp = campForRuntime(runtimeId);
  return camp === null ? null : tiers[tier].camps[camp];
}

export type ModelPolicyValueBasis =
  | "operator-model"
  | "operator-effort"
  | `task-tier:${ModelTierId}`
  | `role-default-tier:${ModelTierId}`
  | "runtime-default"
  | "legacy-frontmatter";

export interface ModelPolicyRequest {
  readonly operatorModel?: string;
  readonly operatorEffort?: string;
  readonly taskTier?: string;
  readonly roleDefaultTier?: RoleDefaultTier;
}

/** A complete, deterministic explanation of the model/effort values handed to an adapter. */
export interface EffectiveModelPolicyResolution {
  readonly requested: ModelPolicyRequest;
  readonly effectiveTier?: ModelTierId;
  readonly model?: string;
  readonly effort?: string;
  /** True when an adapter must receive `model`, including a tier-derived binding. */
  readonly modelExplicit: boolean;
  readonly modelBasis: ModelPolicyValueBasis;
  readonly effortBasis: ModelPolicyValueBasis;
  readonly diagnostics: readonly string[];
}

export class ModelPolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyResolutionError";
  }
}

export interface ResolveEffectiveModelPolicyOptions {
  readonly role: string;
  readonly runtimeId: string;
  readonly policy: ModelTierPolicy | null;
  readonly taskTier?: string;
  readonly operatorModel?: string;
  readonly operatorEffort?: string;
  /** Pre-V8 compatibility only; never competes with a configured V8 role default. */
  readonly legacyFrontmatterModel?: string;
  readonly legacyFrontmatterEffort?: string;
  /** False for a frozen persisted route, which must not consult today's frontmatter. */
  readonly allowLegacyCompatibility?: boolean;
}

function checkedTaskTier(taskTier: string | undefined): ModelTierId | undefined {
  if (taskTier === undefined) return undefined;
  if (!(MODEL_TIER_IDS as readonly string[]).includes(taskTier)) {
    throw new ModelPolicyResolutionError(`task Tier "${taskTier}" is invalid; expected ${MODEL_TIER_IDS.join(", ")}`);
  }
  if (taskTier === "T1") {
    throw new ModelPolicyResolutionError("task Tier T1 is reserved for an explicit human operator choice and cannot be cast by a task");
  }
  return taskTier as ModelTierId;
}

/**
 * Resolve only model/effort policy. Runtime/camp selection happens before this
 * function and is deliberately not an input source in the precedence chain.
 */
export function resolveEffectiveModelPolicy(opts: ResolveEffectiveModelPolicyOptions): EffectiveModelPolicyResolution {
  const taskTier = checkedTaskTier(opts.taskTier);
  const roleDefaultTier = opts.policy?.roleDefaults[opts.role];
  const requested: ModelPolicyRequest = {
    ...(opts.operatorModel === undefined ? {} : { operatorModel: opts.operatorModel }),
    ...(opts.operatorEffort === undefined ? {} : { operatorEffort: opts.operatorEffort }),
    ...(opts.taskTier === undefined ? {} : { taskTier: opts.taskTier }),
    ...(roleDefaultTier === undefined ? {} : { roleDefaultTier }),
  };
  const diagnostics: string[] = [];

  let effectiveTier: ModelTierId | undefined;
  let tierBasis: `task-tier:${ModelTierId}` | `role-default-tier:${ModelTierId}` | undefined;
  if (taskTier) {
    if (!opts.policy) throw new ModelPolicyResolutionError(`task Tier ${taskTier} cannot resolve because model-tiers.yaml is missing`);
    effectiveTier = taskTier;
    tierBasis = `task-tier:${taskTier}`;
    if (roleDefaultTier !== undefined && roleDefaultTier !== taskTier) {
      diagnostics.push(`task Tier ${taskTier} overrides role default ${roleDefaultTier} for ${opts.role}`);
    }
  } else if (roleDefaultTier && roleDefaultTier !== RUNTIME_DEFAULT_TIER) {
    effectiveTier = roleDefaultTier;
    tierBasis = `role-default-tier:${roleDefaultTier}`;
  }

  let tierModel: string | undefined;
  let tierEffort: string | undefined;
  if (effectiveTier) {
    const binding = resolveTierBinding(opts.policy!.tiers, effectiveTier, opts.runtimeId);
    if (!binding) {
      throw new ModelPolicyResolutionError(
        `${tierBasis} cannot resolve for runtime "${opts.runtimeId}" because it has no model-tier camp mapping`,
      );
    }
    tierModel = binding.model;
    tierEffort = binding.effort;
  }

  const useLegacy = opts.allowLegacyCompatibility !== false && (!opts.policy || opts.policy.legacyRoleDefaults);
  if (useLegacy && !effectiveTier) {
    diagnostics.push(
      opts.policy
        ? "model-tiers.yaml has no V8 role_defaults; using legacy agent frontmatter compatibility"
        : "model-tiers.yaml is absent; using legacy agent frontmatter compatibility",
    );
  }

  const model = opts.operatorModel ?? tierModel ?? (useLegacy ? opts.legacyFrontmatterModel : undefined);
  // An explicit model intentionally leaves effort to the operator/runtime unless
  // effort was also explicit; a tier's effort belongs to its own mapped model.
  const effort = opts.operatorEffort ?? (opts.operatorModel === undefined
    ? tierEffort ?? (useLegacy ? opts.legacyFrontmatterEffort : undefined)
    : undefined);
  const modelBasis: ModelPolicyValueBasis = opts.operatorModel !== undefined
    ? "operator-model"
    : tierBasis ?? (useLegacy && opts.legacyFrontmatterModel !== undefined ? "legacy-frontmatter" : "runtime-default");
  const effortBasis: ModelPolicyValueBasis = opts.operatorEffort !== undefined
    ? "operator-effort"
    : opts.operatorModel !== undefined
      ? "runtime-default"
      : tierBasis ?? (useLegacy && opts.legacyFrontmatterEffort !== undefined ? "legacy-frontmatter" : "runtime-default");

  return {
    requested,
    ...(effectiveTier === undefined ? {} : { effectiveTier }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    modelExplicit: model !== undefined && modelBasis !== "legacy-frontmatter",
    modelBasis,
    effortBasis,
    diagnostics,
  };
}

export function formatModelPolicyBasis(resolution: EffectiveModelPolicyResolution): string {
  return `tier=${resolution.effectiveTier ?? RUNTIME_DEFAULT_TIER},model=${resolution.modelBasis},effort=${resolution.effortBasis}`;
}
