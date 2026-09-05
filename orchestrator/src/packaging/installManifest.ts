import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateFileEntry } from "./templateManifest.js";

/**
 * `.sta/manifest.json` is legacy, read-only state — nothing installs to it anymore.
 * This module survives only because `sta migrate` still needs to read and rewrite
 * an existing project's recorded `schema_version`. Bump this when that structure changes.
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
