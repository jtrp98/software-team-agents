import { describe, expect, it } from "vitest";
import { buildQaScope, renderQaScope } from "./scope.js";

describe("buildQaScope", () => {
  it("keeps changed files normalized, deduplicated and sorted", () => {
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: ["src\\b.ts", "./src/a.ts", "src/b.ts"],
    });
    expect(scope.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope.bounded).toBe(true);
  });

  it("fails closed on an empty change list", () => {
    const scope = buildQaScope({ taskId: "T1", changedFiles: [] });
    expect(scope.bounded).toBe(false);
    expect(scope.unboundedReason).toMatch(/no changed-file list/);
  });

  it("walks transitive dependents breadth-first without looping on cycles", () => {
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: ["a.ts"],
      dependents: {
        "a.ts": ["b.ts"],
        "b.ts": ["c.ts", "a.ts"],
        "c.ts": ["b.ts"],
      },
    });
    expect(scope.impactedFiles).toEqual(["b.ts", "c.ts"]);
  });

  it("keeps only knowledge items whose files intersect the scope", () => {
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: ["api/orders.ts"],
      knowledge: [
        { id: "knowledge/orders.yaml", files: ["api/orders.ts", "api/orders.test.ts"] },
        { id: "knowledge/billing.yaml", files: ["api/billing.ts"] },
      ],
    });
    expect(scope.knowledgeRefs).toEqual(["knowledge/orders.yaml"]);
  });

  it("carries task-graph impact through unchanged", () => {
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: ["a.ts"],
      affectedTaskIds: ["T2", "T3", "T2"],
      affectedPhases: [3, 2, 2],
    });
    expect(scope.affectedTaskIds).toEqual(["T2", "T3"]);
    expect(scope.affectedPhases).toEqual([2, 3]);
  });

  it("declares the scope unbounded past the file budget", () => {
    const changed = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: changed,
      maxFiles: 5,
    });
    expect(scope.bounded).toBe(false);
    expect(scope.unboundedReason).toMatch(/over the QA scope budget of 5/);
  });

  it("stays bounded exactly at the budget", () => {
    const changed = Array.from({ length: 5 }, (_, i) => `f${i}.ts`);
    expect(buildQaScope({ taskId: "T1", changedFiles: changed, maxFiles: 5 }).bounded).toBe(true);
  });

  it("does not count changed files as their own impact", () => {
    const scope = buildQaScope({
      taskId: "T1",
      changedFiles: ["a.ts"],
      dependents: { "a.ts": ["a.ts"] },
    });
    expect(scope.impactedFiles).toEqual([]);
  });
});

describe("renderQaScope", () => {
  it("renders the sections a QA prompt needs", () => {
    const lines = renderQaScope(
      buildQaScope({
        taskId: "T1",
        changedFiles: ["a.ts"],
        dependents: { "a.ts": ["b.ts"] },
        knowledge: [{ id: "k1", files: ["b.ts"] }],
        affectedPhases: [2],
        affectedTaskIds: ["T9"],
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).toContain("k1");
    expect(text).toContain("T9");
    expect(text).toContain("phases needing re-verification: 2");
    expect(text).not.toContain("SCOPE NOT BOUNDED");
  });

  it("marks an unbounded scope explicitly", () => {
    const text = renderQaScope(buildQaScope({ taskId: "T1", changedFiles: [] })).join("\n");
    expect(text).toContain("SCOPE NOT BOUNDED");
  });
});
