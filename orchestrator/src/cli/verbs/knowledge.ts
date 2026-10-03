/** `knowledge get|manifest|reconcile` (Knowledge content) and `knowledge add|list|validate|default|remove|modules` (STA Core Knowledge workspaces). */
export async function runKnowledgeVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const args = positionalArgs(rest);
  const subcommand = args[0];
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  if (subcommand && KNOWLEDGE_REGISTRY_SUBCOMMANDS.has(subcommand)) return runKnowledgeRegistryVerb(subcommand, args.slice(1), rest);
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
import { addKnowledge, listKnowledge, listModules, removeKnowledgeRegistration, resolveKnowledge, setDefaultKnowledge, validateKnowledge, type KnowledgeSummary } from "../../core/knowledgeRegistry.js";
import { loadMachineConfig } from "../../core/machineConfig.js";
import { CliUsageError } from "../../cli.js";
import { KnowledgeContext } from "../../knowledge/knowledgeContext.js";
import { buildKnowledgeManifest, renderKnowledgeManifest } from "../../knowledge/knowledgeManifest.js";
import { renderKnowledgeRetrieval } from "../../knowledge/retrievalRender.js";
import { reconcileKnowledge, renderReconciliationReport } from "../../knowledge/reconcile.js";
import { laneGet } from "../../roles/laneContext.js";
import { isRoleLane, type RoleLane } from "../../roles/roleLane.js";
import { resolveFrameworkRoot } from "../../targetcli/roots.js";
import { flagValue, openStore, positionalArgs } from "../support.js";

const KNOWLEDGE_REGISTRY_SUBCOMMANDS = new Set(["add", "list", "validate", "default", "remove", "modules"]);

/**
 * STA Core Knowledge workspaces — `sta knowledge add|list|validate|default|remove|modules`.
 * The same registry layer the Web "Knowledge" page uses (`core/knowledgeRegistry.ts`),
 * over the named roots in installation.yaml. `remove` drops the registration only.
 */
function runKnowledgeRegistryVerb(subcommand: string, args: string[], rest: string[]): number {
  const machine = loadMachineConfig();
  const json = rest.includes("--json");
  const th = machine.language === "th";
  const print = (summary: KnowledgeSummary): void => {
    console.log(`${summary.isDefault ? "●" : "○"} ${summary.name}  ${summary.state}`);
    console.log(`  ${summary.path}`);
    console.log(`  ${summary.targets.length} targets · ${summary.modules.length} modules${summary.modules.length ? ` (${summary.modules.join(", ")})` : ""}`);
    for (const problem of summary.problems) console.log(`  ✗ ${problem}`);
    for (const warning of summary.warnings) console.log(`  ! ${warning}`);
  };
  switch (subcommand) {
    case "add": {
      const [name, knowledgePath] = args;
      if (!name || !knowledgePath) throw new CliUsageError("knowledge add: <name> <path> are required");
      const added = addKnowledge(name, path.resolve(knowledgePath), { makeDefault: rest.includes("--default"), machine, frameworkRoot: resolveFrameworkRoot() });
      if (json) console.log(JSON.stringify(added, null, 2));
      else { console.log(th ? `เพิ่ม Knowledge "${name}" แล้ว` : `Knowledge "${name}" added`); print(added); }
      return 0;
    }
    case "list": {
      const all = listKnowledge({ machine });
      if (json) console.log(JSON.stringify(all, null, 2));
      else if (all.length === 0) console.log(th ? "ยังไม่มี Knowledge — sta knowledge add <name> <path>" : "no Knowledge yet — sta knowledge add <name> <path>");
      else for (const summary of all) print(summary);
      return all.some((summary) => summary.state === "INVALID" || summary.state === "MISSING") ? 1 : 0;
    }
    case "validate": {
      const names = args[0] ? [args[0]] : listKnowledge({ machine }).map((summary) => summary.name);
      const results = names.map((name) => validateKnowledge(name, { machine }));
      if (json) console.log(JSON.stringify(results, null, 2));
      else for (const summary of results) print(summary);
      return results.some((summary) => summary.state === "INVALID" || summary.state === "MISSING") ? 1 : 0;
    }
    case "default": {
      if (!args[0]) throw new CliUsageError("knowledge default: <name> is required");
      setDefaultKnowledge(args[0]);
      console.log(th ? `ตั้ง "${args[0]}" เป็น Knowledge เริ่มต้นแล้ว` : `"${args[0]}" is now the default Knowledge`);
      return 0;
    }
    case "remove": {
      if (!args[0]) throw new CliUsageError("knowledge remove: <name> is required");
      removeKnowledgeRegistration(args[0]);
      console.log(th ? `ลบการลงทะเบียน "${args[0]}" แล้ว — ไฟล์ใน repository ไม่ถูกแตะ` : `Registration "${args[0]}" removed — the repository on disk was not touched`);
      return 0;
    }
    case "modules": {
      const knowledge = resolveKnowledge(args[0]);
      const modules = listModules(knowledge.path);
      if (json) console.log(JSON.stringify({ knowledge: knowledge.name, modules }, null, 2));
      else for (const name of modules) console.log(name);
      return 0;
    }
    default:
      throw new CliUsageError(`knowledge: unknown sub-command ${subcommand}`);
  }
}
