import { HumanDecisionRecordSchema, type ApprovalRecord, type VerifiedHumanDecision } from "./approval.js";

/**
 * The trusted human channel: the only thing that may turn a submission into
 * a human decision STA will record.
 *
 * A verifier authenticates who answered and that they are authorized for this
 * request, using proof the channel itself controls (a signature, an external
 * system's review record, …). Environment variables, OS user names, CLI flags,
 * prompt text and executor output are never proof: every agent STA runs can
 * set or produce them.
 *
 * No production verifier exists yet. `UNCONFIGURED_HUMAN_CHANNEL` is the
 * default everywhere, so every approval fails closed until a human-owned
 * integration decision supplies a real channel (V13 TASK-001).
 */
export interface HumanDecisionSubmission {
  /** The pending request this submission answers. */
  requestId: string;
  approved: boolean;
  note?: string;
  /** Channel-specific proof. Opaque to STA; only the verifier interprets it. */
  credential?: unknown;
}

export interface HumanDecisionVerifier {
  /** Stable channel name, recorded as `decision.source.channel`. */
  readonly channel: string;
  /**
   * Authenticates and authorizes the submission for exactly this request, or
   * throws. Returns the decision in the ledger's shape; the orchestrator still
   * applies every ledger check (pending, scope, replay) afterwards.
   */
  verify(request: ApprovalRecord, submission: HumanDecisionSubmission, now: number): VerifiedHumanDecision;
}

export class NoTrustedHumanChannelError extends Error {
  constructor(requestId: string) {
    super(
      `no trusted human identity channel is configured — approval request ${requestId} cannot be decided. ` +
        "STA fails closed here: a human must choose and integrate an authenticated approval channel (V13 TASK-001 dependency).",
    );
    this.name = "NoTrustedHumanChannelError";
  }
}

export const UNCONFIGURED_HUMAN_CHANNEL: HumanDecisionVerifier = {
  channel: "unconfigured",
  verify(request) {
    throw new NoTrustedHumanChannelError(request.requestId);
  },
};

export class UntrustedHumanDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedHumanDecisionError";
  }
}

/**
 * Checks what a verifier returned before the ledger sees it: it must answer
 * the submitted request, be a well-formed human decision, and name the
 * verifier's own channel. A verifier cannot launder a decision for another
 * request or claim to be a different channel.
 */
export function assertVerifierOutput(
  verifier: HumanDecisionVerifier,
  submission: HumanDecisionSubmission,
  verified: VerifiedHumanDecision,
): VerifiedHumanDecision {
  if (verified.requestId !== submission.requestId) {
    throw new UntrustedHumanDecisionError(`verifier ${verifier.channel} answered ${verified.requestId}, not the submitted ${submission.requestId}`);
  }
  const decision = HumanDecisionRecordSchema.safeParse(verified.decision);
  if (!decision.success) throw new UntrustedHumanDecisionError(`verifier ${verifier.channel} returned a malformed decision: ${decision.error.message}`);
  if (decision.data.source.channel !== verifier.channel) {
    throw new UntrustedHumanDecisionError(`verifier ${verifier.channel} returned a decision claiming channel ${decision.data.source.channel}`);
  }
  if (decision.data.approved !== submission.approved) {
    throw new UntrustedHumanDecisionError(`verifier ${verifier.channel} changed the submitted answer`);
  }
  return { ...verified, decision: decision.data };
}
