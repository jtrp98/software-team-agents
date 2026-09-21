import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { defaultInstallationConfigPath, loadInstallationConfig, normalizeKnowledgeRoots } from "./installation.js";
import { resolveInstallationRoot } from "./rootSelector.js";
import { assertCanonicalRepositoryCoordinate, canonicalRepositoryCoordinate, RepositoryCoordinateError, type RemoteHostAliases } from "./repositoryIdentity.js";
import { declaredCheckoutPaths, loadRemoteHostAliases } from "./localTargets.js";
import { loadTargetRegistry, normalizeTargetRegistry, targetById, writeTargetRegistry, type TargetRegistry, type TargetType } from "./targets.js";
import { TaskState } from "../types.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { qualifiedKnowledgeId, checkKnowledge } from "../knowledge/knowledgeBase.js";
import { listModules } from "../agents/moduleDocs.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { resolveModuleTargets } from "./moduleTargetResolver.js";
import { registerTarget, type RegisterTargetInput } from "./targetRegistration.js";
import { auditTargetOwnershipAcrossRoots, type OwnershipAuditResult } from "./ownershipAudit.js";

/**
 * DT §5.2 — the nine-step human-gated ownership transfer, as mechanics:
 *
 *  step 1  `planTargetOwnershipTransfer` — a read-only plan (coordinates,
 *          non-terminal tasks, module refs, scoped knowledge, mappings);
 *  step 2  the approval record — a person fills `source_approved_by`,
 *          `destination_approved_by` and the not-fork/mirror confirmation;
 *          every operation re-proves the record against the registries;
 *  step 3  the release validator refuses while a non-terminal task binds the
 *          source target (the same terminal rule as `assertTargetIdsImmutable`);
 *  step 4  the release validator refuses while module docs still declare the
 *          source target (a released tombstone must not stay declared);
 *  step 5  knowledge needs no validator — archive-in-source is the default
 *          (Q2.2=A); the plan lists what a person may re-author, and nothing
 *          copies or moves across roots (ข้อยืนยัน 8);
 *  step 6  `releaseTargetForTransfer` writes the `retired + released`
 *          tombstone through the administrative writer only;
 *  step 7  `registerDestinationForTransfer` registers the destination with
 *          alias history; `rollbackTargetTransfer` restores the release with
 *          the same record and refuses once the destination owns;
 *  step 9  `verifyTargetTransfer` runs the installation audit plus the
 *          knowledge and module checks on both roots and only then marks the
 *          record completed — a person still accepts the result.
 *
 * The two registries live in different Git repos, so the write is never
 * atomic: between the release and the destination register the state is
 * intermediate, and preflight refuses both sides (source tombstone via the
 * released-target rules, destination via the absent target) while the audit
 * reports the missing pair as FAIL.
 */

export class TargetTransferError extends Error {}

export type TransferRecordStatus = "pending" | "released" | "completed" | "rolled_back";

export interface TransferRecord {
  schema_version: 1;
  transfer_id: string;
  source_root: string;
  source_target_id: string;
  destination_root: string;
  destination_target_id: string;
  destination_name: string;
  destination_type?: TargetType;
  destination_remote_url: string;
  destination_repository_aliases: string[];
  source_approved_by: string;
  destination_approved_by: string;
  confirmed_transfer_not_fork_or_mirror: boolean;
  status: TransferRecordStatus;
}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "target-transfer.schema.json");
let compiled: ValidateFunction | undefined;
function validator(): ValidateFunction {
  if (!compiled) compiled = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  return compiled;
}

/** Loads and semantically validates the approval record. The schema cannot
 * see an unfilled template, so placeholder approvals (`<fill in …>`) are
 * refused here: an approval is a person's typed act, never a default. */
