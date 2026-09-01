import { actorsIn, auditTrail, decisionTrail, formatAuditTrail } from "../../audit/auditTrail.js";
import { CliUsageError } from "../../cli.js";
import { flagValue, openStore, positionalArg } from "../support.js";

export async function runAuditVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("audit: a task id is required");
  const decisionsOnly = rest.includes("--decisions");
  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    if (!store.loadTask(taskId)) {
      console.error(`[orchestrator] no such task: ${taskId}`);
      return 1;
    }
    const entries = auditTrail(store, taskId);
    const actors = actorsIn(entries);
    console.log(
      `[orchestrator] audit trail for ${taskId}: ${entries.length} event(s), ` +
        `${decisionTrail(entries).length} decision(s)${actors.length > 0 ? `, actors: ${actors.join(", ")}` : ""}`,
    );
    console.log(formatAuditTrail(entries, { decisionsOnly, runs: store.runsForTask(taskId) }));
    return 0;
  } finally {
    registry.close();
  }
}
