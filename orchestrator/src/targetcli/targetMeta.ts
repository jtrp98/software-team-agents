import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { TemplateFileEntry } from "../packaging/templateManifest.js";
import { ExecutionConfigSchema } from "../packaging/staConfig.js";

/**
 * T-TARGET-06 / T-TARGET-05 — Target-side Framework metadata, under one home:
 *
 *   .agent-team/manifest.json   generated. Every file the Framework manages in
 *                               this Target (path + pristine sha256), plus the
 *                               Framework version last synced. Never hand-edited.
 *   .agent-team/config.yaml     the project's own. Target identity + the user
 *                               override list. The only file here a person edits.
 *   .agent-team/backups/<ts>/   pre-overwrite copies, so every sync is undoable.
 *   .agent-team/overrides/<p>   presence marks <p> as user-owned: sync will not
 *                               touch it again until it is removed from here.
 *
 * Ownership rule this module enforces everywhere else: only paths recorded in
 * manifest.json are Framework-managed. Anything else in the Target — src/,
 * tests/, package.json, README.md, business logic — is Target-owned by
 * definition, and no sync operation may add, overwrite, or remove it.
 */

export const TARGET_META_DIR = ".agent-team";

export interface TargetManifest {
  schema_version: number;
  framework_version: string;
  installed_at: string;
  updated_at: string;
  files: TemplateFileEntry[];
  /** Framework-owned delimited contributions inside otherwise project-owned files. */
  framework_blocks?: { path: string; sha256: string }[];
}

export class TargetNotInitializedError extends Error {}

function metaDir(targetRoot: string): string {
  return path.join(targetRoot, TARGET_META_DIR);
}

export function targetManifestPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), "manifest.json");
}

export function targetConfigPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), "config.yaml");
}

export function targetOverridesDir(targetRoot: string): string {
  return path.join(metaDir(targetRoot), "overrides");
}

export function isTargetInitialized(targetRoot: string): boolean {
  return fs.existsSync(targetManifestPath(targetRoot));
}

export function writeTargetManifest(targetRoot: string, manifest: TargetManifest): void {
  const target = targetManifestPath(targetRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Reads the manifest or throws the one error callers translate into "run init first". */
export function readTargetManifest(targetRoot: string): TargetManifest {
  const target = targetManifestPath(targetRoot);
  if (!fs.existsSync(target)) {
    throw new TargetNotInitializedError(
      `${path.join(TARGET_META_DIR, "manifest.json")} does not exist under ${targetRoot} — run \`software-team-agents init\` first`,
    );
  }
  return JSON.parse(fs.readFileSync(target, "utf8")) as TargetManifest;
}

/** Structural problems with an existing manifest (schema drift, duplicate rows). Empty = usable. */
export function checkTargetManifest(data: unknown): string[] {
  const manifest = data as TargetManifest | undefined;
  const problems: string[] = [];
  if (!manifest || typeof manifest !== "object") return ["manifest is not an object"];
  if (manifest.schema_version !== 1) problems.push(`unsupported schema_version ${String(manifest.schema_version)}`);
  if (typeof manifest.framework_version !== "string" || manifest.framework_version.length === 0) {
    problems.push("framework_version is missing");
  }
  if (!Array.isArray(manifest.files)) return [...problems, "files is missing"];
  const seen = new Set<string>();
  for (const file of manifest.files as TemplateFileEntry[]) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
      problems.push("a files entry lacks path/sha256");
      continue;
    }
    if (seen.has(file.path)) problems.push(`"${file.path}" is listed more than once`);
    seen.add(file.path);
  }
  const blockPaths = new Set<string>();
  for (const block of manifest.framework_blocks ?? []) {
    if (!block || typeof block.path !== "string" || typeof block.sha256 !== "string") {
      problems.push("a framework_blocks entry lacks path/sha256");
      continue;
    }
    if (blockPaths.has(block.path)) problems.push(`framework block "${block.path}" is listed more than once`);
    blockPaths.add(block.path);
  }
  return problems;
}

// --- config.yaml -----------------------------------------------------------

