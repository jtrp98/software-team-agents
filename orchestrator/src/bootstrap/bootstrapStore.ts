import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { knowledgeDir } from "../knowledge/knowledgeStore.js";
import { checkBootstrapState, type BootstrapState } from "./bootstrapModel.js";

/**
 * Read/write for `knowledge/_bootstrap/STATE.yaml`.
 *
 * Reserved directory, same reasoning as `_sources`/`_conflicts`:
 * `_bootstrap` is skipped by the knowledge item walk, because a folder of
 * process state and a folder of items are indistinguishable from the outside.
 * See knowledgeStore.ts's `RESERVED_DIRS`, which this module's caller must
 * keep `_bootstrap` registered in.
 */

export const BOOTSTRAP_DIRNAME = "_bootstrap";
export const BOOTSTRAP_FILENAME = "STATE.yaml";

export function bootstrapDir(projectRoot: string = defaultProjectRoot()): string {
  return path.join(knowledgeDir(projectRoot), BOOTSTRAP_DIRNAME);
}

export function bootstrapStatePath(projectRoot: string = defaultProjectRoot()): string {
  return path.join(bootstrapDir(projectRoot), BOOTSTRAP_FILENAME);
}

export class BootstrapStateError extends Error {
  constructor(public readonly issues: string[]) {
    super(`knowledge/${BOOTSTRAP_DIRNAME}/${BOOTSTRAP_FILENAME} is not a usable bootstrap state:\n- ${issues.join("\n- ")}`);
    this.name = "BootstrapStateError";
  }
}

export interface BootstrapStateReadResult {
  state: BootstrapState | null;
  /** true = the file exists but failed validation; state is null either way when problems is non-empty. */
  problems: string[];
}

/** null state + no problems = bootstrap has not started yet, the normal state for a brand-new project. */
export function readBootstrapState(projectRoot: string = defaultProjectRoot()): BootstrapStateReadResult {
  const filePath = bootstrapStatePath(projectRoot);
  if (!fs.existsSync(filePath)) return { state: null, problems: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { state: null, problems: [`could not read the file: ${(e as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return { state: null, problems: [`is not valid YAML: ${(e as Error).message}`] };
  }

  const problems = checkBootstrapState(parsed);
  if (problems.length > 0) return { state: null, problems };
  return { state: parsed as BootstrapState, problems: [] };
}

function render(state: BootstrapState): string {
  return stringifyYaml(state, { sortMapEntries: false });
}

/** Atomic temp+rename write, same pattern as knowledgeStore.ts's writeKnowledgeItem. */
export function writeBootstrapState(state: BootstrapState, projectRoot: string = defaultProjectRoot()): string {
  const problems = checkBootstrapState(state);
  if (problems.length > 0) throw new BootstrapStateError(problems);

  const filePath = bootstrapStatePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, render(state), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}
