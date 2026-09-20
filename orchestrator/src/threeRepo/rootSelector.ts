import * as fs from "node:fs";
import * as path from "node:path";
import {
  KNOWLEDGE_ROOT_NAME_PATTERN,
  canonicalPathForComparison,
  defaultInstallationConfigPath,
  loadInstallationConfig,
  normalizeKnowledgeRoots,
  InstallationConfigError,
  type InstallationConfig,
} from "./installation.js";
import type { KnowledgeRootIdentity } from "../store/taskStore.js";

/**
 * The central Knowledge-root selector (DR §3). Every command resolves its
 * Knowledge root through `resolveInstallationRoot` — exactly one root leaves
 * per invocation, never the roots map. The read-side helper
 * (`resolveSelectedKnowledgeRootOrLegacy`) encodes the one rule the inventory's
 * fail-open sites (A8/A10/A12/A15) kept getting differently wrong: an
 * installation file that exists but cannot be read stops the command, and only
 * a *missing* installation file lets the legacy single-repo fallback stand.
 */

export interface SelectedKnowledgeRoot {
  name: string;
  /** Canonical absolute path of the selected root. */
  path: string;
  source: "flag" | "default" | "legacy-v1" | "frozen";
}

export class KnowledgeRootSelectionError extends Error {}

/** CLI-layer error for a malformed `--root` usage; verbs translate it into
 * their own usage-error vocabulary without re-deriving the rules. */
export class RootSelectorFlagError extends Error {}

/** Resolves the one Knowledge root for this invocation (DR §3):
 * v1 with no flag (or `--root default`) is the legacy synthetic default; v2
 * with no flag is `default_root`; a named entry wins without rewriting the
 * default on disk. The unknown-name error lists roots deterministically and
 * never names paths — the map stays machine-internal. */
export function resolveInstallationRoot(config: InstallationConfig, requestedName?: string): SelectedKnowledgeRoot {
  const normalized = normalizeKnowledgeRoots(config);
  const names = Object.keys(normalized.roots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (requestedName !== undefined) {
    const requested = normalized.roots[requestedName];
    if (requested === undefined) {
      const available = names.join(", ");
      throw new KnowledgeRootSelectionError(
        `unknown Knowledge root "${requestedName}"; available roots: ${available}` +
          (normalized.schemaVersion === 2 ? `; default: ${normalized.defaultRoot}` : ""),
      );
    }
    return {
      name: requestedName,
      path: path.resolve(requested),
      source: normalized.schemaVersion === 1 ? "legacy-v1" : "flag",
    };
  }
  if (normalized.schemaVersion === 1) {
    return { name: "default", path: path.resolve(config.knowledge_root), source: "legacy-v1" };
  }
  return { name: normalized.defaultRoot, path: path.resolve(normalized.roots[normalized.defaultRoot] as string), source: "default" };
}

/** Parses `--root <name>` out of a verb's argv: at most once, a value that is
 * present and honors the root-name contract, and never alongside
 * `--knowledge-root` (DR §4 — the path flag is a deprecated compatibility
 * channel, not a co-equal selector). */
export function extractRootSelectorFlag(argv: readonly string[]): { requestedName?: string; rest: string[] } {
  let requestedName: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--root") {
      rest.push(arg);
      continue;
    }
    if (requestedName !== undefined) {
      throw new RootSelectorFlagError("--root may be given at most once");
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new RootSelectorFlagError("--root requires a root name");
    }
    if (!KNOWLEDGE_ROOT_NAME_PATTERN.test(value)) {
      throw new RootSelectorFlagError(`invalid root name "${value}": must match ${KNOWLEDGE_ROOT_NAME_PATTERN.source}`);
    }
    requestedName = value;
    i++;
  }
  if (requestedName !== undefined && rest.includes("--knowledge-root")) {
    throw new RootSelectorFlagError("--root and --knowledge-root are mutually exclusive; --knowledge-root is a deprecated compatibility channel");
  }
  return { requestedName, rest };
}

/** The `--knowledge-root <path>` compatibility assertion (DR §4): the path
 * must canonical-match exactly one registered root, and the registered root's
 * own path is what the command uses. A v2 installation never accepts a path
 * outside `knowledge_roots`. */
export function matchInstalledKnowledgeRootPath(config: InstallationConfig, requestedPath: string): string {
  const normalized = normalizeKnowledgeRoots(config);
  const requested = canonicalPathForComparison(requestedPath);
  for (const name of Object.keys(normalized.roots)) {
    if (canonicalPathForComparison(normalized.roots[name] as string) === requested) {
      return path.resolve(normalized.roots[name] as string);
    }
  }
  const names = Object.keys(normalized.roots).sort().join(", ");
  throw new KnowledgeRootSelectionError(
    `--knowledge-root "${requestedPath}" does not match any registered Knowledge root (${names}); pass --root <name> or register this path in the installation config`,
  );
}

/** The shared read-side resolver behind the module-docs root (A10/A12): the
 * selected root when an installation exists; the legacy `projectRoot` only
 * when the installation file is absent. A file that exists but cannot be
 * loaded throws — the inventory's silent degradations hid a broken
 * installation behind someone else's docs. */
