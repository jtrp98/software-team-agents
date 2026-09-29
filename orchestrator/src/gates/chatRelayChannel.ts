import { z } from "zod";
import {
  UntrustedHumanDecisionError,
  type HumanDecisionContext,
  type HumanDecisionRequest,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
  type VerifiedDecisionFor,
} from "./humanDecision.js";

/** Controller-reported chat answer. STA cannot independently authenticate these fields. */
export const ChatRelayCredentialSchema = z.strictObject({
  kind: z.literal("controller-chat-relay"),
  conversationId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  messageText: z.string().trim().min(1),
});
export type ChatRelayCredential = z.infer<typeof ChatRelayCredentialSchema>;
export const CHAT_RELAY_CHANNEL = "chat-relay";

/**
 * The sole production decision channel. The Controller presents the pending
 * request to the human and relays the answer with a chat message reference.
 * The human explicitly accepted the reduced assurance: the reference and
 * actor are Controller assertions, not independently verified identity proof.
 */
export function createChatRelayChannel(): HumanDecisionVerifier {
  return {
    channel: CHAT_RELAY_CHANNEL,
    async publish({ request }) {
      return { channel: CHAT_RELAY_CHANNEL, ref: request.requestId, url: null };
    },
    async verify<R extends HumanDecisionRequest>(
      request: R,
      submission: HumanDecisionSubmission,
      { now, publication }: HumanDecisionContext,
    ): Promise<VerifiedDecisionFor<R>> {
      if (publication?.channel !== CHAT_RELAY_CHANNEL || publication.ref !== request.requestId) {
        throw new UntrustedHumanDecisionError("chat-relay: pending request was not presented through STA");
      }
      if (submission.requestId !== request.requestId || submission.approved === undefined) {
        throw new UntrustedHumanDecisionError("chat-relay: exact request ID and approve/reject answer are required");
      }
      const parsed = ChatRelayCredentialSchema.safeParse(submission.credential);
      if (!parsed.success) {
        throw new UntrustedHumanDecisionError("chat-relay: Controller must provide conversation, message, actor and original text");
      }
      const message = parsed.data;
      const evidenceRef = `chat:${encodeURIComponent(message.conversationId)}/${encodeURIComponent(message.messageId)}`;
      return {
        requestId: request.requestId,
        scope: request.scope,
        decision: {
          decisionId: `${CHAT_RELAY_CHANNEL}:${evidenceRef}`,
          approved: submission.approved,
          actor: { kind: "human", id: `chat-user:${message.actorId}` },
          source: { channel: CHAT_RELAY_CHANNEL, evidenceRef },
          decidedAt: now,
          note: message.messageText,
        },
      };
    },
  };
}
