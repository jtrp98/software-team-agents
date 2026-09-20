import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface InstallationIdentities {
  figma_email: string;
  claude_email: string;
}

export interface InstallationConfigV1 {
  schema_version: 1;
  knowledge_root: string;
  /** Declared design-account identities. Optional: installs that never run the UX/UI stage need none. */
  identities?: InstallationIdentities;
}

export interface InstallationConfigV2 {
  schema_version: 2;
  /** Compatibility alias of the default root — never an independent selector (DR §2.3). */
  knowledge_root: string;
  default_root: string;
  knowledge_roots: Record<string, string>;
  identities?: InstallationIdentities;
}

export type InstallationConfig = InstallationConfigV1 | InstallationConfigV2;

/** A root name is a machine-local label (DR §2.1): lowercase CLI-safe slug,
 * deterministic across YAML, Windows paths and shell quoting. */
export const KNOWLEDGE_ROOT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The loader's normalized view of the named roots: exactly one default and
 * one path per name, semantic invariants already enforced. */
export interface NormalizedKnowledgeRoots {
  defaultRoot: string;
  roots: Readonly<Record<string, string>>;
  /** Which on-disk schema the view came from; a v1 file is never rewritten to v2 at read time. */
  schemaVersion: 1 | 2;
}

export class InstallationConfigError extends Error {}

function isSameOrNested(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Validates the repository identity root, not merely the presence of a
 * `.git` marker. Linked worktrees share metadata with another checkout and
 * cannot safely be a Framework, Knowledge, or Target authority root.
 *
 * This deliberately inspects local metadata rather than invoking Git. The
 * runtime guard forbids Git commands, so validation must not create the very
 * policy violation it is supposed to prevent. A directory-form `.git` with no
 * `commondir` is the fail-closed standalone shape; a file-form marker is a
 * linked worktree and is rejected. */
export function assertStandaloneRepositoryRoot(repositoryRoot: string, label: string): string {
  const resolved = path.resolve(repositoryRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new InstallationConfigError(`${label} root "${repositoryRoot}" is not an existing directory`);
  }
  const canonical = fs.realpathSync.native(resolved);
  const gitMarker = path.join(canonical, ".git");
  if (!fs.existsSync(gitMarker)) {
    throw new InstallationConfigError(`${label} root "${canonical}" is not a standalone Git repository`);
  }
  if (!fs.statSync(gitMarker).isDirectory()) {
    throw new InstallationConfigError(`${label} root "${canonical}" is a Git linked worktree; configure a standalone ${label} repository path instead`);
  }
  if (fs.existsSync(path.join(gitMarker, "commondir"))) {
    throw new InstallationConfigError(`${label} root "${canonical}" uses shared Git metadata and is not a standalone repository`);
  }
  return canonical;
}

export function assertStandaloneKnowledgeRoot(knowledgeRoot: string): string {
  return assertStandaloneRepositoryRoot(knowledgeRoot, "Knowledge");
}

export function assertStandaloneFrameworkRoot(frameworkRoot: string): string {
  return assertStandaloneRepositoryRoot(frameworkRoot, "Framework");
}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "installation.schema.json");
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}

/** Ajv's additionalProperties message does not name the offending key; the
 * name is what makes an unknown-property reject diagnosable. */
function formatSchemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => {
      const extra = (e.params as { additionalProperty?: string } | undefined)?.additionalProperty;
      return `${e.instancePath || "(root)"} ${e.message}${extra ? ` (${extra})` : ""}`;
    })
    .join("; ");
}

const TEST_HARNESS_ENV = "STA_TEST_HARNESS";
let overrideChannelDeclaredForTest = false;

/** Declares the `STA_INSTALLATION_CONFIG` override channel for the calling
 * test harness (DR §9, package B). A production invocation that finds the env
 * set without this declaration or the packaged-E2E marker is refused instead
 * of silently reading another installation. */
export function declareInstallationConfigOverrideChannelForTest(): void {
  overrideChannelDeclaredForTest = true;
}

