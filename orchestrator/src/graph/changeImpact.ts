import { AgentStage } from "../types.js";
import { TaskGraph, TaskGraphError, type ResolvedEdge, type TaskNode } from "./taskGraph.js";

/**
 * Change Impact Analysis (T17) — when a task's output changes, which other
 * tasks does that reach: API → Backend → Frontend → the phases QA has to
 * re-verify.
 *
 * `TaskGraph` (T10/T11) already records exactly the fact this needs: a
 * "contract" edge from a producer to every consumer of what it produces, and
 * a "declared" edge for whatever a task's author wrote down by hand. This
 * module doesn't re-derive that — it walks the edges the graph already
 * resolved, forward instead of backward. `edgesInto()` answers "why does this
 * task wait"; `impactOf()` answers "what waits on this one", transitively.
 *
 * "Phase" edges are deliberately excluded from the walk. They mean "runs no
 * earlier than", not "reads something from" — every task in phase 3 has a
 * phase edge from every task in phase 2, and treating that as impact would
 * make a one-line change to any task "impact" the entire rest of the plan,
 * which is exactly the noise this analysis exists to replace. Only
 * "declared" and "contract" edges represent an actual reliance on the
 * changed task's output.
 */

export interface ChangeImpactResult {
  /** The task ids the caller says changed. */
  changed: string[];
  /** Every task transitively affected, not including `changed` itself. */
  affected: TaskNode[];
  /** The affected tasks whose agent is backend-engineer. */
  backend: TaskNode[];
  /** The affected tasks whose agent is frontend-engineer. */
  frontend: TaskNode[];
  /** Every edge the walk crossed, in the order it found them — the "why" for each affected task. */
  path: ResolvedEdge[];
  /**
   * Phases touched by `changed` or `affected`, sorted. This is the "Tests"
   * leg of API → Backend → Frontend → Tests: a phase in this set is one
   * `qa-engineer` has to re-verify, because a task inside it depends,
   * directly or transitively, on something that changed.
   */
  affectedPhases: number[];
}

/** Edge kinds that represent an actual reliance on the source task's output, as opposed to pure scheduling order. */
const IMPACT_EDGE_KINDS: ReadonlySet<ResolvedEdge["kind"]> = new Set(["declared", "contract"]);

/**
 * Forward reachability from `changed`, following only edges that mean "reads
 * something from" rather than "runs after". BFS rather than DFS only because
 * it makes `path` read in the order impact actually spreads (one hop at a
 * time) rather than plunging down one branch first.
 */
export function impactOf(graph: TaskGraph, changed: string[]): ChangeImpactResult {
  for (const id of changed) {
    if (!graph.nodes.has(id)) {
      throw new TaskGraphError(`no task "${id}" in this graph`);
    }
  }

  const changedSet = new Set(changed);
  const affectedIds = new Set<string>();
  const path: ResolvedEdge[] = [];
  const queue = [...changed];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from !== current || !IMPACT_EDGE_KINDS.has(edge.kind)) continue;
      if (changedSet.has(edge.to) || affectedIds.has(edge.to)) continue;
      affectedIds.add(edge.to);
      path.push(edge);
      queue.push(edge.to);
    }
  }

  const affected = [...affectedIds].map((id) => graph.nodes.get(id)!);
  const phases = new Set<number>();
  for (const id of [...changed, ...affectedIds]) {
    const phase = graph.nodes.get(id)?.phase;
    if (phase !== undefined) phases.add(phase);
  }

  return {
    changed,
    affected,
    backend: affected.filter((t) => t.agent === AgentStage.BACKEND_ENGINEER),
    frontend: affected.filter((t) => t.agent === AgentStage.FRONTEND_ENGINEER),
    path,
    affectedPhases: [...phases].sort((a, b) => a - b),
  };
}

/**
 * Same walk, started from "whoever produces this contract" instead of a task
 * id — the natural entry point when what changed is a `design.md` model or
 * an API shape rather than a specific task. Returns an empty result (not an
 * error) for a contract nobody produces: a Data Model field that no task has
 * claimed yet has no impact to report, which is a true and useful answer.
 */
export function impactOfContract(graph: TaskGraph, contract: string): ChangeImpactResult {
  const producers = [...graph.nodes.values()]
    .filter((node) => (node.produces ?? []).includes(contract))
    .map((node) => node.id);
  if (producers.length === 0) {
    return { changed: [], affected: [], backend: [], frontend: [], path: [], affectedPhases: [] };
  }
  return impactOf(graph, producers);
}

/**
 * The report `system-analyst`/`qa-engineer` reads: which backend tasks,
 * which frontend tasks, and which phases a design.md change touches — the
 * chain TASKS.md's T17 asks for, API → Backend → Frontend → Tests, without
 * anyone having to trace it by hand.
 */
export function formatImpactReport(result: ChangeImpactResult): string {
  if (result.changed.length === 0) {
    return "no producer of this contract exists yet — nothing to report";
  }
  if (result.affected.length === 0) {
    return `${result.changed.join(", ")}: no other task depends on this — safe to change alone`;
  }

  const lines = [`changed: ${result.changed.join(", ")}`];
  if (result.backend.length > 0) lines.push(`  backend affected: ${result.backend.map((t) => t.id).join(", ")}`);
  if (result.frontend.length > 0) lines.push(`  frontend affected: ${result.frontend.map((t) => t.id).join(", ")}`);
  const other = result.affected.filter(
    (t) => t.agent !== AgentStage.BACKEND_ENGINEER && t.agent !== AgentStage.FRONTEND_ENGINEER,
  );
  if (other.length > 0) lines.push(`  other affected: ${other.map((t) => t.id).join(", ")}`);
  if (result.affectedPhases.length > 0) {
    lines.push(`  phases needing re-verification: ${result.affectedPhases.join(", ")}`);
  }
  return lines.join("\n");
}
