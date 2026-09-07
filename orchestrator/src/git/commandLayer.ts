import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const GIT_COMMAND_ALLOW_LIST = [
  "rev-parse",
  "symbolic-ref",
  "status --porcelain",
  "ls-files",
  "diff",
  "log",
  "cat-file",
  "merge-base",
  "switch -c",
  "branch",
  "add -- <paths>",
  "commit -m",
] as const;

export type GitCommandId = (typeof GIT_COMMAND_ALLOW_LIST)[number];

export type GitCommandRequest =
  | { readonly command: "rev-parse"; readonly mode: "head" | "git-dir" | "verify-ref"; readonly value?: string }
  | { readonly command: "symbolic-ref" }
  | { readonly command: "status --porcelain" }
  | { readonly command: "ls-files"; readonly mode: "untracked" }
  | { readonly command: "diff"; readonly mode: "name-only" | "cached-name-only" | "stat"; readonly revision?: string; readonly paths?: readonly string[] }
  | { readonly command: "log"; readonly maxCount?: number; readonly grep?: string }
  | { readonly command: "cat-file"; readonly object: string }
  | { readonly command: "merge-base"; readonly left: string; readonly right: string }
  | { readonly command: "switch -c"; readonly branch: string; readonly startPoint: string }
  | { readonly command: "branch"; readonly mode: "list"; readonly pattern?: string }
  | { readonly command: "add -- <paths>"; readonly paths: readonly string[] }
  | { readonly command: "commit -m"; readonly message: string };

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GitProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type GitProcessRunner = (args: readonly string[], options: GitProcessOptions) => Promise<GitProcessResult>;

export interface GitCommandLayerOptions {
  readonly cwd: string;
  readonly identity?: GitIdentity;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsPathLimit?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly processRunner?: GitProcessRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface GitCommitResult extends GitProcessResult {
  readonly identitySource: "git-config" | "sta";
  readonly gpgSigningBypassed: boolean;
}

interface RepositoryGitConfig {
  readonly userName?: string;
  readonly userEmail?: string;
  readonly commitGpgSign: boolean;
  readonly hooksPath?: string;
  readonly sparseCheckout: boolean;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export class GitIdentityError extends GitCommandError {
  constructor() {
    super(
      "Git identity is not configured. Configure it, then retry:\n" +
        'git config user.name "Your Name"\n' +
        'git config user.email "you@example.com"',
    );
    this.name = "GitIdentityError";
  }
}

export function defaultGitProcessRunner(args: readonly string[], options: GitProcessOptions): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new GitCommandError((stderr || error.message).trim(), stderr.trim(), error));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function canonicalProspectivePath(candidate: string): string {
  let existing = path.resolve(candidate);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new GitCommandError(`Cannot resolve a filesystem ancestor for ${candidate}`);
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), ...tail);
}

export function isPathWithinRoot(candidate: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalize = (value: string): string => platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const relative = pathApi.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function parseGitConfig(text: string): RepositoryGitConfig {
  let section = "";
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const heading = line.match(/^\[([^\] ]+)/);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0 || !section) continue;
    values.set(`${section}.${line.slice(0, equals).trim().toLowerCase()}`, line.slice(equals + 1).trim());
  }
  return {
    userName: values.get("user.name"),
    userEmail: values.get("user.email"),
    commitGpgSign: values.get("commit.gpgsign")?.toLowerCase() === "true",
    hooksPath: values.get("core.hookspath"),
    sparseCheckout: values.get("core.sparsecheckout")?.toLowerCase() === "true",
  };
}

