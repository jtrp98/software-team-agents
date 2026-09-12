/** `context <role> [--module <m>] [--phase <n,n>] [--task <id>] [--packet] [--views] [--json]`. */
export async function runContextVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const role = positionalArg(rest);
  if (!role) throw new CliUsageError("context: an agent role is required");
  if (rest.includes("--views") && !rest.includes("--packet")) throw new CliUsageError("context: --views requires --packet and --task <id>");
  const projectRoot = path.resolve(flagValue(rest, "--project-root") ?? defaultProjectRoot);
  const phaseRaw = flagValue(rest, "--phase");
  let phases: number[] | undefined;
  if (phaseRaw !== undefined) {
    phases = phaseRaw.split(",").map((value) => Number(value.trim()));
    if (phases.length === 0 || phases.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new CliUsageError("context: --phase must be a comma-separated list of positive integers");
    }
  }
  try {
    const taskId = flagValue(rest, "--task");
    if (rest.includes("--packet")) {
      if (!taskId) throw new CliUsageError("context: --packet requires --task <id>");
      const stage = stageForRole(role);
      const packetPath = latestExecutionPacketPath(projectRoot, taskId, stage);
      if (!packetPath) throw new ContextCommandError(`no persisted execution packet for ${taskId}/${stage}`, 4);
      if (rest.includes("--views")) {
        const packet = readExecutionPacket(packetPath);
        const executionRoot = packet.scope.roots[0];
        let currentRevision: string | undefined;
        let currentConfigHash: string | undefined;
        let currentPlanHash: string | undefined;
        if (executionRoot) {
          try { currentRevision = (await new GitCommandLayer({ cwd: executionRoot }).revParseHead()).stdout.trim(); } catch { /* stale reason is rendered below */ }
          try {
            currentConfigHash = packetConfigHash({
              config: { target: loadTargetConfig(executionRoot), guardStackRules: resolveGuardStackRules(role, executionRoot) },
              guards: { allow: packet.scope.allow, deny: packet.scope.deny },
              verification: packet.required_verification,
              roots: packet.scope.roots,
            });
          } catch { /* stale reason is rendered below */ }
        }
        const suffix = `#${packet.task_id}`;
        const planPointer = packet.expansion_pointers.find(pointer => pointer.endsWith(suffix));
        if (planPointer) {
          try {
            const parsed = parseCanonicalPlan(fs.readFileSync(planPointer.slice(0, -suffix.length), "utf8"));
            if (parsed.problems.length === 0) currentPlanHash = canonicalPlanHash(parsed.tasks);
          } catch { /* stale reason is rendered below */ }
        }
        const views = generateTaskViews(packet, {
          current_revision: currentRevision,
          current_config_hash: currentConfigHash,
          current_compiler_hash: packetCompilerHash(),
          current_plan_hash: currentPlanHash,
        });
        console.log(rest.includes("--json") ? JSON.stringify(views, null, 2) : renderGeneratedTaskViews(views));
        return views.prompt_preview.state === "executable" ? 0 : 4;
      }
      const packet = readExecutionPacketForAudit(packetPath);
      console.log(rest.includes("--json") ? JSON.stringify(packet, null, 2) : renderContextPacket(packet));
      return 0;
    }
    const startedAt = Date.now();
    const result = await buildContextCommand({
      role,
      moduleHint: flagValue(rest, "--module"),
      phases,
      taskId,
      projectRoot,
    });
    console.log(rest.includes("--json") ? JSON.stringify(contextCommandJson(result), null, 2) : renderContextCommand(result));
    // The one measurable-without-runtime-cooperation number `sta tokens` can
    // report; fail-open, never changes this command's exit code.
    recordContextComposition({
      projectRoot,
      agent: result.stage,
      composition: result.composition,
      startedAt,
      endedAt: Date.now(),
    });
    return 0;
  } catch (error) {
    if (error instanceof ContextCommandError) {
      console.error(`[orchestrator] ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}
import * as path from "node:path";
import { CliUsageError } from "../../cli.js";
import { buildContextCommand, ContextCommandError, contextCommandJson, renderContextCommand, renderContextPacket, stageForRole } from "../../context/contextCommand.js";
import { latestExecutionPacketPath, readExecutionPacketForAudit } from "../../state/runtimeArtifacts.js";
import { readExecutionPacket } from "../../state/runtimeArtifacts.js";
import { recordContextComposition } from "../../observability/sessionRecord.js";
import { flagValue, positionalArg } from "../support.js";
import * as fs from "node:fs";
import { packetConfigHash } from "../../artifacts/executionPacket.js";
import { packetCompilerHash } from "../../runtime/agentRunAssembly.js";
import { resolveGuardStackRules } from "../../runtime/runtimeExecutor.js";
import { loadTargetConfig } from "../../targetcli/targetMeta.js";
import { GitCommandLayer } from "../../git/commandLayer.js";
import { parseCanonicalPlan } from "../../docs/planTask.js";
import { canonicalPlanHash } from "../../orchestrator/runtimeTask.js";
import { generateTaskViews, renderGeneratedTaskViews } from "../../views/generatedTaskViews.js";
