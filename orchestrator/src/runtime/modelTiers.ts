import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentStage } from "../types.js";

/** The stable quality labels in ADR-022; bindings remain human-owned YAML. */
export const MODEL_TIER_IDS = ["T1", "T2", "T3", "T4", "T5", "T6"] as const;
export type ModelTierId = (typeof MODEL_TIER_IDS)[number];

/** A camp is the provider-side name; it maps to a runtime. */
export const MODEL_TIER_CAMPS = ["anthropic", "openai", "google", "zai"] as const;
export type ModelTierCamp = (typeof MODEL_TIER_CAMPS)[number];

export interface ModelTierCell {
  readonly model: string;
  readonly effort: string;
  readonly notes: string;
}

export interface ModelTier {
  readonly reserved: boolean;
  readonly camps: Readonly<Record<ModelTierCamp, ModelTierCell>>;
}

export type ModelTiers = Readonly<Record<ModelTierId, ModelTier>>;

/** Every executable role may have one central default or explicitly defer to the runtime. */
export const MODEL_POLICY_ROLES = Object.values(AgentStage).filter((role) => role !== AgentStage.HUMAN);
export const RUNTIME_DEFAULT_TIER = "runtime-default" as const;
export type RoleDefaultTier = ModelTierId | typeof RUNTIME_DEFAULT_TIER;

/**
 * The human-owned execution policy. `legacyRoleDefaults` is true only for a
 * pre-V8 tier file, whose agent frontmatter remains a compatibility input.
 */
export interface ModelTierPolicy {
  readonly tiers: ModelTiers;
  readonly roleDefaults: Readonly<Record<string, RoleDefaultTier>>;
  readonly legacyRoleDefaults: boolean;
}

export class ModelTiersInvalidError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`model-tiers.yaml is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ModelTiersInvalidError";
  }
}

export function modelTiersPath(projectRoot: string): string {
  return path.join(projectRoot, "model-tiers.yaml");
}

/**
 * Parse only the file's declared shape. This deliberately says nothing about
 * whether a model is adequate for a tier or comparable with another camp.
 */
export function parseModelTierPolicy(raw: string): ModelTierPolicy {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ModelTiersInvalidError([`is not valid YAML: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const problems: string[] = [];
  const root = record(parsed);
  if (!root) throw new ModelTiersInvalidError(["root must be a mapping"]);
  allowedKeys(root, ["role_defaults", "tiers"], "root", problems);

  const tierValues = root.tiers;
  const tiers = record(tierValues);
  if (!tiers) {
    throw new ModelTiersInvalidError(['"tiers" must be a mapping']);
  }

  exactKeys(tiers, MODEL_TIER_IDS, "tiers", problems);
  const result = {} as Record<ModelTierId, ModelTier>;
  for (const tierId of MODEL_TIER_IDS) {
    const tier = record(tiers[tierId]);
    if (!tier) {
      problems.push(`${tierId} must be a mapping`);
      continue;
    }
    const reserved = tier.reserved === true;
    if (tierId === "T1" && !reserved) problems.push("T1 must be marked reserved");
    if (tierId !== "T1" && tier.reserved === true) problems.push(`${tierId} must not be marked reserved`);

    const camps = record(tier.camps);
    if (!camps) {
      problems.push(`${tierId}.camps must be a mapping`);
      continue;
    }
    exactKeys(camps, MODEL_TIER_CAMPS, `${tierId}.camps`, problems);
    const cells = {} as Record<ModelTierCamp, ModelTierCell>;
    for (const camp of MODEL_TIER_CAMPS) {
      const cell = record(camps[camp]);
      if (!cell) {
        problems.push(`${tierId}.camps.${camp} must be a mapping`);
        continue;
      }
      const model = nonBlankString(cell.model, `${tierId}.camps.${camp}.model`, problems);
      const effort = nonBlankString(cell.effort, `${tierId}.camps.${camp}.effort`, problems);
      const notes = nonBlankString(cell.notes, `${tierId}.camps.${camp}.notes`, problems);
      if (model && effort && notes) cells[camp] = { model, effort, notes };
    }
    if (Object.keys(cells).length === MODEL_TIER_CAMPS.length) result[tierId] = { reserved, camps: cells };
  }
  const roleDefaults = {} as Record<string, RoleDefaultTier>;
  const legacyRoleDefaults = root.role_defaults === undefined;
  if (!legacyRoleDefaults) {
    const declared = record(root.role_defaults);
    if (!declared) {
      problems.push('"role_defaults" must be a mapping');
    } else {
      exactKeys(declared, MODEL_POLICY_ROLES, "role_defaults", problems);
      for (const role of MODEL_POLICY_ROLES) {
        const value = declared[role];
        if (value === RUNTIME_DEFAULT_TIER) {
          roleDefaults[role] = value;
        } else if (typeof value !== "string" || !(MODEL_TIER_IDS as readonly string[]).includes(value)) {
          problems.push(`role_defaults.${role} must be one of ${MODEL_TIER_IDS.join(", ")} or ${RUNTIME_DEFAULT_TIER}`);
        } else if (value === "T1") {
          problems.push(`role_defaults.${role} must not use reserved T1; T1 requires an explicit human operator choice`);
        } else {
          roleDefaults[role] = value as ModelTierId;
        }
      }
    }
  }

  if (problems.length > 0) throw new ModelTiersInvalidError(problems);
  return { tiers: result as ModelTiers, roleDefaults, legacyRoleDefaults };
}

/** Compatibility projection retained for callers that need only the tier cells. */
export function parseModelTiers(raw: string): ModelTiers {
  return parseModelTierPolicy(raw).tiers;
}

/** Missing table means the optional tier capability is not configured. */
export function loadModelTiers(projectRoot: string): ModelTiers | null {
  return loadModelTierPolicy(projectRoot)?.tiers ?? null;
}

export function loadModelTierPolicy(projectRoot: string): ModelTierPolicy | null {
  const target = modelTiersPath(projectRoot);
  if (!fs.existsSync(target)) return null;
  return parseModelTierPolicy(fs.readFileSync(target, "utf8"));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], location: string, problems: string[]): void {
  const expectedSet = new Set(expected);
  for (const key of expected) if (!(key in value)) problems.push(`${location} is missing ${key}`);
  for (const key of Object.keys(value)) if (!expectedSet.has(key)) problems.push(`${location} has unexpected key ${key}`);
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], location: string, problems: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) problems.push(`${location} has unexpected key ${key}`);
}

function nonBlankString(value: unknown, location: string, problems: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${location} must be a non-empty string`);
    return null;
  }
  return value;
}
