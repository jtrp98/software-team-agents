import * as fs from "node:fs";
import * as path from "node:path";
import { ArtifactType, validateArtifact, LegacyExecutionPacketSchema, type LegacyExecutionPacket, type ExecutionPacket } from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";
import { FindingSchema, RepairPacketSchema, assertCanTransitionFinding, type Finding, type RepairPacket } from "../artifacts/finding.js";

/** Regenerable artifact classes stored below the VCS-ignored runtime-state root. */
export const RUNTIME_ARTIFACT_KINDS = ["packets", "evidence", "runs", "wave-runs", "findings", "repair-packets"] as const;
export type RuntimeArtifactKind = (typeof RUNTIME_ARTIFACT_KINDS)[number];

/**
 * A deliberately small bounded default. Callers may lower or raise it per
 * installation, but unconfigured runs retain at most ten artifacts of each
 * kind per task instead of growing `.workflow/` without bound.
 */
export const DEFAULT_RUNTIME_ARTIFACT_RETENTION = 10;

export interface RuntimeArtifactPaths {
  readonly packets: string;
  readonly evidence: string;
  readonly runs: string;
  readonly findings: string;
  readonly repairPackets: string;
}

function taskPathSegment(taskId: string): string {
  const trimmed = taskId.trim();
  if (trimmed.length === 0) throw new Error("runtime artifact task id must not be empty");
  if (trimmed === "." || trimmed === "..") throw new Error(`runtime artifact task id "${taskId}" is not safe`);
  // Encoding keeps readable ordinary ids (`T-1`) unchanged while ensuring a
  // slash, backslash or platform-reserved punctuation cannot create a child
  // outside this task's directory.
  return encodeURIComponent(trimmed);
}

/**
 * Resolves all runtime-state homes for one task without creating them. Writers
 * create the selected directory lazily only when an artifact actually exists.
 */
export function runtimeArtifactPaths(projectRoot: string, taskId: string): RuntimeArtifactPaths {
  const workflowRoot = path.resolve(projectRoot, ".workflow");
  const task = taskPathSegment(taskId);
  return {
    packets: path.join(workflowRoot, "packets", task),
    evidence: path.join(workflowRoot, "evidence", task),
    runs: path.join(workflowRoot, "runs", task),
    findings: path.join(workflowRoot, "findings", task),
    repairPackets: path.join(workflowRoot, "repair-packets", task),
  };
}

export interface PruneRuntimeArtifactsOptions {
  /** One task/kind directory returned by `runtimeArtifactPaths`. */
  readonly taskDirectory: string;
  /** Current run's artifact. It must be a direct child and is always retained. */
  readonly currentArtifact: string;
  /** Maximum artifacts retained for this task and kind, including the current one. */
  readonly maxRunsPerTask?: number;
  /** Existing task artifacts are files; durable wave runs are direct child directories. */
  readonly artifactType?: "file" | "directory";
}

/**
 * Keeps the current artifact plus the newest remaining siblings by mtime, with a
 * filename tie-break so equal timestamps prune identically on every run.
 * Symlinks are never followed or removed. Directory pruning is opt-in so the
 * established task-keyed file behaviour cannot change accidentally.
 *
 * Returns deleted absolute paths in deterministic filename order.
 */