export function loadTransferRecord(recordPath: string): TransferRecord {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(recordPath, "utf8"));
  } catch (error) {
    throw new TargetTransferError(`cannot read the transfer approval record ${recordPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = validator();
  if (!validate(parsed)) {
    const details = (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`).join("; ");
    throw new TargetTransferError(`the transfer approval record ${recordPath} is invalid: ${details}`);
  }
  const record = parsed as TransferRecord;
  for (const field of ["source_approved_by", "destination_approved_by"] as const) {
    const value = record[field];
    if (!value.trim() || value.trim().startsWith("<")) {
      throw new TargetTransferError(
        `transfer "${record.transfer_id}" refused: the approval record still contains unfilled placeholder approvals — a person approves every gate, never an agent (DT §5.2 step 2)`,
      );
    }
  }
  if (record.confirmed_transfer_not_fork_or_mirror !== true) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the transfer is not confirmed as a transfer — a fork or mirror is a distinct Target (DT §5.2 step 2)`,
    );
  }
  for (const alias of record.destination_repository_aliases) {
    try {
      assertCanonicalRepositoryCoordinate(alias);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(error.message.indexOf(": ") + 2) : String(error);
      throw new TargetTransferError(
        `transfer "${record.transfer_id}" refused: destination_repository_aliases entry "${alias}" is not a canonical repository coordinate: ${reason}`,
      );
    }
  }
  return record;
}

function updateTransferRecordStatus(recordPath: string, record: TransferRecord, status: TransferRecordStatus): void {
  fs.writeFileSync(recordPath, stringifyYaml({ ...record, status }, { sortMapEntries: false }), "utf8");
}

function canonicalizeOrRefuse(context: string, remoteUrl: string, machineAliases: RemoteHostAliases): string {
  try {
    return canonicalRepositoryCoordinate(remoteUrl, machineAliases);
  } catch (error) {
    if (error instanceof RepositoryCoordinateError && error.message.includes("has no machine-local canonical-host mapping")) {
      throw new TargetTransferError(
        `Cannot verify Target ownership: ${context} remote "${remoteUrl}" uses an SSH host alias with no machine-local canonical-host mapping. ` +
          "Declare the alias in the root's targets.local.yaml or use a canonical remote_url; the transfer is refused fail-closed.",
      );
    }
    throw new TargetTransferError(
      `Cannot verify Target ownership: ${context} remote "${remoteUrl}" cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}. The transfer is refused fail-closed.`,
    );
  }
}

interface RootSnapshot {
  rootsMap: Record<string, string>;
  sourceRootPath: string;
  destinationRootPath: string;
}

function loadRoots(installationConfigPath: string | undefined, record: Pick<TransferRecord, "transfer_id" | "source_root" | "destination_root">): RootSnapshot {
  const configPath = installationConfigPath ?? defaultInstallationConfigPath();
  const installation = loadInstallationConfig(configPath);
  const rootsMap = normalizeKnowledgeRoots(installation).roots;
  const selected = (name: string): string => {
    try {
      return resolveInstallationRoot(installation, name).path;
    } catch (error) {
      throw new TargetTransferError(`transfer "${record.transfer_id}" refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return { rootsMap, sourceRootPath: selected(record.source_root), destinationRootPath: selected(record.destination_root) };
}

function loadRegistryOrRefuse(record: Pick<TransferRecord, "transfer_id">, rootName: string, rootPath: string): TargetRegistry | undefined {
  const file = path.join(rootPath, "targets.yaml");
  if (!fs.existsSync(file)) return undefined;
  try {
    return loadTargetRegistry(rootPath);
  } catch (error) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the Target registry of root "${rootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}. ` +
        "Repair that registry and retry; the transfer is refused fail-closed.",
    );
  }
}

