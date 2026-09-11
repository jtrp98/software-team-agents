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
  if (mode !== "legacy-project" && mode !== "three-repo") {
    throw new CliUsageError("upgrade: --mode <legacy-project|three-repo> is required; mode is never inferred from directories");
  }
  if (mode === "three-repo") {
    try {
      const result = runThreeRepoUpgrade(projectRoot);
      console.log(`[orchestrator] three-repo upgrade leaves ${result.knowledgePathsSkipped.length} Knowledge/Target path(s) untouched; update the installed framework package to update bindings.`);
      return 0;
    } catch (e) {
      console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  // `legacy-project` mode (`.sta/` file-by-file upgrade via
  // packaging/upgradeCommand.ts) is removed. Error naming the replacement for
  // this release rather than vanishing silently: `software-team-agents init`
  // converts a `.sta/`-only workspace to `.agent-team/` (no content loss),
  // after which `software-team-agents sync` (or this same `upgrade` verb,
  // which detects `.agent-team/manifest.json` above) keeps it current.
  console.error(
    `[orchestrator] upgrade --mode legacy-project no longer exists — run \`software-team-agents init\` inside ${projectRoot} ` +
      "to convert it to .agent-team/ (no content loss), then `software-team-agents sync` to keep it current",
  );
  return 1;
}
