import { CodeIntelligenceProvider, ProviderStatus, TargetRef } from "./provider.js";

/**
 * Composes providers into one `CodeIntelligenceProvider`, so everything
 * downstream (`resolver.ts`, capability checks, evidence rendering) keeps
 * dealing with exactly one provider (Architecture Principle 9/11: one
 * selection, frozen for the request — never a silent mid-attempt reroute).
 *
 * SELECTION RULE: ask each provider's `getStatus` in order. A NON-LAST
 * provider reporting `stale`, `error`, or `missing` (or throwing) is skipped
 * in favor of the next one — a stale/broken graph must never leave a machine
 * worse off than one with no graph provider installed at all (D4). The graph
 * itself is still never queried while stale/error: skipping happens at
 * `getStatus` time, before any operation call reaches that provider, so
 * `freshness.ts`'s "stale is a hard stop" policy is untouched — only WHICH
 * provider answers changes, not whether a stale index gets read. The winning
 * provider's status carries `fallenThrough` when a stale/error provider was
 * skipped to reach it, so the resolver can still emit the original
 * stale/error telemetry and mark its result as a fallback (never a silent
 * swap dressed up as an ordinary fresh hit).
 *
 * The LAST provider's status is always terminal (nothing left to fall
 * through to): its `stale`/`error`/`missing` verdict is returned as-is, and
 * the caller's existing fallback handling applies.
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
    let skipped: { status: "stale" | "error"; indexedRevision: string | null } | null = null;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const isLast = i === providers.length - 1;
      let status: ProviderStatus;
      try {
        status = await provider.getStatus(target);
      } catch {
        continue;
      }
      last = status;
      if (status.status === "missing") continue;
      if ((status.status === "stale" || status.status === "error") && !isLast) {
        if (!skipped) skipped = { status: status.status, indexedRevision: status.indexedRevision };
        continue;
      }
      return { provider, status: skipped ? { ...status, fallenThrough: skipped } : status };
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
