import { z } from "zod";
import { HOST_ACTOR_UNAVAILABLE } from "./approval.js";
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
  actorId: z.string().trim().min(1).nullable(),
  actorUnavailableReason: z.literal(HOST_ACTOR_UNAVAILABLE).optional(),
  messageText: z.string().refine((text) => text.trim().length > 0),
}).refine((message) => (message.actorId === null) === (message.actorUnavailableReason !== undefined), {
  message: "null actor requires an explicit host-unavailable reason; a supplied actor must not claim it is unavailable",
});
export type ChatRelayCredential = z.infer<typeof ChatRelayCredentialSchema>;
export const CHAT_RELAY_CHANNEL = "chat-relay";

/** Shared presentation contract for CLI and Controller API; never identity proof. */
export function chatRelayInstructions(requestId: string): string {
  return `Reply with "approve ${requestId}" or "reject ${requestId}" on the first line; an optional reason follows on a new line. A single Markdown code block may wrap the entire answer. ` +
    "The Controller must relay the original answer and chat reference. If the host does not expose the actor ID, explicitly report it as unavailable; audit cannot identify that person. STA cannot independently authenticate the actor or message reference.";
}

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
      if (submission.requestId !== request.requestId || typeof submission.approved !== "boolean") {
        throw new UntrustedHumanDecisionError("chat-relay: exact request ID and approve/reject answer are required");
      }
      const parsed = ChatRelayCredentialSchema.safeParse(submission.credential);
      if (!parsed.success) {
        throw new UntrustedHumanDecisionError("chat-relay: Controller must provide conversation, message, original text and actor ID or explicit host-unavailable metadata");
      }
      const message = parsed.data;
      // Parse an explicit directive, never infer consent from prose, quoted
      // examples, a bare flag, or a reference to some other pending request.
      // Validation may trim whitespace; the durable note retains original bytes.
      const original = message.messageText.trim();
      // Chat renders our copyable answer as a code block. Accept only a whole-
      // message block, never extract a directive from surrounding prose or quotes.
      const fenced = /^```(?:text)?[ \t]*\r?\n((?:(?!```)[\s\S])*)\r?\n```$/.exec(original);
      const answerText = (fenced ? fenced[1] : original).trim();
      const answer = /^(approve|reject)[ \t]+(apr_[0-9a-f]{32})[ \t]*(?:\r?\n[\s\S]*)?$/.exec(answerText);
      if (!answer || answer[2] !== request.requestId) {
        throw new UntrustedHumanDecisionError(`chat-relay: original answer must name the exact request. ${chatRelayInstructions(request.requestId)}`);
      }
      const approved = answer[1] === "approve";
      if (approved !== submission.approved) {
        throw new UntrustedHumanDecisionError("chat-relay: original answer contradicts the submitted approve/reject decision");
      }
      const evidenceRef = `chat:${encodeURIComponent(message.conversationId)}/${encodeURIComponent(message.messageId)}`;
      return {
        requestId: request.requestId,
        scope: request.scope,
        decision: {
          decisionId: `${CHAT_RELAY_CHANNEL}:${evidenceRef}`,
          approved,
          actor: message.actorId === null
            ? { kind: "human", id: null, unavailableReason: HOST_ACTOR_UNAVAILABLE }
            : { kind: "human", id: `chat-user:${message.actorId}` },
          source: { channel: CHAT_RELAY_CHANNEL, evidenceRef },
          decidedAt: now,
          note: message.messageText,
        },
      };
    },
  };
}
