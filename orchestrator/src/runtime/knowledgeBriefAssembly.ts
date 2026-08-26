import { AgentStage } from "../types.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { canSeeKind } from "../knowledge/roleView.js";

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
}

export interface RenderOptions {
  moduleName: string;
  /**
   * Override the stage's kind visibility (roleView). Undefined means "ask
   * roleView" — tests inject a set directly so the rendering rules stay
   * decoupled from whoever owns the visibility table.
   */
  visibleKinds?: ReadonlySet<string>;
}

export function renderKnowledgeBrief(items: KnowledgeItem[], stage: AgentStage, opts: RenderOptions): string[] {
  const mine = items.filter((i) => i.module === opts.moduleName && !i.id.startsWith("SRC-"));
  const visible = opts.visibleKinds
    ? mine.filter((i) => opts.visibleKinds!.has(i.kind))
    : mine.filter((i) => canSeeKind(stage, i.kind));
  if (visible.length === 0) return [];

  const byKind = new Map<string, KnowledgeItem[]>();
  for (const item of visible) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  const kindOrder = [...byKind.keys()].sort();
  const hiddenKinds = [...new Set(mine.map((i) => i.kind).filter((k) => !byKind.has(k)))].sort();

  const parts: string[] = [
    "",
    `Knowledge store brief — module \`${opts.moduleName}\` (\`knowledge/<module>/<kind>/<ID>.yaml\`; \`sta roles context\` reads the same data filtered per lane):`,
  ];
  for (const kind of kindOrder) {
    const list = byKind.get(kind)!.sort((a, b) => a.id.localeCompare(b.id));
    parts.push("", `### ${kind} (${list.length})`);
    const shown = list.slice(0, MAX_PER_KIND);
    for (const item of shown) {
      const mark = STATUS_MARK[item.status] ?? "?";
      const title = item.title.length > TITLE_CAP ? item.title.slice(0, TITLE_CAP - 1) + "…" : item.title;
      parts.push(`- ${item.id} ${mark} ${title}`);
    }
    if (list.length > shown.length) {
      parts.push(`_+${list.length - shown.length} more ${kind} items — the folder has them all._`);
    }
  }
  if (hiddenKinds.length > 0) {
    parts.push("", `_Kinds present for this module but outside this stage's view: ${hiddenKinds.join(", ")}._`);
  }
  return parts;
}

/** Loads the store and renders the brief; any failure yields `[]` (additive, T05). */
export function knowledgeBriefFor(stage: AgentStage, opts: KnowledgeBriefOptions): string[] {
  try {
    const root = opts.knowledgeRoot ?? opts.projectRoot;
    const { items } = loadKnowledge(root);
    return renderKnowledgeBrief(items, stage, { moduleName: opts.moduleName });
  } catch {
    return [];
  }
}