export function resetInstallationConfigOverrideChannelForTest(): void {
  overrideChannelDeclaredForTest = false;
}

function canonicalInstallationConfigPath(platform = process.platform, localAppData = process.env.LOCALAPPDATA, home = os.homedir()): string {
  if (platform === "win32") {
    if (!localAppData) throw new InstallationConfigError("LOCALAPPDATA is unavailable; cannot resolve installation config path");
    return path.join(localAppData, "software-team-agents", "installation.yaml");
  }
  return path.join(home, ".config", "software-team-agents", "installation.yaml");
}

/** The one reader of the `STA_INSTALLATION_CONFIG` override, shared by every
 * caller that resolves installation state. Undefined when unset; refused
 * fail-closed when set outside a declared test/E2E harness — the channel is
 * deterministic isolation, not a security boundary, so the refusal exists to
 * stop an accidental second installation model, not an attacker. */
export function installationConfigOverride(): string | undefined {
  const override = process.env.STA_INSTALLATION_CONFIG;
  if (!override || override.length === 0) return undefined;
  if (!overrideChannelDeclaredForTest && process.env[TEST_HARNESS_ENV] !== "1") {
    let canonical: string;
    try {
      canonical = canonicalInstallationConfigPath();
    } catch {
      canonical = "the platform's canonical installation config path";
    }
    throw new InstallationConfigError(
      `refusing the STA_INSTALLATION_CONFIG override "${path.resolve(override)}": this env var is an internal test/E2E channel, not a production setting — use the canonical installation config at ${canonical}`,
    );
  }
  return path.resolve(override);
}

export function defaultInstallationConfigPath(platform = process.platform, localAppData = process.env.LOCALAPPDATA, home = os.homedir()): string {
  const override = installationConfigOverride();
  if (override) return override;
  return canonicalInstallationConfigPath(platform, localAppData, home);
}

/** Case-folded on Windows because NTFS compares paths case-insensitively by
 * default — an exact-match alias check there would reject the same physical
 * root aliased under a different case (DR §2.3). Pure string work: no fs
 * access, so the invariants hold identically in tests and in production.
 * Shared so path assertions (`--knowledge-root`, registry paths) compare the
 * way the loader's invariants do. */
export function canonicalPathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Enforces what draft-07 cannot express across properties (DR §2.3): the
 * default exists, `knowledge_root` aliases it, names honor the slug contract,
 * and no canonical path is registered under two names. */
function assertInstallationInvariants(config: InstallationConfig): void {
  if (config.schema_version !== 2) return;
  const names = Object.keys(config.knowledge_roots);
  for (const name of names) {
    if (!KNOWLEDGE_ROOT_NAME_PATTERN.test(name)) {
      throw new InstallationConfigError(`installation config is invalid: knowledge root name "${name}" must match ${KNOWLEDGE_ROOT_NAME_PATTERN.source}`);
    }
  }
  const defaultPath = config.knowledge_roots[config.default_root];
  if (defaultPath === undefined) {
    throw new InstallationConfigError(`installation config is invalid: default_root "${config.default_root}" is not a knowledge_roots entry (${names.join(", ")})`);
  }
  if (canonicalPathForComparison(config.knowledge_root) !== canonicalPathForComparison(defaultPath)) {
    throw new InstallationConfigError(`installation config is invalid: knowledge_root is the compatibility alias of the default root "${config.default_root}" (${defaultPath}), not an independent selector`);
  }
  const byPath = new Map<string, string>();
  for (const name of names) {
    const key = canonicalPathForComparison(config.knowledge_roots[name] as string);
    const owner = byPath.get(key);
    if (owner !== undefined) {
      throw new InstallationConfigError(`installation config is invalid: knowledge roots "${owner}" and "${name}" point at the same path (${config.knowledge_roots[name] as string})`);
    }
    byPath.set(key, name);
  }
}

/** Normalizes a loaded config to its named-root view (DR §2.2). A v1 file
 * becomes a synthetic `default` root in memory only — writing v2 happens at
 * the first named-root operation, never at read time. */
