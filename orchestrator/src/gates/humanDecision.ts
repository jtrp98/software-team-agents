import { HumanDecisionRecordSchema, type ApprovalRecord, type HumanDecisionRecord } from "./approval.js";
import type { LaneApprovalRecord } from "./laneApproval.js";

/**
 * The trusted human channel: the only thing that may turn a submission into
 * a human decision STA will record.
 *
 * The current production chat relay receives the Controller's report of a
 * human answer. STA checks its pending request, scope and replay, but cannot
 * independently authenticate the chat actor or message reference. This lower
 * assurance was explicitly accepted by the human for the V13 cutover.
 *
 * The port is asynchronous because a real channel reads its proof from
 * outside the process (V13 TASK-027: GitHub Issue comments over HTTPS). The
 * orchestrator awaits the verifier *before* it opens the store transaction
 * and re-checks the ledger inside it, so no transaction is held across I/O
 * and no blocking sync wrapper exists.
 *
 * Production resolves the single chat-relay channel from humanChannelConfig.
 */
/**
 * Every question a trusted channel can be asked: a task's gate request
 * (`approval.ts`) or a lane act (`laneApproval.ts`, V13 TASK-028). Both carry
 * an immutable STA-minted `requestId`, the time it was opened and a scope
 * whose `type` names the gate — and so the approver list — it is decided under.
 */
export type HumanDecisionRequest = ApprovalRecord | LaneApprovalRecord;

/** What a channel attests for one request: the same request id, the scope it verified, and the decision. */
export interface VerifiedDecisionFor<R extends HumanDecisionRequest> {
  requestId: string;
  scope: R["scope"];
  decision: HumanDecisionRecord;
}

export interface HumanDecisionSubmission {
  /** The pending request this submission answers. */
  requestId: string;
  /**
   * The answer the caller expects. A channel that carries the answer itself
   * may be asked without one; when present, the returned answer must equal it.
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
  /** The channel's own locator for the announcement (chat-relay: the request ID). */
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
  request: HumanDecisionRequest;
  /** Digests of the task's latest artifacts at the time of asking — what the person is approving. A lane request lists its items in its scope instead. */
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
   * Checks the channel submission for exactly this request, or throws. In
   * production chat-relay mode it cannot independently authenticate the
   * Controller-reported actor/message. STA applies pending/scope/replay checks.
   */
  verify<R extends HumanDecisionRequest>(request: R, submission: HumanDecisionSubmission, context: HumanDecisionContext): Promise<VerifiedDecisionFor<R>>;
  /**
   * Called once the decision is committed. Best effort — the decision is
   * already durable; a failure here is reported,
   * never rolled back into the ledger.
   */
  settle?(request: HumanDecisionRequest, decision: HumanDecisionRecord, publication: ApprovalPublication | null): Promise<void>;
}

export class NoTrustedHumanChannelError extends Error {
  constructor(requestId: string, detail?: string) {
    super(
      `no trusted human identity channel is configured — approval request ${requestId} cannot be decided` +
        (detail ? ` (${detail})` : "") +
        ". STA fails closed here until a Controller relays the human's chat answer.",
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
export function assertVerifierOutput<R extends HumanDecisionRequest>(
  verifier: HumanDecisionVerifier,
  submission: HumanDecisionSubmission,
  verified: VerifiedDecisionFor<R>,
): VerifiedDecisionFor<R> {
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
