import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNCONFIGURED_HUMAN_CHANNEL } from "./humanDecision.js";
import { CHAT_RELAY_CHANNEL } from "./chatRelayChannel.js";
import * as mocked from "./humanChannelConfig.js";
import { APPROVAL_CHANNEL_DIR_NAME } from "../agents/pathPermissions.js";

/** The real module — the global test setup replaces only `resolveHumanDecisionChannel` for every other test. */
const actual = await vi.importActual<typeof import("./humanChannelConfig.js")>("./humanChannelConfig.js");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("approval-channel configuration (V13 TASK-027)", () => {
  it("production resolves only the Controller chat relay, without reading App configuration", () => {
    expect(actual.resolveHumanDecisionChannel().channel).toBe(CHAT_RELAY_CHANNEL);
  });
  it("lives in one fixed directory under the OS account home; HOME/USERPROFILE cannot move it", () => {
    const expected = path.join(os.userInfo().homedir, APPROVAL_CHANNEL_DIR_NAME);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH };
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "sta-approval-channel-fixture-"));
    dirs.push(decoy);
    try {
      process.env.HOME = decoy;
      process.env.USERPROFILE = decoy;
      process.env.HOMEDRIVE = "Z:";
      process.env.HOMEPATH = "\\decoy";
      expect(os.homedir()).toBe(decoy); // the env-driven lookup would have moved
      expect(actual.approvalChannelDir()).toBe(expected);
      expect(actual.approvalChannelDir().startsWith(decoy)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("is never read by tests through the production resolver", () => {
    expect(vi.isMockFunction(mocked.resolveHumanDecisionChannel)).toBe(true);
    expect(mocked.resolveHumanDecisionChannel()).toBe(UNCONFIGURED_HUMAN_CHANNEL);
  });
});
