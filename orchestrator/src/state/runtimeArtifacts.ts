import * as fs from "node:fs";
import * as path from "node:path";
import { ArtifactType, validateArtifact, type ExecutionPacket } from "../artifacts/schemas.js";
import { AgentStage } from "../types.js";

/** Regenerable V3 artifact classes stored below the VCS-ignored runtime-state root. */
export const RUNTIME_ARTIFACT_KINDS = ["packets", "evidence", "runs"] as const;
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
  };
}

export interface PruneRuntimeArtifactsOptions {
  /** One task/kind directory returned by `runtimeArtifactPaths`. */
  readonly taskDirectory: string;
  /** Current run's artifact. It must be a direct child and is always retained. */
  readonly currentArtifact: string;
  /** Maximum artifacts retained for this task and kind, including the current one. */
  readonly maxRunsPerTask?: number;
}

/**
 * Keeps the current artifact plus the newest remaining files by mtime, with a
 * filename tie-break so equal timestamps prune identically on every run.
 * Directories and symlinks are never followed or removed.
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
  if (!currentStat.isFile()) throw new Error(`current runtime artifact is not a file: ${currentArtifact}`);

  const files = fs
    .readdirSync(taskDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
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
  for (const entry of removed) fs.unlinkSync(entry.absolute);
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
  let attempt = nextPacketAttempt(taskDirectory, packet.stage);
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  fs.mkdirSync(taskDirectory, { recursive: true });

  // Re-resolve after mkdir so a pre-existing junction cannot become trusted by
  // virtue of the directory now existing.
  assertPacketStorageOwnership(taskDirectory, options.forbiddenRoots ?? [], options.projectRoot);
  let packetPath: string;
  while (true) {
    packetPath = path.join(taskDirectory, `${stageFilePrefix(packet.stage)}${attempt}.json`);
    assertPacketStorageOwnership(packetPath, options.forbiddenRoots ?? [], options.projectRoot);
    try {
      fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      attempt += 1;
    }
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

export function readExecutionPacket(packetPath: string): ExecutionPacket {
  const stat = fs.lstatSync(packetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`execution packet is not a regular file: ${packetPath}`);
  return validateArtifact(ArtifactType.EXECUTION_PACKET, JSON.parse(fs.readFileSync(packetPath, "utf8")));
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