function rootAliasesOrRefuse(record: Pick<TransferRecord, "transfer_id">, rootName: string, rootPath: string): RemoteHostAliases {
  try {
    return loadRemoteHostAliases(rootPath);
  } catch (error) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the local Target mapping of root "${rootName}" is unreadable: ${error instanceof Error ? error.message : String(error)}. The transfer is refused fail-closed.`,
    );
  }
}

/** The coordinates a registry entry answers to: its canonical remote plus its
 * declared alias history. Alias entries must be canonical coordinates — a raw
 * SSH alias in the history is a broken proof. */
function entryCoordinates(context: string, remoteUrl: string, aliases: readonly string[], machineAliases: RemoteHostAliases): string[] {
  const coordinates = [canonicalizeOrRefuse(context, remoteUrl, machineAliases)];
  for (const alias of aliases) {
    try {
      assertCanonicalRepositoryCoordinate(alias);
    } catch (error) {
      throw new TargetTransferError(
        `Cannot verify Target ownership: ${context} keeps alias "${alias}" that is not a canonical repository coordinate: ${error instanceof Error ? error.message : String(error)}. The transfer is refused fail-closed.`,
      );
    }
    coordinates.push(alias);
  }
  return coordinates;
}

/** Step 3's validator — the same terminal rule as `assertTargetIdsImmutable`:
 * a task is non-terminal while it is neither cancelled nor DEPLOYED. The
 * store is opened read-only (a missing store means no durable tasks), so the
 * proof never mutates the source root. */
function nonTerminalTasksBoundTo(record: Pick<TransferRecord, "transfer_id">, sourceRootPath: string, targetId: string): Array<{ taskId: string; state: string }> {
  const db = path.join(sourceRootPath, ".workflow", "state.db");
  if (!fs.existsSync(db)) return [];
  let store: SqliteTaskStore;
  try {
    store = new SqliteTaskStore(db, { readonly: true });
  } catch (error) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the source root's task store cannot be read to prove step 3: ${error instanceof Error ? error.message : String(error)} — retry after the writer closes; the transfer is refused fail-closed`,
    );
  }
  try {
    return store
      .listTasks()
      .filter((task) => !task.cancelled && task.machine.current !== TaskState.DEPLOYED)
      .filter((task) => task.targetBindings.targets.some((binding) => binding.target_id === targetId))
      .map((task) => ({ taskId: task.taskId, state: task.machine.current as string }));
  } finally {
    store.close();
  }
}

/** Step 4's validator — the module docs a released tombstone must not stay in. */
function moduleRefsDeclaring(sourceRootPath: string, targetId: string): string[] {
  const refs: string[] = [];
  for (const moduleName of listModules(sourceRootPath)) {
    const resolution = resolveModuleTargets(moduleName, sourceRootPath, { frameworkRoot: defaultProjectRoot() });
    if (resolution.declaredTargetIds.includes(targetId)) refs.push(moduleName);
  }
  return refs;
}

export interface TransferPlanInput {
  sourceRoot: string;
  sourceTargetId: string;
  destinationRoot: string;
  destinationTargetId?: string;
  installationConfigPath?: string;
}

export interface TransferPlan {
  sourceRoot: string;
  destinationRoot: string;
  sourceTargetId: string;
  destinationTargetId: string;
  sourceEntry: { status: string; ownership_state: string; remote_url: string; repository_aliases: string[] } | null;
  sourceCoordinates: string[];
  destinationExistingEntry: { target_id: string; status: string; ownership_state: string; remote_url: string; repository_aliases: string[] } | null;
  destinationAlreadyCoversSource: boolean;
  aliasHistoryForDestination: string[];
  nonTerminalTasks: Array<{ taskId: string; state: string }>;
  moduleRefs: string[];
  scopedKnowledgeItems: Array<{ id: string; module: string | null; kind: string }>;
  localMappings: { source: string | null; destination: string | null };
  recordTemplate: string;
}

function planRefusalTag(input: TransferPlanInput): Pick<TransferRecord, "transfer_id"> {
  return { transfer_id: `plan-${input.sourceRoot}-${input.sourceTargetId}` };
}

/** Step 1 — the read-only plan. It collects everything steps 2–8 need to
 * decide and never writes: registries, task store and knowledge are only read. */
