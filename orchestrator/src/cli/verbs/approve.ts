import { ApprovalType } from "../../gates/approval.js";
import { CliUsageError, confirm } from "../../cli.js";
import { flagValue, openStore, positionalArg } from "../support.js";

export function approvalFieldFor(approvalType: ApprovalType | null): "requirementApproved" | "designApproved" | "humanApproved" | null {
  if (approvalType === ApprovalType.REQUIREMENT_INTERVIEW) return "requirementApproved";
  if (approvalType === ApprovalType.SCHEMA_CONFIRMATION) return "designApproved";
  if (approvalType === ApprovalType.DEPLOY) return "humanApproved";
  return null;
}

export const APPROVAL_PROMPT: Record<ApprovalType, string> = {
  [ApprovalType.SCHEMA_CONFIRMATION]: "Confirm the data model in design.md before any code is written against it",
  [ApprovalType.DEPLOY]: "Approve an actual deploy/migration to production",
  [ApprovalType.QA_FAILURE]: "A QA round came back ⚠️/❌ and needs a decision",
  [ApprovalType.SECURITY_RISK]: "A Critical/Important security finding is unresolved",
  [ApprovalType.REQUIREMENT_INTERVIEW]: "A requirement needs a person, not an inference",
  [ApprovalType.UXUI_SIGNOFF]: "Confirm the current UX/UI artifact before frontend work starts",
};

/** `approve <task-id> [--yes|--no]` — resolves the current WAITING_FOR_HUMAN gate without the full run loop. */
export async function runApproveVerb(rest: string[], defaultProjectRoot: string): Promise<number> {
  const projectRoot = flagValue(rest, "--project-root") ?? defaultProjectRoot;
  const stateDb = flagValue(rest, "--state-db");
  const taskId = positionalArg(rest);
  if (!taskId) throw new CliUsageError("approve: a task id is required");
  const forcedYes = rest.includes("--yes");
  const forcedNo = rest.includes("--no");

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
    if (status.kind !== "WAITING_FOR_HUMAN") {
      console.log(`[orchestrator] task ${taskId} is not waiting on a human decision right now (status: ${status.kind}).`);
      return 1;
    }
    const field = approvalFieldFor(status.approvalType);
    const label = status.approvalType ? `${status.approvalType}` : `${status.from} -> ${status.to}`;
    console.log(`[orchestrator] human decision required (${label}): ${status.reason}`);
    if (status.approvalType) console.log(`[orchestrator]   ${APPROVAL_PROMPT[status.approvalType]}`);
    const approved = forcedYes ? true : forcedNo ? false : await confirm(`Approve ${label}?`);
    if (status.approvalType) {
      orchestrator.decideApproval(status.approvalType, approved, { by: process.env.USER ?? process.env.USERNAME });
    } else if (field) {
      orchestrator.provideHumanApproval(field, approved);
    } else {
      console.log(`[orchestrator] this CLI doesn't know how to resolve that gate.`);
      return 2;
    }
    registry.refreshStateView();
    console.log(approved ? `[orchestrator] approved.` : `[orchestrator] rejected — recorded, will not be asked again on resume.`);
    return approved ? 0 : 3;
  } finally {
    registry.close();
  }
}
