import { CliUsageError } from "../../cli.js";
import { flagValue, openStore, positionalArg } from "../support.js";

export async function runCancelVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("cancel: a task id is required");
  const reason = flagValue(rest, "--reason") ?? "no reason given";
  const { registry } = openStore(projectRoot, stateDb);
  try {
    registry.cancel(taskId, reason);
    console.log(`[orchestrator] task ${taskId} cancelled: ${reason}`);
    return 0;
  } finally {
    registry.close();
  }
}
