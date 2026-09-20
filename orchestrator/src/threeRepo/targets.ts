import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentStage, TaskState } from "../types.js";
import { assertCanonicalRepositoryCoordinate, canonicalRepositoryCoordinate } from "./repositoryIdentity.js";

export type TargetStatus = "active" | "retired";
/** The repository's delivery role (V9 AD-1) — declared once on the Target, never derived from its stack. */
export type TargetType = "frontend" | "backend" | "fullstack";
/** The cross-root ownership claim (DT §2.4). `retired` still owns; only an
 * explicit `released` tombstone — written through the human-gated transfer —
 * gives the coordinate up. */
export type TargetOwnershipState = "owned" | "released";
export interface TargetEntry {
  target_id: string; name: string; remote_url: string; status: TargetStatus; type?: TargetType;
  /** v2 only (schema): canonical coordinates this Target answered to in the past. */
  repository_aliases?: string[];
  /** v2 only (schema): the ownership claim; a v1 file reads as `owned`. */
  ownership_state?: TargetOwnershipState;
}
export interface TargetRegistry { schema_version: 1 | 2; targets: TargetEntry[]; }
export class TargetRegistryError extends Error {}

/** The loader's normalized view of a registry (DT §2.4 dual-reader): a v1 file
 * reads as every entry `owned` with no alias history, in memory only — the
 * file is never rewritten at read time. */
export interface NormalizedTargetRegistry {
  schemaVersion: 1 | 2;
  targets: Array<TargetEntry & { repository_aliases: string[]; ownership_state: TargetOwnershipState }>;
}

export function normalizeTargetRegistry(registry: TargetRegistry): NormalizedTargetRegistry {
  return {
    schemaVersion: registry.schema_version,
    targets: registry.targets.map((entry) => ({
      ...entry,
      repository_aliases: entry.repository_aliases ?? [],
      ownership_state: entry.ownership_state ?? "owned",
    })),
  };
}

export interface TargetTypeLifecycleTask {
  taskId: string;
  machine: { current: TaskState };
  cancelled: boolean;
  targetBindings: {
    targets: Array<{
      target_id: string;
      role: AgentStage.BACKEND_ENGINEER | AgentStage.FRONTEND_ENGINEER;
    }>;
  };
}

export interface WriteTargetRegistryOptions {
  /** Current durable task history; required only when a type change removes an admitted role. */
  tasks?: readonly TargetTypeLifecycleTask[];
  /** The administrative register context (DT §3.1 step 6). Writes that add or
   * change ownership — a new target_id, a reactivation, an ownership-state or
   * alias-history change — are refused without it, so the raw writer cannot
   * become a bypass around the six-step register flow. */
  ownership?: { channel: "register-flow"; operation: string };
}

/** The engineer roles a Target type admits. Validation against bindings is T-V9-008's job; doctor reports the stack-profile side of this today. */
export const TARGET_TYPE_ROLES: Readonly<Record<TargetType, readonly string[]>> = {
  frontend: ["frontend-engineer"],
  backend: ["backend-engineer"],
  fullstack: ["frontend-engineer", "backend-engineer"],
};

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "targets.schema.json");
let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}

function formatSchemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => {
      const allowed = (e.params as { allowedValues?: unknown[] } | undefined)?.allowedValues;
      return `${e.instancePath || "(root)"} ${e.message}${allowed ? ` (${allowed.map(String).join(", ")})` : ""}`;
    })
    .join("; ");
}
export function targetsPath(knowledgeRoot: string): string { return path.join(knowledgeRoot, "targets.yaml"); }

