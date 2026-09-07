import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TestPyramidError,
  TestPyramidMismatchError,
  allLevels,
  assertTestPyramid,
  checkTestPyramid,
  loadTestPyramid,
  refineVerificationFromScope,
  requiredLevelsFor,
  runtimeVerificationFor,
  runtimeVerificationForClassification,
  runtimeVerificationForTaskTypes,
  testPyramidPath,
} from "./testPyramid.js";
import { buildQaScope } from "../qa/scope.js";

function fixtureRoot(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pyramid-"));
  fs.writeFileSync(path.join(root, "test-pyramid.yaml"), content, "utf8");
  return root;
}

const VALID_YAML = `
version: 1
task_types:
  api-endpoint:
    description: A new or changed REST route.
    required_levels: [unit, api]
  ui-component:
    description: A new or changed frontend component.
    required_levels: [unit]
`;

const CHANGE_AWARE_YAML = `
version: 1
task_types:
  api-endpoint:
    description: A new or changed REST route.
    required_levels: [unit, api]
  data-model-change:
    description: A new or changed database model.
    required_levels: [integration]
  business-rule:
    description: A changed domain rule.
    required_levels: [unit]
  auth-flow:
    description: A changed authentication flow.
    required_levels: [unit, integration, api]
  ui-component:
    description: A changed UI component.
    required_levels: [unit]
`;

describe("the shipped test-pyramid.yaml", () => {
  it("loads and validates against the schema", () => {
    const pyramid = loadTestPyramid();
    expect(pyramid.version).toBe(1);
    expect(Object.keys(pyramid.task_types).length).toBeGreaterThan(0);
  });

  it("passes --check-test-pyramid", () => {
    const result = checkTestPyramid();
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(() => assertTestPyramid()).not.toThrow();
  });

  it("declares a floor for the auth-flow task type, at more than one level", () => {
    const pyramid = loadTestPyramid();
    const levels = requiredLevelsFor("auth-flow", pyramid);
    expect(levels).not.toBeNull();
    expect(levels!.length).toBeGreaterThan(1);
  });
});

describe("loadTestPyramid", () => {
  it("reads a well-formed file", () => {
    const root = fixtureRoot(VALID_YAML);
    const pyramid = loadTestPyramid(root);
    expect(pyramid.task_types["api-endpoint"].required_levels).toEqual(["unit", "api"]);
  });

  it("throws when the file doesn't exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pyramid-empty-"));
    expect(() => loadTestPyramid(root)).toThrow(TestPyramidError);
  });

  it("throws on invalid YAML", () => {
    const root = fixtureRoot("version: 1\ntask_types: [this is not a map");
    expect(() => loadTestPyramid(root)).toThrow(TestPyramidError);
  });

  it("rejects a task type with an unknown level", () => {
    const root = fixtureRoot(`
version: 1
task_types:
  weird:
    description: something
    required_levels: [smoke]
`);
    expect(() => loadTestPyramid(root)).toThrow(TestPyramidError);
  });

  it("rejects an empty required_levels array", () => {
    const root = fixtureRoot(`
version: 1
task_types:
  weird:
    description: something
    required_levels: []
`);
    expect(() => loadTestPyramid(root)).toThrow(TestPyramidError);
  });

  it("resolves testPyramidPath under the given root", () => {
    const root = fixtureRoot(VALID_YAML);
    expect(testPyramidPath(root)).toBe(path.join(root, "test-pyramid.yaml"));
  });
});

describe("requiredLevelsFor", () => {
  it("returns null for a task type the file doesn't name", () => {
    const pyramid = loadTestPyramid(fixtureRoot(VALID_YAML));
    expect(requiredLevelsFor("ghost-type", pyramid)).toBeNull();
  });
});

describe("runtimeVerificationFor", () => {
  it("selects a known task type plus the always-on mechanical baseline", () => {
    const pyramid = loadTestPyramid(fixtureRoot(VALID_YAML));
    expect(runtimeVerificationFor("ui-component", pyramid)).toEqual({
      levels: ["lint", "typecheck", "unit", "build"],
      enforcement: "warn",
      source: "test-pyramid",
      reason: expect.stringContaining("ui-component"),
    });
  });

  it("preserves the historical full order for an unknown task type", () => {
    const pyramid = loadTestPyramid(fixtureRoot(VALID_YAML));
    expect(runtimeVerificationFor("ghost-type", pyramid)).toMatchObject({
      levels: ["lint", "typecheck", "unit", "integration", "build"],
      enforcement: "warn",
      source: "full-order",
    });
  });

  it("makes enforcement reachable only through an explicit policy value", () => {
    const pyramid = loadTestPyramid(fixtureRoot(VALID_YAML.replace("version: 1", "version: 1\nenforcement: enforce")));
    expect(runtimeVerificationFor("ui-component", pyramid).enforcement).toBe("enforce");
  });
});

