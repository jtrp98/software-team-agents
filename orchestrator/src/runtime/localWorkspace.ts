import { spawnSync as nodeSpawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeWorkspace,
} from "./runtimeAdapter.js";

/**
 * `RuntimeWorkspace` over the local filesystem (T108).
 *
 * Shared by every adapter rather than owned by one: both runtimes this framework
 * targets run as a child process on the same machine, against the same working
 * tree, so there is exactly one correct implementation of "read a file where the
 * agent worked" and duplicating it per adapter would only create two places for
 * it to drift.
 *
 * Every path is resolved under `root` and refuses to escape it. That is not
 * defence against a hostile caller — it is the same rule
 * `.claude/hooks/block-outside-repo.js` enforces for agents, applied to the
 * orchestrator's own reads and writes, so "no write outside the repo" does not
 * quietly become "no write outside the repo, unless the orchestrator does it".
 */
export class OutsideWorkspaceError extends Error {
  constructor(relPath: string, root: string) {
    super(`path ${relPath} resolves outside the workspace root ${root}`);
    this.name = "OutsideWorkspaceError";
  }
}

export interface LocalWorkspaceOptions {
  /** Absolute path the workspace is rooted at. Every relative path is resolved against it. */
  root: string;
  /** Injectable for tests; defaults to `child_process.spawnSync`. */
  spawnSync?: typeof nodeSpawnSync;
  /** Default per-command timeout, overridable per call. Generous rather than absent — a `build` on a cold cache is slow, but a hung command must not hold a task forever. */
  defaultTimeoutMs?: number;
}

export class LocalWorkspace implements RuntimeWorkspace {
  readonly root: string;
  private readonly spawn: typeof nodeSpawnSync;
  private readonly defaultTimeoutMs: number;

  constructor(opts: LocalWorkspaceOptions) {
    this.root = path.resolve(opts.root);
    this.spawn = opts.spawnSync ?? nodeSpawnSync;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60_000;
  }

  /** Resolves a workspace-relative path, refusing anything that climbs out. An absolute path is accepted only when it is already inside the root. */
  resolve(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new OutsideWorkspaceError(relPath, this.root);
    return abs;
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      return fs.readFileSync(this.resolve(relPath), "utf8");
    } catch (e) {
      // A missing file is an answer, not a fault — the caller distinguishes
      // "no review.md" from "an empty review.md" and both are meaningful. Any
      // other failure (a permission error, a directory) is a real problem and
      // must not be flattened into the same null.
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      return fs.existsSync(this.resolve(relPath));
    } catch (e) {
      // An escaping path does not "not exist" — it is a caller bug, and
      // returning false would hide it behind a plausible-looking answer.
      if (e instanceof OutsideWorkspaceError) throw e;
      return false;
    }
  }

  async runCommand(spec: RuntimeCommand): Promise<RuntimeCommandResult> {
    const cwd = spec.cwd ? this.resolve(spec.cwd) : this.root;
    const timeout = spec.timeoutMs ?? this.defaultTimeoutMs;

    const proc = this.spawn(spec.command, [...spec.args], {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });

    // Node reports a timeout by returning normally with `error` set and a null
    // status — the same shape T47 had to handle in the legacy executor. Reading it
    // off `error.code` rather than inferring it from `status === null` keeps a
    // killed-by-signal run distinguishable from a timed-out one.
    const timedOut = (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    // Appended, not used as a fallback. On a timeout Node returns an empty
    // `stderr` *and* an `error` — so treating the error as a fallback for a
    // missing stderr loses the only description of what went wrong, leaving the
    // caller a bare "exit null" to explain.
    const stderr = [proc.stderr ?? "", proc.error ? proc.error.message : ""].filter((s) => s.length > 0).join("\n");

    return {
      exitCode: proc.status ?? null,
      stdout: proc.stdout ?? "",
      stderr,
      timedOut,
    };
  }
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