export function planTargetOwnershipTransfer(input: TransferPlanInput): TransferPlan {
  const tag = planRefusalTag(input);
  const installation = loadInstallationConfig(input.installationConfigPath ?? defaultInstallationConfigPath());
  const rootsMap = normalizeKnowledgeRoots(installation).roots;
  const selected = (name: string): string => resolveInstallationRoot(installation, name).path;
  const sourceRootPath = selected(input.sourceRoot);
  const destinationRootPath = selected(input.destinationRoot);
  const destinationTargetId = input.destinationTargetId ?? input.sourceTargetId;

  const sourceRegistry = loadRegistryOrRefuse(tag, input.sourceRoot, sourceRootPath);
  const normalizedSource = sourceRegistry ? normalizeTargetRegistry(sourceRegistry) : undefined;
  const sourceEntry = normalizedSource?.targets.find((target) => target.target_id === input.sourceTargetId);
  if (sourceEntry === undefined) {
    throw new TargetTransferError(`plan refused: unknown Target "${input.sourceTargetId}" in root "${input.sourceRoot}"`);
  }
  const sourceAliases = rootAliasesOrRefuse(tag, input.sourceRoot, sourceRootPath);
  const sourceCoordinates = entryCoordinates(`Target "${input.sourceTargetId}" in root "${input.sourceRoot}"`, sourceEntry.remote_url, sourceEntry.repository_aliases, sourceAliases);

  const destinationRegistry = loadRegistryOrRefuse(tag, input.destinationRoot, destinationRootPath);
  const normalizedDestination = destinationRegistry ? normalizeTargetRegistry(destinationRegistry) : undefined;
  const destinationEntry = normalizedDestination?.targets.find((target) => target.target_id === destinationTargetId) ?? null;

  const destinationAliases = rootAliasesOrRefuse(tag, input.destinationRoot, destinationRootPath);
  let destinationCoordinate: string | undefined;
  if (destinationEntry !== null) {
    destinationCoordinate = canonicalizeOrRefuse(`destination Target "${destinationEntry.target_id}"`, destinationEntry.remote_url, destinationAliases);
  }
  const destinationIdentity = new Set<string>([...(destinationCoordinate !== undefined ? [destinationCoordinate] : []), ...(destinationEntry?.repository_aliases ?? [])]);
  const destinationAlreadyCoversSource = sourceCoordinates.every((coordinate) => destinationIdentity.has(coordinate));

  const aliasHistoryForDestination =
    destinationAlreadyCoversSource || destinationCoordinate === undefined
      ? []
      : sourceCoordinates.filter((coordinate) => coordinate !== destinationCoordinate && !destinationIdentity.has(coordinate));

  const nonTerminalTasks = nonTerminalTasksBoundTo(tag, sourceRootPath, input.sourceTargetId);
  const moduleRefs = moduleRefsDeclaring(sourceRootPath, input.sourceTargetId);

  const { items } = loadKnowledge(sourceRootPath);
  const scopedKnowledgeItems = items
    .filter((item) => (item.target_ids ?? []).includes(input.sourceTargetId))
    .map((item) => ({ id: qualifiedKnowledgeId(item), module: item.module, kind: item.kind }));

  const declaredSource = declaredCheckoutPaths(sourceRootPath);
  const declaredDestination = declaredCheckoutPaths(destinationRootPath);

  return {
    sourceRoot: input.sourceRoot,
    destinationRoot: input.destinationRoot,
    sourceTargetId: input.sourceTargetId,
    destinationTargetId,
    sourceEntry: {
      status: sourceEntry.status,
      ownership_state: sourceEntry.ownership_state,
      remote_url: sourceEntry.remote_url,
      repository_aliases: [...sourceEntry.repository_aliases],
    },
    sourceCoordinates,
    destinationExistingEntry:
      destinationEntry === null
        ? null
        : {
            target_id: destinationEntry.target_id,
            status: destinationEntry.status,
            ownership_state: destinationEntry.ownership_state,
            remote_url: destinationEntry.remote_url,
            repository_aliases: [...destinationEntry.repository_aliases],
          },
    destinationAlreadyCoversSource,
    aliasHistoryForDestination,
    nonTerminalTasks,
    moduleRefs,
    scopedKnowledgeItems,
    localMappings: { source: declaredSource[input.sourceTargetId] ?? null, destination: declaredDestination[destinationTargetId] ?? null },
    recordTemplate: recordTemplate({
      sourceRoot: input.sourceRoot,
      sourceTargetId: input.sourceTargetId,
      destinationRoot: input.destinationRoot,
      destinationTargetId,
      destinationRepositoryAliases: aliasHistoryForDestination,
    }),
  };
}

