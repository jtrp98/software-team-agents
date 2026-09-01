/**
 * Select the execution camp before routing a cast tier.  This deliberately
 * chooses only a runtime id; model/effort still enter resolveRuntimeRoute's
 * existing precedence chain afterwards.
 */
export interface TierCampSelectionOptions {
  readonly flagRuntime?: string;
  readonly configuredRuntime?: string;
  /** A role route is configured, but determines its runtime later per stage. */
  readonly hasConfiguredRoleRoute: boolean;
  readonly isTTY: boolean;
  readonly defaultRuntimeId: string;
  readonly prompt: () => string;
}

export type TierCampSelectionSource = "flag" | "config" | "configured-role-route" | "prompt" | "default";

export interface TierCampSelection {
  readonly runtimeId?: string;
  readonly source: TierCampSelectionSource;
}

/**
 * Precedence is intentionally flag > config > prompt.  The prompt callback is
 * unreachable without a TTY so CI/headless callers cannot read stdin.
 */
export function selectTierCamp(options: TierCampSelectionOptions): TierCampSelection {
  if (options.flagRuntime !== undefined) return { runtimeId: options.flagRuntime, source: "flag" };
  if (options.configuredRuntime !== undefined) return { runtimeId: options.configuredRuntime, source: "config" };
  if (options.hasConfiguredRoleRoute) return { source: "configured-role-route" };
  if (!options.isTTY) return { runtimeId: options.defaultRuntimeId, source: "default" };
  return { runtimeId: options.prompt(), source: "prompt" };
}
