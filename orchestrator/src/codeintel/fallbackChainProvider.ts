import { CodeIntelligenceProvider, ProviderStatus, TargetRef } from "./provider.js";

/**
 * Composes providers into one `CodeIntelligenceProvider`, so everything
 * downstream (`resolver.ts`, capability checks, evidence rendering) keeps
 * dealing with exactly one provider (Architecture Principle 9/11: one
 * selection, frozen for the request — never a silent mid-attempt reroute).
 *
 * SELECTION RULE: ask each provider's `getStatus` in order; the first whose
 * status is not `missing` wins the WHOLE request — every operation call for
 * that request goes to that one provider. `stale`/`error` are NOT treated as
 * "try the next one": a stale graph is deliberately a hard stop
 * (`freshness.ts`'s documented policy — refreshing is a human's decision), not
 * an invitation to silently swap in a different evidence source. Only
 * "no usable graph exists at all" (`missing`, or the provider throwing while
 * asked) falls through.
 *
 * The list MUST end with a provider that never reports `missing` (in
 * practice: `NativeSearchProvider`), or a fully-missing chain still answers
 * `missing` — the caller's existing missing-index fallback then applies as
 * before.
 */
export function createFallbackChainProvider(providers: CodeIntelligenceProvider[]): CodeIntelligenceProvider {
  if (providers.length === 0) {
    throw new Error("createFallbackChainProvider needs at least one provider");
  }
  if (providers.length === 1) return providers[0];

  const select = async (target: TargetRef): Promise<{ provider: CodeIntelligenceProvider; status: ProviderStatus }> => {
    let last: ProviderStatus | null = null;
    for (const provider of providers) {
      let status: ProviderStatus;
      try {
        status = await provider.getStatus(target);
      } catch {
        continue;
      }
      last = status;
      if (status.status !== "missing") return { provider, status };
    }
    // Every provider reported missing (or threw): hand back the last provider
    // and its `missing` verdict so the caller's own missing-index fallback runs.
    return { provider: providers[providers.length - 1], status: last ?? { status: "missing", targetRevision: target.revision, indexedRevision: null, indexedAt: null } };
  };

  return {
    async isAvailable() {
      for (const provider of providers) {
        if (await provider.isAvailable().catch(() => false)) return true;
      }
      return false;
    },
    async getStatus(target) {
      return (await select(target)).status;
    },
    async findRelevantCode(query) {
      return (await select(query.target)).provider.findRelevantCode(query);
    },
    async getDependencies(query) {
      return (await select(query.target)).provider.getDependencies(query);
    },
    async getDependents(query) {
      return (await select(query.target)).provider.getDependents(query);
    },
    async findPath(query) {
      return (await select(query.target)).provider.findPath(query);
    },
    async getImpact(query) {
      return (await select(query.target)).provider.getImpact(query);
    },
  };
}