export const TargetConfigSchema = z.object({
  schema_version: z.literal(1),
  /** Stable identity for this Target — its directory name at init time. */
  target_id: z.string().min(1),
  registered_at: z.string().min(1),
  /** Which role's workspace this repository is (T-ROLE-01). Absent in configs from before this field existed — commands then detect or require --role. */
  role: z.enum(["ba", "dev"]).optional(),
  /** T-ROLE-06 — repo-relative (or absolute) path binding to the team's Knowledge repo, committed with this workspace. */
  knowledge: z.object({ path: z.string().min(1) }).optional(),
  /** T-LV1 — repo-relative (or absolute) path binding to a Target repo, committed with a Knowledge workspace. Optional and read-only: BA never requires it. */
  target: z.object({ path: z.string().min(1) }).optional(),
  /** Deterministic Target stack cache (T-V3-03). Absent means not yet detected. */
  stack: z.object({
    profile: z.string().min(1),
    package_manager: z.string().min(1),
    commands: z.object({
      install: z.string().min(1),
      build: z.string().min(1),
      test: z.string().min(1),
      lint: z.string().min(1),
      typecheck: z.string().min(1),
    }).passthrough(),
    schema_paths: z.array(z.string()),
    source_roots: z.array(z.string().min(1)),
    detected_at: z.string().min(1),
    fingerprint: z.string().startsWith("sha256:"),
    /** Hash of detector-owned fields; a mismatch proves a person changed the block and makes their values authoritative. */
    generated_hash: z.string().startsWith("sha256:").optional(),
  }).passthrough().optional(),
  /** V3 execution policy; additive and absent in every pre-V3 Target config. */
  execution: ExecutionConfigSchema.optional(),
  /** Repo-root-relative paths sync must never touch — the user override list (T-TARGET-05). */
  overrides: z.array(z.string().min(1)).default([]),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type TargetStackConfig = NonNullable<TargetConfig["stack"]>;

export interface TargetConfigCompatibility {
  problems: string[];
  warnings: string[];
}

const PreV3TargetConfigSchema = TargetConfigSchema.omit({ execution: true });
const PRE_V3_TARGET_CONFIG_KEYS = new Set<string>(PreV3TargetConfigSchema.keyof().options);

/** Proves that an older schema ignores additive V3 keys with a warning. */
export function inspectTargetConfigAsPreV3(targetRoot: string): TargetConfigCompatibility {
  const target = targetConfigPath(targetRoot);
  if (!fs.existsSync(target)) return { problems: [], warnings: [] };
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(target, "utf8"));
  } catch (error) {
    return { problems: [`${target} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
  const result = PreV3TargetConfigSchema.safeParse(parsed);
  const problems = result.success
    ? []
    : result.error.issues.map((issue) => `${target} ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const unknownKeys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.keys(parsed).filter((key) => !PRE_V3_TARGET_CONFIG_KEYS.has(key)).sort()
    : [];
  return {
    problems,
    warnings: unknownKeys.length === 0
      ? []
      : [`${target} contains optional key(s) not understood by the pre-v3 schema: ${unknownKeys.join(", ")} — ignored; upgrade the CLI to configure them`],
  };
}

export function defaultTargetConfig(targetId: string, now: string, role?: "ba" | "dev"): TargetConfig {
  return { schema_version: 1, target_id: targetId, registered_at: now, overrides: [], role };
}

export function loadTargetConfig(targetRoot: string): TargetConfig | undefined {
  const target = targetConfigPath(targetRoot);
  if (!fs.existsSync(target)) return undefined;
  const parsed = parseYaml(fs.readFileSync(target, "utf8"));
  const result = TargetConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${TARGET_META_DIR}/config.yaml is invalid:\n${result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`,
    );
  }
  return result.data;
}

export function writeTargetConfig(targetRoot: string, config: TargetConfig): void {
  const target = targetConfigPath(targetRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, stringifyYaml(config, { lineWidth: 0 }), "utf8");
}

/** A path the user claimed via config `overrides:` or a shadow copy under overrides/. */
export function isUserOverridden(targetRoot: string, relPath: string, config: TargetConfig | undefined): boolean {
  if (config?.overrides.includes(relPath)) return true;
  try {
    return fs.statSync(path.join(targetOverridesDir(targetRoot), relPath)).isFile();
  } catch {
    return false;
  }
}

// --- what may never be framework-managed -----------------------------------

const NEVER_MANAGED_PREFIXES = [
  "src/",
  "test/",
  "tests/",
  ".git",
  ".workflow",
  ".sta",
  TARGET_META_DIR,
  "knowledge",
  "_docs",
  "decisions",
  "orchestrator",
  "templates",
  "node_modules",
];

/**
 * Defense in depth for the ownership model: even a corrupted template manifest
 * cannot talk the sync engine into managing application source or runtime state.
 * The template boundary itself (packaging/templateSources.ts) never emits these,
 * so tripping this guard means the payload, not the Target, went wrong.
 */
export function assertManageablePath(relPath: string): void {
  const normalised = relPath.replaceAll("\\", "/");
  if (normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised) || normalised.split("/").includes("..")) {
    throw new Error(`refusing to manage "${relPath}" — managed paths are always repo-relative`);
  }
  if (NEVER_MANAGED_PREFIXES.some((prefix) => normalised === prefix.replace(/\/$/, "") || normalised.startsWith(prefix))) {
    throw new Error(`refusing to manage "${relPath}" — application source and runtime state are Target-owned, always`);
  }
}
