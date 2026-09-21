import { CliUsageError } from "../../cli.js";
import { flagValue, positionalArgs } from "../support.js";
import {
  planTargetOwnershipTransfer,
  registerDestinationForTransfer,
  releaseTargetForTransfer,
  rollbackTargetTransfer,
  verifyTargetTransfer,
} from "../../threeRepo/targetTransfer.js";

/**
 * `sta transfer` — the nine-step human-gated Target ownership transfer
 * (DT §5.2). `plan` is read-only and prints the step-1 surface plus the
 * approval-record template; a person fills the record's approvals and every
 * later operation re-proves the record against the registries. The commands
 * check approvals, they never supply them.
 */

const OPERATIONS = ["plan", "release", "register", "rollback", "verify"] as const;

export async function runTransferVerb(rest: string[], _frameworkRoot: string): Promise<number> {
  const [operation] = positionalArgs(rest);
  const configPath = flagValue(rest, "--config-path");
  try {
    if (operation === "plan") {
      const sourceRoot = flagValue(rest, "--source-root");
      const sourceTarget = flagValue(rest, "--source-target");
      const destinationRoot = flagValue(rest, "--destination-root");
      const destinationTarget = flagValue(rest, "--destination-target");
      if (!sourceRoot || !sourceTarget || !destinationRoot) {
        throw new CliUsageError(
          "transfer plan: --source-root <name>, --source-target <id> and --destination-root <name> are required (--destination-target <id> optional; defaults to the source id)",
        );
      }
      const plan = planTargetOwnershipTransfer({
        sourceRoot,
        sourceTargetId: sourceTarget,
        destinationRoot,
        destinationTargetId: destinationTarget,
        installationConfigPath: configPath,
      });
      console.log(
        `[orchestrator] transfer plan: Target "${plan.sourceTargetId}" in root "${plan.sourceRoot}" → Target "${plan.destinationTargetId}" in root "${plan.destinationRoot}"\n` +
          `  canonical coordinates: ${plan.sourceCoordinates.join(", ")}\n` +
          `  source entry: status=${plan.sourceEntry?.status} ownership=${plan.sourceEntry?.ownership_state} remote=${plan.sourceEntry?.remote_url}\n` +
          `  destination existing entry: ${plan.destinationExistingEntry ? `target_id=${plan.destinationExistingEntry.target_id} ownership=${plan.destinationExistingEntry.ownership_state}` : "none"}\n` +
          `  destination already covers the source: ${plan.destinationAlreadyCoversSource}\n` +
          `  alias history the destination should keep: ${plan.aliasHistoryForDestination.length > 0 ? plan.aliasHistoryForDestination.join(", ") : "(none)"}\n` +
          `  non-terminal tasks bound to the source (step 3): ${plan.nonTerminalTasks.length > 0 ? plan.nonTerminalTasks.map((task) => `${task.taskId} (${task.state})`).join(", ") : "none"}\n` +
          `  module refs declaring the source (step 4): ${plan.moduleRefs.length > 0 ? plan.moduleRefs.join(", ") : "none"}\n` +
          `  scoped knowledge items (step 5): ${plan.scopedKnowledgeItems.length > 0 ? plan.scopedKnowledgeItems.map((item) => item.id).join(", ") : "none"}\n` +
          `  local mappings (step 8): source=${plan.localMappings.source ?? "none"} destination=${plan.localMappings.destination ?? "none"}`,
      );
      console.log(`[orchestrator] approval record template — save it, then a person fills every "<fill in …>" field:\n${plan.recordTemplate}`);
      return 0;
    }
    if (operation === "release") {
      const recordPath = requireTransferRecord(rest);
      const result = releaseTargetForTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath });
      console.log(
        `[orchestrator] transfer released: Target "${result.targetId}" in root "${result.sourceRoot}" is now a retired+released tombstone (${result.registryPath}). ` +
          "Next: sta transfer register --transfer <path>",
      );
      return 0;
    }
    if (operation === "register") {
      const recordPath = requireTransferRecord(rest);
      const result = registerDestinationForTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath });
      console.log(
        result.operation === "addition"
          ? `[orchestrator] transfer registered: Target "${result.targetId}" now owns ${result.canonicalCoordinate} in root "${result.destinationRoot}". Next: sta transfer verify --transfer <path>`
          : `[orchestrator] transfer register: Target "${result.targetId}" in root "${result.destinationRoot}" already owns ${result.canonicalCoordinate} — nothing to write. Next: sta transfer verify --transfer <path>`,
      );
      return 0;
    }
    if (operation === "rollback") {
      const recordPath = requireTransferRecord(rest);
      const result = rollbackTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath });
      console.log(`[orchestrator] transfer rolled back: Target "${result.targetId}" in root "${result.sourceRoot}" owns its coordinate again (the record is marked rolled_back)`);
      return 0;
    }
    if (operation === "verify") {
      const recordPath = requireTransferRecord(rest);
      const verdict = verifyTargetTransfer({ transferRecordPath: recordPath, installationConfigPath: configPath });
      console.log(
        `[orchestrator] transfer verify: ownership audit ${verdict.audit.status} — ${verdict.audit.detail}\n` +
          verdict.knowledgeChecks.map((check) => `  knowledge in root "${check.root}": ${check.ok ? "ok" : check.problems.join("; ")}`).join("\n") +
          "\n" +
          verdict.moduleChecks.map((check) => `  module docs in root "${check.root}": ${check.errors.length === 0 ? "ok" : check.errors.join("; ")}`).join("\n"),
      );
      if (verdict.problems.length > 0) {
        console.error(`[orchestrator] transfer verify found ${verdict.problems.length} problem(s); the record is not marked completed`);
        return 1;
      }
      console.log(
        `[orchestrator] the record is marked completed — a person accepts this result before the transfer is treated as done (DT §5.2 step 9)`,
      );
      return 0;
    }
    throw new CliUsageError(
      `transfer: use "plan" (--source-root <name> --source-target <id> --destination-root <name>), "release" (--transfer <path>), "register" (--transfer <path>), "rollback" (--transfer <path>) or "verify" (--transfer <path>)`,
    );
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function requireTransferRecord(rest: string[]): string {
  const recordPath = flagValue(rest, "--transfer");
  if (!recordPath) {
    throw new CliUsageError("transfer: --transfer <path> is required — the approval record names the transfer and carries the human approvals (DT §5.2 steps 2/6/7)");
  }
  return recordPath;
}
