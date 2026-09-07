import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import type { QaScope } from "../qa/scope.js";

/**
 * Reads `test-pyramid.yaml` — which test levels (unit/integration/api/e2e) a
 * kind of task requires by default, so `test-planner` and `qa-engineer`
 * stop deciding the same floor from scratch every time.
 *
 * Lives at the repo root, unclaimed by any `layout.yaml` concept — the same
 * tier as `project.yaml` and `layout.yaml` itself. It answers a project-wide
 * policy question. `runtimeVerificationFor()` is the execution entry point:
 * it turns the authored task-type floor into the RuntimeTask contract, and
 * falls back to the full deterministic order for unknown task types.
 */

export type TestLevel = "unit" | "integration" | "api" | "e2e";

export interface TaskTypePolicy {
  description: string;
  required_levels: TestLevel[];
  why?: string;
}

export interface TestPyramid {
  version: number;
  /** Ships warning-only by default. A project must explicitly opt in to enforcement. */
  enforcement?: "warn" | "enforce";
  task_types: Record<string, TaskTypePolicy>;
}

export type RuntimeVerificationLevel = TestLevel | "lint" | "typecheck" | "build";

/** Non-test mechanical checks remain the always-on deterministic baseline. */
export const ALWAYS_ON_VERIFICATION_LEVELS: readonly RuntimeVerificationLevel[] = [
  "lint",
  "typecheck",
  "build",
];

/** The level vocabulary the deterministic runner covers end-to-end. */
export const FULL_RUNTIME_VERIFICATION_LEVELS: readonly RuntimeVerificationLevel[] = [
  "lint",
  "typecheck",
  "unit",
  "integration",
  "build",
];

export interface RuntimeVerificationSelection {
  levels: RuntimeVerificationLevel[];
  enforcement: "warn" | "enforce";
  source: "test-pyramid" | "full-order";
  reason: string;
}

export type VerificationSelectionSource = "task-classification" | "change-scope" | "full-order";

export interface TaskAwareVerificationSelection extends RuntimeVerificationSelection {
  taskTypes: string[];
  selectionSource: VerificationSelectionSource;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "test-pyramid.schema.json",
);

export function testPyramidPath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(projectRoot, "test-pyramid.yaml");
}

