import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_STA_SCHEMA_VERSION, installManifestPath, readInstallManifest } from "./installManifest.js";

/**
 * T96 — the engine that carries a project's `.sta/` state across a *breaking*
 * change to the manifest's own shape (as opposed to T95's `upgrade`, which
 * only ever replaces file content — same shape, new bytes).
 *
 * There are no migrations registered yet: `.sta/manifest.json` has had
 * exactly one shape (`schema_version: 1`) since T94 defined it. This module
 * exists so the *mechanism* is proven before it is ever needed under
 * pressure — `migrateSta` walks `STA_MIGRATIONS` from a project's recorded
 * `schema_version` to `CURRENT_STA_SCHEMA_VERSION`, one step at a time, and
 * a project already on the latest version is simply a zero-length walk. The
 * day a real breaking change lands, its step gets appended to
 * `STA_MIGRATIONS` — this file does not get rewritten to invent one now.
 *
 * Paired with T97 by construction, not by convention: every step's mutation
 * runs *after* `backupBeforeMigrating` snapshots the current
 * `.sta/manifest.json` into a normal backup directory (T97's `rollbackSta`
 * doesn't need to know migration exists — a migration snapshot looks exactly
 * like an upgrade snapshot to it).
 */
export interface StaMigrationStep {
  from: number;
  to: number;
  /** Mutates `.sta/`'s on-disk state (and anything else the shape change touches) for this one step. Must not touch `.sta/manifest.json`'s `schema_version` field itself — `migrateSta` writes that once, after every step succeeds. */
  migrate(projectRoot: string): void;
}

/** Empty on purpose — see the module doc above. */
export const STA_MIGRATIONS: readonly StaMigrationStep[] = [];

export class NoMigrationPathError extends Error {}

/** Snapshots `.sta/manifest.json` into a fresh backup dir, in the same shape T95's upgrade leaves one — so T97's `rollbackSta` can undo a migration exactly like it undoes an upgrade. */
function backupBeforeMigrating(projectRoot: string, now: string): string {
  const backupDir = path.join(projectRoot, ".sta", "backups", `${now.replace(/[:.]/g, "-")}-migrate`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(installManifestPath(projectRoot), path.join(backupDir, "manifest.json"));
  return backupDir;
}

export interface MigrationResult {
  from: number;
  to: number;
  appliedSteps: number[];
  backupDir: string | null;
}

/**
 * `migrations` is injectable purely so this engine is testable before any
 * real step exists — production callers always use the default
 * `STA_MIGRATIONS` (currently empty).
 */
export function migrateSta(
  projectRoot: string,
  now: string,
  migrations: readonly StaMigrationStep[] = STA_MIGRATIONS,
): MigrationResult {
  const manifest = readInstallManifest(projectRoot);
  const from = manifest.schema_version;
  if (from === CURRENT_STA_SCHEMA_VERSION) {
    return { from, to: from, appliedSteps: [], backupDir: null };
  }

  const backupDir = backupBeforeMigrating(projectRoot, now);
  const appliedSteps: number[] = [];
  let version = from;
  while (version !== CURRENT_STA_SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      throw new NoMigrationPathError(
        `no migration step takes .sta/ from schema_version ${version} to ${CURRENT_STA_SCHEMA_VERSION}`,
      );
    }
    step.migrate(projectRoot);
    version = step.to;
    appliedSteps.push(step.to);
  }

  const updated = readInstallManifest(projectRoot);
  updated.schema_version = version;
  updated.updated_at = now;
  fs.writeFileSync(installManifestPath(projectRoot), `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  return { from, to: version, appliedSteps, backupDir };
}