export function pruneRuntimeArtifacts(options: PruneRuntimeArtifactsOptions): string[] {
  const limit = options.maxRunsPerTask ?? DEFAULT_RUNTIME_ARTIFACT_RETENTION;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runtime artifact retention must be a positive integer, got ${String(limit)}`);
  }

  const taskDirectory = path.resolve(options.taskDirectory);
  const currentArtifact = path.resolve(
    path.isAbsolute(options.currentArtifact) ? options.currentArtifact : path.join(taskDirectory, options.currentArtifact),
  );
  if (path.dirname(currentArtifact) !== taskDirectory) {
    throw new Error(`current runtime artifact must be a direct child of ${taskDirectory}`);
  }
  const currentStat = fs.lstatSync(currentArtifact);
  const artifactType = options.artifactType ?? "file";
  const currentMatches = artifactType === "file" ? currentStat.isFile() : currentStat.isDirectory();
  if (currentStat.isSymbolicLink() || !currentMatches) {
    throw new Error(`current runtime artifact is not a ${artifactType}: ${currentArtifact}`);
  }

  const files = fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => artifactType === "file" ? entry.isFile() : entry.isDirectory())
    .map((entry) => {
      const absolute = path.join(taskDirectory, entry.name);
      return { name: entry.name, absolute, mtimeMs: fs.statSync(absolute).mtimeMs };
    });

  const keep = new Set<string>([currentArtifact]);
  const newest = files
    .filter((entry) => entry.absolute !== currentArtifact)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  for (const entry of newest) {
    if (keep.size >= limit) break;
    keep.add(entry.absolute);
  }

  const removed = files
    .filter((entry) => !keep.has(entry.absolute))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of removed) {
    if (artifactType === "file") fs.unlinkSync(entry.absolute);
    else fs.rmSync(entry.absolute, { recursive: true });
  }
  return removed.map((entry) => entry.absolute);
}

function canonicalProspectivePath(candidate: string): string {
  let existing = path.resolve(candidate);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`cannot resolve runtime artifact ancestor for ${candidate}`);
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), ...tail);
}

function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Refuses packet storage whose physical path would enter Knowledge or any
 * resolved Target root. The prospective-path resolution also catches an
 * existing `.workflow` symlink/junction before a packet is written.
 */
export function assertPacketStorageOwnership(
  packetPath: string,
  forbiddenRoots: readonly string[],
  runtimeStateRoot?: string,
): void {
  const canonicalPacket = canonicalProspectivePath(packetPath);
  if (runtimeStateRoot) {
    const canonicalRuntimeRoot = fs.realpathSync.native(path.resolve(runtimeStateRoot));
    if (!pathIsInside(canonicalPacket, canonicalRuntimeRoot)) {
      throw new Error(`execution packet storage escapes Local Runtime State root ${canonicalRuntimeRoot}: ${canonicalPacket}`);
    }
  }
  for (const root of forbiddenRoots) {
    const canonicalRoot = fs.realpathSync.native(path.resolve(root));
    if (pathIsInside(canonicalPacket, canonicalRoot)) {
      throw new Error(`execution packet storage must remain Local Runtime State; ${canonicalPacket} resolves inside ${canonicalRoot}`);
    }
  }
}

function stageFilePrefix(stage: AgentStage): string {
  return `${stage}-`;
}

function nextPacketAttempt(taskDirectory: string, stage: AgentStage): number {
  if (!fs.existsSync(taskDirectory)) return 1;
  const prefix = stageFilePrefix(stage);
  const attempts = fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => Number(entry.name.slice(prefix.length, -".json".length)))
    .filter((attempt) => Number.isInteger(attempt) && attempt > 0);
  return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
}

export function nextExecutionPacketAttempt(projectRoot: string, taskId: string, stage: AgentStage): number {
  return nextPacketAttempt(runtimeArtifactPaths(projectRoot, taskId).packets, stage);
}

export interface WriteExecutionPacketOptions {
  projectRoot: string;
  packet: ExecutionPacket;
  /** Canonical Knowledge and Target roots resolved by three-repo preflight. */
  forbiddenRoots?: readonly string[];
  maxRunsPerTask?: number;
}

export interface PersistedExecutionPacket {
  path: string;
  attempt: number;
  removed: string[];
}

/** Validates, writes atomically-by-name, validates from disk, then prunes. */
export function writeExecutionPacket(options: WriteExecutionPacketOptions): PersistedExecutionPacket {
  if (options.maxRunsPerTask !== undefined && (!Number.isInteger(options.maxRunsPerTask) || options.maxRunsPerTask < 1)) {
    throw new Error(`runtime artifact retention must be a positive integer, got ${String(options.maxRunsPerTask)}`);
  }
  const packet = validateArtifact(ArtifactType.EXECUTION_PACKET, options.packet);
  const taskDirectory = runtimeArtifactPaths(options.projectRoot, packet.task_id).packets;
  const attempt = packet.attempt;
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  fs.mkdirSync(taskDirectory, { recursive: true });

  // Re-resolve after mkdir so a pre-existing junction cannot become trusted by
  // virtue of the directory now existing.
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  const packetPath = path.join(taskDirectory, `${stageFilePrefix(packet.stage)}${attempt}.json`);
    assertPacketStorageOwnership(packetPath, options.forbiddenRoots ?? [], options.projectRoot);
    try {
      const fd = fs.openSync(packetPath, "wx");
      try { fs.writeFileSync(fd, `${JSON.stringify(packet, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readExecutionPacket(packetPath);
      if (existing.packet_hash !== packet.packet_hash) throw new Error(`immutable packet drift for ${packet.task_id}/${packet.stage}/attempt ${attempt}; create an explicit new attempt`);
      return { path: packetPath, attempt, removed: [] };
    }

  // A packet is not considered persisted until the on-disk bytes pass the
  // same public artifact schema used at compile time.
  readExecutionPacket(packetPath);
  const removed = pruneRuntimeArtifacts({
    taskDirectory,
    currentArtifact: packetPath,
    maxRunsPerTask: options.maxRunsPerTask,
  });
  return { path: packetPath, attempt, removed };
}

export function readExecutionPacket(packetPath: string, expected?: { packetHash?: string; baseRevision?: string; planHash?: string; configHash?: string; compilerHash?: string }): ExecutionPacket {
  const stat = fs.lstatSync(packetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`execution packet is not a regular file: ${packetPath}`);
  const raw = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  if (raw.version !== 2) throw new Error("legacy packet is audit-only; explicitly recompile in a new attempt before execution");
  const packet = validateArtifact(ArtifactType.EXECUTION_PACKET, raw);
  for (const [name, actual, wanted] of [
    ["packet", packet.packet_hash, expected?.packetHash], ["base revision", packet.identity.base_revision, expected?.baseRevision],
    ["plan", packet.identity.plan_hash, expected?.planHash], ["config", packet.identity.config_hash, expected?.configHash],
    ["compiler", packet.identity.compiler_hash, expected?.compilerHash],
  ]) if (wanted !== undefined && actual !== wanted) throw new Error(`${name} hash/revision drift; recompile in a new attempt`);
  return packet;
}

export function readExecutionPacketForAudit(packetPath: string): ExecutionPacket | LegacyExecutionPacket {
  const stat = fs.lstatSync(packetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`execution packet is not a regular file: ${packetPath}`);
  const raw = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  return raw.version === 2 ? readExecutionPacket(packetPath) : LegacyExecutionPacketSchema.parse(raw);
}

/** Latest regular packet for a stage, ordered by its numeric attempt. */
export function latestExecutionPacketPath(projectRoot: string, taskId: string, stage: AgentStage): string | null {
  const taskDirectory = runtimeArtifactPaths(projectRoot, taskId).packets;
  if (!fs.existsSync(taskDirectory)) return null;
  const prefix = stageFilePrefix(stage);
  const candidates = fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => ({
      path: path.join(taskDirectory, entry.name),
      attempt: Number(entry.name.slice(prefix.length, -".json".length)),
    }))
    .filter((entry) => Number.isInteger(entry.attempt) && entry.attempt > 0)
    .sort((a, b) => b.attempt - a.attempt);
  return candidates[0]?.path ?? null;
}

