import { CliUsageError } from "../cli.js";
import { HOST_ACTOR_UNAVAILABLE } from "../gates/approval.js";
import { ChatRelayCredentialSchema, type ChatRelayCredential } from "../gates/chatRelayChannel.js";
import { flagValue } from "./support.js";

/** Both decision verbs use the API credential schema; omission is never consent or an unavailable identity. */
export function chatRelayCredential(rest: string[]): ChatRelayCredential {
  const unavailable = rest.includes("--chat-actor-unavailable");
  if (unavailable && rest.includes("--chat-actor-id")) {
    throw new CliUsageError("Controller relay: --chat-actor-id and --chat-actor-unavailable are mutually exclusive");
  }
  const value = (flag: string) => {
    const text = flagValue(rest, flag);
    return text?.startsWith("--") ? undefined : text;
  };
  const parsed = ChatRelayCredentialSchema.safeParse({
    kind: "controller-chat-relay",
    conversationId: value("--chat-conversation-id"),
    messageId: value("--chat-message-id"),
    actorId: unavailable ? null : value("--chat-actor-id"),
    ...(unavailable ? { actorUnavailableReason: HOST_ACTOR_UNAVAILABLE } : {}),
    messageText: value("--chat-text"),
  });
  if (!parsed.success) {
    throw new CliUsageError("Controller relay requires --chat-conversation-id, --chat-message-id, --chat-text and either --chat-actor-id or explicit --chat-actor-unavailable (host does not expose the actor ID)");
  }
  return parsed.data;
}
