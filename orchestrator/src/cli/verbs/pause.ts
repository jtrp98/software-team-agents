import { CliUsageError } from "../../cli.js";
import { flagValue, openStore, positionalArg } from "../support.js";

export async function runPauseVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("pause: a task id is required");
  const { registry } = openStore(projectRoot, stateDb);
  try {
    registry.pause(taskId);
    console.log(`[orchestrator] task ${taskId} paused.`);
    return 0;
  } finally {
    registry.close();
  }
}
