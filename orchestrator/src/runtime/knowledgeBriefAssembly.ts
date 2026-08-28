import { AgentStage } from "../types.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { KnowledgeContext } from "../knowledge/knowledgeContext.js";
import { canSeeKind } from "../knowledge/roleView.js";
import { freshnessOf, type Freshness } from "../knowledge/freshness.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { loadTargetRegistry } from "../threeRepo/targets.js";
import { loadLocalTargetMapping, targetIdForLocalPath } from "../threeRepo/localTargets.js";

/**
 * The knowledge-store brief (T-KA5a): a compact, bounded rendering of what
 * `knowledge/<module>/<kind>/<ID>.yaml` already holds for one module, injected
 * beside the sliced docs so a stage starts from the store instead of re-reading
 * whole prose documents to rediscover facts the store already answers.
 *
 * Same posture as `sliceModuleDocsFor`: enrichment must never fail a run, so
 * the loader catches everything and yields `[]` — an absent or unreadable
 * store leaves the prompt exactly as it would have been without the brief.
 *
 * OFF07: this file is pure over its inputs. The caller reads the store however
 * its runtime allows; nothing here knows which process spawned the agent.
 */

const MAX_PER_KIND = 40;
const TITLE_CAP = 90;
/** Bodies are optional expansion, never the navigation mechanism. */
export const BODY_CAP = 1_200;
export const BRIEF_CAP = 16_384;

const STATUS_MARK: Record<string, string> = {
  approved: "✅",
  reviewed: "~",
  draft: "·",
  deprecated: "✕",
};

export interface KnowledgeBriefOptions {
  projectRoot: string;
  /** Resolved Knowledge root in three-repo mode; falls back to projectRoot. */
  knowledgeRoot?: string;
  moduleName: string;
  /** Authoritative task/handoff references only; arbitrary prose is never mined for ids. */
  referencedIds?: readonly string[];
  /** The active application root. When absent/unresolvable, retrieval preserves legacy breadth and reports the fallback. */
  targetRoot?: string;
  now?: string;
  /** Injection seam for deterministic tests; production uses freshnessOf. */
  freshnessResolver?: typeof freshnessOf;
}

export interface RenderOptions {
  moduleName: string;
  /**
   * Override the stage's kind visibility (roleView). Undefined means "ask
   * roleView" — tests inject a set directly so the rendering rules stay
   * decoupled from whoever owns the visibility table.
   */
  visibleKinds?: ReadonlySet<string>;
  referencedIds?: readonly string[];
  /** Test-only cap override; production keeps the bounded default above. */
  cap?: number;
  scopeNote?: string;
  scopeExcluded?: number;
}

type BriefItem = Pick<KnowledgeItem, "id" | "kind" | "title" | "body" | "module" | "status"> & { withheld?: readonly string[]; freshness?: Freshness };

function boundedBody(body: string): string {
  return body.length <= BODY_CAP ? body : `${body.slice(0, BODY_CAP - 1)}…`;
}

/** Adds whole lines only. Index lines enter before any optional body expansion. */
function appendWithinCap(parts: string[], additions: readonly string[], cap: number): string[] {
  const result = [...parts];
  for (const line of additions) {
    const candidate = result.length === 0 ? line : `${result.join("\n")}\n${line}`;
    if (Buffer.byteLength(candidate, "utf8") > cap) break;
    result.push(line);
  }
  return result;
}

