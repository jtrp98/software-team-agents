import type { ModelTierCamp, ModelTierId, ModelTiers } from "./modelTiers.js";

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
