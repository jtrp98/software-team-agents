import { listBackups } from "../../packaging/rollback.js";
import { flagValue } from "../support.js";

/** `list-backups` — read-only listing of the live backup root, oldest first. */
export async function runListBackupsVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const backups = listBackups(projectRoot);
  if (backups.length === 0) {
    console.log(`[orchestrator] no backups under ${projectRoot}/.agent-team/backups/ (or legacy .sta/backups/) yet.`);
    return 0;
  }
  for (const name of backups) console.log(`  ${name}`);
  return 0;
}
