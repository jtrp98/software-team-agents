import type { AgentExecutor, Orchestrator } from "../orchestrator/orchestrator.js";
import type { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { APPROVAL_PROMPT, approvalFieldFor } from "./verbs/approve.js";

export type RunTaskLoopIo = {
  log: (message: string) => void;
  error: (message: string) => void;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  actor: string | undefined;
};

/**
 * Drives one task until it deploys or reaches a terminal/person-owned stop.
 * Composition remains in cli.ts; terminal state is injected so every branch
 * is deterministic under test and headless runs never attempt to read stdin.
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
      const field = approvalFieldFor(status.approvalType);
      if (!field) {
        io.log(
          `[orchestrator] task ${taskId} stuck waiting: ${status.from} -> ${status.to} (${status.reason}), ` +
            "and this CLI doesn't know how to resolve that gate interactively.",
        );
        return 2;
      }
      const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
      io.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
      if (status.approvalType) io.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);

      if (!io.isTTY) {
        io.log(
          `[orchestrator] no terminal attached — parking task ${taskId} with the gate unanswered. ` +
            `Resolve it with: node orchestrator/dist/cli.js approve ${taskId} --yes|--no ` +
            `(or rerun this command in an interactive terminal), then --resume.`,
        );
        return 4;
      }

      const approved = await io.confirm(`Approve ${label}?`);
      if (!approved) {
        if (status.approvalType) {
          orchestrator.decideApproval(status.approvalType, false, { by: io.actor });
        }
        registry.refreshStateView();
        io.log(
          `[orchestrator] rejected — task ${taskId} is stopped and the decision is recorded. ` +
            `Resuming will not ask again; revisit it deliberately if that was wrong.`,
        );
        return 3;
      }
      if (status.approvalType) {
        orchestrator.decideApproval(status.approvalType, true, { by: io.actor });
      } else {
        orchestrator.provideHumanApproval(field, true);
      }
      registry.refreshStateView();
      continue;
    }

    io.log(`[orchestrator] running ${status.stage}...`);
    const nextStatus = await orchestrator.step(executor);
    registry.refreshStateView();
    if (nextStatus.kind === "RUNNING" && nextStatus.stage === status.stage) {
      io.log(`[orchestrator] ${status.stage} did not advance the task — stopping to avoid a spin loop.`);
      return 1;
    }
  }
}
