import * as fs from "node:fs";
import * as path from "node:path";
import { defaultInstallationConfigPath, loadInstallationConfig, normalizeKnowledgeRoots } from "./installation.js";
import { canonicalRepositoryCoordinate, RepositoryCoordinateError } from "./repositoryIdentity.js";
import { loadRemoteHostAliases } from "./localTargets.js";
import {
  loadTargetRegistry,
  normalizeTargetRegistry,
  targetById,
  writeTargetRegistry,
  type TargetRegistry,
  type TargetType,
} from "./targets.js";
import { resolveInstallationRoot } from "./rootSelector.js";

/**
 * The administrative Target register surface (DT §3.1). Before
 * `writeTargetRegistry` records an addition, a reactivation or an ownership
 * change, six steps run in order:
 *
 *  1. snapshot `knowledge_roots` from the canonical installation config —
 *     never from a session env var, never from a disk scan;
 *  2. load every root's registry sorted by root name; an unreadable registry
 *     refuses fail-closed (it might contain the owner that proves the
 *     duplicate);
 *  3. canonicalize every owning entry's `remote_url` and its aliases;
 *  4. refuse a key/alias collision within one root or across roots (a
 *     canonical identity owns at most one Target per machine);
 *  5. run the existing `assertTargetIdsImmutable` inside the destination
 *     registry before the cross-root ownership check concluded above;
 *  6. re-read installation and registries and refuse the write when anything
 *     moved between snapshot and write — a stale snapshot never lands.
 *
 * The write itself goes through `writeTargetRegistry` with the register
 * ownership context; a hand-edit of `targets.yaml` is not (and cannot be)
 * caught here — preflight and doctor are the other two enforcement layers.
 */

export interface RegisterTargetInput {
  targetId: string;
  name: string;
  remoteUrl: string;
  type?: TargetType;
  /** Named destination root (DR §3); omitted = the installation's default. */
  rootName?: string;
  installationConfigPath?: string;
}

export interface RegisterTargetResult {
  rootName: string;
  registryPath: string;
  targetId: string;
  canonicalCoordinate: string;
  operation: "addition" | "reactivation";
}

export class TargetRegistrationError extends Error {}

function canonicalizeOrRefuse(remoteUrl: string, machineAliases: Record<string, string>): string {
  try {
    return canonicalRepositoryCoordinate(remoteUrl, machineAliases);
  } catch (error) {
    if (error instanceof RepositoryCoordinateError && /no machine-local canonical-host mapping/.test(error.message)) {
      const aliasMatch = /host "([^"]+)" has no machine-local canonical-host mapping/.exec(error.message);
      const alias = aliasMatch?.[1] ?? remoteUrl;
      throw new TargetRegistrationError(
        `Cannot verify Target ownership: remote "${remoteUrl}" uses SSH host alias "${alias}" with no machine-local canonical-host mapping. ` +
          "Declare the alias or use a canonical remote_url; registration is refused fail-closed.",
      );
    }
    throw new TargetRegistrationError(
      `Cannot verify Target ownership: remote "${remoteUrl}" cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}. Registration is refused fail-closed.`,
    );
  }
}

