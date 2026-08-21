import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceRef } from "./knowledgeModel.js";
import { parseLocator } from "./sourceDigest.js";

export type SourceResolution =
  | { state: "resolved"; path: string }
  | { state: "external" | "unavailable" | "invalid"; reason: string };

function contained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Resolves a v2 source only inside its declared origin; never follows a locator outside that root. */
export function resolveSource(
  source: SourceRef,
  knowledgeRoot: string,
  targetPaths: ReadonlyMap<string, string> = new Map(),
): SourceResolution {
  const origin = source.origin ?? { root: "knowledge" as const, target_id: null };
  if (origin.root === "external") return { state: "external", reason: "external source has no local filesystem path" };
  const root = origin.root === "knowledge" ? knowledgeRoot : origin.target_id ? targetPaths.get(origin.target_id) : undefined;
  if (!root) return { state: "unavailable", reason: origin.root === "target" ? `Target source mapping is unavailable for ${origin.target_id ?? "(missing target_id)"}` : "Knowledge root is unavailable" };
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const locator = parseLocator(source.locator).file;
  if (path.isAbsolute(locator)) return { state: "invalid", reason: `absolute locator is not allowed: ${locator}` };
  const candidate = path.resolve(canonicalRoot, locator);
  if (!contained(candidate, canonicalRoot)) return { state: "invalid", reason: `locator escapes ${origin.root} root: ${source.locator}` };
  // A lexical check alone is bypassable through an in-root symlink/junction.
  // Resolve existing files before returning them to the digest reader.
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync.native(candidate);
    if (!contained(real, canonicalRoot)) return { state: "invalid", reason: `locator resolves outside ${origin.root} root: ${source.locator}` };
    return { state: "resolved", path: real };
  }
  return { state: "resolved", path: candidate };
}
