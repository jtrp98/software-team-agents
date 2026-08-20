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
  requiredLevelsFor,
  testPyramidPath,
} from "./testPyramid.js";

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
