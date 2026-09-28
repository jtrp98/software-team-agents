import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { Orchestrator, type AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { ApprovalDecisionError, ApprovalType, type ApprovalRecord } from "./approval.js";
import {
  HumanChannelUnavailableError,
  NoTrustedHumanChannelError,
  UNCONFIGURED_HUMAN_CHANNEL,
  UntrustedHumanDecisionError,
  type HumanDecisionVerifier,
} from "./humanDecision.js";
import { createGithubAppChannel, GITHUB_API_BASE, GITHUB_APP_CHANNEL } from "./githubAppChannel.js";
import { FIXTURE_APP_BOT, FIXTURE_APP_ID, fixtureAppKeys, GithubFixture, type FixtureUser } from "./githubAppChannel.testSupport.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

/**
 * V13 TASK-027 — the github-app trusted human channel, proven against an HTTP
 * fixture of the GitHub REST API (`githubAppChannel.testSupport.ts`). Real
 * UAT against a real App is TASK-025's.
 */

const T0 = Date.parse("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const APPROVER: FixtureUser = { id: 1001, login: "approver-one", type: "User" };
const OUTSIDER: FixtureUser = { id: 2002, login: "outsider", type: "User" };
const pass: AgentExecutorResult = { outcome: { tokens: 100, cost: 0.01, result: "PASS" } };

function incremental() {
  return classifyTask({ isIncrementalFeature: true, touchesBackend: true, touchesFrontend: true, testStrategyTriggers: ["cross-task"] });
}

function channel(
  fixture: GithubFixture,
  approvers: Partial<Record<ApprovalType, readonly number[]>> = { [ApprovalType.SCHEMA_CONFIRMATION]: [APPROVER.id] },
  repository = { owner: fixture.owner, name: fixture.repo },
): HumanDecisionVerifier {
  return createGithubAppChannel({ appId: FIXTURE_APP_ID, repository, approvers, privateKey: fixtureAppKeys().privateKey, transport: fixture.transport });
}

async function atDesignGate(verifier: HumanDecisionVerifier, store: MemoryTaskStore | SqliteTaskStore = new MemoryTaskStore()) {
  const orch = new Orchestrator("T-1", incremental(), { store, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: verifier, now: () => T0 });
  await orch.step(withStageEvidence(() => pass)); // system-analyst; the DESIGN gate opens a request
  const pending = orch.pendingApprovalRequest();
  expect(pending?.scope.type).toBe(ApprovalType.SCHEMA_CONFIRMATION);
  return { store, orch, pending: pending! };
}

async function published(fixture: GithubFixture, verifier = channel(fixture)) {
  const gate = await atDesignGate(verifier);
  const publication = await gate.orch.publishPendingApproval();
  expect(publication).toMatchObject({ channel: GITHUB_APP_CHANNEL, ref: `${fixture.owner}/${fixture.repo}#1`, fresh: true });
  return { ...gate, issue: 1 };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
}

/** Nothing was recorded: the request is still pending and no decision evidence exists. */
function expectStillPending(orch: Orchestrator, pending: ApprovalRecord): void {
  expect(orch.approvalLedger.find((a) => a.requestId === pending.requestId)?.status).toBe("pending");
  expect(orch.evidence().some((r) => r.kind === "approval-decision")).toBe(false);
  expect(orch.status().kind).toBe("WAITING_FOR_HUMAN");
}

describe("github-app channel — announcing a pending request (V13 TASK-027)", () => {
  it("opens one Issue per pending request, persists where, and never opens a second one", async () => {
    const fixture = new GithubFixture();
    const { orch, pending, store } = await atDesignGate(channel(fixture));

    const first = await orch.publishPendingApproval();
    expect(first).toEqual({
      channel: GITHUB_APP_CHANNEL,
      ref: "acme/approvals#1",
      url: "https://github.com/acme/approvals/issues/1",
      requestId: pending.requestId,
      fresh: true,
    });
    const issue = fixture.issues.get(1)!;
    expect(issue.title).toContain(pending.requestId);
    expect(issue.body).toContain(`sta-approve: ${pending.requestId}`);
    expect(issue.body).toContain(`sta-reject: ${pending.requestId}`);
    expect(issue.body).toContain(ApprovalType.SCHEMA_CONFIRMATION);

    const publications = orch.evidence().filter((r) => r.kind === "approval-publication");
    expect(publications).toHaveLength(1);
    expect(publications[0]!.payload).toMatchObject({
      kind: "approval-publication",
      requestId: pending.requestId,
      type: ApprovalType.SCHEMA_CONFIRMATION,
      channel: GITHUB_APP_CHANNEL,
      ref: "acme/approvals#1",
    });

    // Idempotent in-process and across a restart (a fresh channel instance reads the persisted record).
    expect(await orch.publishPendingApproval()).toMatchObject({ ref: "acme/approvals#1", fresh: false });
    const resumed = Orchestrator.resume("T-1", store, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: channel(fixture), now: () => T0 });
    expect(await resumed.publishPendingApproval()).toMatchObject({ ref: "acme/approvals#1", fresh: false });
    expect(fixture.issues.size).toBe(1);

    // Only api.github.com, an App JWT for the installation, and a token narrowed to one repo and two permissions.
    expect(fixture.foreignCalls).toEqual([]);
    expect(fixture.calls.every((c) => c.url.startsWith(`${GITHUB_API_BASE}/`))).toBe(true);
    const tokenCall = fixture.calls.find((c) => c.url.endsWith("/access_tokens"))!;
    expect(tokenCall.body).toEqual({ repositories: ["approvals"], permissions: { issues: "write", metadata: "read" } });
  });

  it("has nothing to announce, and records nothing, when no channel is configured", async () => {
    const { orch } = await atDesignGate(UNCONFIGURED_HUMAN_CHANNEL);
    expect(await orch.publishPendingApproval()).toBeNull();
    expect(orch.evidence().some((r) => r.kind === "approval-publication")).toBe(false);
  });

  it("leaves the request pending and unannounced when GitHub refuses the App (not installed)", async () => {
    const fixture = new GithubFixture();
    fixture.installed = false;
    const { orch, pending } = await atDesignGate(channel(fixture));
    const err = await rejection(orch.publishPendingApproval());
    expect(err).toBeInstanceOf(HumanChannelUnavailableError);
    expect(err.message).toMatch(/not installed on acme\/approvals/);
    expect(orch.evidence().some((r) => r.kind === "approval-publication")).toBe(false);
    expectStillPending(orch, pending);
  });
});

describe("github-app channel — accepting a decision (V13 TASK-027)", () => {
  it("records the allowlisted user's approve comment with a traceable comment id, then closes the Issue", async () => {
    const fixture = new GithubFixture();
    const { orch, pending, issue } = await published(fixture);
    fixture.comment(issue, "Looks right to me", APPROVER, at(3)); // conversation, not a decision
    const comment = fixture.comment(issue, `sta-approve: ${pending.requestId}\nschema reviewed against REQ-004`, APPROVER, at(5));

    const { decision, settleError } = await orch.submitHumanDecision({ requestId: pending.requestId });
    expect(settleError).toBeNull();
    expect(decision).toMatchObject({
      decisionId: `github-comment:${comment.id}`,
      approved: true,
      actor: { kind: "human", id: `github-user:${APPROVER.id}` },
      source: { channel: GITHUB_APP_CHANNEL },
      note: "schema reviewed against REQ-004",
    });
    expect(decision.source.evidenceRef).toBe(
      `github:acme/approvals/issues/${issue}/comments/${comment.id}?user_id=${APPROVER.id}&login=${APPROVER.login}&created_at=${encodeURIComponent(at(5))}`,
    );
    expect(orch.approvalLedger[0]).toMatchObject({ requestId: pending.requestId, status: "approved" });
    const recorded = orch.evidence().find((r) => r.kind === "approval-decision")!;
    expect(recorded.payload).toMatchObject({ requestId: pending.requestId, decisionId: `github-comment:${comment.id}`, channel: GITHUB_APP_CHANNEL });
    expect(orch.status()).toEqual({ kind: "RUNNING", stage: AgentStage.TEST_PLANNER });

    expect(fixture.issues.get(issue)).toMatchObject({ state: "closed", state_reason: "completed" });
    const last = fixture.comments.at(-1)!;
    expect(last.user).toEqual(FIXTURE_APP_BOT);
    expect(last.body).toContain(`github-comment:${comment.id}`);
  });

  it("records a reject comment as a rejection, and the task blocks on it", async () => {
    const fixture = new GithubFixture();
    const { orch, pending, issue } = await published(fixture);
    fixture.comment(issue, `sta-reject: ${pending.requestId}\nmissing the discount field`, APPROVER, at(5));
    const { decision } = await orch.submitHumanDecision({ requestId: pending.requestId });
    expect(decision).toMatchObject({ approved: false, note: "missing the discount field" });
    expect(orch.approvalLedger[0]!.status).toBe("rejected");
    expect(fixture.issues.get(issue)).toMatchObject({ state: "closed", state_reason: "not_planned" });
    expect(orch.status().kind).toBe("BLOCKED");
  });

  it("accepts an allowlisted maintainer and verifies the role against api.github.com", async () => {
    const fixture = new GithubFixture();
    fixture.repositoryRoles.set(APPROVER.id, "maintain");
    const { orch, pending, issue } = await published(fixture);
    fixture.comment(issue, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
    const { decision } = await orch.submitHumanDecision({ requestId: pending.requestId });
    expect(decision.approved).toBe(true);
    expect(fixture.calls.some((call) => call.url === `${GITHUB_API_BASE}/repos/acme/approvals/collaborators/${APPROVER.login}/permission`)).toBe(true);
  });

  it("accepts a new approver added to the allowlist without any code change", async () => {
    const fixture = new GithubFixture();
    const { orch, pending, issue, store } = await published(fixture);
    fixture.comment(issue, `sta-approve: ${pending.requestId}`, OUTSIDER, at(5));
    expect(await rejection(orch.submitHumanDecision({ requestId: pending.requestId }))).toBeInstanceOf(UntrustedHumanDecisionError);

    // A person adds the id to the gate's list; the same comment now counts.
    const widened = Orchestrator.resume("T-1", store, {
      stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
      humanDecisionVerifier: channel(fixture, { [ApprovalType.SCHEMA_CONFIRMATION]: [APPROVER.id, OUTSIDER.id] }),
      now: () => T0,
    });
    const { decision } = await widened.submitHumanDecision({ requestId: pending.requestId });
    expect(decision.actor.id).toBe(`github-user:${OUTSIDER.id}`);
  });

  it("a decision survives a restart of the real file-backed store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-github-approval-"));
    const file = path.join(dir, ".workflow", "state.db");
    const fixture = new GithubFixture();
    try {
      // Process 1: reaches the gate, announces it, exits.
      const s1 = new SqliteTaskStore(file);
      const { orch: p1, pending } = await atDesignGate(channel(fixture), s1);
      await p1.publishPendingApproval();
      s1.close();

      // A person answers on GitHub while no STA process runs.
      const comment = fixture.comment(1, `sta-approve: ${pending.requestId}`, APPROVER, at(10));

      // Process 2: a fresh channel instance reads the Issue STA recorded and decides.
      const s2 = new SqliteTaskStore(file);
      const p2 = Orchestrator.resume("T-1", s2, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: channel(fixture), now: () => T0 });
      await p2.submitHumanDecision({ requestId: pending.requestId });
      s2.close();

      // Process 3: no channel at all — the decision is durable and the gate is open.
      const s3 = new SqliteTaskStore(file);
      const p3 = Orchestrator.resume("T-1", s3, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
      expect(p3.approvalLedger[0]).toMatchObject({
        requestId: pending.requestId,
        status: "approved",
        decision: { decisionId: `github-comment:${comment.id}`, actor: { id: `github-user:${APPROVER.id}` }, source: { channel: GITHUB_APP_CHANNEL } },
      });
      expect(p3.status()).toEqual({ kind: "RUNNING", stage: AgentStage.TEST_PLANNER });
      expect(p3.evidence().map((r) => r.kind)).toEqual(expect.arrayContaining(["approval-publication", "approval-decision"]));
      expect(s3.eventsForTask("T-1").find((e) => e.type === "APPROVAL_DECIDED")?.payload).toMatchObject({
        requestId: pending.requestId,
        channel: GITHUB_APP_CHANNEL,
        decisionId: `github-comment:${comment.id}`,
      });
      // Replay after restart: the same comment cannot decide the settled request again.
      const p3again = Orchestrator.resume("T-1", s3, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: channel(fixture), now: () => T0 });
      expect(((await rejection(p3again.submitHumanDecision({ requestId: pending.requestId }))) as ApprovalDecisionError).code).toBe("not-pending");
      s3.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("github-app channel — refusing (fail closed, nothing recorded) (V13 TASK-027)", () => {
  async function refusedFor(
    setup: (fixture: GithubFixture, requestId: string, issue: number) => void,
    expected: RegExp,
    verifierFor: (fixture: GithubFixture) => HumanDecisionVerifier = (f) => channel(f),
  ): Promise<void> {
    const fixture = new GithubFixture();
    const { orch, pending, issue } = await published(fixture, verifierFor(fixture));
    setup(fixture, pending.requestId, issue);
    const err = await rejection(orch.submitHumanDecision({ requestId: pending.requestId }));
    expect(err).toBeInstanceOf(UntrustedHumanDecisionError);
    expect(err.message).toMatch(expected);
    expectStillPending(orch, pending);
    expect(fixture.issues.get(issue)!.state).toBe("open");
  }

  it("refuses a comment naming another request (replay of an earlier or another task's decision)", async () => {
    await refusedFor((f, _id, issue) => f.comment(issue, "sta-approve: apr_ffffffffffffffffffffffffffffffff", APPROVER, at(5)), /other-request/);
  });

  it("refuses a comment created before the request was opened (stale)", async () => {
    await refusedFor((f, id, issue) => f.comment(issue, `sta-approve: ${id}`, APPROVER, at(-1)), /before-request/);
  });

  it("refuses a Bot or App author — including the App itself, whose key this channel holds", async () => {
    await refusedFor((f, id, issue) => f.comment(issue, `sta-approve: ${id}`, FIXTURE_APP_BOT, at(5)), /not-a-user/);
    // An allowlisted numeric id does not help a non-User account.
    await refusedFor((f, id, issue) => f.comment(issue, `sta-approve: ${id}`, { ...APPROVER, type: "Bot" }, at(5)), /not-a-user/);
  });

  it("refuses a user who is not on this gate type's approver list", async () => {
    await refusedFor((f, id, issue) => f.comment(issue, `sta-approve: ${id}`, OUTSIDER, at(5)), /not-an-approver/);
    // Approver for another gate only.
    await refusedFor(
      (f, id, issue) => f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5)),
      /not-an-approver/,
      (f) => channel(f, { [ApprovalType.DEPLOY]: [APPROVER.id] }),
    );
  });

  it("refuses an allowlisted user without admin or maintain on the approval repo", async () => {
    for (const role of ["write", "read", "triage", "none"]) {
      await refusedFor(
        (f, id, issue) => {
          f.repositoryRoles.set(APPROVER.id, role);
          f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5));
        },
        /insufficient-repo-role/,
      );
    }
  });

  it("refuses a permission response for another GitHub identity", async () => {
    await refusedFor(
      (f, id, issue) => {
        f.permissionIdentity.set(APPROVER.id, OUTSIDER);
        f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5));
      },
      /insufficient-repo-role/,
    );
  });

  it("refuses an edited comment", async () => {
    await refusedFor((f, id, issue) => f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5), { updated_at: at(9) }), /edited/);
  });

  it("refuses a comment GitHub reports for a different issue", async () => {
    await refusedFor(
      (f, id, issue) => f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5), { issue_url: `${GITHUB_API_BASE}/repos/acme/approvals/issues/${issue + 1}` }),
      /wrong-issue/,
    );
  });

  it("refuses when approvers disagree, and when the comment contradicts what the caller expected", async () => {
    await refusedFor((f, id, issue) => {
      f.comment(issue, `sta-approve: ${id}`, APPROVER, at(5));
      f.comment(issue, `sta-reject: ${id}`, { id: 1002, login: "approver-two", type: "User" }, at(6));
    }, /disagree/, (f) => channel(f, { [ApprovalType.SCHEMA_CONFIRMATION]: [APPROVER.id, 1002] }));

    const fixture = new GithubFixture();
    const { orch, pending, issue } = await published(fixture);
    fixture.comment(issue, `sta-reject: ${pending.requestId}`, APPROVER, at(5));
    const err = await rejection(orch.submitHumanDecision({ requestId: pending.requestId, approved: true }));
    expect(err.message).toMatch(/says reject/);
    expectStillPending(orch, pending);
  });

  it("refuses a request STA never announced, whatever the submission claims", async () => {
    const fixture = new GithubFixture();
    const { orch, pending } = await atDesignGate(channel(fixture));
    fixture.issues.set(1, { number: 1, title: pending.requestId, body: "", state: "open", state_reason: null });
    fixture.comment(1, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
    const forged = { requestId: pending.requestId, approved: true, credential: { actor: "approver-one", commentId: 1, issue: 1 } };
    const err = await rejection(orch.submitHumanDecision(forged));
    expect(err).toBeInstanceOf(UntrustedHumanDecisionError);
    expect(err.message).toMatch(/no Issue STA opened/);
    expectStillPending(orch, pending);
  });

  it("refuses an announcement recorded for a repository other than the configured one", async () => {
    const fixture = new GithubFixture();
    const { store, pending } = await published(fixture);
    fixture.comment(1, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
    const elsewhere = Orchestrator.resume("T-1", store, {
      stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
      humanDecisionVerifier: channel(fixture, undefined, { owner: "acme", name: "other-repo" }),
      now: () => T0,
    });
    const err = await rejection(elsewhere.submitHumanDecision({ requestId: pending.requestId }));
    expect(err.message).toMatch(/not on the configured acme\/other-repo/);
    expectStillPending(elsewhere, pending);
  });

  it("treats every API failure as a closed channel: 404, 401, 5xx, timeout, network error, non-JSON", async () => {
    const cases: Array<{ name: string; arrange: (f: GithubFixture) => void; expected: RegExp }> = [
      { name: "App uninstalled after the Issue was opened", arrange: (f) => { f.installed = false; }, expected: /not installed on acme\/approvals/ },
      { name: "token refused", arrange: (f) => f.failures.push({ match: /access_tokens/, status: 401 }), expected: /HTTP 401/ },
      { name: "issue gone", arrange: (f) => f.issues.delete(1), expected: /HTTP 404/ },
      { name: "comments 5xx", arrange: (f) => f.failures.push({ match: /\/comments/, status: 502 }), expected: /HTTP 502/ },
      {
        name: "timeout",
        arrange: (f) => f.failures.push({ match: /\/comments/, throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }),
        expected: /TimeoutError/,
      },
      { name: "network", arrange: (f) => f.failures.push({ match: /\/issues\/1$/, throws: new TypeError("fetch failed") }), expected: /fetch failed/ },
      { name: "non-JSON", arrange: (f) => f.failures.push({ match: /\/comments/, notJson: true }), expected: /not JSON/ },
      { name: "permission 404", arrange: (f) => f.failures.push({ match: /\/collaborators\/.*\/permission/, status: 404 }), expected: /HTTP 404/ },
      { name: "permission 403", arrange: (f) => f.failures.push({ match: /\/collaborators\/.*\/permission/, status: 403 }), expected: /HTTP 403/ },
      { name: "permission timeout", arrange: (f) => f.failures.push({ match: /\/collaborators\/.*\/permission/, throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }), expected: /TimeoutError/ },
    ];
    for (const c of cases) {
      const fixture = new GithubFixture();
      const { store, pending, issue } = await published(fixture);
      fixture.comment(issue, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
      c.arrange(fixture);
      // A fresh process: a new channel instance authenticates from scratch.
      const orch = Orchestrator.resume("T-1", store, { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: channel(fixture), now: () => T0 });
      const err = (await orch.submitHumanDecision({ requestId: pending.requestId }).then(
        () => new Error(`${c.name}: expected a refusal`),
        (e: Error) => e,
      )) as Error;
      expect(err, c.name).toBeInstanceOf(HumanChannelUnavailableError);
      expect(err, c.name).toBeInstanceOf(NoTrustedHumanChannelError);
      expect(err.message, c.name).toMatch(c.expected);
      expectStillPending(orch, pending);
    }
  });

  describe("environment cannot move the API", () => {
    const keys = ["GITHUB_API_URL", "GITHUB_API_BASE_URL", "STA_GITHUB_API_BASE", "GH_HOST", "GITHUB_SERVER_URL", "HTTPS_PROXY", "HTTP_PROXY"] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const key of keys) {
        saved[key] = process.env[key];
        process.env[key] = key.endsWith("PROXY") ? "http://127.0.0.1:9" : "https://evil.example.test";
      }
    });
    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("still talks only to https://api.github.com with every override set", async () => {
      const fixture = new GithubFixture();
      const { orch, pending, issue } = await published(fixture);
      fixture.comment(issue, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
      await orch.submitHumanDecision({ requestId: pending.requestId });
      expect(orch.approvalLedger[0]!.status).toBe("approved");
      expect(fixture.foreignCalls).toEqual([]);
      expect(fixture.calls.length).toBeGreaterThan(0);
      for (const call of fixture.calls) expect(new URL(call.url).origin).toBe("https://api.github.com");
    });
  });
});

describe("github-app channel — revoked token mid-process (V13 TASK-027)", () => {
  it("fails closed when the App is uninstalled while a channel instance still holds a cached token", async () => {
    const fixture = new GithubFixture();
    const { orch, pending, issue } = await published(fixture); // this instance cached an installation token
    fixture.comment(issue, `sta-approve: ${pending.requestId}`, APPROVER, at(5));
    fixture.installed = false; // GitHub revokes the installation's tokens
    const err = await rejection(orch.submitHumanDecision({ requestId: pending.requestId }));
    expect(err).toBeInstanceOf(HumanChannelUnavailableError);
    expect(err.message).toMatch(/HTTP 401/);
    expectStillPending(orch, pending);
  });
});
