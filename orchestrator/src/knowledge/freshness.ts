import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeItem, SourceRef } from "./knowledgeModel.js";
import type { KnowledgeBase } from "./knowledgeBase.js";
import {
  DEFAULT_KNOWLEDGE_POLICY,
  type KnowledgePolicy,
  freshnessThresholdFor,
} from "./knowledgePolicy.js";

/**
 * Context freshness (T71) — how old is what an agent is about to rely on, and
 * has the material underneath it moved.
 *
 * TIME IS THE WEAK SIGNAL; THE DIGEST IS THE STRONG ONE
 *
 * Age answers "this has not been looked at in six months", which is a prompt to
 * check, not a finding. The digest answers "the file this was derived from is
 * not the file that is there now", which is a finding: whatever was concluded
 * was concluded about different text. So a changed or missing source outranks
 * any age threshold, and age is what is left when there is nothing to hash.
 *
 * MEASURED FROM captured_at, NOT updated_at
 *
 * `updated_at` says when somebody last touched the item. An item edited this
 * morning out of a document read in February is stale in a way that field
 * cannot express — which is exactly why T61 gave every source its own
 * `captured_at`. Age is taken from the *oldest* source, because an item is only
 * as current as the least current thing it rests on.
 *
 * THRESHOLDS ARE POLICY, NOT CODE
 *
 * How many days is too many differs per project and per kind, so it lives in
 * `knowledge-policy.yaml` (T68). A `db-schema` goes stale faster than a
 * `decision`: the code moves under the first and not under the second.
 */

export type FreshnessVerdict = "fresh" | "aging" | "stale" | "source-changed" | "source-missing" | "unknown";

export interface Freshness {
  id: string;
  verdict: FreshnessVerdict;
  /** Days since the oldest source was captured. null when no source carries a usable date. */
  ageDays: number | null;
  /** The source the age was measured from — the weakest link, not the most recent one. */
  oldestSource: SourceRef | null;
  /** Locators whose material no longer hashes to what was recorded. */
  changedSources: string[];
  /** Locators that are no longer there at all. */
  missingSources: string[];
  /** One line, suitable to show an agent alongside the item it is about to use. */
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `path#L10-L24` -> the file and the line window it names. */
export function parseLocator(locator: string): { file: string; from?: number; to?: number } {
  const match = /^(.*?)#L(\d+)(?:-L(\d+))?$/.exec(locator);
  if (!match) return { file: locator };
  return { file: match[1], from: Number(match[2]), to: match[3] ? Number(match[3]) : Number(match[2]) };
}

/**
 * The digest of what a `file` source points at, or null when there is nothing
 * to read. Hashes only the named lines when the locator names a range: an item
 * derived from lines 48-61 has not gone stale because line 900 changed.
 */
export function digestOfSource(locator: string, projectRoot: string): string | null {
  const { file, from, to } = parseLocator(locator);
  const full = path.isAbsolute(file) ? file : path.join(projectRoot, file);

  let contents: string;
  try {
    contents = fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }

  const text =
    from === undefined
      ? contents
      : contents
          .split(/\r?\n/)
          .slice(from - 1, to)
          .join("\n");

  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export interface FreshnessOptions {
  /** ISO date-time to measure against. Passed in: an agent does not know today's date, and a test needs it fixed. */
  now: string;
  policy?: KnowledgePolicy;
  /**
   * Where to resolve `file` locators from. Omit to skip digest checking
   * entirely — then the verdict is age-only, and says so, rather than silently
   * reporting every source as unchanged.
   */
  projectRoot?: string;
}

export function freshnessOf(item: KnowledgeItem, options: FreshnessOptions): Freshness {
  const policy = options.policy ?? DEFAULT_KNOWLEDGE_POLICY;
  const threshold = freshnessThresholdFor(item.kind, policy);
  const nowMs = Date.parse(options.now);

  let oldestSource: SourceRef | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  const changedSources: string[] = [];
  const missingSources: string[] = [];

  for (const source of item.sources) {
    const capturedMs = Date.parse(source.captured_at);
    if (!Number.isNaN(capturedMs) && capturedMs < oldestMs) {
      oldestMs = capturedMs;
      oldestSource = source;
    }

    if (options.projectRoot === undefined) continue;
    if (source.type !== "file" && source.type !== "code") continue;
    if (source.digest === null) continue;

    const current = digestOfSource(source.locator, options.projectRoot);
    if (current === null) missingSources.push(source.locator);
    else if (current !== source.digest) changedSources.push(source.locator);
  }

  const ageDays =
    oldestSource === null || Number.isNaN(nowMs) ? null : Math.floor((nowMs - oldestMs) / DAY_MS);

  // Strongest signal first: what the material actually is beats how long ago
  // somebody looked at it.
  if (missingSources.length > 0) {
    return {
      id: item.id,
      verdict: "source-missing",
      ageDays,
      oldestSource,
      changedSources,
      missingSources,
      reason: `the material this came from is gone: ${missingSources.join(", ")}`,
    };
  }
  if (changedSources.length > 0) {
    return {
      id: item.id,
      verdict: "source-changed",
      ageDays,
      oldestSource,
      changedSources,
      missingSources,
      reason: `changed since it was read: ${changedSources.join(", ")} — whatever this concluded, it concluded about different text`,
    };
  }
  if (ageDays === null) {
    return {
      id: item.id,
      verdict: "unknown",
      ageDays: null,
      oldestSource,
      changedSources,
      missingSources,
      reason: "no source carries a date this can be measured from",
    };
  }
  if (ageDays >= threshold.staleAfterDays) {
    return {
      id: item.id,
      verdict: "stale",
      ageDays,
      oldestSource,
      changedSources,
      missingSources,
      reason: `read ${ageDays} days ago; ${item.kind} goes stale after ${threshold.staleAfterDays}`,
    };
  }
  if (ageDays >= threshold.agingAfterDays) {
    return {
      id: item.id,
      verdict: "aging",
      ageDays,
      oldestSource,
      changedSources,
      missingSources,
      reason: `read ${ageDays} days ago; worth re-checking after ${threshold.agingAfterDays}`,
    };
  }
  return {
    id: item.id,
    verdict: "fresh",
    ageDays,
    oldestSource,
    changedSources,
    missingSources,
    reason: `read ${ageDays} days ago`,
  };
}

export const NEEDS_ATTENTION: FreshnessVerdict[] = ["aging", "stale", "source-changed", "source-missing", "unknown"];

/** Every item that is not simply fresh, worst first — the order somebody would work through them. */
export function needsAttention(kb: KnowledgeBase, options: FreshnessOptions): Freshness[] {
  const rank: Record<FreshnessVerdict, number> = {
    "source-missing": 0,
    "source-changed": 1,
    stale: 2,
    aging: 3,
    unknown: 4,
    fresh: 5,
  };
  return kb.items
    .map((item) => freshnessOf(item, options))
    .filter((f) => f.verdict !== "fresh")
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
}
