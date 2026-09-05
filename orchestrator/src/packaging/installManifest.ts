import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateFileEntry } from "./templateManifest.js";

/**
 * T94 — this manifest's own shape version, bumped only when `.sta/manifest.json`'s structure changes in a way T96 must migrate.
 *
 * T-V5-038 — the installer that used to write this file (`sta init`/`sta
 * upgrade`) is gone; `.sta/manifest.json` is now legacy, read-only state.
 * This module survives only because `sta migrate` (T96, out of scope for
 * T-V5-038) still needs to read and rewrite an existing project's recorded
 * `schema_version` — `isInstalled` and `checkInstallManifest` (the ajv schema
 * check) existed solely for the now-deleted installer/validator and were
 * removed with it.
 */
export const CURRENT_STA_SCHEMA_VERSION = 1;

export interface InstallManifest {
  schema_version: number;
  framework_version: string;
  installed_at: string;
  updated_at: string;
  files: TemplateFileEntry[];
}

export function installManifestPath(projectRoot: string): string {
  return path.join(projectRoot, ".sta", "manifest.json");
}

export function writeInstallManifest(projectRoot: string, manifest: InstallManifest): void {
  const target = installManifestPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export class InstallManifestMissingError extends Error {}

export function readInstallManifest(projectRoot: string): InstallManifest {
  const target = installManifestPath(projectRoot);
  if (!fs.existsSync(target)) {
    throw new InstallManifestMissingError(`${target} does not exist — this project has not run \`sta init\` yet`);
  }
  return JSON.parse(fs.readFileSync(target, "utf8")) as InstallManifest;
}
