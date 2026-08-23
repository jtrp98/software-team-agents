import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultInstallationConfigPath, loadInstallationConfig } from "../threeRepo/installation.js";

/**
 * T-TARGET-01 / T-TARGET-02 — the root model for Target-first execution.
 *
 * Three roots, three responsibilities, never one standing in for another:
 *
 *   targetRoot     the repository being developed; `process.cwd()` by
 *                  definition. Every write an agent makes lands here.
 *   frameworkRoot  where this CLI is installed (a dev checkout of this repo,
 *                  or the installed npm package). Read-only source of truth.
 *   knowledgeRoot  optional shared Knowledge repository, bound machine-wide
 *                  via installation.yaml. Read-only context dependency.
 *
 * Nothing in this module may assume cwd === frameworkRoot: that assumption is
 * exactly what T-TARGET-22 removes. The framework root is resolved from this
 * module's own on-disk location (walk up until a `templates/manifest.json`
 * shows up), so it works identically in a checkout and under node_modules.
 */

export class TargetDetectionError extends Error {}

export interface Roots {
  targetRoot: string;
  frameworkRoot: string;
  /** Absent when no installation binding exists — Knowledge is always optional. */
  knowledgeRoot?: string;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks up from `fromDir` looking for the package root — the directory that
 * holds `templates/manifest.json`. In a dev checkout that is the repo root;
 * in an installed package it is the package directory itself. The walk is the
 * whole point: no caller ever names the framework root explicitly, because a
 * hardcoded path would break one of the two shapes.
 */
export function resolveFrameworkRoot(fromDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let cursor = path.resolve(fromDir);
  for (;;) {
    if (fs.existsSync(path.join(cursor, "templates", "manifest.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new TargetDetectionError(
    "cannot locate the Framework installation: no templates/manifest.json found above " +
      `${path.resolve(fromDir)}. Reinstall the software-team-agents package (or run npm run build:templates in a dev checkout).`,
  );
}

/**
 * Standalone-repo check for a Target, mirroring installation.ts's rule:
 * a directory-form `.git` with no `commondir`. Linked worktrees share metadata
 * with another checkout and cannot be an authority root. Inspected locally —
 * invoking git here would create the very policy violation the runtime guard
 * forbids.
 */
export type TargetVerdict = { ok: true; targetRoot: string } | { ok: false; problem: string };

export function validateTargetRoot(candidate: string): TargetVerdict {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved) || !isDirectory(resolved)) {
    return { ok: false, problem: `"${candidate}" is not an existing directory — cd into your project first (or pass --target-root <path>)` };
  }
  const canonical = (() => {
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  })();
  const gitMarker = path.join(canonical, ".git");
  if (!fs.existsSync(gitMarker)) {
    return {
      ok: false,
      problem:
        `"${canonical}" is not a Git repository — a Target must be real, versioned source code. ` +
        "Run `git init` in your project, then re-run this command.",
    };
  }
  if (!fs.statSync(gitMarker).isDirectory()) {
    return { ok: false, problem: `"${canonical}" is a Git linked worktree; point --target-root at a standalone repository instead` };
  }
  if (fs.existsSync(path.join(gitMarker, "commondir"))) {
    return { ok: false, problem: `"${canonical}" uses shared Git metadata and is not a standalone repository` };
  }
  return { ok: true, targetRoot: canonical };
}

/** True when `candidate` is the Framework root itself or lives inside it — the pollution guard (T-TARGET-17). */
export function isInsideFrameworkRoot(candidate: string, frameworkRoot: string): boolean {
  const target = path.resolve(candidate);
  const framework = path.resolve(frameworkRoot);
  return target === framework || target.startsWith(`${framework}${path.sep}`);
}

/**
 * Resolves all three roots for a run. `targetRootInput` defaults to
 * process.cwd() — Target-first means the user's shell decides the Target.
 */
export function resolveRoots(options: { targetRoot?: string; frameworkRootFrom?: string } = {}): Roots {
  const frameworkRoot = resolveFrameworkRoot(options.frameworkRootFrom);
  const candidate = options.targetRoot ?? process.cwd();
  const verdict = validateTargetRoot(candidate);
  if (!verdict.ok) throw new TargetDetectionError(verdict.problem);
  if (isInsideFrameworkRoot(verdict.targetRoot, frameworkRoot)) {
    throw new TargetDetectionError(
      `"${verdict.targetRoot}" is inside the Framework installation (${frameworkRoot}). ` +
        "Source code never lives in the Framework — cd into your project repository and re-run.",
    );
  }
  const roots: Roots = { targetRoot: verdict.targetRoot, frameworkRoot };
  try {
    roots.knowledgeRoot = loadInstallationConfig(defaultInstallationConfigPath()).knowledge_root;
  } catch {
    // No installation binding yet — Knowledge stays optional by design.
  }
  return roots;
}
