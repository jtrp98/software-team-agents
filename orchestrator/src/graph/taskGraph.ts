import { AgentStage } from "../types.js";

/**
 * A dependency graph over the individual tasks in a phase — `BE-004`, `FE-010`
 * — rather than over the phases themselves.
 *
 * Phases are too coarse to schedule with. "Phase 2 comes after Phase 1" is true
 * but says nothing about the eight tasks inside Phase 2, so the only safe
 * reading of it was "run everything in written order", and the pipeline's one
 * ordering rule had to be a blanket one: backend-engineer before
 * frontend-engineer, always, per `policies/agent-boundaries.md` §6a.
 *
 * That rule exists for a real reason — the frontend reads its types and API
 * calls off what the backend actually built, and running both at once produced
 * a real `staff-roles/sync` response-shape mismatch that cost an extra fix
 * round. But §6a also grants an exception nobody could act on: tasks in the
 * same phase that share no API contract may run in either order. Acting on it
 * required someone to know which tasks shared a contract, which is exactly the
 * knowledge a person is worst at holding across a phase.
 *
 * So the rule becomes an edge that is *derived*, not remembered: a frontend
 * task that consumes a contract a backend task produces gets an implicit
 * dependency on it. One that consumes nothing gets no edge, and can run
 * alongside. The ordering guarantee is strictly stronger than the blanket rule
 * where it matters, and absent where it never did.
 *
 * The graph knows nothing about running anything. It answers "what may go now"
 * and "what must wait"; who executes and how many at a time is the caller's.
 */

export interface TaskNode {
  /** Plan-level id, e.g. "BE-004". Unique within a graph. */
  id: string;
  /**
   * The role that will do it. Optional because this graph also serves the task
   * *registry*, where a node is a whole pipeline run rather than one agent's
   * task, and no single role owns it.
   */
  agent?: AgentStage;
  /**
   * Phase this task belongs to. Tasks in a later phase never run before an
   * earlier phase finishes. Omitted means "no phase", which is one flat phase —
   * the right reading for registry-level tasks, whose ordering is entirely in
   * their declared dependencies.
   */
  phase?: number;
  /** Explicit dependencies, as authored in the plan. */
  dependsOn?: string[];
  /**
   * API contracts this task creates — an endpoint name, a response shape, a
   * generated type. Anything a consumer would have to guess at if it ran first.
   */
  produces?: string[];
  /** Contracts this task reads. Consuming one it does not produce is what creates an implicit edge. */
  consumes?: string[];
  /**
   * The `design.md` Contract Version this task was planned against (T18).
   * Not used by the graph itself — `dependsOn`/`produces`/`consumes` are what
   * scheduling reads — but carried on the node so `contracts/contractVersion.ts`
   * can flag a task whose plan predates a later schema amendment, without a
   * second parallel data structure to keep in sync with this one.
   */
  contractVersion?: number;
  description?: string;
}

export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskGraphError";
  }
}

export class CircularDependencyError extends TaskGraphError {
  constructor(public readonly cycle: string[]) {
    super(`circular dependency: ${cycle.join(" -> ")} — a task cannot transitively depend on itself`);
    this.name = "CircularDependencyError";
  }
}

export class UnknownTaskError extends TaskGraphError {
  constructor(
    public readonly taskId: string,
    public readonly missing: string[],
  ) {
    super(
      `task ${taskId} depends on ${missing.join(", ")}, which are not in this graph — ` +
        "a dependency on a task that does not exist can never be satisfied",
    );
    this.name = "UnknownTaskError";
  }
}

export interface ResolvedEdge {
  from: string;
  to: string;
  /** Why this edge exists — an authored dependency, a shared contract, or phase order. */
  kind: "declared" | "contract" | "phase";
  reason: string;
}

export class TaskGraph {
  readonly nodes: Map<string, TaskNode>;
  readonly edges: ResolvedEdge[];
  private readonly incoming: Map<string, Set<string>>;

