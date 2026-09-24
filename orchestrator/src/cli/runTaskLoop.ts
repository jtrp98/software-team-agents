import type { AgentExecutor, Orchestrator } from "../orchestrator/orchestrator.js";
import type { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { APPROVAL_PROMPT } from "./verbs/approve.js";

export type RunTaskLoopIo = {
  log: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Drives one task until it deploys or reaches a terminal/person-owned stop.
 * Composition remains in cli.ts; terminal state is injected so every branch
 * is deterministic under test.
 *
 * A human gate always parks the task: the loop never answers it, never asks
 * on stdin and never names an actor. A decision reaches STA only through
 * `approve --request <id>`, which requires a trusted human channel.
 */
export async function runTaskLoop(
  orchestrator: Orchestrator,
  registry: Pick<TaskRegistry, "refreshStateView">,
  executor: AgentExecutor,
  io: RunTaskLoopIo,
): Promise<number> {
  const taskId = orchestrator.taskId;
  for (;;) {
    const status = orchestrator.status();
    registry.refreshStateView();

    if (status.kind === "DEPLOYED") {
      io.log(`[orchestrator] task ${taskId} DEPLOYED.`);
      io.log(orchestrator.runLog.summary(taskId));
      return 0;
    }
    if (status.kind === "BLOCKED") {
      io.log(`[orchestrator] task ${taskId} BLOCKED: ${status.reason}`);
      return 1;
    }
    if (status.kind === "WAITING_FOR_HUMAN") {
      const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
      io.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
      if (status.approvalType) io.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);
      if (!status.requestId) {
        io.log(
          `[orchestrator] task ${taskId} stuck waiting: ${status.from} -> ${status.to} has no pending approval request to answer.`,
        );
        return 2;
      }
      io.log(
        `[orchestrator] parking task ${taskId} on pending request ${status.requestId}. ` +
          `A person resolves it through a trusted channel: ` +
          `node orchestrator/dist/cli.js approve ${taskId} --request ${status.requestId} --yes|--no, then --resume.`,
      );
      return 4;
    }

    io.log(`[orchestrator] running ${status.stage}...`);
    const nextStatus = await orchestrator.step(executor);
    registry.refreshStateView();
    if (nextStatus.kind === "RUNNING" && nextStatus.stage === status.stage) {
      io.log(`[orchestrator] ${status.stage} did not advance the task — stopping to avoid a spin loop.`);
      // Why, from STA's own completion decision rather than the agent's report (V13 TASK-003).
      const decision = orchestrator.stageDecision;
      if (decision && !decision.decision.complete) {
        io.log(`[orchestrator]   attempt ${decision.attempt} is incomplete: ${decision.decision.missing.join("; ")}`);
      }
      return 1;
    }
  }
}
