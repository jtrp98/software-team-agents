import type { KnowledgeItem, KnowledgeKind, RelationType } from "./knowledgeModel.js";
import type { KnowledgeBase } from "./knowledgeBase.js";

/**
 * Graph questions over the knowledge base (T64).
 *
 * `knowledgeBase.ts` already stores relations and walks one hop at a time. That
 * is enough to answer "what does this point at"; it is not enough for the two
 * questions the relations were recorded for in the first place:
 *
 *   "I am about to change DB-Shift. What breaks?"      -> impactOf()
 *   "Why is this test connected to that requirement?"  -> pathBetween()
 *
 * Both are why a graph was chosen over a flat list of references. A list can
 * say REQ-003 is mentioned by four things; only a graph can say a change to
 * DB-Shift reaches REQ-003 through two hops, and name them.
 *
 * DIRECTION IS THE WHOLE DESIGN
 *
 * Every relation in the matrix points from the dependent thing to the thing it
 * depends on: a task *implements* a design, a test *verifies* a requirement, an
 * API *references* a model. So impact travels against the arrows — the things
 * that would have to change are the ones pointing at what changed — while
 * derivation travels with them. Getting this backwards produces an impact
 * analysis that is confidently empty, which is worse than none.
 */

export interface ImpactEntry {
  item: KnowledgeItem;
  /** Hops from the changed item. 1 = points at it directly. */
  depth: number;
  /** The relation that brought it in, at the hop that reached it first. */
  via: RelationType;
  /** The item one hop closer to the change — enough to reconstruct the route without storing the whole path per entry. */
  from: string;
}

export interface ImpactOptions {
  types?: RelationType[];
  maxDepth?: number;
  /** Stop the walk at these kinds — reached, reported, not expanded through. */
  stopAt?: KnowledgeKind[];
}

/**
 * Everything that would have to be looked at if `id` changed, nearest first.
 *
 * Walks incoming edges: a task that implements this design, a test that
 * verifies that task, and so on outward. `stopAt` exists because some kinds are
 * natural terminals — an impact report that keeps expanding through `decision`
 * items reaches most of the project and stops being a list anyone acts on.
 */
export function impactOf(kb: KnowledgeBase, id: string, options: ImpactOptions = {}): ImpactEntry[] {
  if (!kb.get(id)) return [];
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const stopAt = new Set(options.stopAt ?? []);

  const seen = new Set<string>([id]);
  const found: ImpactEntry[] = [];
  let frontier = [id];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const type of relationTypesInto(kb, current, options.types)) {
        for (const dependent of kb.incoming(current, type)) {
          if (seen.has(dependent.id)) continue;
          seen.add(dependent.id);
          found.push({ item: dependent, depth, via: type, from: current });
          if (!stopAt.has(dependent.kind)) next.push(dependent.id);
        }
      }
    }
    frontier = next;
  }

  return found;
}

/** The relation types actually present on the edges into `id`, so the walk asks the base once per real type rather than once per possible one. */
function relationTypesInto(kb: KnowledgeBase, id: string, filter?: RelationType[]): RelationType[] {
  const types = new Set<RelationType>();
  for (const item of kb.items) {
    for (const relation of item.relations) {
      if (relation.to === id) types.add(relation.type);
    }
  }
  return [...types].filter((t) => !filter || filter.includes(t));
}

export interface PathStep {
  from: string;
  type: RelationType;
  to: string;
  /** False when the step was taken against the arrow — the connection is real, the direction is not. */
  forward: boolean;
}

/**
 * The shortest chain of relations connecting two items, or null when there is
 * none. Traverses edges in both directions and records which way each step
 * actually points, because "these are connected" and "this one depends on that
 * one" are different claims and a path that blurred them would support the
 * wrong conclusion.
 */
export function pathBetween(kb: KnowledgeBase, fromId: string, toId: string): PathStep[] | null {
  if (!kb.get(fromId) || !kb.get(toId)) return null;
  if (fromId === toId) return [];

  const adjacency = new Map<string, PathStep[]>();
  const add = (node: string, step: PathStep): void => {
    const list = adjacency.get(node) ?? [];
    list.push(step);
    adjacency.set(node, list);
  };

  for (const item of kb.items) {
    for (const relation of item.relations) {
      if (!kb.get(relation.to)) continue; // dangling: check() reports it, paths do not traverse it
      add(item.id, { from: item.id, type: relation.type, to: relation.to, forward: true });
      add(relation.to, { from: relation.to, type: relation.type, to: item.id, forward: false });
    }
  }

  const previous = new Map<string, PathStep>();
  const seen = new Set<string>([fromId]);
  const queue = [fromId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of adjacency.get(current) ?? []) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      previous.set(step.to, step);
      if (step.to === toId) {
        const path: PathStep[] = [];
        for (let node = toId; node !== fromId; ) {
          const back = previous.get(node)!;
          path.unshift(back);
          node = back.from;
        }
        return path;
      }
      queue.push(step.to);
    }
  }

  return null;
}

export interface GraphEdge {
  from: string;
  type: RelationType;
  to: string;
}

export interface Subgraph {
  items: KnowledgeItem[];
  /** Only edges with both ends inside the selection — an edge leaving it would describe a node that is not here. */
  edges: GraphEdge[];
}

export function subgraph(kb: KnowledgeBase, ids: string[]): Subgraph {
  const wanted = new Set(ids);
  const items = kb.items.filter((i) => wanted.has(i.id));
  const present = new Set(items.map((i) => i.id));
  const edges: GraphEdge[] = [];

  for (const item of items) {
    for (const relation of item.relations) {
      if (present.has(relation.to)) edges.push({ from: item.id, type: relation.type, to: relation.to });
    }
  }

  return { items, edges };
}

/**
 * Items with no relation in either direction. Not an error — a domain term can
 * legitimately stand alone, and a freshly captured item has not been wired up
 * yet — but it is the shape knowledge takes when it was recorded and then
 * forgotten, so it is worth being able to ask for.
 */
export function orphans(kb: KnowledgeBase): KnowledgeItem[] {
  return kb.items.filter((item) => item.relations.length === 0 && kb.incoming(item.id).length === 0);
}
