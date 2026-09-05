import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  CircularDependencyError,
  TaskGraph,
  TaskGraphError,
  UnknownTaskError,
  buildPlanGraph,
  type TaskNode,
} from "./taskGraph.js";

function be(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, agent: AgentStage.BACKEND_ENGINEER, phase: 1, ...over };
}
function fe(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, agent: AgentStage.FRONTEND_ENGINEER, phase: 1, ...over };
}

const ids = (nodes: TaskNode[]) => nodes.map((n) => n.id).sort();
/** Edges pointing at one task, for asserting on `resolveEdges` directly. */
const edgesInto = (graph: TaskGraph, id: string) => graph.edges.filter((e) => e.to === id);

describe("declared dependencies (T11)", () => {
  it("orders a chain of tasks", () => {
    const graph = new TaskGraph([be("BE-001"), be("BE-002", { dependsOn: ["BE-001"] }), be("BE-003", { dependsOn: ["BE-002"] })]);
    expect(graph.parallelLayers().flat().map((n) => n.id)).toEqual(["BE-001", "BE-002", "BE-003"]);
  });

  it("reports the actual cycle, not just that one exists", () => {
    try {
      new TaskGraph([be("A", { dependsOn: ["C"] }), be("B", { dependsOn: ["A"] }), be("C", { dependsOn: ["B"] })]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CircularDependencyError);
      const cycle = (e as CircularDependencyError).cycle;
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle).toContain("A");
    }
  });

  it("rejects a dependency on a task that is not in the graph", () => {
    expect(() => new TaskGraph([be("BE-001", { dependsOn: ["GHOST"] })])).toThrow(UnknownTaskError);
  });

  it("rejects a duplicate id", () => {
    expect(() => new TaskGraph([be("BE-001"), be("BE-001")])).toThrow(TaskGraphError);
  });

  it("explains why a task is waiting", () => {
    const graph = new TaskGraph([be("BE-001"), be("BE-002", { dependsOn: ["BE-001"] })]);
    const edge = edgesInto(graph, "BE-002")[0];
    expect(edge.kind).toBe("declared");
    expect(edge.reason).toContain("BE-001");
  });
});

describe("contract edges — §6a computed rather than remembered", () => {
  /** The mismatch that actually happened: the frontend read a response shape the backend had not built. */
  it("makes a frontend task wait for the backend task whose contract it consumes", () => {
    const graph = new TaskGraph([
      be("BE-004", { produces: ["staff-roles/sync"] }),
      fe("FE-010", { consumes: ["staff-roles/sync"] }),
    ]);
    expect(graph.dependenciesOf("FE-010")).toEqual(["BE-004"]);
    expect(edgesInto(graph, "FE-010")[0].kind).toBe("contract");
  });

  /** §6a's exception, finally actionable: no shared contract means no edge. */
  it("lets a frontend task that shares no contract run alongside the backend", () => {
    const graph = new TaskGraph([
      be("BE-004", { produces: ["staff-roles/sync"] }),
      fe("FE-020", { consumes: ["something-else"], produces: [] }),
    ]);
    expect(graph.dependenciesOf("FE-020")).toEqual([]);
    expect(graph.parallelLayers()[0].map((n) => n.id).sort()).toEqual(["BE-004", "FE-020"]);
  });

  it("does not make a task depend on itself for a contract it both produces and consumes", () => {
    const graph = new TaskGraph([be("BE-004", { produces: ["x"], consumes: ["x"] })]);
    expect(graph.dependenciesOf("BE-004")).toEqual([]);
  });

  it("waits for every producer when a contract has more than one", () => {
    const graph = new TaskGraph([
      be("BE-001", { produces: ["shape"] }),
      be("BE-002", { produces: ["shape"] }),
      fe("FE-001", { consumes: ["shape"] }),
    ]);
    expect(graph.dependenciesOf("FE-001").sort()).toEqual(["BE-001", "BE-002"]);
  });
});

