import { rollbackSta } from "../../packaging/rollback.js";
import { flagValue } from "../support.js";

/** `rollback [--backup <name>]`. Defaults to the most recent snapshot. */
export async function runRollbackVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const backup = flagValue(rest, "--backup");
  try {
    const result = rollbackSta(projectRoot, backup);
    console.log(
      `[orchestrator] rolled back ${projectRoot} to backup "${result.fromBackup}": ${result.restoredFiles.length} file(s) restored.`,
    );
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
