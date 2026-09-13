import * as path from "node:path";
import { readModuleDoc, resolveModule } from "../agents/moduleDocs.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { parseModuleTargets } from "../docs/moduleTargets.js";
import { loadLocalTargetMapping, localTargetsPath } from "./localTargets.js";
import { loadTargetRegistry, targetById, targetsPath, type TargetEntry } from "./targets.js";

export type ModuleTargetProblemSeverity = "note" | "warning" | "error";

export interface ModuleTargetProblem {
  severity: ModuleTargetProblemSeverity;
  message: string;
}

export interface ResolvedModuleTarget {
  target_id: string;
  registryEntry: TargetEntry;
  localPath: string | null;
}

export interface ModuleTargetResolution {
  module: string;
  designPath: string;
  declaredTargetIds: string[];
  targets: ResolvedModuleTarget[];
  /** Notes and warnings are kept beside blocking errors so every resolution outcome is observable. */
  problems: ModuleTargetProblem[];
}

export interface ResolveModuleTargetsOptions {
  /** Framework root used by the canonical local-mapping loader's overlap checks. */
  frameworkRoot?: string;
}

/**
 * Resolves one module's authored `## Targets` declaration without preparing an
 * execution. Registry and local-path semantics stay owned by their canonical
 * loaders; declaration-only local failures are warnings because mappings are
 * machine-local.
 */
export function resolveModuleTargets(
  moduleName: string,
  docsRoot: string,
  options: ResolveModuleTargetsOptions = {},
): ModuleTargetResolution {
  const designPath = path.join(docsRoot, "_docs", "module", moduleName, "design.md");
  const result: ModuleTargetResolution = {
    module: moduleName,
    designPath,
    declaredTargetIds: [],
    targets: [],
    problems: [],
  };

  const moduleResolution = resolveModule(docsRoot, moduleName);
  if (moduleResolution.status !== "one") {
    result.problems.push({
      severity: "error",
      message: `module "${moduleName}" does not resolve under ${path.join(docsRoot, "_docs", "module")} — create its requirement.md or design.md, or correct the module name`,
    });
    return result;
  }

  const design = readModuleDoc(docsRoot, moduleName, "design.md");
  if (design === null) {
    result.problems.push({
      severity: "note",
      message: `module "${moduleName}" has no design.md at ${designPath}; it has no declared Targets to resolve`,
    });
    return result;
  }

  const declaration = parseModuleTargets(design);
  result.declaredTargetIds = declaration.ids;
  for (const grammarProblem of declaration.problems) {
    result.problems.push({ severity: "error", message: `${designPath}: ${grammarProblem}` });
  }
  for (const duplicate of declaration.duplicates) {
    result.problems.push({
      severity: "error",
      message: `Target "${duplicate}" is duplicated in ${designPath} — remove the duplicate declaration`,
    });
  }
  if (declaration.ids.length === 0) {
    result.problems.push({
      severity: "note",
      message: declaration.present
        ? `module "${moduleName}" declares no Targets in ${designPath}; it remains unscoped`
        : `module "${moduleName}" has no ## Targets section in ${designPath}; it remains unscoped`,
    });
    return result;
  }

  let registry;
  try {
    registry = loadTargetRegistry(docsRoot);
  } catch (error) {
    result.problems.push({
      severity: "error",
      message: `cannot resolve module "${moduleName}" against ${targetsPath(docsRoot)}: ${error instanceof Error ? error.message : String(error)} — create or fix the Target registry`,
    });
    return result;
  }

  let localById: Map<string, string> | null = null;
  try {
    localById = new Map(
      loadLocalTargetMapping(docsRoot, registry, options.frameworkRoot ?? defaultProjectRoot()).map((entry) => [
        entry.target_id,
        entry.path,
      ]),
    );
  } catch (error) {
    result.problems.push({
      severity: "warning",
      message: `cannot load machine-local mapping for declared Target id(s) ${declaration.ids.join(", ")} from ${localTargetsPath(docsRoot)}: ${error instanceof Error ? error.message : String(error)} — create or fix that file on this machine`,
    });
  }

  for (const targetId of declaration.ids) {
    let registryEntry: TargetEntry;
    try {
      registryEntry = targetById(registry, targetId);
    } catch {
      result.problems.push({
        severity: "error",
        message: `Target "${targetId}" declared by module "${moduleName}" is not present in ${targetsPath(docsRoot)} — add the id to the registry or remove it from ${designPath}`,
      });
      continue;
    }

    if (registryEntry.status === "retired") {
      result.problems.push({
        severity: "error",
        message: `Target "${targetId}" is retired — reactivate it before using module "${moduleName}"`,
      });
    }
    const localPath = localById?.get(targetId) ?? null;
    if (localById !== null && localPath === null) {
      result.problems.push({
        severity: "warning",
        message: `Target "${targetId}" has no local path mapping — add it to ${localTargetsPath(docsRoot)}`,
      });
    }
    result.targets.push({ target_id: targetId, registryEntry, localPath });
  }

  return result;
}