// -- T-V8-013: durable finding and repair-packet persistence ----------------
//
// A `Finding` is unlike a packet: its identity (`finding_id`) is fixed at
// creation, but its `status` field is expected to change over its lifecycle
// (OPEN -> FIX_CLAIMED -> VERIFIED -> ACCEPTED). Packet storage's
// write-once/drift-refuses-silently model is therefore the wrong shape here —
// `writeFinding` instead keeps exactly one file per `finding_id` (so a
// re-derived duplicate — same defect, different attempt — always resolves to
// the same path, satisfying "IDs survive review archive/rewrite and resolve
// to one attempt/packet"), and every write after the first must pass
// `assertCanTransitionFinding` against the record already on disk before it
// is allowed to land. That is the actual enforcement point for "DEV cannot
// close QA/security findings": the check runs here, at the only place a
// status change becomes durable, not merely in an in-memory helper nothing
// is obliged to call.

export function readFindingRecord(findingPath: string): Finding {
  const stat = fs.lstatSync(findingPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`finding record is not a regular file: ${findingPath}`);
  return FindingSchema.parse(JSON.parse(fs.readFileSync(findingPath, "utf8")));
}

export interface WriteFindingOptions {
  projectRoot: string;
  finding: Finding;
  /** Who is making this write — checked against the finding's own transition rule when a prior record exists. */
  actor: AgentStage | "human";
  forbiddenRoots?: readonly string[];
}

export interface PersistedFinding {
  path: string;
  /** False when this write updated an existing record's status rather than raising a new finding. */
  created: boolean;
}

/**
 * The fields that describe the defect itself — they must not change across
 * writes sharing a `finding_id`, or the identity that id names is a lie.
 * `run_id`/`attempt`/`packet_hash` are deliberately excluded: a resumed or
 * re-occurring defect legitimately carries a new one of each on every write
 * (that is the whole point of resolving to "one attempt" — the *current*
 * one), and `status`/`evidence_refs` are the fields its lifecycle exists to
 * change.
 */
function findingIdentityPayload(finding: Finding): Pick<Finding, "finding_id" | "task_id" | "category" | "owner" | "raised_by" | "severity" | "acceptance_ids" | "design_ids" | "files" | "expected" | "observed" | "retryable" | "requires_human"> {
  const { finding_id, task_id, category, owner, raised_by, severity, acceptance_ids, design_ids, files, expected, observed, retryable, requires_human } = finding;
  return { finding_id, task_id, category, owner, raised_by, severity, acceptance_ids, design_ids, files, expected, observed, retryable, requires_human };
}

