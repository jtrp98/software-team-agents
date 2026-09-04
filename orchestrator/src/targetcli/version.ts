import * as path from "node:path";
import { readTemplateManifest } from "../packaging/templateManifest.js";

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

/**
 * T-V5-030 — the version string alone cannot distinguish two Framework
 * checkouts on the same linked-checkout install (F-02/F-23): the version
 * only moves on an intentional bump, while content changes on every commit.
 * Append the payload digest (T-V5-015) as semver build metadata so
 * `--version` differs whenever the payload does, without changing what a
 * plain version comparison sees (`+...` is ignored by `parseVersion` above).
 */
export function installedFrameworkVersion(frameworkRoot: string): string {
  const manifest = readTemplateManifest(path.join(frameworkRoot, "templates"));
  const digest = manifest.payload_digest;
  return digest ? `${manifest.framework_version}+${digest.slice(0, 12)}` : manifest.framework_version;
}

export type SyncState = "NOT_INITIALIZED" | "UP_TO_DATE" | "OUTDATED" | "INCOMPATIBLE";

/**
 * Version strings decide compatibility only. Freshness is derived from
 * `planSync` by the caller: equal versions can carry different payload bytes,
 * and different same-major versions can carry identical selected payloads.
 */
export function classifySyncState(syncedVersion: string, installedVersion: string): "INCOMPATIBLE" | undefined {
  return sameMajor(syncedVersion, installedVersion) ? undefined : "INCOMPATIBLE";
}