export function loadTargetRegistry(knowledgeRoot: string): TargetRegistry {
  const file = targetsPath(knowledgeRoot);
  let parsed: unknown;
  try { parsed = parseYaml(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new TargetRegistryError(`cannot read Target registry ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const validate = validator();
  if (!validate(parsed)) throw new TargetRegistryError(`Target registry is invalid: ${formatSchemaErrors(validate)}`);
  const registry = parsed as TargetRegistry;
  const duplicates = registry.targets.filter((entry, index) => registry.targets.findIndex((candidate) => candidate.target_id === entry.target_id) !== index).map((entry) => entry.target_id);
  if (duplicates.length) throw new TargetRegistryError(`Target registry has duplicate target_id values: ${[...new Set(duplicates)].join(", ")}`);
  for (const target of registry.targets) {
    if (!target.name.trim()) throw new TargetRegistryError(`Target "${target.target_id}" name must not be blank`);
    if (!isCredentialFreeGitRemote(target.remote_url)) {
      throw new TargetRegistryError(`Target "${target.target_id}" remote_url must be a credential-free Git remote URL`);
    }
  }
  assertRegistryV2Invariants(registry);
  return registry;
}

/** v2-only invariants (DT §2.4/§5.1) a JSON Schema cannot express: aliases are
 * canonical coordinates (never raw remotes or SSH aliases) that do not
 * duplicate their own remote or another entry's claim, and a released
 * tombstone must be retired (`active+released` is invalid). Released entries
 * claim nothing — that is exactly what being a tombstone means. */
function assertRegistryV2Invariants(registry: TargetRegistry): void {
  if (registry.schema_version !== 2) return;
  const claimed = new Map<string, string>();
  for (const target of registry.targets) {
    for (const alias of target.repository_aliases ?? []) {
      try {
        assertCanonicalRepositoryCoordinate(alias);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(error.message.indexOf(": ") + 2) : String(error);
        throw new TargetRegistryError(`Target "${target.target_id}" repository_aliases entry "${alias}" is not a canonical repository coordinate: ${reason}`);
      }
    }
    if (target.ownership_state === "released" && target.status !== "retired") {
      throw new TargetRegistryError(`Target "${target.target_id}" has status active+released, which is invalid — a released tombstone is retired (DT §5.1)`);
    }
    if (target.ownership_state === "released") continue;
    const ownCoordinates: string[] = [];
    try {
      ownCoordinates.push(canonicalRepositoryCoordinate(target.remote_url));
    } catch {
      // An alias-form remote whose host has no machine-local mapping cannot be
      // canonicalized by a pure loader; the register flow refuses it
      // fail-closed with the machine's mapping available.
    }
    for (const alias of target.repository_aliases ?? []) {
      if (ownCoordinates[0] === alias) {
        throw new TargetRegistryError(`Target "${target.target_id}" repository_aliases entry "${alias}" duplicates its own remote_url coordinate`);
      }
      ownCoordinates.push(alias);
    }
    for (const coordinate of ownCoordinates) {
      const owner = claimed.get(coordinate);
      if (owner !== undefined) {
        throw new TargetRegistryError(`Target registry coordinates "${owner}" and "${target.target_id}" collide on "${coordinate}"`);
      }
      claimed.set(coordinate, target.target_id);
    }
  }
}

/** The only registry writer used by administrative commands. It reads the
 * previous registry first so an existing target's identity cannot be replaced,
 * and ownership-affecting writes are only accepted from the register flow. */
export function writeTargetRegistry(
  knowledgeRoot: string,
  next: TargetRegistry,
  options: WriteTargetRegistryOptions = {},
): void {
  const validate = validator();
  if (!validate(next)) throw new TargetRegistryError(`Target registry is invalid: ${formatSchemaErrors(validate)}`);
  const file = targetsPath(knowledgeRoot);
  const previous = fs.existsSync(file) ? loadTargetRegistry(knowledgeRoot) : undefined;
  assertOwnershipWriteIsAuthorized(previous, next, options);
  if (previous) assertTargetIdsImmutable(previous, next, options.tasks);
  assertRegistryV2Invariants(next);
  for (const target of next.targets) {
    if (!target.name.trim() || !isCredentialFreeGitRemote(target.remote_url)) {
      throw new TargetRegistryError(`Target "${target.target_id}" has an invalid name or credential-bearing remote_url`);
    }
  }
  fs.writeFileSync(file, stringifyYaml(next, { sortMapEntries: false }), "utf8");
}

function isCredentialFreeGitRemote(value: string): boolean {
  if (/^(https?|ssh):\/\/[^/\s@]+@/i.test(value) || /[?&](token|access_token|password)=/i.test(value)) return false;
  return /^(https?:\/\/[^\s/]+\/[^\s]+|ssh:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/i.test(value);
}

/** DT §3.1 step 6: the raw writer must not become an ownership bypass. */
function assertOwnershipWriteIsAuthorized(
  previous: TargetRegistry | undefined,
  next: TargetRegistry,
  options: WriteTargetRegistryOptions,
): void {
  const authorized = options.ownership?.channel === "register-flow";
  const ownershipAffecting = ((): { reason: string } | undefined => {
    if (!previous) return next.targets.length > 0 ? { reason: "a first write that registers ownership" } : undefined;
    const previousById = new Map(previous.targets.map((target) => [target.target_id, target]));
    for (const target of next.targets) {
      const before = previousById.get(target.target_id);
      if (!before) return { reason: `the addition of Target "${target.target_id}"` };
      if (before.status === "retired" && target.status === "active") return { reason: `the reactivation of Target "${target.target_id}"` };
      if ((before.ownership_state ?? "owned") !== (target.ownership_state ?? "owned")) return { reason: `the ownership-state change of Target "${target.target_id}"` };
      if (JSON.stringify(before.repository_aliases ?? []) !== JSON.stringify(target.repository_aliases ?? [])) return { reason: `the alias-history change of Target "${target.target_id}"` };
    }
    return undefined;
  })();
  if (ownershipAffecting && !authorized) {
    throw new TargetRegistryError(
      `Target registry write refused (${ownershipAffecting.reason}): adding or changing Target ownership requires the administrative register flow (DT §3.1) — direct writer calls must not become an ownership bypass`,
    );
  }
}

export function targetById(registry: TargetRegistry, targetId: string): TargetEntry {
  const target = registry.targets.find((entry) => entry.target_id === targetId);
  if (!target) throw new TargetRegistryError(`unknown Target "${targetId}"`);
  return target;
}

/** DT §5.1: a released tombstone is a finished transfer's record, not a usable
 * Target. Its knowledge items stay as historical archive; nothing may bind,
 * declare, run or reconcile against it here. */
export function isReleasedTombstone(target: Pick<TargetEntry, "ownership_state">): boolean {
  return target.ownership_state === "released";
}

export function assertTargetCanStartNewTask(registry: TargetRegistry, targetId: string): TargetEntry {
  const target = targetById(registry, targetId);
  if (isReleasedTombstone(target)) {
    throw new TargetRegistryError(
      `Target "${targetId}" is a released tombstone in this root — its ownership moved through the human-gated transfer; bind the Target in its owning root`,
    );
  }
  if (target.status === "retired") throw new TargetRegistryError(`Target "${targetId}" is retired and cannot be used for a new task`);
  return target;
}

export function assertTargetIdsImmutable(
  previous: TargetRegistry,
  next: TargetRegistry,
  tasks?: readonly TargetTypeLifecycleTask[],
): void {
  const afterById = new Map(next.targets.map((target) => [target.target_id, target]));
  for (const before of previous.targets) {
    const after = afterById.get(before.target_id);
    if (!after) throw new TargetRegistryError(`immutable Target "${before.target_id}" cannot be deleted; set status to retired instead`);
    if (after.remote_url !== before.remote_url) {
      throw new TargetRegistryError(`Target "${before.target_id}" remote_url is immutable after creation`);
    }
  }
  const previousByRemote = new Map(previous.targets.map((target) => [target.remote_url, target]));
  for (const target of next.targets) {
    const before = previousByRemote.get(target.remote_url);
    if (before && before.target_id !== target.target_id) throw new TargetRegistryError(`Target remote "${target.remote_url}" changed immutable target_id from "${before.target_id}" to "${target.target_id}"`);
  }

  const effectiveRoles = (type: TargetType | undefined): ReadonlySet<string> =>
    new Set(type === undefined ? TARGET_TYPE_ROLES.fullstack : TARGET_TYPE_ROLES[type]);
  for (const before of previous.targets) {
    const after = afterById.get(before.target_id)!;
    const afterRoles = effectiveRoles(after.type);
    const removedRoles = [...effectiveRoles(before.type)].filter((role) => !afterRoles.has(role));
    if (removedRoles.length === 0) continue;
    if (tasks === undefined) {
      throw new TargetRegistryError(
        `Target "${before.target_id}" cannot narrow type from "${before.type ?? "untyped"}" to "${after.type ?? "untyped"}" without current task history — load durable tasks and retry the registry write`,
      );
    }
    for (const task of tasks) {
      if (task.cancelled || task.machine.current === TaskState.DEPLOYED) continue;
      const removedBinding = task.targetBindings.targets.find(
        (binding) => binding.target_id === before.target_id && removedRoles.includes(binding.role),
      );
      if (removedBinding) {
        throw new TargetRegistryError(
          `Target "${before.target_id}" cannot narrow type from "${before.type ?? "untyped"}" to "${after.type ?? "untyped"}" while non-terminal task "${task.taskId}" binds removed role "${removedBinding.role}" — keep type "${before.type ?? "untyped"}" before running or resuming task ${task.taskId}`,
        );
      }
    }
  }
}
