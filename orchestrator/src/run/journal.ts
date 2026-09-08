import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanTaskRow } from "../docs/planGraph.js";
import { DEFAULT_RUNTIME_ARTIFACT_RETENTION, pruneRuntimeArtifacts } from "../state/runtimeArtifacts.js";

export interface RunManifest {
  run_id: string;
  created_at: string;
  target_root: string;
  target_id: string;
  knowledge_root: string;
  module: string;
  wave: number;
  plan_hash: string;
  task_order: string[];
  base_branch: string;
  base_sha: string;
  run_branch: string;
  runtime_id: string;
  tier: string;
  model: string;
  max_tasks: number;
  sta_version: string;
}

interface JournalBase {
  ts: string;
  task_id?: string;
}

export type KnownJournalRecord =
  | (JournalBase & { kind: "RUN_STARTED" })
  | (JournalBase & { kind: "RUN_ISOLATED" })
  | (JournalBase & { kind: "TASK_READY"; task_id: string })
  | (JournalBase & { kind: "TASK_STARTED"; task_id: string })
  | (JournalBase & { kind: "TASK_AGENT_DONE"; task_id: string })
  | (JournalBase & { kind: "GATE_RESULT"; task_id: string; result: "passed" | "failed" | "unverified"; summary?: string })
  | (JournalBase & { kind: "TASK_CHECKPOINTED"; task_id: string; sha: string })
  | (JournalBase & { kind: "TASK_FAILED"; task_id: string; reason: string; class: string })
  | (JournalBase & { kind: "RUN_HALTED"; reason: string })
  | (JournalBase & { kind: "RUN_COMPLETED" })
  | (JournalBase & { kind: "HUMAN_REVIEW_REQUIRED" })
  | (JournalBase & { kind: "RUN_REFUSED"; reason: string })
  | (JournalBase & { kind: "RUN_RESUMED"; reason: string })
  | (JournalBase & { kind: "RUN_STALE"; reason: string })
  | (JournalBase & { kind: "RUN_ABANDONED"; reason: string });

export interface UnknownJournalRecord extends JournalBase {
  kind: string;
  [key: string]: unknown;
}

export type JournalRecord = KnownJournalRecord | UnknownJournalRecord;

export interface RunArtifactPaths {
  directory: string;
  manifest: string;
  journal: string;
}

export interface JournalReadResult {
  records: JournalRecord[];
  truncatedFinalLine: boolean;
}

const KNOWN_RECORD_KINDS = new Set<KnownJournalRecord["kind"]>([
  "RUN_STARTED", "RUN_ISOLATED", "TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE", "GATE_RESULT",
  "TASK_CHECKPOINTED", "TASK_FAILED", "RUN_HALTED", "RUN_COMPLETED", "HUMAN_REVIEW_REQUIRED",
  "RUN_REFUSED", "RUN_RESUMED", "RUN_STALE", "RUN_ABANDONED",
]);

export function isKnownJournalRecord(record: JournalRecord): record is KnownJournalRecord {
  return KNOWN_RECORD_KINDS.has(record.kind as KnownJournalRecord["kind"]);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, length: number): string {
  let remaining = value;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result = CROCKFORD[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

/** A sortable 26-character identifier: 48-bit timestamp followed by 80 random bits. */
export function createRunId(now = Date.now, random = randomBytes): string {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error(`run timestamp is outside the 48-bit sortable range: ${String(timestamp)}`);
  }
  const entropy = random(10);
  if (entropy.length !== 10) throw new Error("run id entropy source must return exactly 10 bytes");
  let randomPart = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of entropy) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randomPart += CROCKFORD[Math.floor(accumulator / 2 ** bits) % 32];
      accumulator %= 2 ** bits;
    }
  }
  return `${encodeBase32(timestamp, 10)}${randomPart}`;
}

function safeRunSegment(runId: string): string {
  const trimmed = runId.trim();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(trimmed)) {
    throw new Error(`run id must be a 26-character ULID-style value, got "${runId}"`);
  }
  return trimmed;
}

/** Wave runs are a sibling kind because `.workflow/runs/` is task-keyed already. */
export function runArtifactPaths(projectRoot: string, runId: string): RunArtifactPaths {
  const directory = path.join(path.resolve(projectRoot), ".workflow", "wave-runs", safeRunSegment(runId));
  return {
    directory,
    manifest: path.join(directory, "manifest.json"),
    journal: path.join(directory, "journal.jsonl"),
  };
}

function stableTaskTable(tasks: readonly PlanTaskRow[]): unknown[] {
  return tasks.map((task) => ({
    id: task.id,
    phase: task.phase,
    designRefs: [...task.designRefs],
    dependsOn: [...task.dependsOn],
    status: task.status,
    owner: task.owner,
    wave: task.wave,
    tier: task.tier ?? null,
    description: task.description,
    fromCheckbox: task.fromCheckbox,
    produces: task.produces === undefined ? null : [...task.produces],
    consumes: task.consumes === undefined ? null : [...task.consumes],
  }));
}

export function planHash(tasks: readonly PlanTaskRow[]): string {
  return createHash("sha256").update(JSON.stringify(stableTaskTable(tasks)), "utf8").digest("hex");
}

