import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ApprovalRecord, VerifiedHumanDecision } from "./approval.js";
import { UntrustedHumanDecisionError, type HumanDecisionSubmission, type HumanDecisionVerifier } from "./humanDecision.js";

/**
 * Test-only trusted channel. It stands in for a real authenticated channel so
 * tests can exercise the ledger's checks; nothing in production composes it,
 * and production defaults to `UNCONFIGURED_HUMAN_CHANNEL`.
 */
export const TEST_HUMAN_CHANNEL = "test-human-channel";
export const TEST_HUMAN_CREDENTIAL = "test-human-credential";

export interface TestCredential {
  token: string;
  actorId?: string;
  /** Fixed decision id, for replay tests. Defaults to a fresh id per verification. */
  decisionId?: string;
  /** Overrides the scope the channel attests to, for wrong-scope tests. */
  scope?: Partial<ApprovalRecord["scope"]>;
}

export function testHumanVerifier(opts: { defaultActor?: string; authorizedActors?: readonly string[] } = {}): HumanDecisionVerifier {
  const defaultActor = opts.defaultActor ?? "test-human";
  let counter = 0;
  return {
    channel: TEST_HUMAN_CHANNEL,
    verify(request: ApprovalRecord, submission: HumanDecisionSubmission, now: number): VerifiedHumanDecision {
      const credential = submission.credential as TestCredential | undefined;
      if (!credential || credential.token !== TEST_HUMAN_CREDENTIAL) {
        throw new UntrustedHumanDecisionError(`${TEST_HUMAN_CHANNEL}: credential not authenticated`);
      }
      const actorId = credential.actorId ?? defaultActor;
      if (opts.authorizedActors && !opts.authorizedActors.includes(actorId)) {
        throw new UntrustedHumanDecisionError(`${TEST_HUMAN_CHANNEL}: ${actorId} is not authorized for ${request.scope.type}`);
      }
      counter += 1;
      return {
        requestId: submission.requestId,
        scope: { ...request.scope, ...(credential.scope ?? {}) },
        decision: {
          decisionId: credential.decisionId ?? `test-decision-${request.requestId}-${counter}`,
          approved: submission.approved,
          actor: { kind: "human", id: actorId },
          source: { channel: TEST_HUMAN_CHANNEL, evidenceRef: `test-evidence-${counter}` },
          decidedAt: now,
          note: submission.note ?? null,
        },
      };
    },
  };
}

export function trustedCredential(extra: Omit<TestCredential, "token"> = {}): TestCredential {
  return { token: TEST_HUMAN_CREDENTIAL, ...extra };
}

/** Answers whatever request the task is waiting on, through the orchestrator's configured channel. */
export function decidePending(orchestrator: Orchestrator, approved: boolean, extra: { note?: string; actorId?: string } = {}): string {
  const pending = orchestrator.pendingApprovalRequest();
  if (!pending) throw new Error(`task ${orchestrator.taskId} has no pending approval request`);
  orchestrator.submitHumanDecision({
    requestId: pending.requestId,
    approved,
    ...(extra.note === undefined ? {} : { note: extra.note }),
    credential: trustedCredential(extra.actorId === undefined ? {} : { actorId: extra.actorId }),
  });
  return pending.requestId;
}
