import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { type TargetRegistry, TargetRegistryError, targetById } from "./targets.js";
import { assertStandaloneRepositoryRoot } from "./installation.js";

export interface LocalTargetMapping { schema_version: 1; targets: Record<string, { path: string }>; }
export interface ResolvedLocalTarget { target_id: string; path: string; }
export class LocalTargetMappingError extends Error {}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "targets-local.schema.json");
let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}
export function localTargetsPath(knowledgeRoot: string): string { return path.join(knowledgeRoot, ".workflow", "targets.local.yaml"); }
function isSameOrNested(candidate: string, root: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

export function loadLocalTargetMapping(knowledgeRoot: string, registry: TargetRegistry, frameworkRoot: string): ResolvedLocalTarget[] {
  const file = localTargetsPath(knowledgeRoot);
  let parsed: unknown;
  try { parsed = parseYaml(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new LocalTargetMappingError(`cannot read local Target mapping ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const validate = validator();
  if (!validate(parsed)) throw new LocalTargetMappingError(`local Target mapping is invalid: ${(validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")}`);
  const mapping = parsed as LocalTargetMapping;
  const knowledgeCanonical = fs.realpathSync.native(path.resolve(knowledgeRoot));
  const frameworkCanonical = fs.realpathSync.native(path.resolve(frameworkRoot));
  const resolved: ResolvedLocalTarget[] = [];
  for (const [targetId, entry] of Object.entries(mapping.targets)) {
    try { targetById(registry, targetId); } catch (error) { throw new LocalTargetMappingError(error instanceof TargetRegistryError ? error.message : String(error)); }
    const candidate = path.resolve(entry.path);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new LocalTargetMappingError(`Target "${targetId}" path "${entry.path}" is not an existing directory`);
    let canonical: string;
    try {
      canonical = assertStandaloneRepositoryRoot(candidate, `Target "${targetId}"`);
    } catch (error) {
      throw new LocalTargetMappingError(error instanceof Error ? error.message : String(error));
    }
    if (isSameOrNested(canonical, knowledgeCanonical) || isSameOrNested(knowledgeCanonical, canonical)) throw new LocalTargetMappingError(`Target "${targetId}" path overlaps Knowledge root`);
    if (isSameOrNested(canonical, frameworkCanonical) || isSameOrNested(frameworkCanonical, canonical)) throw new LocalTargetMappingError(`Target "${targetId}" path overlaps Framework root`);
    const conflict = resolved.find((other) => isSameOrNested(canonical, other.path) || isSameOrNested(other.path, canonical));
    if (conflict) throw new LocalTargetMappingError(`Target "${targetId}" path overlaps Target "${conflict.target_id}"`);
    resolved.push({ target_id: targetId, path: canonical });
  }
  return resolved;
}
