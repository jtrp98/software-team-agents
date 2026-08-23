import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * The manifest T90 produces alongside `templates/` — one row per templated
 * file, its content hash, and the framework version this build came from.
 *
 * This is the anchor T94-T97 build on: `sta upgrade` diffs a target
 * project's on-disk file hash against the `sha256` recorded here at install
 * time. Unchanged since install -> safe to overwrite. Changed -> the user
 * edited it, so upgrade skips it and warns instead of clobbering it.
 */
export interface TemplateFileEntry {
  /** Repo-root-relative, forward-slashed — identical to how it lands in the target project. */
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface TemplateManifest {
  schema_version: number;
  framework_version: string;
  generated_at: string;
  files: TemplateFileEntry[];
}

export function sha256Of(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Reads the Framework version from the *distributable's* package.json at the
 **repo root** — the single source of truth. The `.tgz` filename npm pack
 * produces (`<name>-<version>.tgz`) comes from this same file, so the artifact
 * name and every `framework_version` stamped into templates/manifest.json can
 * never drift apart. Falls back to the orchestrator dev-package manifest only
 * when no root package.json exists (templateBuilder unit fixtures).
 */
export function readFrameworkVersion(repoRoot: string): string {
  const candidates = [path.join(repoRoot, "package.json"), path.join(repoRoot, "orchestrator", "package.json")];
  for (const pkgPath of candidates) {
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  }
  throw new Error(`no package.json with a "version" field found under ${repoRoot} — framework_version needs one`);
}

export function buildManifest(
  repoRoot: string,
  relFiles: readonly string[],
  frameworkVersion: string,
  now: string,
): TemplateManifest {
  const files: TemplateFileEntry[] = relFiles.map((relPath) => {
    const abs = path.join(repoRoot, relPath);
    const content = fs.readFileSync(abs);
    return { path: relPath.split(path.sep).join("/"), sha256: sha256Of(content), size_bytes: content.length };
  });
  return { schema_version: 1, framework_version: frameworkVersion, generated_at: now, files };
}

export class TemplatesNotBuiltError extends Error {}

/** Reads and validates `<templatesDir>/manifest.json` — the file `sta init`/`upgrade` (T92/T95) read as their source of truth for what to install. */
export function readTemplateManifest(templatesDir: string): TemplateManifest {
  const target = path.join(templatesDir, "manifest.json");
  if (!fs.existsSync(target)) {
    throw new TemplatesNotBuiltError(`${target} does not exist — run \`npm run build:templates\` first`);
  }
  const manifest = JSON.parse(fs.readFileSync(target, "utf8")) as TemplateManifest;
  const problems = checkTemplateManifest(manifest);
  if (problems.length > 0) {
    throw new TemplatesNotBuiltError(`${target} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return manifest;
}

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
  "template-manifest.schema.json",
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

/** Schema validity plus the one rule a JSON Schema cannot express: no path listed twice. */
export function checkTemplateManifest(data: unknown): string[] {
  const validate = validator();
  if (!validate(data)) {
    return (validate.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${extra ? `: "${extra}"` : ""}`;
    });
  }

  const manifest = data as TemplateManifest;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) problems.push(`"${file.path}" is listed more than once`);
    seen.add(file.path);
  }
  return problems;
}