function syncWrite(file: string, contents: string, flag: "wx" | "a"): void {
  const fd = fs.openSync(file, flag);
  try {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes the immutable manifest. `wx` makes a repeated write a refusal. */
export function writeRunManifest(projectRoot: string, manifest: RunManifest): string {
  validateManifest(manifest);
  const paths = runArtifactPaths(projectRoot, manifest.run_id);
  fs.mkdirSync(paths.directory, { recursive: true });
  syncWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "wx");
  return paths.manifest;
}

export function readRunManifest(projectRoot: string, runId: string): RunManifest {
  const file = runArtifactPaths(projectRoot, runId).manifest;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`run manifest is not a regular file: ${file}`);
  return validateManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Appends and flushes one complete JSONL record before returning. */
export function appendJournalRecord(projectRoot: string, runId: string, record: KnownJournalRecord): string {
  const paths = runArtifactPaths(projectRoot, runId);
  readRunManifest(projectRoot, runId);
  syncWrite(paths.journal, `${JSON.stringify(record)}\n`, "a");
  return paths.journal;
}

function parseRecord(value: unknown, lineNumber: number): JournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`journal line ${lineNumber} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ts !== "string" || typeof candidate.kind !== "string") {
    throw new Error(`journal line ${lineNumber} must contain string ts and kind fields`);
  }
  if (candidate.task_id !== undefined && typeof candidate.task_id !== "string") {
    throw new Error(`journal line ${lineNumber} task_id must be a string when present`);
  }
  if (KNOWN_RECORD_KINDS.has(candidate.kind as KnownJournalRecord["kind"])) {
    const taskKinds = new Set(["TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE", "GATE_RESULT", "TASK_CHECKPOINTED", "TASK_FAILED"]);
    const reasonKinds = new Set(["TASK_FAILED", "RUN_HALTED", "RUN_REFUSED", "RUN_RESUMED", "RUN_STALE", "RUN_ABANDONED"]);
    if (taskKinds.has(candidate.kind) && (typeof candidate.task_id !== "string" || candidate.task_id.length === 0)) {
      throw new Error(`journal line ${lineNumber} ${candidate.kind} requires task_id`);
    }
    if (reasonKinds.has(candidate.kind) && (typeof candidate.reason !== "string" || candidate.reason.length === 0)) {
      throw new Error(`journal line ${lineNumber} ${candidate.kind} requires reason`);
    }
    if (candidate.kind === "TASK_FAILED" && (typeof candidate.class !== "string" || candidate.class.length === 0)) {
      throw new Error(`journal line ${lineNumber} TASK_FAILED requires class`);
    }
    if (candidate.kind === "TASK_CHECKPOINTED" && (typeof candidate.sha !== "string" || candidate.sha.length === 0)) {
      throw new Error(`journal line ${lineNumber} TASK_CHECKPOINTED requires sha`);
    }
    if (candidate.kind === "GATE_RESULT" && !["passed", "failed", "unverified"].includes(String(candidate.result))) {
      throw new Error(`journal line ${lineNumber} GATE_RESULT has invalid result`);
    }
  }
  return candidate as JournalRecord;
}

function validateManifest(value: unknown): RunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run manifest must be a JSON object");
  const candidate = value as Record<string, unknown>;
  const stringFields: Array<keyof RunManifest> = [
    "run_id", "created_at", "target_root", "target_id", "knowledge_root", "module", "plan_hash",
    "base_branch", "base_sha", "run_branch", "runtime_id", "tier", "model", "sta_version",
  ];
  for (const field of stringFields) {
    if (typeof candidate[field] !== "string" || (candidate[field] as string).length === 0) {
      throw new Error(`run manifest field ${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(candidate.wave) || (candidate.wave as number) < 1) {
    throw new Error("run manifest field wave must be a positive integer");
  }
  if (!Number.isInteger(candidate.max_tasks) || (candidate.max_tasks as number) < 1) {
    throw new Error("run manifest field max_tasks must be a positive integer");
  }
  if (!Array.isArray(candidate.task_order) || candidate.task_order.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
    throw new Error("run manifest field task_order must contain task ids");
  }
  safeRunSegment(candidate.run_id as string);
  return candidate as unknown as RunManifest;
}

export function readJournal(projectRoot: string, runId: string): JournalReadResult {
  const file = runArtifactPaths(projectRoot, runId).journal;
  const body = fs.readFileSync(file, "utf8");
  const lines = body.split(/\r?\n/);
  const hasIncompleteFinalLine = body.length > 0 && !body.endsWith("\n");
  const records: JournalRecord[] = [];
  let truncatedFinalLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    try {
      records.push(parseRecord(JSON.parse(line), index + 1));
    } catch (error) {
      if (hasIncompleteFinalLine && index === lines.length - 1) {
        truncatedFinalLine = true;
        break;
      }
      throw new Error(`invalid journal record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { records, truncatedFinalLine };
}

/** Removes only an incomplete final JSONL fragment after it has been reported by `readJournal`. */
export function repairTruncatedJournal(projectRoot: string, runId: string): boolean {
  const result = readJournal(projectRoot, runId);
  if (!result.truncatedFinalLine) return false;
  const file = runArtifactPaths(projectRoot, runId).journal;
  const body = fs.readFileSync(file, "utf8");
  const lastNewline = Math.max(body.lastIndexOf("\n"), body.lastIndexOf("\r"));
  const repaired = lastNewline < 0 ? "" : body.slice(0, lastNewline + 1);
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, repaired, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function pruneWaveRunArtifacts(
  projectRoot: string,
  currentRunId: string,
  maximum = DEFAULT_RUNTIME_ARTIFACT_RETENTION,
): string[] {
  const current = runArtifactPaths(projectRoot, currentRunId).directory;
  return pruneRuntimeArtifacts({
    taskDirectory: path.dirname(current),
    currentArtifact: current,
    maxRunsPerTask: maximum,
    artifactType: "directory",
  });
}