function recordTemplate(plan: {
  sourceRoot: string;
  sourceTargetId: string;
  destinationRoot: string;
  destinationTargetId: string;
  destinationRepositoryAliases: string[];
}): string {
  return [
    "# Transfer approval record (DT §5.2) — a person fills every `<fill in …>` field;",
    "# agents never approve. Save the file, then run: sta transfer release --transfer <path>",
    "schema_version: 1",
    "transfer_id: <fill in: a lowercase-slug name for this transfer>",
    `source_root: ${plan.sourceRoot}`,
    `source_target_id: ${plan.sourceTargetId}`,
    `destination_root: ${plan.destinationRoot}`,
    `destination_target_id: ${plan.destinationTargetId}`,
    "destination_name: <fill in: the display name of the destination Target>",
    "destination_remote_url: <fill in: the remote the destination registers (the same repository)>",
    `destination_repository_aliases: [${plan.destinationRepositoryAliases.map((alias) => JSON.stringify(alias)).join(", ")}]`,
    "source_approved_by: <fill in: the person approving the release for the source root>",
    "destination_approved_by: <fill in: the person approving for the destination root>",
    "confirmed_transfer_not_fork_or_mirror: false  # set true only after step 2's confirmation",
    "status: pending",
    "",
  ].join("\n");
}

export interface TransferOpInput {
  transferRecordPath: string;
  installationConfigPath?: string;
}

/** Steps 2/3/4 checks, then step 6: the source entry becomes a
 * `retired + released` tombstone through the administrative writer. The
 * entry itself is never deleted and its `remote_url`/aliases stay readable —
 * that is what makes the tombstone resolve the archived knowledge. */