export function normalizeKnowledgeRoots(config: InstallationConfig): NormalizedKnowledgeRoots {
  if (config.schema_version === 1) {
    return { defaultRoot: "default", roots: { default: config.knowledge_root }, schemaVersion: 1 };
  }
  return { defaultRoot: config.default_root, roots: { ...config.knowledge_roots }, schemaVersion: 2 };
}

export function loadInstallationConfig(configPath = defaultInstallationConfigPath()): InstallationConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new InstallationConfigError(`cannot read installation config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = validator();
  if (!validate(parsed)) throw new InstallationConfigError(`installation config is invalid: ${formatSchemaErrors(validate)}`);
  const config = parsed as InstallationConfig;
  assertInstallationInvariants(config);
  return config;
}

/** Everything a Knowledge-root write must prove about the *path and the
 * config location* before any file is touched: the root is a standalone Git
 * checkout, it does not overlap the Framework, and the config file itself
 * stays installation-local (never inside a Knowledge, Target or Framework
 * repository). Shared by the v1 compat writer and the v2 named-root writer so
 * both entry points refuse identically. */
function assertConfigurableKnowledgePath(knowledgeRoot: string, configPath: string, frameworkRoot?: string): string {
  const canonical = assertStandaloneKnowledgeRoot(knowledgeRoot);
  if (frameworkRoot) {
    // Two legitimate shapes for the Framework root:
    //  - a developer/source checkout (has .git): must be standalone, never a
    //    linked worktree sharing metadata across machines;
    //  - an npm-installed package under node_modules (no .git): perfectly
    //    normal for end users — requiring Git here made every clean-machine
    //    install fail before it started.
    // Either way, Knowledge and Framework must not overlap on disk.
    const gitMarker = path.join(frameworkRoot, ".git");
    if (fs.existsSync(gitMarker)) {
      const frameworkCanonical = assertStandaloneFrameworkRoot(frameworkRoot);
      if (isSameOrNested(canonical, frameworkCanonical) || isSameOrNested(frameworkCanonical, canonical)) {
        throw new InstallationConfigError("Knowledge root must not overlap the Framework root");
      }
    } else {
      const frameworkPlain = path.resolve(frameworkRoot);
      if (isSameOrNested(canonical, frameworkPlain) || isSameOrNested(frameworkPlain, canonical)) {
        throw new InstallationConfigError("Knowledge root must not overlap the Framework package directory");
      }
    }
  }
  const configCanonicalCandidate = path.resolve(configPath);
  if (configCanonicalCandidate === canonical || configCanonicalCandidate.startsWith(`${canonical}${path.sep}`)) {
    throw new InstallationConfigError("installation config must be installation-local, not inside the Knowledge repo");
  }
  // A per-run override must never turn a Target or the framework itself into
  // installation state. Both are writable workspaces, not configuration homes.
  // A clone has a .git directory at its root. Installation-local state may be
  // anywhere on the machine, but it must not be committed into either a Target
  // or Framework repository (nor into any nested worktree).
  for (let cursor = path.dirname(configCanonicalCandidate); ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) {
      throw new InstallationConfigError("installation config must be installation-local, not inside a Framework or Target repository");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
  }
  return canonical;
}

/** The only way a v2 config reaches disk (DR §2.4): `knowledge_root` is
 * computed from `default_root` — never carried independently — and the result
 * must pass the same schema and semantic invariants a later load applies. */
function persistV2InstallationConfig(next: Omit<InstallationConfigV2, "knowledge_root">, configPath: string): InstallationConfigV2 {
  const knowledge_root = next.knowledge_roots[next.default_root];
  const v2: InstallationConfigV2 = { ...next, knowledge_root };
  const validate = validator();
  if (!validate(v2)) throw new InstallationConfigError(`installation config write is invalid: ${formatSchemaErrors(validate)}`);
  assertInstallationInvariants(v2);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringifyYaml(v2, { sortMapEntries: false }), "utf8");
  return v2;
}

function sortedRootNames(config: InstallationConfig): string {
  return Object.keys(normalizeKnowledgeRoots(config).roots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
}

/** Loads the existing installation state for a writer, or `undefined` when no
 * file exists yet. A file that exists but cannot be loaded stops the write:
 * a configure run must never silently replace installation state it could not
 * even read. */
function loadExistingInstallationConfigForWrite(configPath: string): InstallationConfig | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  return loadInstallationConfig(configPath);
}

export function configureKnowledgeRoot(knowledgeRoot: string, configPath = defaultInstallationConfigPath(), frameworkRoot?: string): InstallationConfig {
  const canonical = assertConfigurableKnowledgePath(knowledgeRoot, configPath, frameworkRoot);
  const existing = loadExistingInstallationConfigForWrite(configPath);
  if (existing?.schema_version === 2) {
    throw new InstallationConfigError(
      `installation config ${configPath} is schema v2 with named roots (${sortedRootNames(existing)}) — ` +
        "pass --root <name> to add or update one named entry; a pathless write would replace the whole map",
    );
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config: InstallationConfig = { schema_version: 1, knowledge_root: canonical };
  fs.writeFileSync(configPath, stringifyYaml(config, { sortMapEntries: false }), "utf8");
  return config;
}

/** Options of the v2 named-root writer (DR §2.4). */
export interface ConfigureNamedKnowledgeRootOptions {
  /** `--root <name>` — the entry this write adds or updates. */
  rootName: string;
  /** `--default` — make the named entry the default root. */
  makeDefault?: boolean;
  configPath?: string;
  frameworkRoot?: string;
}

/** Adds or updates exactly one named Knowledge root entry (DR §2.4). The
 * first named operation on a v1 file migrates it to v2: the same physical
 * root takes the given name as the first entry and the default; a new path
 * keeps the original root under the name `default` (still the default unless
 * `makeDefault`). On a v2 file the named entry is added or repointed and
 * `knowledge_root` follows `default_root`. Canonical paths stay unique across
 * names, and no target move or root removal ever happens here. */
export function configureNamedKnowledgeRoot(knowledgeRoot: string, options: ConfigureNamedKnowledgeRootOptions): InstallationConfig {
  const rootName = options.rootName;
  if (!KNOWLEDGE_ROOT_NAME_PATTERN.test(rootName)) {
    throw new InstallationConfigError(`knowledge root name "${rootName}" must match ${KNOWLEDGE_ROOT_NAME_PATTERN.source}`);
  }
  const configPath = options.configPath ?? defaultInstallationConfigPath();
  const canonical = assertConfigurableKnowledgePath(knowledgeRoot, configPath, options.frameworkRoot);
  const existing = loadExistingInstallationConfigForWrite(configPath);

  let defaultRoot: string;
  let roots: Record<string, string>;
  if (!existing || existing.schema_version === 1) {
    if (existing && canonicalPathForComparison(existing.knowledge_root) !== canonicalPathForComparison(canonical)) {
      if (rootName === "default") {
        throw new InstallationConfigError(
          `cannot name a different path "default": the existing v1 root ${existing.knowledge_root} keeps the name "default" through migration — ` +
            "configure its own path to rename it, or choose another name for the new root",
        );
      }
      // v1 + a new path: the original root survives migration as `default`
      roots = { default: existing.knowledge_root, [rootName]: canonical };
      defaultRoot = options.makeDefault ? rootName : "default";
    } else {
      // v1 + the same physical root (or no file): the given name becomes the
      // first entry and the default — nothing else exists to keep it
      roots = { [rootName]: canonical };
      defaultRoot = rootName;
    }
  } else {
    const currentPath = existing.knowledge_roots[rootName];
    if (currentPath === undefined) {
      for (const name of Object.keys(existing.knowledge_roots)) {
        if (canonicalPathForComparison(existing.knowledge_roots[name] as string) === canonicalPathForComparison(canonical)) {
          throw new InstallationConfigError(
            `knowledge root path ${canonical} is already registered as "${name}" — a canonical path is registered under exactly one name`,
          );
        }
      }
    }
    roots = { ...existing.knowledge_roots, [rootName]: canonical };
    defaultRoot = options.makeDefault ? rootName : existing.default_root;
  }
  return persistV2InstallationConfig(
    { schema_version: 2, default_root: defaultRoot, knowledge_roots: roots, identities: existing?.identities },
    configPath,
  );
}

/** `sta configure default-root --root <name>` (DR §2.4): switches the default
 * on a v2 installation without re-taking a path; `knowledge_root` follows.
 * Naming the current default is a no-op that never rewrites the file. A v1
 * file has exactly one root and it is already the default — the name
 * `default` answers without touching the v1 file, anything else is unknown. */
export function configureDefaultRoot(rootName: string, configPath = defaultInstallationConfigPath()): InstallationConfig {
  if (!KNOWLEDGE_ROOT_NAME_PATTERN.test(rootName)) {
    throw new InstallationConfigError(`knowledge root name "${rootName}" must match ${KNOWLEDGE_ROOT_NAME_PATTERN.source}`);
  }
  const config = loadExistingInstallationConfigForWrite(configPath);
  if (!config) {
    throw new InstallationConfigError(`no installation config at ${configPath} yet — run \`sta configure knowledge-root <path>\` first`);
  }
  const normalized = normalizeKnowledgeRoots(config);
  if (normalized.roots[rootName] === undefined) {
    throw new InstallationConfigError(
      `unknown Knowledge root "${rootName}"; available roots: ${sortedRootNames(config)}` +
        (config.schema_version === 2 ? `; default: ${normalized.defaultRoot}` : ""),
    );
  }
  if (config.schema_version === 1) return config;
  if (rootName === config.default_root) return config;
  return persistV2InstallationConfig(
    {
      schema_version: 2,
      default_root: rootName,
      knowledge_roots: { ...config.knowledge_roots },
      identities: config.identities,
    },
    configPath,
  );
}

