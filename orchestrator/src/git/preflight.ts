import * as fs from "node:fs";
import * as path from "node:path";
import { GitCommandError, GitCommandLayer, readRepositoryGitConfig } from "./commandLayer.js";

export type RepositoryRefusalKind =
  | "modified-tracked"
  | "staged"
  | "untracked"
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "detached-head"
  | "bisect"
  | "submodules"
  | "sparse-checkout"
  | "commit-hook"
  | "branch-collision";

export class RepositoryPreflightError extends Error {
  constructor(readonly kind: RepositoryRefusalKind, message: string) {
    super(message);
    this.name = "RepositoryPreflightError";
  }
}

export interface RepositoryPreflightResult {
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly runBranch: string;
  readonly warnings: readonly string[];
}

export interface RunBranchResult extends RepositoryPreflightResult {
  readonly branchCreated: true;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function porcelainPath(line: string): string {
  const raw = line.slice(3);
  const renamed = raw.lastIndexOf(" -> ");
  return renamed < 0 ? raw : raw.slice(renamed + 4);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function remediation(command: string): string {
  return `Resolve this repository state, then retry. Run: ${command}`;
}

function assertMarkerAbsent(gitDir: string, relative: string, kind: RepositoryRefusalKind, command: string): void {
  if (fs.existsSync(path.join(gitDir, relative))) throw new RepositoryPreflightError(kind, remediation(command));
}

function executableHook(gitDir: string, cwd: string): string | null {
  const configured = readRepositoryGitConfig(cwd).hooksPath;
  const hooksRoot = configured
    ? path.resolve(cwd, configured.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE ?? "~"))
    : path.join(gitDir, "hooks");
  for (const name of ["pre-commit", "commit-msg"] as const) {
    const hook = path.join(hooksRoot, name);
    try {
      fs.accessSync(hook, fs.constants.X_OK);
      return hook;
    } catch {}
  }
  return null;
}

export function generatedRunBranch(moduleName: string, runId: string): string {
  const segment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const moduleSegment = segment(moduleName);
  const runSegment = segment(runId);
  const candidate = `sta/run/${moduleSegment}/${runSegment}`;
  if (!isConservativeBranchName(candidate)) {
    throw new GitCommandError(`Generated run branch is not a valid Git branch name: ${candidate}`);
  }
  return candidate;
}

// The signed command allow-list excludes check-ref-format. Keep this validator
// conservative; integration tests compare every generated candidate with Git.
export function isConservativeBranchName(candidate: string): boolean {
  if (!candidate || candidate.length > 255 || candidate.startsWith("-") || candidate.startsWith("/") || candidate.endsWith("/")) return false;
  if (candidate.endsWith(".") || candidate.includes("..") || candidate.includes("@{") || candidate.includes("//")) return false;
  if (candidate.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return false;
  return !/[\u0000-\u0020\u007f~^:?*[\\]/.test(candidate);
}

export async function inspectRepositoryPreflight(
  git: GitCommandLayer,
  moduleName: string,
  runId: string,
): Promise<RepositoryPreflightResult> {
  const dotGit = path.join(git.cwd, ".git");
  let dotGitStat: fs.Stats;
  try {
    dotGitStat = fs.statSync(dotGit);
  } catch {
    throw new RepositoryPreflightError("detached-head", remediation("git status"));
  }
  if (!dotGitStat.isDirectory()) {
    throw new RepositoryPreflightError("detached-head", remediation("git status"));
  }

  const status = lines((await git.statusPorcelain()).stdout);
  const modified = status.filter((line) => line.length >= 2 && line[1] !== " " && line[0] !== "?");
  if (modified.length > 0) {
    const paths = modified.map(porcelainPath).map(quote).join(" ");
    throw new RepositoryPreflightError("modified-tracked", remediation(`git restore --worktree -- ${paths}`));
  }
  const staged = status.filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
  if (staged.length > 0) {
    const paths = staged.map(porcelainPath).map(quote).join(" ");
    throw new RepositoryPreflightError("staged", remediation(`git restore --staged -- ${paths}`));
  }
  const untracked = lines((await git.listUntrackedFiles()).stdout);
  if (untracked.length > 0) {
    const paths = untracked.map(quote).join(" ");
    throw new RepositoryPreflightError(
      "untracked",
      remediation(`git add -- ${paths} && git commit -m "Preserve work before STA run"`),
    );
  }

  assertMarkerAbsent(dotGit, "MERGE_HEAD", "merge", "git merge --continue");
  if (fs.existsSync(path.join(dotGit, "rebase-merge")) || fs.existsSync(path.join(dotGit, "rebase-apply"))) {
    throw new RepositoryPreflightError("rebase", remediation("git rebase --continue"));
  }
  assertMarkerAbsent(dotGit, "CHERRY_PICK_HEAD", "cherry-pick", "git cherry-pick --continue");
  assertMarkerAbsent(dotGit, "REVERT_HEAD", "revert", "git revert --continue");

  let baseBranch: string;
  try {
    baseBranch = (await git.symbolicRefHead()).stdout.trim();
  } catch {
    throw new RepositoryPreflightError("detached-head", remediation("git switch -"));
  }
  if (!baseBranch) throw new RepositoryPreflightError("detached-head", remediation("git switch -"));
  const baseSha = (await git.revParseHead()).stdout.trim();

  assertMarkerAbsent(dotGit, "BISECT_LOG", "bisect", "git bisect reset");
  if (fs.existsSync(path.join(git.cwd, ".gitmodules"))) {
    throw new RepositoryPreflightError("submodules", remediation("git submodule status"));
  }

  const config = readRepositoryGitConfig(git.cwd);
  if (config.sparseCheckout || fs.existsSync(path.join(dotGit, "info", "sparse-checkout"))) {
    throw new RepositoryPreflightError("sparse-checkout", remediation("git sparse-checkout disable"));
  }

  const hook = executableHook(dotGit, git.cwd);
  if (hook) {
    throw new RepositoryPreflightError(
      "commit-hook",
      `Executable Git hook refuses unattended commits: ${hook}. ${remediation(`Rename-Item -LiteralPath ${quote(hook)} -NewName ${quote(`${path.basename(hook)}.disabled`)}`)}`,
    );
  }

  const warnings: string[] = [];
  const attributes = path.join(git.cwd, ".gitattributes");
  if (fs.existsSync(attributes) && /filter\s*=\s*lfs/i.test(fs.readFileSync(attributes, "utf8"))) {
    warnings.push("Git LFS detected: pointer/object state is not validated by this run.");
  }

  const runBranch = generatedRunBranch(moduleName, runId);
  if ((await git.listBranches(runBranch)).stdout.trim()) {
    throw new RepositoryPreflightError(
      "branch-collision",
      remediation(`git branch -m ${quote(runBranch)} ${quote(`${runBranch}.saved`)}`),
    );
  }
  return { baseBranch, baseSha, runBranch, warnings };
}

export async function createIsolatedRunBranch(
  git: GitCommandLayer,
  moduleName: string,
  runId: string,
): Promise<RunBranchResult> {
  const preflight = await inspectRepositoryPreflight(git, moduleName, runId);
  await git.createBranch(preflight.runBranch, preflight.baseSha);
  return { ...preflight, branchCreated: true };
}
