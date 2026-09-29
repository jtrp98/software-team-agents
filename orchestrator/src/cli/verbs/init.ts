import { CliUsageError } from "../../cli.js";
import { runThreeRepoInit } from "../../packaging/threeRepoCommand.js";
import { flagValue } from "../support.js";

/** `init --templates <dir> [--force]`. */
export async function runInitVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const mode = flagValue(rest, "--mode");
  if (mode === "legacy-project") {
    throw new CliUsageError("init: --mode legacy-project has been removed; use --mode three-repo");
  }
  if (mode !== "three-repo") {
    throw new CliUsageError("init: --mode three-repo is required; mode is never inferred from directories");
  }
  try {
    const result = runThreeRepoInit(projectRoot);
    console.log(`[orchestrator] initialized Knowledge root ${projectRoot}: ${result.createdDirectories.length} directory(ies), ${result.createdFiles.length} config file(s)`);
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