export function renderKnowledgeBrief(items: readonly BriefItem[], stage: AgentStage, opts: RenderOptions): string[] {
  const mine = items.filter((i) => i.module === opts.moduleName && !i.id.startsWith("SRC-"));
  const visible = opts.visibleKinds
    ? mine.filter((i) => opts.visibleKinds!.has(i.kind))
    : mine.filter((i) => canSeeKind(stage, i.kind));
  if (visible.length === 0) {
    const scopeOnly = [
      ...(opts.scopeNote ? [`Knowledge scope: ${opts.scopeNote}`] : []),
      ...((opts.scopeExcluded ?? 0) > 0 ? [`Scope-excluded: ${opts.scopeExcluded} item(s) belonging only to another Target.`] : []),
    ];
    return appendWithinCap([], scopeOnly, opts.cap ?? BRIEF_CAP);
  }

  const byKind = new Map<string, BriefItem[]>();
  for (const item of visible) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  const kindOrder = [...byKind.keys()].sort();
  const index: string[] = [
    "",
    `Knowledge store brief — module \`${opts.moduleName}\`. Retrieve a visible item with \`sta knowledge get <ID>\`:`,
  ];
  if (opts.scopeNote) index.push(`Scope: ${opts.scopeNote}`);
  if ((opts.scopeExcluded ?? 0) > 0) index.push(`Scope-excluded: ${opts.scopeExcluded} item(s) belonging only to another Target.`);
  for (const kind of kindOrder) {
    const list = byKind.get(kind)!.sort((a, b) => a.id.localeCompare(b.id));
    index.push("", `### ${kind} (${list.length})`);
    const shown = list.slice(0, MAX_PER_KIND);
    for (const item of shown) {
      const mark = STATUS_MARK[item.status] ?? "?";
      const title = item.title.length > TITLE_CAP ? item.title.slice(0, TITLE_CAP - 1) + "…" : item.title;
      const withheld = item.withheld?.length ? ` (withheld: ${item.withheld.join(", ")})` : "";
      const freshness = item.freshness ? ` [${item.freshness.verdict}]` : "";
      index.push(`- ${item.id} ${mark}${freshness} ${title}${withheld}`);
      if (item.freshness && (item.freshness.verdict === "changed" || item.freshness.verdict === "unavailable")) {
        index.push(`  freshness: ${item.freshness.reason}`);
      }
    }
    if (list.length > shown.length) {
      index.push(`_+${list.length - shown.length} more ${kind} items — retrieve one with \`sta knowledge get <ID>\`._`);
    }
  }
  const cappedIndex = appendWithinCap([], index, opts.cap ?? BRIEF_CAP);
  // A role is not told the kinds it cannot retrieve: that would turn the brief
  // into a kind-visibility side channel.  Querying through KnowledgeContext
  // below has already removed fully hidden sensitive items.
  const referenced = new Set(opts.referencedIds ?? []);
  const expansions = visible
    .filter((item) => referenced.has(item.id) && !item.withheld?.includes("body"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((item) => ["", `#### ${item.id} referenced body`, boundedBody(item.body)]);
  return appendWithinCap(cappedIndex, expansions, opts.cap ?? BRIEF_CAP);
}

/** Loads the store and renders the brief; any failure yields `[]` (additive, T05). */
export function knowledgeBriefFor(stage: AgentStage, opts: KnowledgeBriefOptions): string[] {
  try {
    const root = opts.knowledgeRoot ?? opts.projectRoot;
    let targetId: string | undefined;
    let targetPaths = new Map<string, string>();
    let scopeNote: string | undefined;
    if (opts.targetRoot) {
      try {
        const registry = loadTargetRegistry(root);
        const mapped = loadLocalTargetMapping(root, registry, defaultProjectRoot());
        targetPaths = new Map(mapped.map((entry) => [entry.target_id, entry.path]));
        targetId = targetIdForLocalPath(mapped, opts.targetRoot);
        scopeNote = targetId ? `Target \`${targetId}\`.` : "Target id could not be resolved; legacy unscoped fallback is active.";
      } catch {
        scopeNote = "Target id could not be resolved; legacy unscoped fallback is active.";
      }
    }
    const context = KnowledgeContext.load(root);
    const retrieved = context.forRole(stage).query({ module: opts.moduleName, ...(targetId ? { target_ids: [targetId] } : {}) });
    const rawById = new Map(context.kb.items.map((item) => [item.id, item]));
    let freshness = new Map<string, Freshness>();
    try {
      freshness = new Map(retrieved.items.map((entry) => {
        const raw = rawById.get(entry.item.id)!;
        return [entry.item.id, (opts.freshnessResolver ?? freshnessOf)(raw, { now: opts.now ?? new Date().toISOString(), projectRoot: root, knowledgeRoot: root, targetPaths })];
      }));
    } catch {
      // Additive-on-failure: omit every marker so rendering is byte-identical
      // to the pre-freshness brief for the same retrieval result.
      freshness = new Map();
    }
    return renderKnowledgeBrief(retrieved.items.map((entry) => ({ ...entry.item, freshness: freshness.get(entry.item.id) })), stage, {
      moduleName: opts.moduleName,
      referencedIds: opts.referencedIds,
      scopeNote,
      scopeExcluded: retrieved.scopeExcluded,
    });
  } catch {
    return [];
  }
}
