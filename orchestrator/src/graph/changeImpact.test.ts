import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { TaskGraph, TaskGraphError, type TaskNode } from "./taskGraph.js";
import { formatImpactReport, impactOf, impactOfContract } from "./changeImpact.js";

function be(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, agent: AgentStage.BACKEND_ENGINEER, phase: 1, ...over };
}
function fe(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, agent: AgentStage.FRONTEND_ENGINEER, phase: 1, ...over };
}

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

describe("impactOf", () => {
  it("finds a direct contract consumer", () => {
    const graph = new TaskGraph([
      be("BE-001", { produces: ["users/list"] }),
      fe("FE-001", { consumes: ["users/list"] }),
    ]);
    const result = impactOf(graph, ["BE-001"]);
    expect(ids(result.affected)).toEqual(["FE-001"]);
    expect(ids(result.frontend)).toEqual(["FE-001"]);
    expect(result.backend).toEqual([]);
  });

  it("follows a transitive chain: BE-001 -> BE-002 (declared) -> FE-001 (contract)", () => {
    const graph = new TaskGraph([
      be("BE-001"),
      be("BE-002", { dependsOn: ["BE-001"], produces: ["orders/create"] }),
      fe("FE-001", { consumes: ["orders/create"] }),
    ]);
    const result = impactOf(graph, ["BE-001"]);
    expect(ids(result.affected)).toEqual(["BE-002", "FE-001"]);
  });

  it("does not treat an unrelated task in a later phase as impacted", () => {
    const graph = new TaskGraph([
      be("BE-001", { phase: 1, produces: ["a"] }),
      fe("FE-001", { phase: 1, consumes: ["a"] }),
      be("BE-099", { phase: 2, consumes: [] }), // unrelated, only ordered after phase 1 by a phase edge
    ]);
    const result = impactOf(graph, ["BE-001"]);
    expect(ids(result.affected)).toEqual(["FE-001"]);
  });

  it("does not list a diamond-shaped consumer twice", () => {
    const graph = new TaskGraph([
      be("BE-001", { produces: ["a"] }),
      be("BE-002", { consumes: ["a"] }),
      be("BE-003", { consumes: ["a"] }),
      fe("FE-001", { dependsOn: ["BE-002", "BE-003"] }),
    ]);
    const result = impactOf(graph, ["BE-001"]);
    expect(ids(result.affected)).toEqual(["BE-002", "BE-003", "FE-001"]);
  });

  it("collects the phases of everything affected", () => {
    const graph = new TaskGraph([
      be("BE-001", { phase: 1, produces: ["a"] }),
      fe("FE-001", { phase: 2, consumes: ["a"] }),
    ]);
    const result = impactOf(graph, ["BE-001"]);
    expect(result.affectedPhases).toEqual([1, 2]);
  });

  it("reports an empty result for a task nothing depends on", () => {
    const graph = new TaskGraph([be("BE-001")]);
    const result = impactOf(graph, ["BE-001"]);
    expect(result.affected).toEqual([]);
    expect(result.affectedPhases).toEqual([1]);
  });

  it("rejects an unknown task id rather than silently returning no impact", () => {
    const graph = new TaskGraph([be("BE-001")]);
    expect(() => impactOf(graph, ["GHOST"])).toThrow(TaskGraphError);
  });

  it("accepts more than one changed task at once", () => {
    const graph = new TaskGraph([
      be("BE-001", { produces: ["a"] }),
      be("BE-002", { produces: ["b"] }),
      fe("FE-001", { consumes: ["a"] }),
      fe("FE-002", { consumes: ["b"] }),
    ]);
    const result = impactOf(graph, ["BE-001", "BE-002"]);
    expect(ids(result.affected)).toEqual(["FE-001", "FE-002"]);
  });
});

describe("impactOfContract", () => {
  it("starts from whoever produces the contract", () => {
    const graph = new TaskGraph([
      be("BE-001", { produces: ["users/login"] }),
      fe("FE-001", { consumes: ["users/login"] }),
    ]);
    const result = impactOfContract(graph, "users/login");
    expect(result.changed).toEqual(["BE-001"]);
    expect(ids(result.affected)).toEqual(["FE-001"]);
  });

  it("returns an empty, non-throwing result for a contract nobody produces yet", () => {
    const graph = new TaskGraph([be("BE-001")]);
    const result = impactOfContract(graph, "not-produced-anywhere");
    expect(result.changed).toEqual([]);
    expect(result.affected).toEqual([]);
  });
});

describe("formatImpactReport", () => {
  it("reports backend, frontend, and phases separately", () => {
    const graph = new TaskGraph([
      be("BE-001", { phase: 1, produces: ["a"] }),
      be("BE-002", { phase: 1, dependsOn: ["BE-001"] }),
      fe("FE-001", { phase: 2, consumes: ["a"] }),
    ]);
    const report = formatImpactReport(impactOf(graph, ["BE-001"]));
    expect(report).toContain("backend affected: BE-002");
    expect(report).toContain("frontend affected: FE-001");
    expect(report).toContain("phases needing re-verification: 1, 2");
  });

  it("says plainly when nothing depends on the change", () => {
    const graph = new TaskGraph([be("BE-001")]);
    const report = formatImpactReport(impactOf(graph, ["BE-001"]));
    expect(report).toContain("safe to change alone");
  });

  it("says plainly when the contract has no producer", () => {
    const graph = new TaskGraph([be("BE-001")]);
    const report = formatImpactReport(impactOfContract(graph, "ghost"));
    expect(report).toContain("no producer of this contract exists yet");
  });
});