export function resolveSelectedKnowledgeRootOrLegacy(projectRoot: string, requestedName?: string, configPath?: string): string {
  const resolvedConfigPath = configPath ?? defaultInstallationConfigPath();
  let config: InstallationConfig;
  try {
    config = loadInstallationConfig(resolvedConfigPath);
  } catch (error) {
    if (error instanceof InstallationConfigError && !fs.existsSync(resolvedConfigPath)) {
      return path.resolve(projectRoot);
    }
    throw error;
  }
  return resolveInstallationRoot(config, requestedName).path;
}

/** DR §7.4 — the selection summary dynamic surfaces (`status`, `sta context`)
 * display: which root this invocation points at, where it canonically lives,
 * where the selection came from, and the installation default it did **not**
 * change. The name is absent only for a legacy launch env (`STA_KNOWLEDGE_ROOT`
 * without `STA_KNOWLEDGE_ROOT_NAME`) — one is never invented from a path. */
export interface KnowledgeSelectionSummary {
  name?: string;
  /** Canonical absolute path of the selected root. */
  path: string;
  source: SelectedKnowledgeRoot["source"] | "launch-env";
  defaultRootName?: string;
  defaultPath?: string;
}

/** Builds the DR §7.4 selection summary, or `undefined` when there is no
 * installation config at all (a legacy single-repo machine has no selection
 * to name). A launch env (`STA_KNOWLEDGE_ROOT`) wins over the installation,
 * mirroring `resolveContextDocsRoot`; the default still comes from the
 * installation when it exists. A file that exists but cannot be loaded
 * throws — the caller's own resolution path throws identically, so display
 * and read never disagree. */
export function summarizeKnowledgeSelection(options: {
  requestedName?: string;
  installationConfigPath?: string;
  env?: { STA_KNOWLEDGE_ROOT?: string | undefined; STA_KNOWLEDGE_ROOT_NAME?: string | undefined };
}): KnowledgeSelectionSummary | undefined {
  const envRoot = options.env?.STA_KNOWLEDGE_ROOT?.trim();
  const configPath = options.installationConfigPath ?? defaultInstallationConfigPath();
  let installation: InstallationConfig | undefined;
  if (fs.existsSync(configPath)) installation = loadInstallationConfig(configPath);
  if (envRoot) {
    const name = options.env?.STA_KNOWLEDGE_ROOT_NAME?.trim() || undefined;
    return {
      name,
      path: path.resolve(envRoot),
      source: "launch-env",
      defaultRootName: installation ? (installation.schema_version === 2 ? installation.default_root : "default") : undefined,
      defaultPath: installation ? path.resolve(installation.knowledge_root) : undefined,
    };
  }
  if (!installation) return undefined;
  const selected = resolveInstallationRoot(installation, options.requestedName);
  return {
    name: selected.name,
    path: selected.path,
    source: selected.source,
    defaultRootName: installation.schema_version === 2 ? installation.default_root : "default",
    defaultPath: path.resolve(installation.knowledge_root),
  };
}

/** DR §5 invariant 5 — a task frozen at intake resumes on its frozen root.
 * The frozen name is re-resolved through the installation (never the fresh
 * default), the canonical path must still match, and an explicit `--root` is
 * a drift assertion that must name the very same identity. A frozen task
 * whose installation file vanished refuses fail-closed: without it, no
 * selection can be verified at all. `frozen == null` (legacy task, no
 * installation at intake) is untouched. */
export function assertRootMatchesFrozenIdentity(
  frozen: KnowledgeRootIdentity | null | undefined,
  requestedName: string | undefined,
  configPath?: string,
): void {
  if (!frozen) return;
  let config: InstallationConfig;
  try {
    config = loadInstallationConfig(configPath);
  } catch (error) {
    throw new KnowledgeRootSelectionError(
      `the task is frozen to Knowledge root "${frozen.name}" (${frozen.path}) but the installation config cannot confirm it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let frozenSelected: SelectedKnowledgeRoot;
  try {
    frozenSelected = resolveInstallationRoot(config, frozen.name);
  } catch (error) {
    throw new KnowledgeRootSelectionError(
      `the task is frozen to Knowledge root "${frozen.name}" (${frozen.path}) but the installation config cannot confirm it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalPathForComparison(frozenSelected.path) !== canonicalPathForComparison(frozen.path)) {
    throw new KnowledgeRootSelectionError(
      `Knowledge root drift: the task is frozen to root "${frozen.name}" (${frozen.path}) but that name now resolves to ${frozenSelected.path} — a frozen task never re-selects; start a new task for another root`,
    );
  }
  if (requestedName === undefined || requestedName === frozen.name) return;
  const requested = resolveInstallationRoot(config, requestedName);
  if (canonicalPathForComparison(requested.path) !== canonicalPathForComparison(frozen.path)) {
    throw new KnowledgeRootSelectionError(
      `Knowledge root drift: the task is frozen to root "${frozen.name}" (${frozen.path}) but --root ${requestedName} resolves to "${requested.name}" (${requested.path}) — --root on a resume is an assertion, never a re-selection; start a new task for another root`,
    );
  }
}
