/** `knowledge get <id>[,<id>...] [--lane <lane>] [--json]`; `knowledge manifest [--json]`; `knowledge reconcile --target <id>`. */
export async function runKnowledgeVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const args = positionalArgs(rest);
  const subcommand = args[0];
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  if (subcommand === "manifest") {
    if (args.length > 1) throw new CliUsageError("knowledge manifest: no positional arguments are accepted");
    // The same store `sta status` reads, so discovery and status can never
    // disagree about what STA holds (V13 TASK-010).
    const { store, registry } = openStore(projectRoot, flagValue(rest, "--state-db"));
    try {
      const manifest = buildKnowledgeManifest({ knowledgeRoot: projectRoot, store, now: new Date().toISOString() });
      if (rest.includes("--json")) console.log(JSON.stringify(manifest, null, 2));
      else for (const line of renderKnowledgeManifest(manifest)) console.log(line);
      // Stale/missing references are visible failures, not notes: a non-zero
      // exit is how a fresh Controller learns the manifest cannot be trusted.
      return manifest.problems.length > 0 ? 1 : 0;
    } finally {
      registry.close();
    }
  }
  if (subcommand === "reconcile") {
    if (args.length > 1) throw new CliUsageError("knowledge reconcile: no positional arguments are accepted");
    const targetId = flagValue(rest, "--target");
    if (!targetId) throw new CliUsageError("knowledge reconcile: --target <id> is required");
    const report = reconcileKnowledge({ knowledgeRoot: projectRoot, frameworkRoot: resolveFrameworkRoot(), targetId, now: flagValue(rest, "--now") ?? new Date().toISOString() });
    console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : renderReconciliationReport(report));
    return 0;
  }
  if (subcommand !== "get") throw new CliUsageError("knowledge: expected sub-command get, manifest or reconcile");
  const ids = (args[1] ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length === 0) throw new CliUsageError("knowledge get: an item id is required");
  if (args.length > 2) throw new CliUsageError("knowledge get: ids must be one comma-separated argument");

  const laneRaw = flagValue(rest, "--lane") ?? "dev";
  if (!isRoleLane(laneRaw)) {
    throw new CliUsageError(`knowledge get: "${laneRaw}" is not a lane — use ba, sa, uxui, or dev`);
  }
  const lane = laneRaw as RoleLane;
  const context = KnowledgeContext.load(projectRoot, new Date().toISOString());
  const rendered = ids.map((id) => ({ id, result: renderKnowledgeRetrieval(lane, id, laneGet(lane, context, id)) }));
  const json = rest.includes("--json");
  if (json) console.log(JSON.stringify({ lane, items: rendered.map((entry) => entry.result.json) }, null, 2));
  else for (const entry of rendered) console.log(entry.result.text);
  return rendered.some((entry) => (entry.result.json.status as string | undefined) === "not_found") ? 1 : 0;
}
import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import { KnowledgeContext } from "../../knowledge/knowledgeContext.js";
import { buildKnowledgeManifest, renderKnowledgeManifest } from "../../knowledge/knowledgeManifest.js";
import { renderKnowledgeRetrieval } from "../../knowledge/retrievalRender.js";
import { reconcileKnowledge, renderReconciliationReport } from "../../knowledge/reconcile.js";
import { laneGet } from "../../roles/laneContext.js";
import { isRoleLane, type RoleLane } from "../../roles/roleLane.js";
import { resolveFrameworkRoot } from "../../targetcli/roots.js";
import { flagValue, openStore, positionalArgs } from "../support.js";
