import * as fs from "node:fs";
import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import { runThreeRepoUpgrade } from "../../packaging/threeRepoCommand.js";
import { runTargetCli } from "../../targetcli/cli.js";
import { flagValue } from "../support.js";

/** `upgrade --templates <dir>`. */
export async function runUpgradeVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  // The live lifecycle is `.agent-team/`; `sta upgrade` is a
  // compatibility spelling for the same sync operation. The legacy branch
  // below remains available only to `.sta/` workspaces during the transition.
  if (fs.existsSync(path.join(projectRoot, ".agent-team", "manifest.json"))) {
    return runTargetCli(
      ["sync", "--target-root", projectRoot, ...(rest.includes("--force") ? ["--force"] : [])],
      projectRoot,
    );
  }
  const mode = flagValue(rest, "--mode");
  if (mode === "legacy-project") {
    throw new CliUsageError("upgrade: --mode legacy-project has been removed; use --mode three-repo");
  }
  if (mode !== "three-repo") {
    throw new CliUsageError("upgrade: --mode three-repo is required; mode is never inferred from directories");
  }
  try {
    const result = runThreeRepoUpgrade(projectRoot);
    console.log(`[orchestrator] three-repo upgrade leaves ${result.knowledgePathsSkipped.length} Knowledge/Target path(s) untouched; update the installed framework package to update bindings.`);
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