export function releaseTargetForTransfer(input: TransferOpInput): { sourceRoot: string; targetId: string; registryPath: string } {
  const record = loadTransferRecord(input.transferRecordPath);
  if (record.status !== "pending") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: the record status is "${record.status}" — the release runs on a "pending" record only`);
  }
  const roots = loadRoots(input.installationConfigPath, record);
  const sourceRegistry = loadRegistryOrRefuse(record, record.source_root, roots.sourceRootPath);
  if (sourceRegistry === undefined) {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: root "${record.source_root}" has no Target registry`);
  }
  const normalized = normalizeTargetRegistry(sourceRegistry);
  const sourceEntry = normalized.targets.find((target) => target.target_id === record.source_target_id);
  if (sourceEntry === undefined) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the record names Target "${record.source_target_id}" in source root "${record.source_root}", but the registry holds "${normalized.targets.map((target) => target.target_id).join(", ") || "nothing"}"`,
    );
  }
  if (sourceEntry.ownership_state === "released") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: Target "${record.source_target_id}" in root "${record.source_root}" is already a released tombstone`);
  }

  // Identity proof: the record's destination must name the same repository
  // the source Target answers to, alias history included.
  const sourceAliases = rootAliasesOrRefuse(record, record.source_root, roots.sourceRootPath);
  const sourceCoordinates = entryCoordinates(`source Target "${record.source_target_id}"`, sourceEntry.remote_url, sourceEntry.repository_aliases, sourceAliases);
  const destinationAliases = rootAliasesOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const destinationCoordinate = canonicalizeOrRefuse(`destination identity of transfer "${record.transfer_id}"`, record.destination_remote_url, destinationAliases);
  const destinationIdentity = new Set<string>([destinationCoordinate, ...record.destination_repository_aliases]);
  const uncovered = sourceCoordinates.filter((coordinate) => !destinationIdentity.has(coordinate));
  if (uncovered.length > 0) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the record's destination identity (${destinationCoordinate} + [${record.destination_repository_aliases.join(", ")}]) ` +
        `does not cover the source Target "${record.source_target_id}" coordinates (${sourceCoordinates.join(", ")}) — the record must name the same repository as the source Target`,
    );
  }

  // Steps 3/4 — a person settled the tasks and the module docs first; the
  // validators prove it rather than trust the record.
  const tasks = nonTerminalTasksBoundTo(record, roots.sourceRootPath, record.source_target_id);
  if (tasks.length > 0) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: non-terminal task(s) still bind Target "${record.source_target_id}" in source root "${record.source_root}": ` +
        `${tasks.map((task) => `${task.taskId} (${task.state})`).join(", ")}. Terminate, cancel or close them and forbid new source tasks before the release (DT §5.2 step 3).`,
    );
  }
  const moduleRefs = moduleRefsDeclaring(roots.sourceRootPath, record.source_target_id);
  if (moduleRefs.length > 0) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: module docs in root "${record.source_root}" still declare Target "${record.source_target_id}": ${moduleRefs.join(", ")}. ` +
        "Amend each module (remove the declaration, move the contract, or re-declare) before the release (DT §5.2 step 4).",
    );
  }

  // Fresh re-read: a registry that moved under us is not written on.
  const current = loadTargetRegistry(roots.sourceRootPath);
  if (JSON.stringify(current) !== JSON.stringify(sourceRegistry)) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the Target registry of root "${record.source_root}" changed during the release — nothing was written; re-run the release`,
    );
  }
  const next: TargetRegistry = {
    schema_version: 2,
    targets: normalized.targets.map((target) =>
      target.target_id === record.source_target_id ? { ...target, status: "retired" as const, ownership_state: "released" as const } : target,
    ),
  };
  writeTargetRegistry(roots.sourceRootPath, next, { ownership: { channel: "register-flow", operation: "transfer-release" } });
  updateTransferRecordStatus(input.transferRecordPath, record, "released");
  return { sourceRoot: record.source_root, targetId: record.source_target_id, registryPath: path.join(roots.sourceRootPath, "targets.yaml") };
}

export interface TransferRegisterResult {
  destinationRoot: string;
  targetId: string;
  canonicalCoordinate: string;
  operation: "addition" | "already-current";
}

/** Step 7 — the destination becomes the owner, with alias history when the
 * remote moved. The write goes through the six-step register flow; a
 * destination entry that already matches the record makes the operation an
 * idempotent no-write (the repair case where the destination registered
 * first). */
export function registerDestinationForTransfer(input: TransferOpInput): TransferRegisterResult {
  const record = loadTransferRecord(input.transferRecordPath);
  if (record.status !== "released") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: the record status is "${record.status}" — the destination register runs on a "released" record (the step 6 release must happen first)`);
  }
  const roots = loadRoots(input.installationConfigPath, record);
  const sourceRegistry = loadRegistryOrRefuse(record, record.source_root, roots.sourceRootPath);
  const sourceEntry = sourceRegistry ? normalizeTargetRegistry(sourceRegistry).targets.find((target) => target.target_id === record.source_target_id) : undefined;
  if (sourceEntry === undefined || sourceEntry.ownership_state !== "released") {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: Target "${record.source_target_id}" in source root "${record.source_root}" is not a released tombstone — the register runs after the release`,
    );
  }
  const destinationAliases = rootAliasesOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const destinationCoordinate = canonicalizeOrRefuse(`destination identity of transfer "${record.transfer_id}"`, record.destination_remote_url, destinationAliases);
  const destinationRegistry = loadRegistryOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const existing = destinationRegistry
    ? (() => {
        try {
          return targetById(destinationRegistry, record.destination_target_id);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (existing !== undefined) {
    const existingNormalized = normalizeTargetRegistry(destinationRegistry as TargetRegistry).targets.find((target) => target.target_id === record.destination_target_id)!;
    const existingCoordinate = canonicalizeOrRefuse(`destination Target "${existing.target_id}"`, existing.remote_url, destinationAliases);
    const sameIdentity =
      existingNormalized.ownership_state === "owned" &&
      existingCoordinate === destinationCoordinate &&
      JSON.stringify([...existingNormalized.repository_aliases].sort()) === JSON.stringify([...record.destination_repository_aliases].sort());
    if (!sameIdentity) {
      throw new TargetTransferError(
        `transfer "${record.transfer_id}" refused: Target "${record.destination_target_id}" already exists in root "${record.destination_root}" and does not match the record's destination identity — ` +
          "resolve the difference by hand-review of the record and the registry; nothing was written",
      );
    }
    return { destinationRoot: record.destination_root, targetId: record.destination_target_id, canonicalCoordinate: destinationCoordinate, operation: "already-current" };
  }
  const registration = registerTarget({
    targetId: record.destination_target_id,
    name: record.destination_name,
    remoteUrl: record.destination_remote_url,
    type: record.destination_type,
    rootName: record.destination_root,
    repositoryAliases: record.destination_repository_aliases,
    installationConfigPath: input.installationConfigPath,
  });
  return { destinationRoot: record.destination_root, targetId: record.destination_target_id, canonicalCoordinate: registration.canonicalCoordinate, operation: "addition" };
}

