import { migrateSta } from "../../packaging/migration.js";
import { flagValue } from "../support.js";

/** `migrate` — a no-op, reported as such, when the project is already on the current .sta/ schema version. */
export async function runMigrateVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  try {
    const result = migrateSta(projectRoot, new Date().toISOString());
    if (result.appliedSteps.length === 0) {
      console.log(`[orchestrator] .sta/ is already at schema_version ${result.to} — nothing to migrate.`);
      return 0;
    }
    console.log(
      `[orchestrator] migrated .sta/ from schema_version ${result.from} to ${result.to} ` +
        `(steps: ${result.appliedSteps.join(" -> ")}), backup at ${result.backupDir}`,
    );
    return 0;
  } catch (e) {
    console.error(`[orchestrator] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