export function readRepositoryGitConfig(cwd: string): RepositoryGitConfig {
  const configPath = path.join(cwd, ".git", "config");
  try {
    return parseGitConfig(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { commitGpgSign: false, sparseCheckout: false };
    throw error;
  }
}

function rejectOptionLike(value: string, label: string): void {
  if (!value || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GitCommandError(`${label} is not a safe Git argument`);
  }
}

function buildGitArgs(request: GitCommandRequest): string[] {
  switch (request.command) {
    case "rev-parse":
      if (request.mode === "head") return ["rev-parse", "HEAD"];
      if (request.mode === "git-dir") return ["rev-parse", "--git-dir"];
      rejectOptionLike(request.value ?? "", "ref");
      return ["rev-parse", "--verify", "--quiet", request.value!];
    case "symbolic-ref":
      return ["symbolic-ref", "--quiet", "--short", "HEAD"];
    case "status --porcelain":
      return ["status", "--porcelain"];
    case "ls-files":
      return ["ls-files", "--others", "--exclude-standard"];
    case "diff": {
      const args = request.mode === "cached-name-only"
        ? ["diff", "--cached", "--name-only"]
        : request.mode === "name-only"
          ? ["diff", "--name-only"]
          : ["diff", "--stat"];
      if (request.revision) {
        rejectOptionLike(request.revision, "revision");
        args.push(request.revision);
      }
      if (request.paths) args.push("--", ...request.paths);
      return args;
    }
    case "log": {
      const args = ["log", "--format=%H"];
      if (request.maxCount !== undefined) {
        if (!Number.isInteger(request.maxCount) || request.maxCount < 1) throw new GitCommandError("log maxCount must be positive");
        args.push(`--max-count=${request.maxCount}`);
      }
      if (request.grep !== undefined) args.push(`--grep=${request.grep}`);
      return args;
    }
    case "cat-file":
      rejectOptionLike(request.object, "object");
      return ["cat-file", "-e", request.object];
    case "merge-base":
      rejectOptionLike(request.left, "left revision");
      rejectOptionLike(request.right, "right revision");
      return ["merge-base", request.left, request.right];
    case "switch -c":
      rejectOptionLike(request.branch, "branch");
      rejectOptionLike(request.startPoint, "start point");
      return ["switch", "-c", request.branch, request.startPoint];
    case "branch":
      if (request.pattern !== undefined) rejectOptionLike(request.pattern, "branch pattern");
      return ["branch", "--list", ...(request.pattern === undefined ? [] : [request.pattern])];
    case "add -- <paths>":
      if (request.paths.length === 0) throw new GitCommandError("Git add requires at least one path");
      return ["add", "--", ...request.paths];
    case "commit -m":
      if (!request.message || /\u0000/.test(request.message)) throw new GitCommandError("Commit message is not safe");
      return ["commit", "--no-gpg-sign", "-m", request.message, "--"];
    default: {
      const command = (request as { readonly command?: unknown }).command;
      throw new GitCommandError(`Git command is outside the closed allow-list: ${String(command)}`);
    }
  }
}

function isMutating(command: unknown): boolean {
  return command === "switch -c" || command === "add -- <paths>" || command === "commit -m";
}

function isRetrySafeLock(error: unknown): boolean {
  const text = error instanceof GitCommandError ? `${error.message}\n${error.stderr}` : String(error);
  return /index\.lock|unable to create ['\"]?[^\n]*\.lock|permission denied|access is denied|used by another process/i.test(text);
}

export class GitCommandLayer {
  readonly cwd: string;
  private readonly identity?: GitIdentity;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly windowsPathLimit: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly processRunner: GitProcessRunner;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GitCommandLayerOptions) {
    this.cwd = fs.realpathSync.native(path.resolve(options.cwd));
    this.identity = options.identity;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.platform = options.platform ?? process.platform;
    this.windowsPathLimit = options.windowsPathLimit ?? 260;
    this.environment = options.environment ?? process.env;
    this.processRunner = options.processRunner ?? defaultGitProcessRunner;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private checkedPaths(paths: readonly string[]): string[] {
    return paths.map((input) => {
      if (!input || path.isAbsolute(input)) throw new GitCommandError(`Git path must be relative to the repository root: ${input}`);
      const absolute = canonicalProspectivePath(path.join(this.cwd, input));
      if (!isPathWithinRoot(absolute, this.cwd, this.platform)) {
        throw new GitCommandError(`Git path resolves outside the repository root: ${input}`);
      }
      if (this.platform === "win32" && absolute.length >= this.windowsPathLimit) {
        throw new GitCommandError(`Git path exceeds the Windows path limit (${this.windowsPathLimit - 1} characters): ${input}`);
      }
      return path.relative(this.cwd, absolute) || ".";
    });
  }

  async execute(request: GitCommandRequest): Promise<GitProcessResult> {
    const command = (request as { readonly command?: unknown }).command;
    if (!(GIT_COMMAND_ALLOW_LIST as readonly unknown[]).includes(command)) {
      throw new GitCommandError(`Git command is outside the closed allow-list: ${String(command)}`);
    }

    let normalized = request;
    if (request.command === "add -- <paths>") normalized = { ...request, paths: this.checkedPaths(request.paths) };
    if (request.command === "diff" && request.paths) normalized = { ...request, paths: this.checkedPaths(request.paths) };

    let args = buildGitArgs(normalized);
    if (request.command === "commit -m") {
      const config = readRepositoryGitConfig(this.cwd);
      if ((!config.userName || !config.userEmail) && this.identity?.name && this.identity.email) {
        args = ["-c", `user.name=${this.identity.name}`, "-c", `user.email=${this.identity.email}`, ...args];
      }
    }

    const options: GitProcessOptions = {
      cwd: this.cwd,
      env: { ...this.environment, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      timeout: this.timeoutMs,
      windowsHide: true,
    };
    let attempt = 0;
    while (true) {
      try {
        return await this.processRunner(args, options);
      } catch (error) {
        if (!isMutating(command) || !isRetrySafeLock(error) || attempt >= this.maxRetries) throw error;
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
  }

  revParseHead(): Promise<GitProcessResult> {
    return this.execute({ command: "rev-parse", mode: "head" });
  }

  revParseGitDir(): Promise<GitProcessResult> {
    return this.execute({ command: "rev-parse", mode: "git-dir" });
  }

  verifyRef(ref: string): Promise<GitProcessResult> {
    return this.execute({ command: "rev-parse", mode: "verify-ref", value: ref });
  }

  symbolicRefHead(): Promise<GitProcessResult> {
    return this.execute({ command: "symbolic-ref" });
  }

  statusPorcelain(): Promise<GitProcessResult> {
    return this.execute({ command: "status --porcelain" });
  }

  listUntrackedFiles(): Promise<GitProcessResult> {
    return this.execute({ command: "ls-files", mode: "untracked" });
  }

  listBranches(pattern?: string): Promise<GitProcessResult> {
    return this.execute({ command: "branch", mode: "list", pattern });
  }

  createBranch(branch: string, startPoint: string): Promise<GitProcessResult> {
    return this.execute({ command: "switch -c", branch, startPoint });
  }

  addPaths(paths: readonly string[]): Promise<GitProcessResult> {
    return this.execute({ command: "add -- <paths>", paths });
  }

  async commit(message: string): Promise<GitCommitResult> {
    const config = readRepositoryGitConfig(this.cwd);
    let result: GitProcessResult;
    try {
      result = await this.execute({ command: "commit -m", message });
    } catch (error) {
      if (error instanceof GitCommandError && /author identity unknown|please tell me who you are|unable to auto-detect email address/i.test(error.message)) {
        throw new GitIdentityError();
      }
      throw error;
    }
    return {
      ...result,
      identitySource: (!config.userName || !config.userEmail) && this.identity ? "sta" : "git-config",
      gpgSigningBypassed: true,
    };
  }
}
