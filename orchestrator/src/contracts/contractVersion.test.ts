import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { TaskNode } from "../graph/taskGraph.js";
import { ContractVersionError, checkTaskContractVersions, parseContractVersion } from "./contractVersion.js";

function be(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return { id, agent: AgentStage.BACKEND_ENGINEER, ...over };
}

describe("parseContractVersion", () => {
  it("reads the version from a design.md-shaped document", () => {
    const md = "# Sales CRM — Feasibility & Design\n\n**Contract Version:** 2\n\n## Feasibility Summary\n";
    expect(parseContractVersion(md, "design.md")).toBe(2);
  });

  it("reads the version from a plan.md-shaped document", () => {
    const md = "# Sales CRM — Implementation Plan\n\n## Plan Summary\nSome paragraph.\n\n**Contract Version:** `1`\n";
    expect(parseContractVersion(md, "plan.md")).toBe(1);
  });

  it("throws with the document label when there's no version line", () => {
    expect(() => parseContractVersion("# no version line here", "design.md")).toThrow(ContractVersionError);
    try {
      parseContractVersion("# no version line here", "design.md");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as ContractVersionError).label).toBe("design.md");
      expect((e as Error).message).toContain("design.md");
    }
  });
});

describe("checkTaskContractVersions", () => {
  it("passes when every declared version matches the current one", () => {
    const nodes = [be("BE-001", { contractVersion: 2 }), be("BE-002", { contractVersion: 2 })];
    const result = checkTaskContractVersions(nodes, 2);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("flags a task planned against an older version as stale", () => {
    const nodes = [be("BE-001", { contractVersion: 1 })];
    const result = checkTaskContractVersions(nodes, 2);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("BE-001");
    expect(result.problems[0]).toContain("Contract Version 1");
    expect(result.problems[0]).toContain("now at 2");
  });

  it("flags a task claiming a version newer than the design's current one as out of sync", () => {
    const nodes = [be("BE-001", { contractVersion: 3 })];
    const result = checkTaskContractVersions(nodes, 2);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("newer than design.md's");
  });

  it("does not flag a task with no contractVersion declared at all", () => {
    const nodes = [be("BE-001")];
    const result = checkTaskContractVersions(nodes, 5);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("reports every stale task, not just the first", () => {
    const nodes = [be("BE-001", { contractVersion: 1 }), be("BE-002", { contractVersion: 1 }), be("BE-003", { contractVersion: 2 })];
    const result = checkTaskContractVersions(nodes, 2);
    expect(result.problems).toHaveLength(2);
  });
});
