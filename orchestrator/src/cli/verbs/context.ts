/** `context <role> [--module <m>] [--phase <n,n>] [--task <id>] [--packet] [--json]`. */
export async function runContextVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const role = positionalArg(rest);
  if (!role) throw new CliUsageError("context: an agent role is required");
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
      const packet = readExecutionPacket(packetPath);
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
import { latestExecutionPacketPath, readExecutionPacket } from "../../state/runtimeArtifacts.js";
import { recordContextComposition } from "../../observability/sessionRecord.js";
import { flagValue, positionalArg } from "../support.js";