/** Step 7's fallback — the release is undone with the same approval record.
 * It refuses once any root owns the transferred coordinates: rolling back
 * then would recreate exactly the duplicate the transfer exists to resolve. */
export function rollbackTargetTransfer(input: TransferOpInput): { sourceRoot: string; targetId: string } {
  const record = loadTransferRecord(input.transferRecordPath);
  if (record.status !== "released") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: the record status is "${record.status}" — the rollback undoes a release (nothing to roll back)`);
  }
  const roots = loadRoots(input.installationConfigPath, record);
  const sourceRegistry = loadRegistryOrRefuse(record, record.source_root, roots.sourceRootPath);
  const sourceEntry = sourceRegistry ? normalizeTargetRegistry(sourceRegistry).targets.find((target) => target.target_id === record.source_target_id) : undefined;
  if (sourceEntry === undefined || sourceEntry.ownership_state !== "released") {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: Target "${record.source_target_id}" in source root "${record.source_root}" is not a released tombstone — nothing to roll back`,
    );
  }

  const destinationAliases = rootAliasesOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const destinationCoordinate = canonicalizeOrRefuse(`destination identity of transfer "${record.transfer_id}"`, record.destination_remote_url, destinationAliases);
  const destinationIdentity = new Set<string>([destinationCoordinate, ...record.destination_repository_aliases]);
  const rootNames = Object.keys(roots.rootsMap).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const rootName of rootNames) {
    const registry = loadRegistryOrRefuse(record, rootName, roots.rootsMap[rootName] as string);
    if (registry === undefined) continue;
    const rootAliases = rootAliasesOrRefuse(record, rootName, roots.rootsMap[rootName] as string);
    for (const target of normalizeTargetRegistry(registry).targets) {
      if (target.ownership_state === "released") continue;
      const coordinates = entryCoordinates(`Target "${target.target_id}" in root "${rootName}"`, target.remote_url, target.repository_aliases, rootAliases);
      if (coordinates.some((coordinate) => destinationIdentity.has(coordinate))) {
        throw new TargetTransferError(
          `transfer "${record.transfer_id}" refused: root "${rootName}" (Target "${target.target_id}") already owns the transferred coordinates — the transfer is past rollback; ` +
            "verify and complete it, or resolve by hand-review",
        );
      }
    }
  }

  const current = loadTargetRegistry(roots.sourceRootPath);
  if (JSON.stringify(current) !== JSON.stringify(sourceRegistry)) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" refused: the Target registry of root "${record.source_root}" changed during the rollback — nothing was written; re-run the rollback`,
    );
  }
  const next: TargetRegistry = {
    schema_version: 2,
    targets: normalizedTargetsOf(sourceRegistry as TargetRegistry).map((target) =>
      target.target_id === record.source_target_id ? { ...target, ownership_state: "owned" as const } : target,
    ),
  };
  writeTargetRegistry(roots.sourceRootPath, next, { ownership: { channel: "register-flow", operation: "transfer-rollback" } });
  updateTransferRecordStatus(input.transferRecordPath, record, "rolled_back");
  return { sourceRoot: record.source_root, targetId: record.source_target_id };
}

function normalizedTargetsOf(registry: TargetRegistry) {
  return normalizeTargetRegistry(registry).targets.map((target) => ({ ...target }));
}

export interface TransferVerifyVerdict {
  complete: boolean;
  audit: OwnershipAuditResult;
  knowledgeChecks: Array<{ root: string; ok: boolean; problems: string[] }>;
  moduleChecks: Array<{ root: string; errors: string[]; warnings: string[] }>;
  problems: string[];
  completed: boolean;
}

