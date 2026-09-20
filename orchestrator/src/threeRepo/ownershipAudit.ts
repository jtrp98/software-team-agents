import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  canonicalPathForComparison,
  defaultInstallationConfigPath,
  loadInstallationConfig,
  normalizeKnowledgeRoots,
} from "./installation.js";
import { canonicalRepositoryCoordinate, RepositoryCoordinateError } from "./repositoryIdentity.js";
import { loadRemoteHostAliases, localTargetsPath } from "./localTargets.js";
import { loadTargetRegistry, normalizeTargetRegistry } from "./targets.js";

/**
 * "Target ownership across configured roots" (DT §4) — the installation-wide
 * doctor check. It reads the canonical `knowledge_roots` map plus every
 * configured root's `targets.yaml` (with ownership state and alias history)
 * and `.workflow/targets.local.yaml` (canonical checkout paths and
 * machine-local host-alias mappings). It never scans the filesystem: an
 * undeclared root is out of scope by design, and the cross-machine coverage
 * warning says so.
 *
 * `FAIL`: one canonical key or alias owned by more than one root, one
 * checkout path mapped by owning Targets of more than one root, or a registry
 * that exists but cannot be read — the proof itself is broken. `WARNING`: an
 * opaque legacy SSH alias with no machine-local mapping (ownership cannot be
 * proven for it, and preflight will refuse it at run time), and the standing
 * cross-machine coverage warning. `PASS`: every owning key unique across the
 * roots this machine declares; released tombstones own nothing.
 */

export type OwnershipAuditStatus = "PASS" | "WARNING" | "FAIL";

export interface OwnershipAuditResult {
  status: OwnershipAuditStatus;
  /** FAIL findings, draft-shaped (DT §4). */
  problems: string[];
  /** WARNING findings, including the standing cross-machine coverage line. */
  warnings: string[];
  /** Names of the roots actually scanned, sorted. */
  scannedRoots: string[];
  /** Composed single-line detail for the doctor check output. */
  detail: string;
}

const CROSS_MACHINE_WARNING =
  "Cross-machine Target ownership is unverified: no shared registry exists. " +
  "This result covers only roots declared in the canonical installation config on this machine.";

/** True when the coordinate refusal is the expected legacy-alias shape — an
 * opaque SSH host alias this machine has no mapping for. That state is a
 * named WARNING here (preflight refuses it at run time); any other refusal
 * means the registry's own identity is broken and the proof cannot stand. */
function isUnmappedAliasRefusal(error: RepositoryCoordinateError): boolean {
  return error.message.includes("has no machine-local canonical-host mapping");
}

/** Reads one root's `.workflow/targets.local.yaml` target-path map without
 * the existence/standalone validation `loadLocalTargetMapping` applies: the
 * ownership proof needs the *declared* path, and a checkout may legitimately
 * not exist on this machine. The file itself is schema-validated by
 * `loadRemoteHostAliases`, which reads the same file first. */
function declaredCheckoutPaths(knowledgeRoot: string): Record<string, string> {
  try {
    const parsed = parseYaml(fs.readFileSync(localTargetsPath(knowledgeRoot), "utf8")) as
      | { targets?: Record<string, { path?: string }> }
      | undefined;
    const entries = parsed?.targets ?? {};
    const paths: Record<string, string> = {};
    for (const [targetId, entry] of Object.entries(entries)) {
      if (entry?.path) paths[targetId] = path.resolve(entry.path);
    }
    return paths;
  } catch {
    return {};
  }
}

