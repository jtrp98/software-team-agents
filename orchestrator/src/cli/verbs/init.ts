import { CliUsageError } from "../../cli.js";
import { runThreeRepoInit } from "../../packaging/threeRepoCommand.js";
import { flagValue } from "../support.js";

/** `init --templates <dir> [--force]`. */
export async function runInitVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const mode = flagValue(rest, "--mode");
  if (mode !== "legacy-project" && mode !== "three-repo") {
    throw new CliUsageError("init: --mode <legacy-project|three-repo> is required; mode is never inferred from directories");
  }
  if (mode === "three-repo") {
    try {
      const result = runThreeRepoInit(projectRoot);
      console.log(`[orchestrator] initialized Knowledge root ${projectRoot}: ${result.createdDirectories.length} directory(ies), ${result.createdFiles.length} config file(s)`);
      return 0;
    } catch (e) {
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  // `legacy-project` mode (`.sta/` materialization via
  // packaging/initCommand.ts) is removed. Error naming the replacement for
  // this release rather than vanishing silently; `software-team-agents init`
  // (targetcli's installer) writes `.agent-team/` and converts a `.sta/`-only
  // workspace with no content loss.
  console.error(
    `[orchestrator] init --mode legacy-project no longer exists — run \`software-team-agents init\` inside ${projectRoot} instead ` +
      "(it writes .agent-team/ and converts an existing .sta/-only workspace with no content loss)",
  );
  return 1;
}
