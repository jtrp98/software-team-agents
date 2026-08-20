import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * The published contract for `.workflow/state.yaml`, compiled once.
 *
 * The schema lives in a real `.json` file rather than as an object literal
 * here on purpose: it is meant to be readable by things that are not this
 * package — a dashboard, a CI check, another tool — and a contract that only
 * exists as TypeScript is not a contract anyone else can use. This module is
 * just the loader.
 *
 * Ajv (not zod) for exactly the same reason: the YAML/JSON artefacts on disk
 * are validated against JSON Schema, while values that never leave the process
 * keep using zod. Two tools, one rule for which is which.
 */

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "state-view.schema.json",
);

export function stateViewSchemaPath(): string {
  return SCHEMA_PATH;
}

export function loadStateViewSchema(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
}

export class StateViewSchemaError extends Error {
  constructor(public readonly issues: string[]) {
    super(`generated state view does not match its own schema:\n- ${issues.join("\n- ")}`);
    this.name = "StateViewSchemaError";
  }
}

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(loadStateViewSchema());
  }
  return compiled;
}

export function isValidStateView(doc: unknown): boolean {
  return validator()(doc) === true;
}

/**
 * Throws unless the document matches the schema. Called by the generator
 * before it writes: a view that violates its own published contract is a bug
 * to surface immediately, not a file to leave on disk for a reader to trip
 * over later.
 */
export function assertValidStateView(doc: unknown): void {
  const validate = validator();
  if (validate(doc)) return;
  const issues = (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
  throw new StateViewSchemaError(issues);
}