export function writeFinding(options: WriteFindingOptions): PersistedFinding {
  const finding = FindingSchema.parse(options.finding);
  const taskDirectory = runtimeArtifactPaths(options.projectRoot, finding.task_id).findings;
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  fs.mkdirSync(taskDirectory, { recursive: true });
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  const findingPath = path.join(taskDirectory, `${finding.finding_id}.json`);
  assertPacketStorageOwnership(findingPath, options.forbiddenRoots ?? [], options.projectRoot);

  if (!fs.existsSync(findingPath)) {
    if (finding.status !== "OPEN") throw new Error(`finding ${finding.finding_id}: first persisted write must be OPEN, got ${finding.status}`);
    fs.writeFileSync(findingPath, `${JSON.stringify(finding, null, 2)}\n`, "utf8");
    return { path: findingPath, created: true };
  }

  const existing = readFindingRecord(findingPath);
  if (JSON.stringify(findingIdentityPayload(existing)) !== JSON.stringify(findingIdentityPayload(finding))) {
    throw new Error(
      `finding ${finding.finding_id}: identity fields differ from the persisted record — a defect's identity never changes after it is raised, only its status/evidence do; derive a new finding_id instead`,
    );
  }
  assertCanTransitionFinding(existing, finding.status, options.actor);
  fs.writeFileSync(findingPath, `${JSON.stringify(finding, null, 2)}\n`, "utf8");
  return { path: findingPath, created: false };
}

/** Every persisted finding for a task, oldest-id-first (deterministic, not creation-order dependent). */
export function readFindingsForTask(projectRoot: string, taskId: string): Finding[] {
  const taskDirectory = runtimeArtifactPaths(projectRoot, taskId).findings;
  if (!fs.existsSync(taskDirectory)) return [];
  return fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readFindingRecord(path.join(taskDirectory, entry.name)))
    .sort((a, b) => a.finding_id.localeCompare(b.finding_id));
}

export interface WriteRepairPacketOptions {
  projectRoot: string;
  packet: RepairPacket;
  forbiddenRoots?: readonly string[];
  maxRunsPerTask?: number;
}

export interface PersistedRepairPacket {
  path: string;
  removed: string[];
}

export function readRepairPacket(repairPacketPath: string): RepairPacket {
  const stat = fs.lstatSync(repairPacketPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`repair packet is not a regular file: ${repairPacketPath}`);
  return RepairPacketSchema.parse(JSON.parse(fs.readFileSync(repairPacketPath, "utf8")));
}

/**
 * Write-once and immutable, exactly like `writeExecutionPacket`: a repair
 * packet is a point-in-time compilation (original packet + finding + the
 * diff/evidence/delta at that moment), never edited after the fact. Named by
 * its own `repair_packet_hash` rather than an attempt counter, so recompiling
 * from identical inputs is idempotent (same file, no duplicate) while any
 * real change in the diff/evidence/delta lands as a new, separate file.
 */
export function writeRepairPacket(options: WriteRepairPacketOptions): PersistedRepairPacket {
  if (options.maxRunsPerTask !== undefined && (!Number.isInteger(options.maxRunsPerTask) || options.maxRunsPerTask < 1)) {
    throw new Error(`runtime artifact retention must be a positive integer, got ${String(options.maxRunsPerTask)}`);
  }
  const packet = RepairPacketSchema.parse(options.packet);
  const taskDirectory = runtimeArtifactPaths(options.projectRoot, packet.finding.task_id).repairPackets;
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  fs.mkdirSync(taskDirectory, { recursive: true });
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  const repairPacketPath = path.join(taskDirectory, `${packet.finding.finding_id}-${packet.repair_packet_hash.slice(0, 16)}.json`);
  assertPacketStorageOwnership(repairPacketPath, options.forbiddenRoots ?? [], options.projectRoot);

  try {
    const fd = fs.openSync(repairPacketPath, "wx");
    try { fs.writeFileSync(fd, `${JSON.stringify(packet, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readRepairPacket(repairPacketPath);
    if (existing.repair_packet_hash !== packet.repair_packet_hash) throw new Error(`immutable repair-packet drift for ${packet.finding.finding_id}; recompile as an explicit new repair packet`);
    return { path: repairPacketPath, removed: [] };
  }

  readRepairPacket(repairPacketPath);
  const removed = pruneRuntimeArtifacts({
    taskDirectory,
    currentArtifact: repairPacketPath,
    maxRunsPerTask: options.maxRunsPerTask,
  });
  return { path: repairPacketPath, removed };
}
