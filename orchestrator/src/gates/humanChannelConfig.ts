import * as os from "node:os";
import * as path from "node:path";
import { APPROVAL_CHANNEL_DIR_NAME } from "../agents/pathPermissions.js";
import type { HumanDecisionVerifier } from "./humanDecision.js";
import { createChatRelayChannel } from "./chatRelayChannel.js";

/**
 * The sandbox's protected approval directory and the one production channel.
 *
 * The directory is fixed: `<account home>/.sta-approval-channel/`, with the
 * home taken from the OS account database (`os.userInfo()`), never from
 * `HOME`/`USERPROFILE` or any other environment variable. No flag, env var or
 * project file can point STA at another location: whoever controls approval
 * controls decisions, so the location is exactly one place — outside every
 * Knowledge, Target and workspace root a role agent is given, and behind the
 * guard floor that denies every runtime's tools the directory
 * (`APPROVAL_CHANNEL_DENY_MARKERS` in `agents/pathPermissions.ts`).
 *
 * Nothing reads configuration from it: production resolves only the
 * Controller chat relay (V13 TASK-027 amendment) and never opens a file from
 * the directory. The directory is what the a1 preflight and the guard floor
 * deny to every role agent's tools, so key or config files a person left on
 * an older machine stay out of reach. The historical GitHub App loader was
 * removed with TASK-026.
 */

/** The one configuration directory. Throws only when the OS cannot say who the account is. */
export function approvalChannelDir(): string {
  return path.join(os.userInfo().homedir, APPROVAL_CHANNEL_DIR_NAME);
}

/**
 * The sole production channel. No environment/configuration chooses another.
 */
export function resolveHumanDecisionChannel(): HumanDecisionVerifier {
  return createChatRelayChannel();
}
