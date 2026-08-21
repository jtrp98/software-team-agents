import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type TargetStatus = "active" | "retired";
export interface TargetEntry { target_id: string; name: string; remote_url: string; status: TargetStatus; }
export interface TargetRegistry { schema_version: 1; targets: TargetEntry[]; }
export class TargetRegistryError extends Error {}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "targets.schema.json");
let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}
export function targetsPath(knowledgeRoot: string): string { return path.join(knowledgeRoot, "targets.yaml"); }

export function loadTargetRegistry(knowledgeRoot: string): TargetRegistry {
  const file = targetsPath(knowledgeRoot);
  let parsed: unknown;
  try { parsed = parseYaml(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new TargetRegistryError(`cannot read Target registry ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const validate = validator();
  if (!validate(parsed)) throw new TargetRegistryError(`Target registry is invalid: ${(validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`);
  const registry = parsed as TargetRegistry;
  const duplicates = registry.targets.filter((entry, index) => registry.targets.findIndex((candidate) => candidate.target_id === entry.target_id) !== index).map((entry) => entry.target_id);
  if (duplicates.length) throw new TargetRegistryError(`Target registry has duplicate target_id values: ${[...new Set(duplicates)].join(", ")}`);
  for (const target of registry.targets) {
    if (!target.name.trim()) throw new TargetRegistryError(`Target "${target.target_id}" name must not be blank`);
    if (!isCredentialFreeGitRemote(target.remote_url)) {
      throw new TargetRegistryError(`Target "${target.target_id}" remote_url must be a credential-free Git remote URL`);
    }
  }
  return registry;
}

/** The only registry writer used by administrative commands.  It reads the
 * previous registry first so an existing target's identity cannot be replaced. */
export function writeTargetRegistry(knowledgeRoot: string, next: TargetRegistry): void {
  const validate = validator();
  if (!validate(next)) throw new TargetRegistryError(`Target registry is invalid: ${(validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`);
  const file = targetsPath(knowledgeRoot);
  if (fs.existsSync(file)) assertTargetIdsImmutable(loadTargetRegistry(knowledgeRoot), next);
  for (const target of next.targets) {
    if (!target.name.trim() || !isCredentialFreeGitRemote(target.remote_url)) {
      throw new TargetRegistryError(`Target "${target.target_id}" has an invalid name or credential-bearing remote_url`);
    }
  }
  fs.writeFileSync(file, stringifyYaml(next, { sortMapEntries: false }), "utf8");
}

function isCredentialFreeGitRemote(value: string): boolean {
  if (/^(https?|ssh):\/\/[^/\s@]+@/i.test(value) || /[?&](token|access_token|password)=/i.test(value)) return false;
  return /^(https?:\/\/[^\s/]+\/[^\s]+|ssh:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/i.test(value);
}

export function targetById(registry: TargetRegistry, targetId: string): TargetEntry {
  const target = registry.targets.find((entry) => entry.target_id === targetId);
  if (!target) throw new TargetRegistryError(`unknown Target "${targetId}"`);
  return target;
}

export function assertTargetCanStartNewTask(registry: TargetRegistry, targetId: string): TargetEntry {
  const target = targetById(registry, targetId);
  if (target.status === "retired") throw new TargetRegistryError(`Target "${targetId}" is retired and cannot be used for a new task`);
  return target;
}

export function assertTargetIdsImmutable(previous: TargetRegistry, next: TargetRegistry): void {
  const afterById = new Map(next.targets.map((target) => [target.target_id, target]));
  for (const before of previous.targets) {
    const after = afterById.get(before.target_id);
    if (!after) throw new TargetRegistryError(`immutable Target "${before.target_id}" cannot be deleted; set status to retired instead`);
    if (after.remote_url !== before.remote_url) {
      throw new TargetRegistryError(`Target "${before.target_id}" remote_url is immutable after creation`);
    }
  }
  const previousByRemote = new Map(previous.targets.map((target) => [target.remote_url, target]));
  for (const target of next.targets) {
    const before = previousByRemote.get(target.remote_url);
    if (before && before.target_id !== target.target_id) throw new TargetRegistryError(`Target remote "${target.remote_url}" changed immutable target_id from "${before.target_id}" to "${target.target_id}"`);
  }
}