  constructor(nodes: TaskNode[]) {
    this.nodes = new Map();
    for (const node of nodes) {
      if (this.nodes.has(node.id)) {
        throw new TaskGraphError(`duplicate task id "${node.id}" — an id has to identify one task`);
      }
      this.nodes.set(node.id, node);
    }

    this.edges = this.resolveEdges();
    this.incoming = new Map([...this.nodes.keys()].map((id) => [id, new Set<string>()]));
    for (const edge of this.edges) this.incoming.get(edge.to)!.add(edge.from);

    this.assertAcyclic();
  }

  /**
   * Every edge, from all three sources. Declared edges are what the plan wrote
   * down; contract edges are §6a's rule made computable; phase edges keep an
   * earlier phase's work ahead of a later phase's.
   */
  private resolveEdges(): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];
    const seen = new Set<string>();
    const add = (edge: ResolvedEdge) => {
      const key = `${edge.from}->${edge.to}`;
      if (seen.has(key)) return; // a declared edge already covers it; no need for a weaker duplicate
      seen.add(key);
      edges.push(edge);
    };

    for (const node of this.nodes.values()) {
      const missing = (node.dependsOn ?? []).filter((id) => !this.nodes.has(id));
      if (missing.length > 0) throw new UnknownTaskError(node.id, missing);
      for (const dep of node.dependsOn ?? []) {
        add({ from: dep, to: node.id, kind: "declared", reason: `${node.id} declares a dependency on ${dep}` });
      }
    }

    // Contract edges: whoever produces a contract runs before whoever consumes it.
    const producers = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      for (const contract of node.produces ?? []) {
        producers.set(contract, [...(producers.get(contract) ?? []), node.id]);
      }
    }
    for (const node of this.nodes.values()) {
      for (const contract of node.consumes ?? []) {
        for (const producer of producers.get(contract) ?? []) {
          if (producer === node.id) continue; // producing and consuming its own contract is not a dependency
          add({
            from: producer,
            to: node.id,
            kind: "contract",
            reason: `${node.id} consumes "${contract}", which ${producer} produces — reading a contract before it is built is what §6a exists to prevent`,
          });
        }
      }
    }

    // Phase edges: the last tasks of an earlier phase gate the first of a later one.
    const byPhase = new Map<number, string[]>();
    for (const node of this.nodes.values()) {
      const phase = node.phase ?? 0;
      byPhase.set(phase, [...(byPhase.get(phase) ?? []), node.id]);
    }
    const phases = [...byPhase.keys()].sort((a, b) => a - b);
    for (let i = 1; i < phases.length; i++) {
      for (const earlier of byPhase.get(phases[i - 1])!) {
        for (const later of byPhase.get(phases[i])!) {
          add({
            from: earlier,
            to: later,
            kind: "phase",
            reason: `phase ${phases[i]} follows phase ${phases[i - 1]}`,
          });
        }
      }
    }

    return edges;
  }

  /**
   * Depth-first cycle detection that reports the actual cycle rather than only
   * its existence — "A -> B -> C -> A" is actionable, "there is a cycle
   * somewhere" is not.
   */
  private assertAcyclic(): void {
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (id: string): void => {
      const mark = state.get(id);
      if (mark === "done") return;
      if (mark === "visiting") {
        throw new CircularDependencyError([...stack.slice(stack.indexOf(id)), id]);
      }
      state.set(id, "visiting");
      stack.push(id);
      for (const edge of this.edges) {
        if (edge.from === id) visit(edge.to);
      }
      stack.pop();
      state.set(id, "done");
    };

    for (const id of this.nodes.keys()) visit(id);
  }

  /** Ids this task must wait for, directly. */
  dependenciesOf(id: string): string[] {
    const set = this.incoming.get(id);
    if (!set) throw new TaskGraphError(`no task "${id}" in this graph`);
    return [...set];
  }

  /** Why this task waits for that one — the edge's own explanation, for a person asking. */
  edgesInto(id: string): ResolvedEdge[] {
    return this.edges.filter((e) => e.to === id);
  }

  /**
   * The tasks that could start right now, given what has already finished.
   * Unknown ids in `completed` are ignored rather than rejected: a caller
   * tracking a superset of this graph is a normal thing, not an error.
   */
  readyTasks(completed: Iterable<string> = []): TaskNode[] {
    const done = new Set(completed);
    return [...this.nodes.values()].filter(
      (node) => !done.has(node.id) && this.dependenciesOf(node.id).every((dep) => done.has(dep)),
    );
  }

  /**
   * The whole graph as batches: everything in one batch can run at the same
   * time, and every batch waits for the one before it.
   *
   * This is the answer to T10 — the schedule the blanket backend-then-frontend
   * rule could never produce, because it had no way to tell an independent
   * frontend task from a dependent one.
   */
  parallelLayers(): TaskNode[][] {
    const layers: TaskNode[][] = [];
    const done = new Set<string>();

    while (done.size < this.nodes.size) {
      const ready = this.readyTasks(done);
      if (ready.length === 0) {
        // Unreachable: the constructor rejects cycles, and every other stall is one.
        throw new TaskGraphError("no task is ready and not everything is finished — the graph is not schedulable");
      }
      layers.push(ready);
      for (const node of ready) done.add(node.id);
    }
    return layers;
  }

  /** Layers capped to a maximum width, for a caller that can only run so many agents at once. */
  parallelLayersCapped(maxParallel: number): TaskNode[][] {
    if (maxParallel < 1) throw new TaskGraphError(`maxParallel must be at least 1, got ${maxParallel}`);
    return this.parallelLayers().flatMap((layer) => {
      const chunks: TaskNode[][] = [];
      for (let i = 0; i < layer.length; i += maxParallel) chunks.push(layer.slice(i, i + maxParallel));
      return chunks;
    });
  }

  /** A single valid order, for a caller that will not run anything in parallel. */
  topologicalOrder(): TaskNode[] {
    return this.parallelLayers().flat();
  }

  /**
   * How much the graph actually buys over running everything one at a time.
   * Reported rather than assumed: a scheduler whose parallelism quietly
   * collapsed to 1 looks exactly like a correct one from the outside.
   */
  parallelism(): { tasks: number; layers: number; widest: number; sequentialSpeedup: number } {
    const layers = this.parallelLayers();
    const widest = layers.reduce((n, l) => Math.max(n, l.length), 0);
    return {
      tasks: this.nodes.size,
      layers: layers.length,
      widest,
      sequentialSpeedup: layers.length === 0 ? 1 : Number((this.nodes.size / layers.length).toFixed(2)),
    };
  }
}

