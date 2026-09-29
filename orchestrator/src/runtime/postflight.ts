import * as fs from "node:fs";
import * as path from "node:path";
import { canWritePath, type PathRules } from "../agents/pathPermissions.js";
import { stableHash } from "../artifacts/executionPacket.js";

/**
 * V13 TASK-017 — STA's own post-run scope verification.
 *
 * A pre-tool guard hook is advice a runtime may or may not enforce; the one
 * check that cannot be skipped is STA re-reading the workspace after the run
 * and deciding, from the files that actually changed, whether the attempt
 * stayed inside the scope it was granted. A runtime's self-report — exit
 * status, "done" text, a guard verdict in its envelope — is never the reason
 * an out-of-scope change is accepted; this check is.
 *
 * The changed-file list comes from the executor port's evidence (the adapter's
 * own pre/post snapshots over the granted roots — read-only git inspection,
 * never the agent's account of its work). What STA adds here is the decision:
 *
 *   1. every changed file must resolve inside one of the roots this attempt
 *      was granted — textually (no `../`) and through the filesystem's real
 *      path, so a symlink pointing outside the root is a violation, and
 *   2. every changed file must pass the same `canWritePath` rules the
 *      dispatch preflight compiled from the contract — universal deny, the
 *      framework payload, the role's deny list, and allow-list only, and
 *   3. a root granted read-only must not change at all.
 *
 * Deny is the default: a file that cannot be attributed to a granted root, or
 * that no allow pattern covers, is a violation. A check that cannot run is the
 * caller's "missing required check" — this module only ever grades files it
 * was actually handed.
 */

/** One snapshot root — the shape `captureChangeSetFingerprint` namespaces by `targetId`. */
export interface PostflightRoot {
  readonly targetId?: string;
  readonly path: string;
  readonly access: "read" | "write";
}

export interface PostflightScopeInput {
  /** The role that ran — violation lines name it. */
  readonly role: string;
  /** The roots this attempt was granted, exactly as the request carried them. */
  readonly roots: readonly PostflightRoot[];
  /** Files the snapshots say changed, in the port evidence's namespaced form. */
  readonly changedFiles: readonly string[];
  /** The enforced write rules for this stage (contract + stack layout + floor). */
  readonly rules: Pick<PathRules, "write" | "deny">;
  /**
   * Resolves a path's real location for the symlink-escape check. Injectable
   * so tests can force an escape; production uses `fs.realpathSync`.
   */
  readonly resolveReal?: (absPath: string) => string;
  /** Whether the changed path still exists (deleted files skip the realpath check). Injectable for tests. */
  readonly fileExists?: (absPath: string) => boolean;
}

export interface PostflightScopeResult {
  readonly ok: boolean;
  /** How many changed files were graded. */
  readonly checked: number;
  /** One line per violation; empty exactly when `ok`. */
  readonly violations: readonly string[];
  /** sha256 over the graded inputs and verdicts — what the persisted evidence digests. */
  readonly digest: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function defaultResolveReal(absPath: string): string {
  return fs.realpathSync(absPath);
}

function defaultFileExists(absPath: string): boolean {
  try {
    fs.statSync(absPath);
    return true;
  } catch {
    return false;
  }
}

export function verifyChangedFilesScope(input: PostflightScopeInput): PostflightScopeResult {
  const resolveReal = input.resolveReal ?? defaultResolveReal;
  const fileExists = input.fileExists ?? defaultFileExists;
  const roots = input.roots.map((root) => ({ ...root, path: path.resolve(root.path) }));
  const violations: string[] = [];
  const graded: Array<{ file: string; verdict: string }> = [];

  for (const changed of [...input.changedFiles].sort()) {
    let verdict = "allowed";
    // Multi-root evidence namespaces each file by its root's targetId
    // (`captureChangeSetFingerprint`'s convention); a single root's files are bare.
    let root: PostflightRoot | undefined;
    let relative: string | undefined;
    if (roots.length === 1) {
      root = roots[0];
      relative = changed;
    } else {
      const separator = changed.indexOf(":");
      const namespace = separator === -1 ? null : changed.slice(0, separator);
      const candidate = namespace === null ? undefined : roots.find((entry) => entry.targetId === namespace);
      if (!candidate || namespace === null) {
        verdict = `changed file "${changed}" cannot be attributed to any granted work root`;
      } else {
        root = candidate;
        relative = changed.slice(separator + 1);
      }
    }

    if (root && relative !== undefined) {
      const absolute = path.resolve(root.path, relative);
      // Textual escape first: a relative path that climbs out of its root is a
      // violation even before the filesystem is asked anything.
      if (!inside(path.resolve(root.path), absolute)) {
        verdict = `changed path "${relative}" escapes its granted root`;
      } else if (root.access === "read") {
        verdict = `read-only root "${root.targetId ?? root.path}" changed: ${relative}`;
      } else {
        if (fileExists(absolute)) {
          try {
            const real = resolveReal(absolute);
            if (!inside(path.resolve(root.path), real)) {
              verdict = `changed path "${relative}" resolves outside its granted root (symlink escape)`;
            }
          } catch {
            verdict = `cannot resolve the real path of changed file "${relative}" — the check is not answered, so the write is refused`;
          }
        }
        if (verdict === "allowed") {
          const decision = canWritePath({ ...input.rules, read: [] }, relative.replaceAll("\\", "/"));
          if (!decision.allowed) verdict = decision.reason;
        }
      }
    }
    graded.push({ file: changed, verdict });
    if (verdict !== "allowed") {
      violations.push(`${input.role} postflight: ${verdict}`);
    }
  }

  return {
    ok: violations.length === 0,
    checked: graded.length,
    violations,
    digest: stableHash({ files: graded }),
  };
}
