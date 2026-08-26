import { execFile } from "node:child_process";
import { ProviderUnavailableError } from "./provider.js";

/**
 * Where the freshness comparison starts: the checkout's current HEAD.
 *
 * Deliberately the ONLY place this module runs git. Everything downstream
 * (freshness verdicts, gates) works on the sha string, which keeps them pure
 * and testable; the runner is injectable so tests never shell out.
 */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const spawnGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new ProviderUnavailableError(`git ${args.join(" ")} failed in ${cwd}: ${String(stderr || error).slice(0, 200)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });

export async function resolveTargetRevision(root: string, run: GitRunner = spawnGit): Promise<string> {
  const rev = await run(["rev-parse", "HEAD"], root);
  if (!/^[0-9a-f]{7,64}$/i.test(rev)) {
    throw new ProviderUnavailableError(`could not resolve HEAD revision of ${root}`);
  }
  return rev;
}
