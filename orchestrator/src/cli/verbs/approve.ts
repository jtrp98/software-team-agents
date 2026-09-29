import { ApprovalDecisionError, ApprovalType } from "../../gates/approval.js";
import { NoTrustedHumanChannelError, UntrustedHumanDecisionError } from "../../gates/humanDecision.js";
import { CliUsageError } from "../../cli.js";
import { flagValue, openStore, positionalArg } from "../support.js";

export const APPROVAL_PROMPT: Record<ApprovalType, string> = {
  [ApprovalType.SCHEMA_CONFIRMATION]: "Confirm the exact risk-triggered design boundary: schema/migration, breaking compatibility, critical security, or material ambiguity",
  [ApprovalType.DEPLOY]: "Approve an actual deploy/migration to production",
  [ApprovalType.REVIEW_FAILURE]: "A reviewer round came back ❌ Changes requested and no automatic route may answer it",
  [ApprovalType.QA_FAILURE]: "A QA round came back ⚠️/❌ and needs a decision",
  [ApprovalType.SECURITY_RISK]: "A Critical/Important security finding is unresolved",
  [ApprovalType.REQUIREMENT_INTERVIEW]: "Answer the displayed missing confirmation or material business question; generic approval cannot supply a missing decision",
  [ApprovalType.UXUI_SIGNOFF]: "Sign off the UXUI lane: the listed UX artifacts at these exact versions are binding and frontend work may start",
  [ApprovalType.BA_SIGNOFF]: "Sign off the BA lane: the listed requirement items at these exact versions are binding and the BA lane is finished",
  [ApprovalType.SA_SIGNOFF]: "Sign off the SA lane: the listed design items at these exact versions are binding and the SA lane is finished",
  [ApprovalType.DEV_SIGNOFF]: "Sign off the DEV lane: the listed task items at these exact versions are binding",
  [ApprovalType.BA_ACK]: "Acknowledge, for the BA lane, that you have seen the listed items at these exact versions",
  [ApprovalType.SA_ACK]: "Acknowledge, for the SA lane, that you have seen the listed items at these exact versions",
  [ApprovalType.UXUI_ACK]: "Acknowledge, for the UXUI lane, that you have seen the listed items at these exact versions",
  [ApprovalType.DEV_ACK]: "Acknowledge, for the DEV lane, that you have seen the listed items at these exact versions",
};

/** Exit code when no trusted human identity channel can authenticate the decision (unconfigured, or unreachable). */
export const APPROVE_EXIT_NO_TRUSTED_CHANNEL = 5;
/** Exit code when the ledger refuses the decision (unknown, settled, superseded, wrong scope, replay, untrusted output). */
export const APPROVE_EXIT_REFUSED = 6;
/** Exit code when STA has just announced the request on its channel: nobody can have answered it yet. */
export const APPROVE_EXIT_ANNOUNCED = 4;

/**
 * `approve <task-id> --request <request-id> [--yes|--no] [--note <text>]`
 *
 * Shows one pending request or records the Controller's relay of the Human's
 * chat answer. STA checks the pending request and requires chat reference
 * fields; it cannot authenticate their origin independently.
 */
export async function runApproveVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("approve: a task id is required");
  const yes = rest.includes("--yes");
  const no = rest.includes("--no");
  const requestId = flagValue(rest, "--request");
  const note = flagValue(rest, "--note");

  const { store, registry } = openStore(projectRoot, stateDb);
  try {
    const stored = store.loadTask(taskId);
    if (!stored) throw new CliUsageError(`approve: task ${taskId} is not in this store`);
    if (stored.cancelled) {
      console.log(`[orchestrator] task ${taskId} is cancelled — nothing to approve.`);
      return 1;
    }
    const orchestrator = registry.resume(taskId);
    const status = orchestrator.status();
    registry.refreshStateView();
    const pending = orchestrator.pendingApprovalRequest();
    if (!pending) {
      console.log(`[orchestrator] task ${taskId} has no pending approval request (status: ${status.kind}).`);
      return 1;
    }
    const { scope } = pending;
    console.log(
      `[orchestrator] pending approval request ${pending.requestId} (${scope.type}` +
        `${scope.from && scope.to ? `, ${scope.from} -> ${scope.to}` : ""}): ${pending.reason}`,
    );
    console.log(`[orchestrator]   ${APPROVAL_PROMPT[scope.type]}`);
    if (!requestId) {
      throw new CliUsageError(`approve: --request <request-id> is required; the pending request is ${pending.requestId}`);
    }
    if (yes && no) throw new CliUsageError("approve: --yes and --no are mutually exclusive");
    const conversationId = flagValue(rest, "--chat-conversation-id");
    const messageId = flagValue(rest, "--chat-message-id");
    const actorId = flagValue(rest, "--chat-actor-id");
    const messageText = flagValue(rest, "--chat-text");
    if ((yes || no) && [conversationId, messageId, actorId, messageText].some((value) => !value?.trim())) {
      throw new CliUsageError("approve: Controller relay requires --chat-conversation-id, --chat-message-id, --chat-actor-id and --chat-text");
    }

    try {
      if (requestId === pending.requestId) {
        const publication = await orchestrator.publishPendingApproval();
        if (!publication) throw new NoTrustedHumanChannelError(requestId);
        console.log(`[orchestrator] request ${publication.requestId} is announced on ${publication.channel}: ${publication.url ?? publication.ref}`);
        if (!yes && !no) {
          console.log("[orchestrator] show this request to the human in chat, then relay the answer with --yes or --no and its chat reference.");
          return APPROVE_EXIT_ANNOUNCED;
        }
        const { decision, settleError } = await orchestrator.submitHumanDecision({
          requestId,
          approved: yes,
          ...(note === undefined ? {} : { note }),
          credential: {
            kind: "controller-chat-relay",
            conversationId, messageId, actorId, messageText,
          },
        });
        registry.refreshStateView();
        if (settleError) console.error(`[orchestrator] decision recorded, but the channel could not settle its announcement: ${settleError}`);
        console.log(`[orchestrator] ${decision.approved ? "approved" : "rejected"} ${requestId} (${decision.actor.id} via ${decision.source.channel}).`);
        return decision.approved ? 0 : 3;
      }
      throw new ApprovalDecisionError("unknown-request", `pending request is ${pending.requestId}, not ${requestId}`);
    } catch (e) {
      if (e instanceof NoTrustedHumanChannelError) {
        console.error(`[orchestrator] refused: ${e.message}`);
        return APPROVE_EXIT_NO_TRUSTED_CHANNEL;
      }
      if (e instanceof ApprovalDecisionError || e instanceof UntrustedHumanDecisionError) {
        console.error(`[orchestrator] refused: ${e.message}`);
        return APPROVE_EXIT_REFUSED;
      }
      throw e;
    }
  } finally {
    registry.close();
  }
}
