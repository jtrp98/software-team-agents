import { HumanDecisionRecordSchema, type ApprovalRecord, type HumanDecisionRecord, type VerifiedHumanDecision } from "./approval.js";

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
 * The port is asynchronous because a real channel reads its proof from
 * outside the process (V13 TASK-027: GitHub Issue comments over HTTPS). The
 * orchestrator awaits the verifier *before* it opens the store transaction
 * and re-checks the ledger inside it, so no transaction is held across I/O
 * and no blocking sync wrapper exists.
 *
 * Production resolves the channel from `humanChannelConfig.ts`: the
 * `github-app` channel when its human-owned configuration is complete, else
 * `UNCONFIGURED_HUMAN_CHANNEL`, which fails every approval closed.
 */
export interface HumanDecisionSubmission {
  /** The pending request this submission answers. */
  requestId: string;
  /**
   * The answer the caller expects. A channel that carries the answer itself
   * (github-app: the comment says approve or reject) may be asked without
   * one; when present, the verified answer must equal it.
   */
  approved?: boolean;
  note?: string;
  /** Channel-specific proof. Opaque to STA; only the verifier interprets it. */
  credential?: unknown;
}

/**
 * Where a channel announced a pending request to the human — persisted as
 * `approval-publication` evidence so the binding survives a restart and a
 * decision is looked for only where STA itself asked.
 */
export interface ApprovalPublication {
  channel: string;
  /** The channel's own locator for the announcement (github-app: `owner/repo#<issue>`). */
  ref: string;
  /** Where a person answers, when the channel has a page for it. */
  url: string | null;
}

/** What the orchestrator knows about a request beyond its ledger record, handed to the verifier. */
export interface HumanDecisionContext {
  now: number;
  /** The persisted announcement of this request on the verifier's channel, if it was published. */
  publication: ApprovalPublication | null;
}

/** What a channel shows the human about the request it announces. Never an authority input. */
export interface ApprovalAnnouncement {
  request: ApprovalRecord;
  /** Digests of the task's latest artifacts at the time of asking — what the person is approving. */
  artifacts: ReadonlyArray<{ artifactType: string; contentDigest: string; evidenceId: string }>;
}

export interface HumanDecisionVerifier {
  /** Stable channel name, recorded as `decision.source.channel`. */
  readonly channel: string;
  /**
   * Announces a pending request where a person can answer it. Optional: a
   * channel with nothing to announce (the unconfigured one, test channels)
   * omits it. Throws when the channel is unavailable; the request stays
   * pending either way.
   */
  publish?(announcement: ApprovalAnnouncement): Promise<ApprovalPublication>;
  /**
   * Authenticates and authorizes the submission for exactly this request, or
   * throws. Returns the decision in the ledger's shape; the orchestrator still
   * applies every ledger check (pending, scope, replay) afterwards.
   */
  verify(request: ApprovalRecord, submission: HumanDecisionSubmission, context: HumanDecisionContext): Promise<VerifiedHumanDecision>;
  /**
   * Called once the decision is committed (github-app: closes the Issue).
   * Best effort — the decision is already durable; a failure here is reported,
   * never rolled back into the ledger.
   */
  settle?(request: ApprovalRecord, decision: HumanDecisionRecord, publication: ApprovalPublication | null): Promise<void>;
}

export class NoTrustedHumanChannelError extends Error {
  constructor(requestId: string, detail?: string) {
    super(
      `no trusted human identity channel is configured — approval request ${requestId} cannot be decided` +
        (detail ? ` (${detail})` : "") +
        ". STA fails closed here: a human must install and configure the github-app approval channel (V13 TASK-027).",
    );
    this.name = "NoTrustedHumanChannelError";
  }
}

/**
 * The configured channel could not be reached or refused STA (network error,
 * timeout, 401/404, App not installed). Still a closed gate, never a
 * fallback: the request stays pending until the channel answers.
 */
export class HumanChannelUnavailableError extends NoTrustedHumanChannelError {
  constructor(requestId: string, detail: string) {
    super(requestId, detail);
    this.name = "HumanChannelUnavailableError";
  }
}

/**
 * A channel with no configuration, or whose configuration is broken. Refuses
 * every decision. A broken one also refuses to announce, so a parked run says
 * why nobody can be asked instead of parking silently.
 */
export function unconfiguredHumanChannel(detail?: string): HumanDecisionVerifier {
  return {
    channel: "unconfigured",
    ...(detail === undefined
      ? {}
      : {
          async publish({ request }: ApprovalAnnouncement): Promise<ApprovalPublication> {
            throw new NoTrustedHumanChannelError(request.requestId, detail);
          },
        }),
    async verify(request) {
      throw new NoTrustedHumanChannelError(request.requestId, detail);
    },
  };
}

export const UNCONFIGURED_HUMAN_CHANNEL: HumanDecisionVerifier = unconfiguredHumanChannel();

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
  if (submission.approved !== undefined && decision.data.approved !== submission.approved) {
    throw new UntrustedHumanDecisionError(`verifier ${verifier.channel} changed the submitted answer`);
  }
  return { ...verified, decision: decision.data };
}
