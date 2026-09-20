import { CliUsageError } from "../../cli.js";
import { configureIdentities, configureKnowledgeRoot } from "../../threeRepo/installation.js";
import { extractRootSelectorFlag } from "../../threeRepo/rootSelector.js";
import { registerTarget } from "../../threeRepo/targetRegistration.js";
import { flagValue, positionalArgs } from "../support.js";

export async function runConfigureVerb(rest: string[], frameworkRoot: string): Promise<number> {
  const { requestedName } = extractRootSelectorFlag(rest);
  if (requestedName !== undefined) {
    // DR §4: `configure ... --root <name>` names the entry a *writer* edits.
    // That writer is the v2 named-root writer; until it lands, refusing beats
    // silently writing the whole v1 config while dropping the name.
    throw new CliUsageError(
      "configure: --root <name> requires the named-root writer (sta configure knowledge-root <path> --root <name> / sta configure default-root --root <name>), which is not available yet — the installation config still writes schema v1",
    );
  }
  const [subject, knowledgeRoot] = positionalArgs(rest);
  if (subject === "identity") {
    try {
      const config = configureIdentities(
        { figma_email: flagValue(rest, "--figma-email"), claude_email: flagValue(rest, "--claude-email") },
        flagValue(rest, "--config-path"),
      );
      const ids = config.identities!;
      console.log(`[orchestrator] configured identities: figma_email=${ids.figma_email} claude_email=${ids.claude_email}`);
      if (ids.figma_email.trim().toLowerCase() !== ids.claude_email.trim().toLowerCase()) {
        console.error("[orchestrator] WARNING: the two declared emails differ — the UX/UI stage will refuse to run until they match");
      }
      return 0;
    } catch (error) {
      console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subject === "target") {
    return runConfigureTarget(rest);
  }
  if (subject !== "knowledge-root" || !knowledgeRoot) {
    throw new CliUsageError(
      "configure: use `configure knowledge-root <path>`, `configure identity --figma-email <e> --claude-email <e>`, or `configure target --target-id <id> --name <n> --remote-url <url>`",
    );
  }
  try {
    const config = configureKnowledgeRoot(knowledgeRoot, flagValue(rest, "--config-path"), frameworkRoot);
    console.log(`[orchestrator] configured Knowledge root: ${config.knowledge_root}`);
    return 0;
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** `configure target` — the administrative register surface (DT §3.1). It
 * names the entry to create or reactivate; ownership is enforced by the
 * register flow, never here. A remote change is refused: identity moves only
 * through the human-gated transfer. */
function runConfigureTarget(rest: string[]): number {
  const targetId = flagValue(rest, "--target-id");
  const name = flagValue(rest, "--name");
  const remoteUrl = flagValue(rest, "--remote-url");
  const type = flagValue(rest, "--type");
  if (!targetId || !name || !remoteUrl) {
    throw new CliUsageError("configure target: --target-id <id>, --name <name> and --remote-url <url> are required (--type frontend|backend|fullstack optional)");
  }
  if (type !== undefined && type !== "frontend" && type !== "backend" && type !== "fullstack") {
    throw new CliUsageError("configure target: --type must be frontend, backend or fullstack");
  }
  try {
    const result = registerTarget({
      targetId,
      name,
      remoteUrl,
      type: type as "frontend" | "backend" | "fullstack" | undefined,
      rootName: extractRootSelectorFlag(rest).requestedName,
      installationConfigPath: flagValue(rest, "--config-path"),
    });
    console.log(
      `[orchestrator] Target "${result.targetId}" ${result.operation === "addition" ? "registered" : "reactivated"} in root "${result.rootName}" ` +
        `(canonical repository ${result.canonicalCoordinate}; registry ${result.registryPath})`,
    );
    return 0;
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
