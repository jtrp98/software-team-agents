import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ApprovalType } from "./approval.js";
import { NoTrustedHumanChannelError, UNCONFIGURED_HUMAN_CHANNEL, type HumanDecisionVerifier } from "./humanDecision.js";
import { GITHUB_APP_CHANNEL } from "./githubAppChannel.js";
import { FIXTURE_APP_ID, fixtureAppKeys, GithubFixture } from "./githubAppChannel.testSupport.js";
import * as mocked from "./humanChannelConfig.js";
import { APPROVAL_CHANNEL_DIR_NAME } from "../agents/pathPermissions.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

/** The real module — the global test setup replaces only `resolveHumanDecisionChannel` for every other test. */
const actual = await vi.importActual<typeof import("./humanChannelConfig.js")>("./humanChannelConfig.js");

const dirs: string[] = [];
function channelDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-approval-channel-fixture-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PEM = fixtureAppKeys().privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const validConfig = (approvers: Record<string, number[]> = { [ApprovalType.SCHEMA_CONFIRMATION]: [1001] }) =>
  JSON.stringify({ appId: FIXTURE_APP_ID, repository: "acme/approvals", approvers });

async function refusalOf(verifier: HumanDecisionVerifier): Promise<Error> {
  const orch = new Orchestrator("T-1", classifyTask({ isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true, testStrategyTriggers: ["cross-task"] }), {
    store: new MemoryTaskStore(),
    stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
    humanDecisionVerifier: verifier,
  });
  await orch.step(withStageEvidence(() => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } })));
  const pending = orch.pendingApprovalRequest()!;
  // A broken configuration cannot announce either — a parked run says why rather than parking silently.
  if (verifier !== UNCONFIGURED_HUMAN_CHANNEL) {
    await expect(orch.publishPendingApproval()).rejects.toBeInstanceOf(NoTrustedHumanChannelError);
    expect(orch.evidence().some((r) => r.kind === "approval-publication")).toBe(false);
  } else {
    expect(await orch.publishPendingApproval()).toBeNull();
  }
  try {
    await orch.submitHumanDecision({ requestId: pending.requestId, approved: true });
  } catch (e) {
    expect(orch.approvalLedger[0]!.status).toBe("pending");
    return e as Error;
  }
  throw new Error("expected a refusal");
}

describe("approval-channel configuration (V13 TASK-027)", () => {
  it("lives in one fixed directory under the OS account home; HOME/USERPROFILE cannot move it", () => {
    const expected = path.join(os.userInfo().homedir, APPROVAL_CHANNEL_DIR_NAME);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH };
    const decoy = channelDir({ [actual.GITHUB_APP_CONFIG_FILE]: validConfig(), [actual.GITHUB_APP_KEY_FILE]: PEM });
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

  it("no configuration is the unconfigured channel: every decision fails closed", async () => {
    const verifier = actual.loadHumanDecisionChannelFrom(channelDir());
    expect(verifier).toBe(UNCONFIGURED_HUMAN_CHANNEL);
    expect(await refusalOf(verifier)).toBeInstanceOf(NoTrustedHumanChannelError);
  });

  it("a broken configuration is a closed channel that says why, never a fallback", async () => {
    const ed25519 = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const broken: Array<{ name: string; files: Record<string, string>; why: RegExp }> = [
      { name: "not JSON", files: { [actual.GITHUB_APP_CONFIG_FILE]: "{", [actual.GITHUB_APP_KEY_FILE]: PEM }, why: /not a valid github-app configuration/ },
      {
        name: "API base smuggled in",
        files: { [actual.GITHUB_APP_CONFIG_FILE]: JSON.stringify({ ...JSON.parse(validConfig()), apiBaseUrl: "https://evil.example.test" }), [actual.GITHUB_APP_KEY_FILE]: PEM },
        why: /apiBaseUrl/,
      },
      { name: "unknown gate type", files: { [actual.GITHUB_APP_CONFIG_FILE]: validConfig({ "all-gates": [1001] }), [actual.GITHUB_APP_KEY_FILE]: PEM }, why: /not a valid/ },
      {
        name: "login instead of numeric id",
        files: { [actual.GITHUB_APP_CONFIG_FILE]: JSON.stringify({ appId: 1, repository: "acme/approvals", approvers: { deploy: ["approver-one"] } }), [actual.GITHUB_APP_KEY_FILE]: PEM },
        why: /not a valid/,
      },
      { name: "missing key", files: { [actual.GITHUB_APP_CONFIG_FILE]: validConfig() }, why: /private key .* missing or unreadable/ },
      { name: "non-RSA key", files: { [actual.GITHUB_APP_CONFIG_FILE]: validConfig(), [actual.GITHUB_APP_KEY_FILE]: ed25519 }, why: /not RSA/ },
    ];
    for (const b of broken) {
      const verifier = actual.loadHumanDecisionChannelFrom(channelDir(b.files));
      expect(verifier.channel, b.name).toBe("unconfigured");
      const err = await refusalOf(verifier);
      expect(err, b.name).toBeInstanceOf(NoTrustedHumanChannelError);
      expect(err.message, b.name).toMatch(b.why);
    }
  });

  it("a complete configuration composes the github-app channel, and a new approver is one id in the file", async () => {
    const fixture = new GithubFixture();
    const dir = channelDir({ [actual.GITHUB_APP_CONFIG_FILE]: validConfig(), [actual.GITHUB_APP_KEY_FILE]: PEM });
    const T0 = Date.parse("2026-01-01T00:00:00Z");
    const load = () => actual.loadHumanDecisionChannelFrom(dir, { transport: fixture.transport });
    expect(load().channel).toBe(GITHUB_APP_CHANNEL);

    const store = new MemoryTaskStore();
    const orch = new Orchestrator("T-1", classifyTask({ isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true, testStrategyTriggers: ["cross-task"] }), {
      store,
      stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
      humanDecisionVerifier: load(),
      now: () => T0,
    });
    await orch.step(withStageEvidence(() => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } })));
    const pending = orch.pendingApprovalRequest()!;
    await orch.publishPendingApproval();
    fixture.comment(1, `sta-approve: ${pending.requestId}`, { id: 3003, login: "second-approver", type: "User" }, "2026-01-01T00:05:00Z");
    expect((await orch.submitHumanDecision({ requestId: pending.requestId }).catch((e: Error) => e)) instanceof Error).toBe(true);

    // A person adds the second approver's id — data, not code.
    fs.writeFileSync(path.join(dir, actual.GITHUB_APP_CONFIG_FILE), validConfig({ [ApprovalType.SCHEMA_CONFIRMATION]: [1001, 3003] }));
    const resumed = Orchestrator.resume("T-1", store, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: load(), now: () => T0 });
    const { decision } = await resumed.submitHumanDecision({ requestId: pending.requestId });
    expect(decision).toMatchObject({ approved: true, actor: { id: "github-user:3003" } });
  });
});
