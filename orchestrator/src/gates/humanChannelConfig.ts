import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { APPROVAL_CHANNEL_DIR_NAME } from "../agents/pathPermissions.js";
import { ApprovalType } from "./approval.js";
import { createGithubAppChannel, type GithubTransport } from "./githubAppChannel.js";
import { UNCONFIGURED_HUMAN_CHANNEL, unconfiguredHumanChannel, type HumanDecisionVerifier } from "./humanDecision.js";

/**
 * Where the human-owned approval-channel configuration lives, and how STA
 * composes its production trusted channel from it (V13 TASK-027).
 *
 * The directory is fixed: `<account home>/.sta-approval-channel/`, with the
 * home taken from the OS account database (`os.userInfo()`), never from
 * `HOME`/`USERPROFILE` or any other environment variable. No flag, env var or
 * project file can point STA at another configuration: whoever controls the
 * approver list controls approval, so the list is looked for in exactly one
 * place — outside every Knowledge, Target and workspace root a role agent is
 * given, and behind the guard floor that denies every runtime's tools the
 * directory (`APPROVAL_CHANNEL_DENY_MARKERS` in `agents/pathPermissions.ts`).
 *
 * The files are created by a person, never by STA or an agent:
 *   github-app.json             { "appId": 123, "repository": "owner/name",
 *                                 "approvers": { "deploy": [<github user id>], … } }
 *   github-app.private-key.pem  the App's private key, as GitHub issued it
 *
 * No configuration means `UNCONFIGURED_HUMAN_CHANNEL`; a broken one (bad
 * JSON, unknown field, missing or unreadable key) is a closed channel that
 * says why. Neither ever falls back to another channel.
 */

export const GITHUB_APP_CONFIG_FILE = "github-app.json";
export const GITHUB_APP_KEY_FILE = "github-app.private-key.pem";

/** The one configuration directory. Throws only when the OS cannot say who the account is. */
export function approvalChannelDir(): string {
  return path.join(os.userInfo().homedir, APPROVAL_CHANNEL_DIR_NAME);
}

const APPROVAL_TYPE_VALUES = Object.values(ApprovalType) as [ApprovalType, ...ApprovalType[]];

export const GithubAppChannelConfigSchema = z.strictObject({
  appId: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository must be owner/name"),
  /** Per gate type: the numeric GitHub user ids that may decide it. Adding an approver is adding an id here. */
  approvers: z.partialRecord(z.enum(APPROVAL_TYPE_VALUES), z.array(z.number().int().positive()).readonly()),
});
export type GithubAppChannelConfig = z.infer<typeof GithubAppChannelConfigSchema>;

export interface ChannelLoadOptions {
  /** Code-level transport injection for fixture tests. There is no configuration or environment equivalent. */
  transport?: GithubTransport;
  clock?: () => number;
}

/**
 * The production trusted channel. Every composition that builds a task
 * registry calls this; nothing else constructs a channel outside tests.
 */
export function resolveHumanDecisionChannel(): HumanDecisionVerifier {
  let dir: string;
  try {
    dir = approvalChannelDir();
  } catch (e) {
    return unconfiguredHumanChannel(`the OS account home directory could not be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return loadHumanDecisionChannelFrom(dir);
}

/** Loads the channel from `dir`. Exported for fixture tests; production passes only `approvalChannelDir()`. */
export function loadHumanDecisionChannelFrom(dir: string, options: ChannelLoadOptions = {}): HumanDecisionVerifier {
  const configPath = path.join(dir, GITHUB_APP_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return UNCONFIGURED_HUMAN_CHANNEL;
  let config: GithubAppChannelConfig;
  try {
    config = GithubAppChannelConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch (e) {
    return unconfiguredHumanChannel(`${configPath} is not a valid github-app configuration: ${e instanceof Error ? e.message : String(e)}`);
  }
  const keyPath = path.join(dir, GITHUB_APP_KEY_FILE);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(fs.readFileSync(keyPath, "utf8"));
  } catch (e) {
    return unconfiguredHumanChannel(`the github-app private key ${keyPath} is missing or unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    return unconfiguredHumanChannel(`the github-app private key ${keyPath} is ${privateKey.asymmetricKeyType ?? "not an asymmetric key"}, not RSA`);
  }
  const [owner, name] = config.repository.split("/") as [string, string];
  return createGithubAppChannel({
    appId: config.appId,
    repository: { owner, name },
    approvers: config.approvers,
    privateKey,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
