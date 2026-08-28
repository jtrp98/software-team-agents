import type { RuntimeRegistry } from "../runtime/runtimeRegistry.js";

/** V3's only automatic ordering policy. Provider is deliberately not an axis. */
export const SUBSCRIPTION_FIRST_STRATEGY = "subscription-first" as const;

/**
 * Return registered runtime ids in deterministic subscription-first order.
 * An explicit order is authoritative; otherwise the configured default stays
 * first and registration order breaks ties. Nothing here probes or selects.
 */
export function subscriptionFirstRuntimeIds(
  registry: RuntimeRegistry,
  defaultRuntimeId: string,
  explicitOrder?: readonly string[],
): string[] {
  if (explicitOrder) return [...new Set(explicitOrder)];
  return [defaultRuntimeId, ...registry.ids().filter((id) => id !== defaultRuntimeId)];
}
