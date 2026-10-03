import { randomUUID } from "node:crypto";
import { openStore } from "../cli/support.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { WorkRunError } from "./workRunService.js";

/**
 * The engine-approval relay — the one hook that lets a decision made OUTSIDE
 * this machine's chat (e.g. in the STA Platform inbox) reach the engine's
 * approval ledger through the same trusted path `sta approve` uses.
 *
 * Listing is read-only over the engine's own truth: a task's `approvals`
 * ledger IS the approval state, so a pending row there is exactly what the
 * orchestrator is waiting on. Answering replays the human decision through
 * `registry.resume` → `publishPendingApproval` → `submitHumanDecision` with a
 * local chat-relay credential whose decision id is unique per answer, so the
 * engine's replay protection still holds.
 */

export interface EngineApprovalRef {
  taskId: string;
  requestId: string;
  type: string;
  from: string | null;
  to: string | null;
  reason: string;
}

/** Every pending engine approval across a work run's bounded runs (deduped by task). */
export function pendingApprovalsForRun(knowledgePath: string, boundedRunIds: readonly string[]): EngineApprovalRef[] {
  const { store, registry } = openStore(knowledgePath);
  const ledger = new SqliteRunLedger(store, { projectRoot: knowledgePath });
  try {
    const seen = new Set<string>();
    const approvals: EngineApprovalRef[] = [];
    for (const boundedRunId of boundedRunIds) {
      for (const row of ledger.readTasks(boundedRunId)) {
        if (seen.has(row.task_id)) continue;
        seen.add(row.task_id);
        const task = store.loadTask(row.task_id);
        if (!task || task.cancelled) continue;
        for (const approval of task.approvals) {
          if (approval.status !== "pending") continue;
          approvals.push({
            taskId: task.taskId,
            requestId: approval.requestId,
            type: approval.scope.type,
            from: approval.scope.from ?? null,
            to: approval.scope.to ?? null,
            reason: approval.reason ?? "",
          });
        }
      }
    }
    return approvals;
  } finally {
    ledger.close();
    registry.close();
  }
}

/** Relays one human decision into the engine's approval ledger. Throws when the request is not pending. */
export async function answerEngineApproval(
  knowledgePath: string,
  taskId: string,
  requestId: string,
  approved: boolean,
  by: string,
  note: string | undefined,
): Promise<void> {
  const { registry } = openStore(knowledgePath);
  try {
    const orchestrator = registry.resume(taskId);
    const pending = orchestrator.pendingApprovalRequest();
    if (!pending || pending.requestId !== requestId) {
      throw new WorkRunError(`engine approval ${requestId} is not pending on task ${taskId} (pending: ${pending?.requestId ?? "none"})`, 409);
    }
    const publication = await orchestrator.publishPendingApproval();
    if (!publication) throw new WorkRunError(`engine approval ${requestId} could not be announced on the trusted channel`, 409);
    const { settleError } = await orchestrator.submitHumanDecision({
      requestId,
      approved,
      ...(note === undefined ? {} : { note }),
      credential: {
        kind: "controller-chat-relay",
        conversationId: "sta-core-local",
        messageId: `local-${randomUUID()}`,
        actorId: by,
        messageText: `${approved ? "approve" : "reject"} ${requestId}\n(relayed through the STA Core Local API by ${by}${note ? `: ${note}` : ""})`,
      },
    });
    registry.refreshStateView();
    if (settleError) throw new WorkRunError(`the decision was recorded, but settling the announcement failed: ${settleError}`, 500);
  } finally {
    registry.close();
  }
}