describe("change-aware runtime verification", () => {
  it("uses canonical task types from structured classification instead of workflow ids", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const schema = runtimeVerificationForClassification("schema-change", { touchesSchema: true }, pyramid);
    expect(schema).toMatchObject({
      levels: ["lint", "typecheck", "integration", "build"],
      taskTypes: ["data-model-change"],
      selectionSource: "task-classification",
    });

    const businessRule = runtimeVerificationForClassification("business-rule", {}, pyramid);
    expect(businessRule).toMatchObject({
      levels: ["lint", "typecheck", "unit", "build"],
      taskTypes: ["business-rule"],
      selectionSource: "task-classification",
    });

    const unresolved = runtimeVerificationForClassification("bugfix", {}, pyramid);
    expect(unresolved).toMatchObject({
      levels: ["lint", "typecheck", "unit", "integration", "build"],
      source: "full-order",
      taskTypes: [],
    });
    expect(unresolved.reason).toContain("workflow ids are routing identifiers");
  });

  it("selects levels from a bounded post-implementation change scope", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const selection = runtimeVerificationForClassification("bugfix", {}, pyramid);
    const refined = refineVerificationFromScope({
      selection,
      taskTypes: selection.taskTypes,
      workflow: "bugfix",
      classification: { sensitiveGate: false },
      scope: buildQaScope({ taskId: "T1", changedFiles: ["src/routes/orders.route.ts"] }),
      pyramid,
    });
    expect(refined).toMatchObject({
      levels: ["lint", "typecheck", "unit", "api", "build"],
      source: "test-pyramid",
      taskTypes: ["api-endpoint"],
      selectionSource: "change-scope",
    });
  });

  it("never lets change scope weaken an existing task-type floor", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const floor = runtimeVerificationForTaskTypes(
      ["auth-flow"],
      pyramid,
      "task-classification",
      "fixture floor",
    );
    const refined = refineVerificationFromScope({
      selection: floor,
      taskTypes: floor.taskTypes,
      workflow: "security-fix",
      classification: { sensitiveGate: true },
      scope: buildQaScope({ taskId: "T1", changedFiles: ["src/components/Login.tsx"] }),
      pyramid,
    });
    expect(refined.levels).toEqual(["lint", "typecheck", "unit", "integration", "api", "build"]);
    expect(refined.taskTypes).toEqual(["auth-flow", "ui-component"]);
    expect(refined.reason).toContain("retained the build-time task-type floor");
  });

  it("keeps full order when scope is unbounded", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const selection = runtimeVerificationForClassification("bugfix", {}, pyramid);
    const refined = refineVerificationFromScope({
      selection,
      workflow: "bugfix",
      classification: { sensitiveGate: false },
      scope: buildQaScope({ taskId: "T1", changedFiles: ["src/routes/orders.ts"], maxFiles: 0 }),
      pyramid,
    });
    expect(refined).toMatchObject({
      source: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
    });
    expect(refined.reason).toContain("unbounded");
  });

  it("keeps full order when a changed file has no known task type", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const selection = runtimeVerificationForClassification("refactor", {}, pyramid);
    const refined = refineVerificationFromScope({
      selection,
      workflow: "refactor",
      classification: { sensitiveGate: false },
      scope: buildQaScope({ taskId: "T1", changedFiles: ["src/domain/cache.ts"] }),
      pyramid,
    });
    expect(refined).toMatchObject({
      source: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
    });
    expect(refined.reason).toContain("do not resolve");
  });

  it("keeps full order when the pyramid is unavailable", () => {
    const pyramid = loadTestPyramid(fixtureRoot(CHANGE_AWARE_YAML));
    const selection = runtimeVerificationForClassification("bugfix", {}, pyramid);
    const refined = refineVerificationFromScope({
      selection,
      workflow: "bugfix",
      classification: { sensitiveGate: false },
      scope: buildQaScope({ taskId: "T1", changedFiles: ["src/routes/orders.ts"] }),
      pyramid: null,
      pyramidUnavailableReason: "fixture missing",
    });
    expect(refined).toMatchObject({
      source: "full-order",
      levels: ["lint", "typecheck", "unit", "integration", "build"],
    });
    expect(refined.reason).toContain("fixture missing");
  });
});

describe("allLevels", () => {
  it("collects the union of every declared level, deduped", () => {
    const pyramid = loadTestPyramid(fixtureRoot(VALID_YAML));
    expect(allLevels(pyramid).sort()).toEqual(["api", "unit"]);
  });
});

describe("checkTestPyramid", () => {
  it("fails when two task types share a description", () => {
    const root = fixtureRoot(`
version: 1
task_types:
  a:
    description: Same thing.
    required_levels: [unit]
  b:
    description: Same thing.
    required_levels: [api]
`);
    const result = checkTestPyramid(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("same description");
  });

  it("reports the underlying load error when the file is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pyramid-missing-"));
    const result = checkTestPyramid(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("no file at");
  });

  it("throws TestPyramidMismatchError from assertTestPyramid on a broken file", () => {
    const root = fixtureRoot(`
version: 1
task_types:
  a:
    description: Same thing.
    required_levels: [unit]
  b:
    description: Same thing.
    required_levels: [api]
`);
    expect(() => assertTestPyramid(root)).toThrow(TestPyramidMismatchError);
  });
});
