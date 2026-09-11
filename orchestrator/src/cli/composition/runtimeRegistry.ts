import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { loadModelTiers, MODEL_TIER_IDS } from "../../runtime/modelTiers.js";
import { ClaudeCodeAdapter } from "../../runtime/claudeCodeAdapter.js";
import { CodexAdapter } from "../../runtime/codexAdapter.js";
import { OpenCodeAdapter } from "../../runtime/openCodeAdapter.js";
import { AntigravityAdapter } from "../../runtime/antigravityAdapter.js";

export interface CliDependencies {
  createRuntimeRegistry?: (projectRoot: string) => RuntimeRegistry;
}

export function runtimeRegistryFor(projectRoot: string, dependencies: CliDependencies): RuntimeRegistry {
  return (dependencies.createRuntimeRegistry ?? createProductionRuntimeRegistry)(projectRoot);
}

/**
 * The production composition root.
 *
 * The paid API adapter is no longer constructed here at all:
 * `--runtime` only offers runtimes that can actually run, and `ApiAdapter`
 * (`runtime/apiAdapter.ts`) has no `invoke` in production, so every call it
 * received always returned `NOT_CONFIGURED`. The class itself survives as an
 * unwired reference implementation; it is simply never registered.
 */
export function createProductionRuntimeRegistry(projectRoot: string): RuntimeRegistry {
  // The human-owned tier file is the one declarative source for models this
  // installation may request.  Adapters use it as a catalogue to reject a
  // typo before a provider call, rather than maintaining a second stale list.
  const modelsFor = (camp: "openai" | "google" | "zai"): string[] => {
    try {
      const tiers = loadModelTiers(projectRoot);
      return tiers ? [...new Set(MODEL_TIER_IDS.map((tier) => tiers[tier].camps[camp].model))] : [];
    } catch {
      // Runtime execution reports the malformed table through its existing
      // route diagnostics; construction itself remains safe for `doctor`.
      return [];
    }
  };
  return RuntimeRegistry.forProcess([
    new ClaudeCodeAdapter({ projectRoot }),
    new CodexAdapter({ projectRoot, models: modelsFor("openai") }),
    new OpenCodeAdapter({ projectRoot, models: modelsFor("zai") }),
    new AntigravityAdapter({ projectRoot, models: modelsFor("google") }),
  ]);
}
