import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { TemplateFileEntry } from "./templateManifest.js";

/** T94 — this manifest's own shape version, bumped only when `.sta/manifest.json`'s structure changes in a way T96 must migrate. */
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

export function isInstalled(projectRoot: string): boolean {
  return fs.existsSync(installManifestPath(projectRoot));
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

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "install-manifest.schema.json",
);

let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  }
  return compiled;
}

/** Schema validity plus the one rule the schema can't express: no path listed twice. */
export function checkInstallManifest(data: unknown): string[] {
  const validate = validator();
  if (!validate(data)) {
    return (validate.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
    });
  }
  const manifest = data as InstallManifest;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) problems.push(`"${file.path}" is listed more than once`);
    seen.add(file.path);
  }
  return problems;
}