/** Step 9 — the pair proof plus the doctor-grade checks on both roots. The
 * record is marked completed only when everything is clean; a person still
 * accepts the result before the transfer is treated as done. */
export function verifyTargetTransfer(input: TransferOpInput): TransferVerifyVerdict {
  const record = loadTransferRecord(input.transferRecordPath);
  if (record.status !== "released" && record.status !== "completed") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: the record status is "${record.status}" — verify runs after the release`);
  }
  const roots = loadRoots(input.installationConfigPath, record);
  const sourceRegistry = loadRegistryOrRefuse(record, record.source_root, roots.sourceRootPath);
  const sourceEntry = sourceRegistry ? normalizeTargetRegistry(sourceRegistry).targets.find((target) => target.target_id === record.source_target_id) : undefined;
  if (sourceEntry === undefined || sourceEntry.ownership_state !== "released") {
    throw new TargetTransferError(`transfer "${record.transfer_id}" refused: Target "${record.source_target_id}" in source root "${record.source_root}" is not a released tombstone`);
  }

  const sourceAliases = rootAliasesOrRefuse(record, record.source_root, roots.sourceRootPath);
  const sourceCoordinates = entryCoordinates(`source Target "${record.source_target_id}"`, sourceEntry.remote_url, sourceEntry.repository_aliases, sourceAliases);
  const destinationAliases = rootAliasesOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const destinationCoordinate = canonicalizeOrRefuse(`destination identity of transfer "${record.transfer_id}"`, record.destination_remote_url, destinationAliases);
  const destinationRegistry = loadRegistryOrRefuse(record, record.destination_root, roots.destinationRootPath);
  const destinationEntry = destinationRegistry
    ? normalizeTargetRegistry(destinationRegistry).targets.find((target) => target.target_id === record.destination_target_id)
    : undefined;
  const destinationIdentity = new Set<string>([destinationCoordinate, ...record.destination_repository_aliases]);
  const paired =
    destinationEntry !== undefined &&
    destinationEntry.ownership_state === "owned" &&
    (() => {
      const ownedCoordinates = entryCoordinates(
        `destination Target "${destinationEntry.target_id}"`,
        destinationEntry.remote_url,
        destinationEntry.repository_aliases,
        destinationAliases,
      );
      return sourceCoordinates.every((coordinate) => destinationIdentity.has(coordinate) || ownedCoordinates.includes(coordinate));
    })();
  if (!paired) {
    throw new TargetTransferError(
      `transfer "${record.transfer_id}" is not complete: source released, but no owning destination pair in root "${record.destination_root}" — ` +
        "run the destination register (step 7) or roll the release back; the intermediate state refuses both roots",
    );
  }

  const audit = auditTargetOwnershipAcrossRoots({ installationConfigPath: input.installationConfigPath });
  const knowledgeChecks = [record.source_root, record.destination_root].map((rootName) => {
    const report = checkKnowledge(roots.rootsMap[rootName] as string);
    return { root: rootName, ok: report.ok, problems: [...report.problems] };
  });
  const moduleChecks = [record.source_root, record.destination_root].map((rootName) => {
    const rootPath = roots.rootsMap[rootName] as string;
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const moduleName of listModules(rootPath)) {
      const resolution = resolveModuleTargets(moduleName, rootPath, { frameworkRoot: defaultProjectRoot() });
      for (const problem of resolution.problems) {
        if (problem.severity === "error") errors.push(problem.message);
        else if (problem.severity === "warning") warnings.push(problem.message);
      }
    }
    return { root: rootName, errors, warnings };
  });

  const problems: string[] = [];
  if (audit.status === "FAIL") problems.push(...audit.problems);
  for (const check of knowledgeChecks) problems.push(...check.problems.map((problem) => `knowledge in root "${check.root}": ${problem}`));
  for (const check of moduleChecks) problems.push(...check.errors.map((error) => `module docs in root "${check.root}": ${error}`));

  const completed = problems.length === 0;
  if (completed && record.status !== "completed") {
    updateTransferRecordStatus(input.transferRecordPath, record, "completed");
  }
  return { complete: true, audit, knowledgeChecks, moduleChecks, problems, completed };
}
