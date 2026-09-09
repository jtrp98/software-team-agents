import { describe, expect, it } from "vitest";
import {
  buildTaskRetrievalQuery,
  parseRetrievalHint,
  MAX_RETRIEVAL_QUERY_IDS,
  MAX_RETRIEVAL_DESCRIPTION_CHARS,
  type RetrievalTaskFields,
} from "./retrievalQuery.js";

const TASK: RetrievalTaskFields = {
  id: "T-Q1",
  objective: "Add task-specific retrieval so DEV stops reading the whole module.",
  scopeAndConstraints: "Touch only orchestrator/src/context and orchestrator/src/runtime.",
  retrievalHints: "Hypothesis: The moduleName-only query is the bottleneck.\nQuery: Locate codeIntelSlices and its callers.\nProvenance: DES-011",
  traceability: ["REQ-011", "AC-011.1", "DES-011"],
  produces: ["Contract:Retrieval.v1"],
  consumes: [],
};

describe("parseRetrievalHint", () => {
  it("reads the Hypothesis/Query/Provenance triple", () => {
    const hint = parseRetrievalHint(TASK.retrievalHints);
    expect(hint).toEqual({
      hypothesis: "The moduleName-only query is the bottleneck.",
      query: "Locate codeIntelSlices and its callers.",
      provenanceIds: ["DES-011"],
    });
  });

  it("answers null rather than guessing when Hypothesis or Query is missing", () => {
    expect(parseRetrievalHint("Provenance: DES-011")).toBeNull();
    expect(parseRetrievalHint("Hypothesis: only one line")).toBeNull();
    expect(parseRetrievalHint("")).toBeNull();
  });
});

describe("buildTaskRetrievalQuery", () => {
  it("includes task-specific semantics: objective, Query hint, constraints, ids", () => {
    const query = buildTaskRetrievalQuery(TASK);
    expect(query.source).toBe("task");
    expect(query.description).toContain(TASK.objective);
    expect(query.description).toContain("Locate codeIntelSlices and its callers.");
    expect(query.description).toContain(TASK.scopeAndConstraints);
    expect(query.description).toContain("Related IDs: T-Q1, REQ-011, AC-011.1, DES-011, Contract:Retrieval.v1");
    expect(query.reason).toContain("T-Q1");
    expect(query.reason).toContain("PM's Query hint");
  });

  it("excludes fields not carried by this task — no other task's ids leak in", () => {
    const other: RetrievalTaskFields = { ...TASK, id: "T-Q2", traceability: ["REQ-999", "AC-999.1", "DES-999"], produces: [], consumes: [] };
    const query = buildTaskRetrievalQuery(other);
    expect(query.description).not.toContain("T-Q1");
    expect(query.description).not.toContain("REQ-011");
    expect(query.ids).toEqual(["T-Q2", "REQ-999", "AC-999.1", "DES-999"]);
  });

  it("orders ids task-id first, then traceability, produces, consumes, and deduplicates", () => {
    const dup: RetrievalTaskFields = { ...TASK, traceability: ["REQ-011", "REQ-011", "AC-011.1", "DES-011"], consumes: ["Contract:Retrieval.v1"] };
    const query = buildTaskRetrievalQuery(dup);
    expect(query.ids).toEqual(["T-Q1", "REQ-011", "AC-011.1", "DES-011", "Contract:Retrieval.v1"]);
  });

  it("includes changed files when supplied", () => {
    const query = buildTaskRetrievalQuery(TASK, { changedFiles: ["orchestrator/src/context/retrievalQuery.ts"] });
    expect(query.description).toContain("Changed files: orchestrator/src/context/retrievalQuery.ts");
    expect(query.changedFiles).toEqual(["orchestrator/src/context/retrievalQuery.ts"]);
  });

  it("truncates an oversized id list and names the truncation in reason, never silently", () => {
    const manyIds = Array.from({ length: MAX_RETRIEVAL_QUERY_IDS + 5 }, (_, i) => `REQ-${100 + i}`);
    const big: RetrievalTaskFields = { ...TASK, traceability: ["DES-011", ...manyIds] };
    const query = buildTaskRetrievalQuery(big);
    expect(query.ids.length).toBe(MAX_RETRIEVAL_QUERY_IDS);
    expect(query.reason).toContain("id(s) truncated");
  });

  it("truncates an oversized description and names it in reason", () => {
    const big: RetrievalTaskFields = { ...TASK, objective: "x".repeat(MAX_RETRIEVAL_DESCRIPTION_CHARS + 500) };
    const query = buildTaskRetrievalQuery(big);
    expect(query.description.length).toBe(MAX_RETRIEVAL_DESCRIPTION_CHARS);
    expect(query.reason).toContain("description text truncated");
  });

  it("falls back to the module name, visibly, when no task fields resolved", () => {
    const query = buildTaskRetrievalQuery(undefined, { moduleName: "billing" });
    expect(query.source).toBe("module-fallback");
    expect(query.description).toBe("billing");
    expect(query.reason).toContain("falling back to the module name");
    expect(query.ids).toEqual([]);
  });

  it("expands safely — names having nothing at all rather than an empty query passed off as normal", () => {
    const query = buildTaskRetrievalQuery(undefined, {});
    expect(query.source).toBe("module-fallback");
    expect(query.description).toBe("");
    expect(query.reason).toContain("neither canonical task fields nor a module name");
  });

  it("still constructs a task query when the Query hint does not parse — never fails closed", () => {
    const noHint: RetrievalTaskFields = { ...TASK, retrievalHints: "no structured hint here" };
    const query = buildTaskRetrievalQuery(noHint);
    expect(query.source).toBe("task");
    expect(query.description).toContain(TASK.objective);
    expect(query.reason).toContain("no parseable Query hint");
  });
});
