import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { UNIVERSAL_DENY, matchesGlob } from "../agents/pathPermissions.js";
import type { DeterministicCheckId, DeterministicVerification } from "../qa/deterministic.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import {
  canonicalProspectivePath,
  GitCommandError,
  GitCommandLayer,
  isPathWithinRoot,
} from "./commandLayer.js";

export type CheckpointRefusalKind =
  | "ADAPTER_FAILURE"
  | "NO_CHANGES"
  | "GUARD_FAILURE"
  | "DENIED_PATH"
  | "DETERMINISTIC_FAILED"
  | "DETERMINISTIC_SKIPPED"
  | "SECRET_DETECTED"
  | "TASK_CONTRACT_VIOLATION"
  | "UNEXPECTED_DEPENDENCY_CHANGE"
  | "STAGING_MISMATCH"
  | "INVALID_METADATA";

export class CheckpointRefusal extends Error {
  constructor(readonly kind: CheckpointRefusalKind, message: string) {
    super(message);
    this.name = "CheckpointRefusal";
  }
}

export interface SecretScanResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export type SecretScanner = (repositoryRoot: string, relativePaths: readonly string[]) => SecretScanResult;

export interface CheckpointInput {
  readonly git: GitCommandLayer;
  readonly adapter: Pick<RuntimeAgentResult, "status" | "exitCode">;
  readonly writableRoots: readonly string[];
  readonly runVerification: () => Promise<DeterministicVerification>;
  readonly runId: string;
  readonly taskId: string;
  readonly module: string;
  readonly planHash: string;
  readonly taskDescription: string;
  /** Exact current-stage write contract carried by the immutable packet. */
  readonly allowedPathGlobs?: readonly string[];
  /** Identity of the immutable packet executed by this attempt. */
  readonly packetHash?: string;
  readonly secretScanner?: SecretScanner;
}

export interface CheckpointResult {
  readonly sha: string;
  readonly changedPaths: readonly string[];
  readonly verification: DeterministicVerification;
  readonly gpgSigningBypassed: boolean;
}

const DEPENDENCY_CONTROL_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "pyproject.toml", "poetry.lock", "pdm.lock", "pipfile", "pipfile.lock", "requirements.txt",
  "uv.lock", "pixi.lock",
  "cargo.toml", "cargo.lock", "go.mod", "go.sum", "gemfile", "gemfile.lock", "composer.json", "composer.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile", "packages.lock.json", "packages.config",
  "directory.packages.props", "nuget.config", "paket.dependencies", "paket.lock",
  "deno.lock", "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock",
  "podfile", "podfile.lock", "package.swift", "package.resolved",
]);

export function isDependencyControlPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath.replace(/\\/g, "/")).toLowerCase();
  return DEPENDENCY_CONTROL_FILES.has(basename)
    || /^requirements(?:[._-].+)?\.txt$/u.test(basename)
    || /\.(?:csproj|fsproj|vbproj)$/u.test(basename);
}

export function assertTaskContractPaths(changedPaths: readonly string[], allowedPathGlobs: readonly string[]): void {
  if (allowedPathGlobs.length === 0) {
    throw new CheckpointRefusal("TASK_CONTRACT_VIOLATION", "The immutable task packet contains no writable path; no checkpoint may be staged.");
  }
  const outside = changedPaths.filter((changed) => {
    const normalized = changed.replace(/\\/g, "/");
    return !allowedPathGlobs.some((glob) => matchesGlob(glob.replace(/\\/g, "/"), normalized));
  });
  if (outside.length > 0) {
    throw new CheckpointRefusal(
      "TASK_CONTRACT_VIOLATION",
      `Changed path(s) are outside the immutable task/stage write contract: ${outside.join(", ")}`,
    );
  }
}

function parseStatusPathToken(token: string): string {
  if (token.length < 4 || token[2] !== " ") throw new GitCommandError(`Malformed git status record: ${JSON.stringify(token)}`);
  return token.slice(3);
}