export function registerTarget(input: RegisterTargetInput): RegisterTargetResult {
  const configPath = input.installationConfigPath ?? defaultInstallationConfigPath();
  const installation = loadInstallationConfig(configPath);
  const rootsMap = normalizeKnowledgeRoots(installation).roots;

  // Step 1+2 — canonical roots snapshot; every root's registry loaded
  // (sorted by name), unreadable = refuse fail-closed. A root whose registry
  // file does not exist yet owns nothing.
  const rootNames = Object.keys(rootsMap).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const selected = resolveInstallationRoot(installation, input.rootName);
  const snapshots = new Map<string, TargetRegistry>();
  for (const rootName of rootNames) {
    const rootPath = rootsMap[rootName] as string;
    if (!fs.existsSync(path.join(rootPath, "targets.yaml"))) {
      snapshots.set(rootName, { schema_version: 1, targets: [] });
      continue;
    }
    try {
      snapshots.set(rootName, loadTargetRegistry(rootPath));
    } catch (error) {
      throw new TargetRegistrationError(
        `Cannot verify machine-local Target ownership: registry for root "${rootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}. ` +
          "Repair that registry and retry; registration is refused fail-closed.",
      );
    }
  }

  // Step 3+4 — canonicalize every owned coordinate (remotes + aliases) and
  // refuse a key/alias collision within one root or across roots.
  const owners = new Map<string, { rootName: string; targetId: string }>();
  for (const rootName of rootNames) {
    const rootPath = rootsMap[rootName] as string;
    const machineAliases = loadRemoteHostAliases(rootPath);
    const normalized = normalizeTargetRegistry(snapshots.get(rootName) as TargetRegistry);
    for (const entry of normalized.targets) {
      if (entry.ownership_state === "released") continue;
      const coordinates: string[] = [canonicalizeOrRefuse(entry.remote_url, machineAliases)];
      for (const alias of entry.repository_aliases) coordinates.push(alias);
      for (const coordinate of coordinates) {
        const owner = owners.get(coordinate);
        if (owner !== undefined) {
          throw new TargetRegistrationError(
            `Target registration refused: canonical repository "${coordinate}" is already owned by root "${owner.rootName}" as Target "${owner.targetId}". ` +
              "Run sta doctor and complete the human-approved Target ownership transfer; do not edit targets.yaml by hand.",
          );
        }
        owners.set(coordinate, { rootName, targetId: entry.target_id });
      }
    }
  }

  // The candidate itself: canonicalized with the destination root's mapping.
  const destinationRegistryPath = path.join(rootsMap[selected.name] as string, "targets.yaml");
  const destinationAliases = loadRemoteHostAliases(rootsMap[selected.name] as string);
  const candidateCoordinate = canonicalizeOrRefuse(input.remoteUrl, destinationAliases);

  const previousDestination = snapshots.get(selected.name) as TargetRegistry;
  let existing;
  try {
    existing = targetById(previousDestination, input.targetId);
  } catch {
    existing = undefined;
  }
  let operation: RegisterTargetResult["operation"];
  // The destination registry is written as v2 (the administrative operation
  // is the named write), so its entries must carry the v2 fields.
  let nextTargets = normalizeTargetRegistry(previousDestination).targets.map((target) => ({ ...target }));
  if (existing === undefined) {
    operation = "addition";
    nextTargets.push({
      target_id: input.targetId,
      name: input.name,
      remote_url: input.remoteUrl,
      status: "active",
      ...(input.type !== undefined ? { type: input.type } : {}),
      ownership_state: "owned",
      repository_aliases: [],
    });
  } else {
    if (existing.status === "active") {
      throw new TargetRegistrationError(
        `Target "${input.targetId}" is already active in root "${selected.name}" — reactivation applies to a retired Target, and ownership is changed only through the human-gated transfer`,
      );
    }
    if (canonicalizeOrRefuse(existing.remote_url, destinationAliases) !== candidateCoordinate) {
      throw new TargetRegistrationError(
        `Target "${input.targetId}" remote_url is immutable and its canonical identity changed — a remote move is a human-gated identity change (DT §2.4/§5.2), not a register operation`,
      );
    }
    operation = "reactivation";
    nextTargets = nextTargets.map((target) =>
      target.target_id === input.targetId ? { ...target, status: "active" as const, name: input.name, ownership_state: "owned" as const } : target,
    );
  }

  // Step 4 (candidate side) — the candidate's coordinate must be free.
  const candidateOwner = owners.get(candidateCoordinate);
  if (candidateOwner !== undefined && !(candidateOwner.rootName === selected.name && candidateOwner.targetId === input.targetId)) {
    throw new TargetRegistrationError(
      `Target registration refused: canonical repository "${candidateCoordinate}" is already owned by root "${candidateOwner.rootName}" as Target "${candidateOwner.targetId}". ` +
        "Run sta doctor and complete the human-approved Target ownership transfer; do not edit targets.yaml by hand.",
    );
  }

  // Step 5 — the registry's own immutability invariants run inside the writer.
  const next: TargetRegistry = { schema_version: 2, targets: nextTargets };

  // Step 6 — fresh re-read; a snapshot that moved under us is not written on.
  const freshRoots = normalizeKnowledgeRoots(loadInstallationConfig(configPath)).roots;
  if (JSON.stringify(freshRoots) !== JSON.stringify(rootsMap)) {
    throw new TargetRegistrationError(
      "the installation config changed during registration — nothing was written; re-run the register command",
    );
  }
  for (const rootName of rootNames) {
    const rootPath = freshRoots[rootName] as string;
    const registryFile = path.join(rootPath, "targets.yaml");
    const current: TargetRegistry = fs.existsSync(registryFile)
      ? loadTargetRegistry(rootPath)
      : { schema_version: 1, targets: [] };
    if (JSON.stringify(current) !== JSON.stringify(snapshots.get(rootName))) {
      throw new TargetRegistrationError(
        `the Target registry of root "${rootName}" changed during registration — nothing was written; re-run the register command`,
      );
    }
  }
  writeTargetRegistry(rootsMap[selected.name] as string, next, {
    ownership: { channel: "register-flow", operation: operation === "addition" ? "addition" : "ownership-reactivation" },
  });
  return {
    rootName: selected.name,
    registryPath: destinationRegistryPath,
    targetId: input.targetId,
    canonicalCoordinate: candidateCoordinate,
    operation,
  };
}
