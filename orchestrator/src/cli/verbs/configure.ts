import { CliUsageError } from "../../cli.js";
import {
  configureDefaultRoot,
  configureIdentities,
  configureKnowledgeRoot,
  configureNamedKnowledgeRoot,
  normalizeKnowledgeRoots,
} from "../../threeRepo/installation.js";
import { extractRootSelectorFlag } from "../../threeRepo/rootSelector.js";
import { registerTarget } from "../../threeRepo/targetRegistration.js";
import { flagValue, positionalArgs } from "../support.js";

export async function runConfigureVerb(rest: string[], frameworkRoot: string): Promise<number> {
  const { requestedName } = extractRootSelectorFlag(rest);
  const [subject, knowledgeRoot] = positionalArgs(rest);
  const configPath = flagValue(rest, "--config-path");
  if (subject === "default-root") {
    if (requestedName === undefined) {
      throw new CliUsageError("configure default-root: --root <name> is required — it names the entry that becomes the default (a path is never taken here)");
    }
    if (knowledgeRoot !== undefined) {
      throw new CliUsageError("configure default-root takes no path — pass --root <name> only; paths change through `configure knowledge-root <path> --root <name>`");
    }
    try {
      const config = configureDefaultRoot(requestedName, configPath);
      const normalized = normalizeKnowledgeRoots(config);
      console.log(`[orchestrator] default Knowledge root: ${normalized.defaultRoot} (${config.knowledge_root})`);
      return 0;
    } catch (error) {
      console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subject === "identity") {
    try {
      const config = configureIdentities(
        { figma_email: flagValue(rest, "--figma-email"), claude_email: flagValue(rest, "--claude-email") },
        configPath,
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
      "configure: use `configure knowledge-root <path> [--root <name>] [--default]`, `configure default-root --root <name>`, `configure identity --figma-email <e> --claude-email <e>`, or `configure target --target-id <id> --name <n> --remote-url <url>`",
    );
  }
  const makeDefault = rest.includes("--default");
  if (makeDefault && requestedName === undefined) {
    throw new CliUsageError("configure knowledge-root: --default requires --root <name> — a pathless write never chooses the default");
  }
  try {
    // DR §2.4: the pathless form is the v1 compatibility writer (create or
    // replace a single root); `--root <name>` names the entry the v2 named-root
    // writer edits, migrating the file at the first named operation.
    const config = requestedName === undefined
      ? configureKnowledgeRoot(knowledgeRoot, configPath, frameworkRoot)
      : configureNamedKnowledgeRoot(knowledgeRoot, { rootName: requestedName, makeDefault, configPath, frameworkRoot });
    const defaultName = config.schema_version === 2 ? config.default_root : "default";
    console.log(`[orchestrator] configured Knowledge root "${requestedName ?? "default"}": ${config.knowledge_root} (default: ${defaultName})`);
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
