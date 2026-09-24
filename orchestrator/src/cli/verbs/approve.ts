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
  [ApprovalType.UXUI_SIGNOFF]: "Confirm the current UX/UI artifact before frontend work starts",
};

/** Exit code when no trusted human identity channel can authenticate the decision. */
export const APPROVE_EXIT_NO_TRUSTED_CHANNEL = 5;
/** Exit code when the ledger refuses the decision (unknown, settled, superseded, wrong scope, replay, untrusted output). */
export const APPROVE_EXIT_REFUSED = 6;

/**
 * `approve <task-id> --request <request-id> --yes|--no [--note <text>]`
 *
 * Submits a decision for one exact pending request through the task's trusted
 * human channel. Nothing here identifies the person: no environment variable,
 * OS user name or flag is accepted as an actor. With no trusted channel
 * configured the submission is refused and the request stays pending.
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
    if (yes === no) throw new CliUsageError("approve: exactly one of --yes or --no is required");

    try {
      orchestrator.submitHumanDecision({ requestId, approved: yes, ...(note === undefined ? {} : { note }) });
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
    registry.refreshStateView();
    console.log(yes ? `[orchestrator] approved ${requestId}.` : `[orchestrator] rejected ${requestId} — recorded, will not be asked again on resume.`);
    return yes ? 0 : 3;
  } finally {
    registry.close();
  }
}