/**
 * Builds a graph from plan tasks, defaulting `consumes` for frontend work.
 *
 * A frontend task that names no contracts at all is the ambiguous case, and it
 * is the common one — most plans do not annotate contracts. Treating it as
 * independent would silently drop §6a's protection for every unannotated plan,
 * which is the failure that rule was written for. So an unannotated frontend
 * task depends on the backend tasks in its phase, exactly as the blanket rule
 * required; annotating it is what buys the parallelism back.
 */
export function buildPlanGraph(nodes: TaskNode[]): TaskGraph {
  const withDefaults = nodes.map((node) => {
    // Presence of the field is the annotation, not its length. `consumes: []`
    // is a task stating it reads nothing — a real claim, and the one that earns
    // parallelism. An omitted field states nothing, so the blanket rule holds.
    const annotated = node.produces !== undefined || node.consumes !== undefined;
    if (node.agent !== AgentStage.FRONTEND_ENGINEER || annotated) return node;

    const backendInPhase = nodes
      .filter((n) => n.agent === AgentStage.BACKEND_ENGINEER && n.phase === node.phase)
      .map((n) => n.id);
    if (backendInPhase.length === 0) return node;

    return { ...node, dependsOn: [...new Set([...(node.dependsOn ?? []), ...backendInPhase])] };
  });
  return new TaskGraph(withDefaults);
}