/** Parses `git status --porcelain -z`; rename/copy records carry destination then source. */
export function parsePorcelainStatus(output: string): string[] {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    paths.push(parseStatusPathToken(record));
    if (status.includes("R") || status.includes("C")) {
      const source = records[++index];
      if (source === undefined || source === "") throw new GitCommandError("Malformed git rename/copy status record");
      paths.push(source);
    }
  }
  return [...new Set(paths)];
}

function canonicalRoots(roots: readonly string[]): string[] {
  if (roots.length === 0) throw new CheckpointRefusal("GUARD_FAILURE", "No writable root was resolved for checkpoint containment.");
  return roots.map((root) => {
    try {
      return fs.realpathSync.native(path.resolve(root));
    } catch (error) {
      throw new CheckpointRefusal("GUARD_FAILURE", `Writable root cannot be resolved: ${root} (${(error as Error).message})`);
    }
  });
}

export function assertCheckpointPaths(
  repositoryRoot: string,
  changedPaths: readonly string[],
  writableRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const repo = fs.realpathSync.native(path.resolve(repositoryRoot));
  const roots = canonicalRoots(writableRoots);
  return changedPaths.map((relativePath) => {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new CheckpointRefusal("GUARD_FAILURE", `Changed path is not repository-relative: ${relativePath}`);
    }
    const normalized = relativePath.replace(/\\/g, "/");
    const absolute = canonicalProspectivePath(path.join(repo, relativePath));
    if (!isPathWithinRoot(absolute, repo, platform) || !roots.some((root) => isPathWithinRoot(absolute, root, platform))) {
      throw new CheckpointRefusal(
        "GUARD_FAILURE",
        `Changed path escaped the resolved writable roots: ${relativePath}. The runtime write guard did not hold.`,
      );
    }
    const denied = UNIVERSAL_DENY.find((pattern) => matchesGlob(pattern, normalized));
    if (denied) throw new CheckpointRefusal("DENIED_PATH", `Changed path matches the universal deny rule ${denied}: ${relativePath}`);
    return (path.relative(repo, absolute) || ".").replace(/\\/g, "/");
  });
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function taskSegment(taskId: string): string {
  return oneLine(taskId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

function gateValue(verification: DeterministicVerification, id: DeterministicCheckId): string {
  return verification.ran.find((result) => result.id === id)?.status ?? "SKIPPED";
}

export function checkpointMessages(input: {
  readonly taskId: string;
  readonly taskDescription: string;
  readonly runId: string;
  readonly module: string;
  readonly planHash: string;
  readonly packetHash?: string;
  readonly verification: DeterministicVerification;
}): readonly [string, string] {
  const taskId = taskSegment(input.taskId);
  const description = oneLine(input.taskDescription);
  if (!taskId || !description) throw new CheckpointRefusal("INVALID_METADATA", "Task id and plan description are required for a checkpoint message.");
  const prefix = `sta(${taskId}): `;
  const subject = `${prefix}${description}`.slice(0, 72).trimEnd();
  const trailerValue = (value: string, name: string): string => {
    const sanitized = oneLine(value);
    if (!sanitized) throw new CheckpointRefusal("INVALID_METADATA", `${name} is required for a checkpoint trailer.`);
    return sanitized;
  };
  const gate = ["lint", "typecheck", "build", "unit-tests"]
    .map((id) => `${id}=${gateValue(input.verification, id as DeterministicCheckId)}`)
    .join(" ");
  return [
    subject,
    [
      `STA-Run-Id: ${trailerValue(input.runId, "run id")}`,
      `STA-Task-Id: ${trailerValue(input.taskId, "task id")}`,
      `STA-Module: ${trailerValue(input.module, "module")}`,
      `STA-Plan-Hash: ${trailerValue(input.planHash, "plan hash")}`,
      ...(input.packetHash === undefined ? [] : [`STA-Packet-Hash: ${trailerValue(input.packetHash, "packet hash")}`]),
      `STA-Gate: ${gate}`,
    ].join("\n"),
  ];
}

export function scanChangedFilesForSecrets(repositoryRoot: string, relativePaths: readonly string[]): SecretScanResult {
  const script = path.join(repositoryRoot, ".claude", "scripts", "static-analysis-gate.js");
  if (!fs.existsSync(script)) return { ok: false, problems: [`secret scan is unavailable: ${script}`] };
  const proc = spawnSync(process.execPath, [script, "--scan-files-for-secrets"], {
    cwd: repositoryRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repositoryRoot },
    input: JSON.stringify(relativePaths),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (proc.error || proc.status === null) {
    return { ok: false, problems: [`secret scan could not run: ${proc.error?.message ?? "no exit status"}`] };
  }
  try {
    const parsed = JSON.parse(proc.stdout) as SecretScanResult;
    if (typeof parsed.ok !== "boolean" || !Array.isArray(parsed.problems)) throw new Error("invalid report shape");
    if (parsed.ok && proc.status !== 0) return { ok: false, problems: [`secret scan exited ${proc.status} despite an empty report`] };
    return parsed;
  } catch (error) {
    return { ok: false, problems: [`secret scan did not return a valid report: ${(error as Error).message}`, proc.stderr.trim()].filter(Boolean) };
  }
}

export async function checkpointTask(input: CheckpointInput): Promise<CheckpointResult> {
  if (input.adapter.status !== "OK" || input.adapter.exitCode !== 0) {
    throw new CheckpointRefusal("ADAPTER_FAILURE", `Runtime adapter exited with ${input.adapter.status}/${String(input.adapter.exitCode)}; no checkpoint was created.`);
  }

  const changedPaths = parsePorcelainStatus((await input.git.statusPorcelainNull()).stdout);
  if (changedPaths.length === 0) {
    throw new CheckpointRefusal("NO_CHANGES", "NO_CHANGES: the task produced no repository change; the run must halt without a commit.");
  }

  const safePaths = assertCheckpointPaths(input.git.cwd, changedPaths, input.writableRoots);
  if (input.allowedPathGlobs !== undefined) assertTaskContractPaths(safePaths, input.allowedPathGlobs);
  const dependencyChanges = safePaths.filter(isDependencyControlPath);
  if (dependencyChanges.length > 0) {
    throw new CheckpointRefusal(
      "UNEXPECTED_DEPENDENCY_CHANGE",
      `Dependency manifest/lockfile change requires human review and was not staged: ${dependencyChanges.join(", ")}`,
    );
  }
  const verification = await input.runVerification();
  if (verification.status === "skipped") {
    throw new CheckpointRefusal("DETERMINISTIC_SKIPPED", "Deterministic verification was skipped; no checkpoint was created.");
  }
  if (verification.status !== "passed") {
    throw new CheckpointRefusal("DETERMINISTIC_FAILED", "Deterministic verification failed; no checkpoint was created.");
  }

  const secretScan = (input.secretScanner ?? scanChangedFilesForSecrets)(input.git.cwd, safePaths);
  if (!secretScan.ok) {
    throw new CheckpointRefusal("SECRET_DETECTED", `Secret-shaped content refused the checkpoint: ${secretScan.problems.join("; ")}`);
  }

  await input.git.addPaths(safePaths);
  const stagedPaths = parsePorcelainStatus((await input.git.statusPorcelainNull()).stdout)
    .filter((changed) => safePaths.includes(changed.replace(/\\/g, "/")));
  const cachedPaths = (await input.git.execute({ command: "diff", mode: "cached-name-only" })).stdout
    .split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => item.replace(/\\/g, "/"));
  const expected = [...new Set(safePaths)].sort();
  const actual = [...new Set(cachedPaths)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CheckpointRefusal(
      "STAGING_MISMATCH",
      `Exact staging manifest mismatch; expected [${expected.join(", ")}], staged [${actual.join(", ")}]. Work is preserved for inspection.`,
    );
  }
  // Keep the porcelain read above as an independent post-add observation. It
  // also catches a path disappearing between validation and staging.
  if (stagedPaths.length !== expected.length) {
    throw new CheckpointRefusal("STAGING_MISMATCH", "A changed path disappeared or changed identity while exact staging was in progress.");
  }
  const messages = checkpointMessages({ ...input, verification });
  const committed = await input.git.commit(messages);
  const sha = (await input.git.revParseHead()).stdout.trim();
  return { sha, changedPaths: safePaths, verification, gpgSigningBypassed: committed.gpgSigningBypassed };
}