/**
 * Declares (or replaces) the design-account identities — `sta configure
 * identity --figma-email <e> --claude-email <e>`. Merges into whatever
 * config already exists so binding a Knowledge root and declaring identities
 * are independent acts, in either order.
 *
 * Emails only. A token must never be passed here, and none of these functions
 * has a parameter that could accept one: secrets stay in the environment or
 * the OS keychain, and installation state stays reproducible from commands.
 */
export function configureIdentities(
  identities: { figma_email?: string; claude_email?: string },
  configPath = defaultInstallationConfigPath(),
): InstallationConfig {
  const figma = identities.figma_email?.trim();
  const claude = identities.claude_email?.trim();
  if (!figma && !claude) {
    throw new InstallationConfigError(
      "configure identity: give at least one of --figma-email / --claude-email; both accounts must be declared to be the same address",
    );
  }

  let config: InstallationConfig;
  try {
    config = loadInstallationConfig(configPath);
  } catch {
    // No usable existing config: identities extend an installation, they are
    // not a substitute for one. Binding a Knowledge root remains its own act.
    throw new InstallationConfigError(
      `no usable installation config at ${configPath} yet — run \`configure knowledge-root <path>\` first`,
    );
  }

  const merged: InstallationIdentities = {
    figma_email: figma ?? config.identities?.figma_email ?? "",
    claude_email: claude ?? config.identities?.claude_email ?? "",
  };
  if (!merged.figma_email || !merged.claude_email) {
    throw new InstallationConfigError(
      "both emails are required for the identity gate — " +
        `declare them together: sta configure identity --figma-email <email> --claude-email <email>`,
    );
  }
  const next: InstallationConfig = { ...config, identities: merged };

  // Validate through the same schema a later load will use, so an invalid
  // declaration never reaches disk.
  const validate = validator();
  if (!validate(next)) {
    throw new InstallationConfigError(
      `identities are invalid: ${formatSchemaErrors(validate)}`,
    );
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringifyYaml(next, { sortMapEntries: false }), "utf8");
  return next;
}