export class TestPyramidError extends Error {
  constructor(public readonly issues: string[]) {
    super(`test-pyramid.yaml is not usable:\n- ${issues.join("\n- ")}`);
    this.name = "TestPyramidError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/** Reads and validates the file. Throws rather than returning a partly trusted policy — a half-read floor is worse than none. */
export function loadTestPyramid(projectRoot: string = defaultProjectRoot()): TestPyramid {
  const file = testPyramidPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new TestPyramidError([`no file at ${file}`]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new TestPyramidError([`file is not valid YAML: ${(e as Error).message}`]);
  }

  const validate = validator();
  if (!validate(parsed)) {
    throw new TestPyramidError((validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`));
  }
  return parsed as TestPyramid;
}

/** The required levels for one task type, or null when this file doesn't name it — an unclassified task type is a fact, not an error. */
export function requiredLevelsFor(taskType: string, pyramid: TestPyramid): TestLevel[] | null {
  return pyramid.task_types[taskType]?.required_levels ?? null;
}

/**
 * Execution-time selection for one RuntimeTask.
 *
 * `requiredLevelsFor()` is deliberately called here rather than re-reading the
 * YAML shape at a second call site. Unknown task types get the full
 * deterministic order. Known types keep lint/typecheck/build as the mechanical
 * baseline and add only their declared test levels; API/E2E remain visible
 * requirements even though runners for those levels are deliberately deferred.
 */
export function runtimeVerificationFor(
  taskType: string,
  pyramid: TestPyramid,
): RuntimeVerificationSelection {
  const required = requiredLevelsFor(taskType, pyramid);
  const enforcement = pyramid.enforcement ?? "warn";
  if (required === null) {
    return {
      levels: [...FULL_RUNTIME_VERIFICATION_LEVELS],
      enforcement,
      source: "full-order",
      reason: `task type "${taskType}" is absent from test-pyramid.yaml; preserving the historical full deterministic order`,
    };
  }

  const selected = new Set<RuntimeVerificationLevel>([
    ...ALWAYS_ON_VERIFICATION_LEVELS,
    ...required,
  ]);
  const order: readonly RuntimeVerificationLevel[] = [
    "lint",
    "typecheck",
    "unit",
    "integration",
    "api",
    "e2e",
    "build",
  ];
  return {
    levels: order.filter((level) => selected.has(level)),
    enforcement,
    source: "test-pyramid",
    reason: `selected from test-pyramid.yaml task type "${taskType}" with the always-on mechanical baseline`,
  };
}

function fullOrderSelection(
  enforcement: "warn" | "enforce",
  reason: string,
  taskTypes: readonly string[] = [],
): TaskAwareVerificationSelection {
  return {
    levels: [...FULL_RUNTIME_VERIFICATION_LEVELS],
    enforcement,
    source: "full-order",
    reason,
    taskTypes: [...new Set(taskTypes)].sort(),
    selectionSource: "full-order",
  };
}

export function runtimeVerificationForTaskTypes(
  taskTypes: readonly string[],
  pyramid: TestPyramid,
  selectionSource: Exclude<VerificationSelectionSource, "full-order">,
  reason: string,
): TaskAwareVerificationSelection {
  const uniqueTypes = [...new Set(taskTypes)].sort();
  const enforcement = pyramid.enforcement ?? "warn";
  if (uniqueTypes.length === 0) {
    return fullOrderSelection(
      enforcement,
      `${reason}; no test-pyramid task type resolved, preserving the historical full deterministic order`,
    );
  }

  const unknownTypes = uniqueTypes.filter((taskType) => requiredLevelsFor(taskType, pyramid) === null);
  if (unknownTypes.length > 0) {
    return fullOrderSelection(
      enforcement,
      `${reason}; unknown test-pyramid task type(s): ${unknownTypes.join(", ")}, preserving the historical full deterministic order`,
      uniqueTypes,
    );
  }

  const selected = new Set<RuntimeVerificationLevel>(ALWAYS_ON_VERIFICATION_LEVELS);
  for (const taskType of uniqueTypes) {
    for (const level of requiredLevelsFor(taskType, pyramid) ?? []) selected.add(level);
  }
  const order: readonly RuntimeVerificationLevel[] = [
    "lint",
    "typecheck",
    "unit",
    "integration",
    "api",
    "e2e",
    "build",
  ];
  return {
    levels: order.filter((level) => selected.has(level)),
    enforcement,
    source: "test-pyramid",
    reason: `${reason}; selected task type(s): ${uniqueTypes.join(", ")}`,
    taskTypes: uniqueTypes,
    selectionSource,
  };
}

function structuredTaskTypes(workflow: string, classification: Pick<ClassificationResult, "touchesSchema">): string[] {
  const taskTypes = new Set<string>();
  if (classification.touchesSchema) taskTypes.add("data-model-change");
  if (workflow === "business-rule") taskTypes.add("business-rule");
  return [...taskTypes];
}

export function runtimeVerificationForClassification(
  workflow: string,
  classification: Pick<ClassificationResult, "touchesSchema">,
  pyramid: TestPyramid,
): TaskAwareVerificationSelection {
  return runtimeVerificationForTaskTypes(
    structuredTaskTypes(workflow, classification),
    pyramid,
    "task-classification",
    `derived from structured classification for workflow "${workflow}"; workflow ids are routing identifiers, not test-pyramid task types`,
  );
}

function taskTypesForPath(
  rawPath: string,
  classification: Pick<ClassificationResult, "sensitiveGate">,
): string[] {
  const file = rawPath.replaceAll("\\", "/").toLowerCase();
  const taskTypes = new Set<string>();
  if (file.endsWith(".prisma") || /(^|\/)migrations?(\/|$)/.test(file)) {
    taskTypes.add("data-model-change");
  }
  if (/(^|\/)(api|routes?)(\/|$)/.test(file) || /\.(route|controller)\.[^.]+$/.test(file)) {
    taskTypes.add("api-endpoint");
  }
  if (
    /\.(tsx|jsx|vue|svelte)$/.test(file) ||
    (/(^|\/)(components?|pages?|ui)(\/|$)/.test(file) && /\.(ts|js)$/.test(file))
  ) {
    taskTypes.add("ui-component");
  }
  if (classification.sensitiveGate && /(^|\/)(auth|session)(\/|$)/.test(file)) {
    taskTypes.add("auth-flow");
  }
  return [...taskTypes];
}

export interface ChangeAwareVerificationInput {
  selection: RuntimeVerificationSelection;
  taskTypes?: readonly string[];
  workflow: string;
  classification: Pick<ClassificationResult, "sensitiveGate">;
  scope: QaScope;
  pyramid: TestPyramid | null;
  pyramidUnavailableReason?: string;
}

export function refineVerificationFromScope(input: ChangeAwareVerificationInput): TaskAwareVerificationSelection {
  if (!input.pyramid) {
    return fullOrderSelection(
      input.selection.enforcement,
      `test-pyramid policy unavailable; preserving the historical full deterministic order${input.pyramidUnavailableReason ? `: ${input.pyramidUnavailableReason}` : ""}`,
      input.taskTypes,
    );
  }
  if (!input.scope.bounded) {
    return fullOrderSelection(
      input.selection.enforcement,
      `change scope is unbounded (${input.scope.unboundedReason ?? "unknown reason"}); preserving the historical full deterministic order`,
      input.taskTypes,
    );
  }

  const taskTypes = new Set(input.taskTypes ?? []);
  const businessRuleCoversTask = taskTypes.has("business-rule") && input.workflow === "business-rule";
  const unresolvedChangedFiles: string[] = [];
  for (const file of input.scope.changedFiles) {
    const resolved = taskTypesForPath(file, input.classification);
    if (resolved.length === 0 && !businessRuleCoversTask) unresolvedChangedFiles.push(file);
    for (const taskType of resolved) taskTypes.add(taskType);
  }
  for (const file of input.scope.impactedFiles) {
    for (const taskType of taskTypesForPath(file, input.classification)) taskTypes.add(taskType);
  }

  if (unresolvedChangedFiles.length > 0 || taskTypes.size === 0) {
    const detail = unresolvedChangedFiles.length > 0
      ? `changed file(s) do not resolve to a test-pyramid task type: ${unresolvedChangedFiles.join(", ")}`
      : "no changed file or structured signal resolves to a test-pyramid task type";
    return fullOrderSelection(
      input.selection.enforcement,
      `${detail}; preserving the historical full deterministic order`,
      [...taskTypes],
    );
  }

  const refined = runtimeVerificationForTaskTypes(
    [...taskTypes],
    input.pyramid,
    "change-scope",
    `refined from bounded post-implementation change scope for workflow "${input.workflow}"`,
  );
  if (refined.source === "full-order") return refined;

  const floor = new Set(input.taskTypes?.length ? input.selection.levels : []);
  for (const level of refined.levels) floor.add(level);
  const order: readonly RuntimeVerificationLevel[] = [
    "lint",
    "typecheck",
    "unit",
    "integration",
    "api",
    "e2e",
    "build",
  ];
  return {
    ...refined,
    levels: order.filter((level) => floor.has(level)),
    reason: input.taskTypes?.length
      ? `${refined.reason}; retained the build-time task-type floor`
      : `${refined.reason}; no build-time task-type floor was available`,
  };
}

/** Every level named by at least one task type — the vocabulary `test-plan.md`'s `**Levels:**` lines actually draw from. */
export function allLevels(pyramid: TestPyramid): TestLevel[] {
  const levels = new Set<TestLevel>();
  for (const policy of Object.values(pyramid.task_types)) {
    for (const level of policy.required_levels) levels.add(level);
  }
  return [...levels];
}

export interface TestPyramidCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * The check `--check-test-pyramid` runs: the file parses and validates, and
 * every task type actually declares a floor worth reading (schema already
 * enforces non-empty `required_levels`; this catches the one thing schema
 * validation can't — a description too generic to tell two task types apart).
 */
export function checkTestPyramid(projectRoot: string = defaultProjectRoot()): TestPyramidCheckResult {
  let pyramid: TestPyramid;
  try {
    pyramid = loadTestPyramid(projectRoot);
  } catch (e) {
    return { ok: false, problems: e instanceof TestPyramidError ? e.issues : [String(e)] };
  }

  const problems: string[] = [];
  const seenDescriptions = new Map<string, string>();
  for (const [id, policy] of Object.entries(pyramid.task_types)) {
    const key = policy.description.trim().toLowerCase();
    const clash = seenDescriptions.get(key);
    if (clash) {
      problems.push(`"${id}" and "${clash}" have the same description — a floor nobody can tell apart from another is not a floor`);
    }
    seenDescriptions.set(key, id);
  }

  return { ok: problems.length === 0, problems };
}

export class TestPyramidMismatchError extends Error {
  constructor(public readonly problems: string[]) {
    super(`test-pyramid.yaml has problems:\n- ${problems.join("\n- ")}`);
    this.name = "TestPyramidMismatchError";
  }
}

export function assertTestPyramid(projectRoot: string = defaultProjectRoot()): void {
  const result = checkTestPyramid(projectRoot);
  if (!result.ok) throw new TestPyramidMismatchError(result.problems);
}
