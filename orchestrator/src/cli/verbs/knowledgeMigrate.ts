import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import { configureKnowledgeRoot } from "../../threeRepo/installation.js";
import {
  collectMigrationManifest,
  confirmCutover,
  copyMigrationSource,
  readMigrationManifest,
  transformMigratedKnowledge,
  verifyMigration,
  writeMigrationManifest,
} from "../../threeRepo/knowledgeMigration.js";
import { flagValue, positionalArgs } from "../support.js";

export async function runKnowledgeMigrateVerb(rest: string[], frameworkRoot: string): Promise<number> {
  const [action] = positionalArgs(rest);
  const sourceRoot = flagValue(rest, "--source-root");
  const knowledgeRoot = flagValue(rest, "--knowledge-root");
  if (!sourceRoot || !knowledgeRoot || !["dry-run", "copy", "verify", "cutover"].includes(action ?? "")) {
    throw new CliUsageError("knowledge-migrate: use <dry-run|copy|verify|cutover> --source-root <path> --knowledge-root <path>");
  }
  const options = { sourceRoot: path.resolve(sourceRoot), knowledgeRoot: path.resolve(knowledgeRoot), now: flagValue(rest, "--now") ?? new Date().toISOString() };
  try {
    if (action === "dry-run") {
      const manifest = collectMigrationManifest(options);
      console.log(`[orchestrator] migration dry-run: ${manifest.docs.length} _docs files, ${manifest.knowledge.length} knowledge YAML; no files changed.`);
      return 0;
    }
    if (action === "copy") {
      const manifest = collectMigrationManifest(options);
      copyMigrationSource(manifest, options); transformMigratedKnowledge(options); writeMigrationManifest(manifest, options.knowledgeRoot);
      console.log("[orchestrator] copied migration data; source remains the rollback source. Run verify before cutover.");
      return 0;
    }
    const manifest = readMigrationManifest(options.knowledgeRoot);
    const verification = verifyMigration(manifest, options);
    console.log(`[orchestrator] migration verification: ${verification.ok ? "PASS" : "FAIL"}; ${verification.items} items, ${verification.fresh}/${verification.items} fresh.`);
    for (const problem of verification.problems) console.error(`[orchestrator] ${problem}`);
    if (action === "verify") return verification.ok ? 0 : 1;
    const configPath = flagValue(rest, "--config-path");
    confirmCutover(verification, flagValue(rest, "--confirm"), configPath);
    configureKnowledgeRoot(options.knowledgeRoot, configPath, frameworkRoot);
    console.log("[orchestrator] cutover confirmation accepted and installation binding changed. No source deletion was performed.");
    return 0;
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`); return 1;
  }
}
