import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Provider-neutral helpers for OS permission profiles (V13 TASK-027/TASK-031).
 *
 * The Codex headless adapter and the Codex-sandbox-wrapped Claude Code adapter
 * render packet guards into the same native permission-profile shape, and the
 * a1 preflight re-derives those grants to prove them disjoint from the approval
 * channel. Adapters may not import one another, so the shared path logic lives here.
 */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Resolve junctions and symlinks, including the nearest existing parent of an absent channel. */
export function canonicalPath(input: string): string {
  const absolute = path.resolve(input);
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve existing ancestor of ${absolute}`);
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, absolute));
}

function normalizeGuardPattern(pattern: string): string {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`unsafe guard path pattern ${JSON.stringify(pattern)} — paths must be non-empty and workspace-relative`);
  }
  return normalized;
}

function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Native profiles (Codex's, and the Codex sandbox wrapping other runtimes) support exact read/write paths and a trailing `/**`, but not interior
 * read/write globs. Expand only wildcard directory segments that already
 * exist, retaining later literal segments so a role may create its owned file.
 */
export function permissionPathsFor(root: string, rawPattern: string): string[] {
  const pattern = normalizeGuardPattern(rawPattern);
  if (pattern === "**") return ["."];
  const trailingTree = pattern.endsWith("/**");
  const withoutTree = trailingTree ? pattern.slice(0, -3).replace(/\/$/, "") : pattern;
  if (!withoutTree.includes("*")) return [withoutTree || "."];

  const parts = withoutTree.split("/");
  const walk = (relative: string, index: number): string[] => {
    if (index >= parts.length) return [relative || "."];
    const segment = parts[index]!;
    if (!segment.includes("*")) {
      const next = relative ? `${relative}/${segment}` : segment;
      return walk(next, index + 1);
    }
    const absoluteParent = path.join(root, ...relative.split("/").filter(Boolean));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteParent, { withFileTypes: true });
    } catch {
      return [];
    }
    const matcher = segmentMatcher(segment);
    const needsDirectory = index < parts.length - 1 || trailingTree;
    return entries.flatMap((entry) => {
      if (!matcher.test(entry.name) || (needsDirectory && !entry.isDirectory())) return [];
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      return walk(next, index + 1);
    });
  };
  return [...new Set(walk("", 0))];
}