export function auditTargetOwnershipAcrossRoots(
  options: { installationConfigPath?: string } = {},
): OwnershipAuditResult {
  const configPath = options.installationConfigPath ?? defaultInstallationConfigPath();
  if (!fs.existsSync(configPath)) {
    return {
      status: "PASS",
      problems: [],
      warnings: [],
      scannedRoots: [],
      detail: "no installation config — a legacy single-root machine declares no roots to audit",
    };
  }
  // An installation file that exists but cannot be loaded throws: the proof
  // needs the canonical map, so a broken map is this check's failure, not a
  // pass-by-absence.
  const normalized = normalizeKnowledgeRoots(loadInstallationConfig(configPath));
  const scannedRoots = Object.keys(normalized.roots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // One identity space for canonical keys and alias history (DT §4), plus the
  // separate machine-space of canonical checkout paths.
  const identityOwners = new Map<string, Set<string>>();
  const checkoutOwners = new Map<string, Set<string>>();
  const problems: string[] = [];
  const warnings: string[] = [];
  let releasedTombstones = 0;

  for (const rootName of scannedRoots) {
    const rootPath = path.resolve(normalized.roots[rootName] as string);
    let registry;
    try {
      registry = loadTargetRegistry(rootPath);
    } catch (error) {
      if (!fs.existsSync(path.join(rootPath, "targets.yaml"))) {
        continue; // no registry file declares no Targets — the register flow's own semantics
      }
      problems.push(`the registry in root "${rootName}" cannot be read (${path.join(rootPath, "targets.yaml")}): ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let aliases: Record<string, string> = {};
    try {
      aliases = loadRemoteHostAliases(rootPath);
    } catch (error) {
      problems.push(`the local Target mapping in root "${rootName}" cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const normalizedRegistry = normalizeTargetRegistry(registry);
    const checkouts = declaredCheckoutPaths(rootPath);
    for (const target of normalizedRegistry.targets) {
      const owner = `${rootName}/${target.target_id}`;
      if (target.ownership_state === "released") {
        releasedTombstones++;
        continue; // a tombstone claims nothing — that is what being released means
      }
      let key: string;
      try {
        key = canonicalRepositoryCoordinate(target.remote_url, aliases);
      } catch (error) {
        if (error instanceof RepositoryCoordinateError && isUnmappedAliasRefusal(error)) {
          warnings.push(
            `${owner}: remote "${target.remote_url}" is an opaque legacy SSH alias with no machine-local mapping (${error.message}) — ` +
              "ownership cannot be proven across roots, and a task bound to it is refused at preflight until mapped",
          );
        } else {
          problems.push(`${owner}: the remote identity cannot be proven: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (!identityOwners.has(key)) identityOwners.set(key, new Set());
      identityOwners.get(key)!.add(owner);
      for (const alias of target.repository_aliases) {
        if (!identityOwners.has(alias)) identityOwners.set(alias, new Set());
        identityOwners.get(alias)!.add(owner);
      }
      const declared = checkouts[target.target_id];
      if (declared !== undefined) {
        const canonical = canonicalPathForComparison(declared);
        if (!checkoutOwners.has(canonical)) checkoutOwners.set(canonical, new Set());
        checkoutOwners.get(canonical)!.add(owner);
      }
    }
  }

  const sortOwners = (owners: Set<string>): string => [...owners].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
  for (const [coordinate, owners] of [...identityOwners.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (owners.size > 1) {
      problems.push(
        `Target ownership: canonical repository "${coordinate}" appears in multiple configured roots: ${sortOwners(owners)}. ` +
          "Resolve through the human-gated ownership transfer before running either Target.",
      );
    }
  }
  for (const [checkout, owners] of [...checkoutOwners.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (owners.size > 1) {
      problems.push(
        `Target ownership: checkout path "${checkout}" is mapped by owning Targets in multiple configured roots: ${sortOwners(owners)}. ` +
          "Resolve through the human-gated ownership transfer before running either Target.",
      );
    }
  }
  if (scannedRoots.length > 0) warnings.push(CROSS_MACHINE_WARNING);

  // The coverage line is informational, not a defect of this machine: an
  // otherwise-clean installation stays PASS (a machine in perfect local shape
  // must not read as degraded), while substantive warnings — unprovable
  // aliases — hold WARNING. Duplicates and unreadable proof hold FAIL.
  const substantiveWarnings = warnings.filter((warning) => warning !== CROSS_MACHINE_WARNING);
  const status: OwnershipAuditStatus = problems.length > 0 ? "FAIL" : substantiveWarnings.length > 0 ? "WARNING" : "PASS";
  const passNote =
    scannedRoots.length > 0
      ? `${scannedRoots.length} configured root(s) scanned; owning keys unique across roots` +
        (releasedTombstones > 0 ? `; ${releasedTombstones} released tombstone(s) not counted as owners` : "")
      : "no installation config — a legacy single-root machine declares no roots to audit";
  const detail =
    problems.length > 0
      ? [...problems, ...warnings].join("; ")
      : substantiveWarnings.length > 0
        ? [...substantiveWarnings, ...warnings.filter((warning) => warning === CROSS_MACHINE_WARNING)].join("; ")
        : warnings.length > 0
          ? `${passNote}; ${warnings.join("; ")}`
          : passNote;
  return { status, problems, warnings, scannedRoots, detail };
}
