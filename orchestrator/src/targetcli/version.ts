import * as path from "node:path";
import { readTemplateManifest } from "../packaging/templateManifest.js";
import { TargetNotInitializedError, readTargetManifest } from "./targetMeta.js";

/**
 * T-TARGET-09 — Framework version tracking.
 *
 * The installed Framework's version lives in its `templates/manifest.json`
 * (one copy, written by build:templates). A Target records the version it last
 * synced in `.agent-team/manifest.json`. Comparing them answers "is this
 * Target outdated?" without any network call or registry.
 */

export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) throw new Error(`"${version}" is not a semantic version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Compatibility rule for running agents against synced assets: same major. */
export function sameMajor(a: string, b: string): boolean {
  try {
    return parseVersion(a).major === parseVersion(b).major;
  } catch {
    return false;
  }
}

export function installedFrameworkVersion(frameworkRoot: string): string {
  return readTemplateManifest(path.join(frameworkRoot, "templates")).framework_version;
}

export type SyncState = "NOT_INITIALIZED" | "UP_TO_DATE" | "OUTDATED" | "INCOMPATIBLE";

export interface VersionReport {
  state: SyncState;
  /** Version this Target last synced, when initialized. */
  syncedVersion?: string;
  /** Version of the Framework installation itself. */
  installedVersion: string;
}

/**
 * Same major = compatible: sync is a routine update (OUTDATED).
 * Different major = INCOMPATIBLE — managed assets may change shape across
 * majors, so a cross-major jump (an upgrade OR especially a downgrade) needs
 * explicit --force rather than happening silently.
 */
export function classifySyncState(syncedVersion: string, installedVersion: string): SyncState {
  if (syncedVersion === installedVersion) return "UP_TO_DATE";
  if (!sameMajor(syncedVersion, installedVersion)) return "INCOMPATIBLE";
  return "OUTDATED";
}

export function reportVersions(frameworkRoot: string, targetRoot: string): VersionReport {
  const installedVersion = installedFrameworkVersion(frameworkRoot);
  let syncedVersion: string;
  try {
    syncedVersion = readTargetManifest(targetRoot).framework_version;
  } catch (e) {
    if (e instanceof TargetNotInitializedError) return { state: "NOT_INITIALIZED", installedVersion };
    throw e;
  }
  return { state: classifySyncState(syncedVersion, installedVersion), syncedVersion, installedVersion };
}
