import { CliUsageError } from "../../cli.js";
import { configureIdentities, configureKnowledgeRoot } from "../../threeRepo/installation.js";
import { flagValue, positionalArgs } from "../support.js";

export async function runConfigureVerb(rest: string[], frameworkRoot: string): Promise<number> {
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
  if (subject !== "knowledge-root" || !knowledgeRoot) {
    throw new CliUsageError("configure: use `configure knowledge-root <path>` or `configure identity --figma-email <email> --claude-email <email>`");
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