describe("phase edges", () => {
  it("keeps a later phase behind an earlier one", () => {
    const graph = new TaskGraph([be("BE-001", { phase: 1 }), be("BE-010", { phase: 2 })]);
    expect(graph.dependenciesOf("BE-010")).toEqual(["BE-001"]);
    expect(edgesInto(graph, "BE-010")[0].kind).toBe("phase");
  });

  it("still runs independent tasks within one phase together", () => {
    const graph = new TaskGraph([
      be("BE-001", { phase: 1, produces: ["a"] }),
      be("BE-002", { phase: 1, produces: ["b"] }),
      fe("FE-001", { phase: 2, consumes: ["a"] }),
    ]);
    const layers = graph.parallelLayers();
    expect(ids(layers[0])).toEqual(["BE-001", "BE-002"]);
    expect(ids(layers[1])).toEqual(["FE-001"]);
  });
});

describe("parallel scheduling (T10)", () => {
  const graph = () =>
    new TaskGraph([
      be("BE-001", { produces: ["orders"] }),
      be("BE-002", { produces: ["reports"] }),
      fe("FE-001", { consumes: ["orders"] }),
      fe("FE-002", { consumes: ["reports"] }),
      fe("FE-003", { consumes: [], produces: [] }),
    ]);

  it("puts everything independent in the first batch", () => {
    expect(ids(graph().parallelLayers()[0])).toEqual(["BE-001", "BE-002", "FE-003"]);
  });

  it("puts each dependent task in the batch after its producer", () => {
    expect(ids(graph().parallelLayers()[1])).toEqual(["FE-001", "FE-002"]);
  });

  it("reports what it is ready to run given what has finished", () => {
    expect(ids(graph().readyTasks(["BE-001", "BE-002", "FE-003"]))).toEqual(["FE-001", "FE-002"]);
  });

  it("ignores ids it does not know about, so a caller tracking more than this graph still works", () => {
    expect(() => graph().readyTasks(["BE-001", "SOMETHING-ELSE"])).not.toThrow();
  });

  /** A scheduler whose parallelism collapsed to 1 looks correct from outside; this is how you see it. */
  it("measures how much the graph buys over running one at a time", () => {
    const stats = graph().parallelism();
    expect(stats.tasks).toBe(5);
    expect(stats.layers).toBe(2);
    expect(stats.widest).toBe(3);
    expect(stats.sequentialSpeedup).toBeGreaterThan(1);
  });

  it("degenerates to one task per layer when everything is a chain", () => {
    const chain = new TaskGraph([be("A"), be("B", { dependsOn: ["A"] }), be("C", { dependsOn: ["B"] })]);
    expect(chain.parallelism()).toMatchObject({ layers: 3, widest: 1, sequentialSpeedup: 1 });
  });
});

describe("buildPlanGraph — the unannotated case", () => {
  /**
   * Most plans do not annotate contracts. Treating an unannotated frontend task
   * as independent would silently drop §6a's protection for every one of them,
   * which is the exact failure the rule was written for.
   */
  it("falls back to the blanket rule when a frontend task names no contracts", () => {
    const graph = buildPlanGraph([be("BE-001"), be("BE-002"), fe("FE-001")]);
    expect(graph.dependenciesOf("FE-001").sort()).toEqual(["BE-001", "BE-002"]);
  });

  it("uses the real contract edges as soon as the task is annotated", () => {
    const graph = buildPlanGraph([
      be("BE-001", { produces: ["orders"] }),
      be("BE-002", { produces: ["reports"] }),
      fe("FE-001", { consumes: ["orders"] }),
    ]);
    expect(graph.dependenciesOf("FE-001")).toEqual(["BE-001"]);
  });

  it("annotating is what buys the parallelism back", () => {
    const blanket = buildPlanGraph([be("BE-001"), fe("FE-001")]).parallelism();
    const annotated = buildPlanGraph([be("BE-001", { produces: ["a"] }), fe("FE-001", { consumes: [] })]).parallelism();
    expect(blanket.widest).toBe(1);
    expect(annotated.widest).toBe(2);
  });

  it("leaves a frontend-only phase alone — there is no backend task to wait for", () => {
    const graph = buildPlanGraph([fe("FE-001"), fe("FE-002")]);
    expect(graph.parallelism().widest).toBe(2);
  });

  it("does not apply the fallback across phases", () => {
    const graph = buildPlanGraph([be("BE-001", { phase: 1 }), fe("FE-001", { phase: 2 })]);
    // Phase order already covers it; no extra same-phase backend edge is invented.
    expect(edgesInto(graph, "FE-001").map((e) => e.kind)).toEqual(["phase"]);
  });
});
