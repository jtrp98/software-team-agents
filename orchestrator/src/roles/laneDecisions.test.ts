import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { ApprovalDecisionError, ApprovalType } from "../gates/approval.js";
import { createChatRelayChannel } from "../gates/chatRelayChannel.js";
import { resolveHumanDecisionChannel } from "../gates/humanChannelConfig.js";
import { createGithubAppChannel, GITHUB_APP_CHANNEL } from "../gates/githubAppChannel.js";
import { FIXTURE_APP_ID, fixtureAppKeys, GithubFixture, type FixtureUser } from "../gates/githubAppChannel.testSupport.js";
import { NoTrustedHumanChannelError, UNCONFIGURED_HUMAN_CHANNEL, UntrustedHumanDecisionError } from "../gates/humanDecision.js";
import { testHumanVerifier, trustedCredential } from "../gates/humanDecision.testSupport.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { checkRoleLaneEntry } from "../orchestrator/stageGuards.js";
import { LANE_FIXTURE_MODULE as MODULE, LANE_FIXTURE_NOW as NOW, decideLane, writeApprovedKnowledge, writeSignedOffHandoffs } from "../orchestrator/stageGuards.testSupport.js";
import { createStaApi } from "../controller/staApi.js";
import { runRolesVerb } from "../cli/verbs/roles.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import Database from "../store/sqliteDatabase.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { LaneActRefusedError, LaneDecisionService, canonicalKnowledgeRoot, loadGovernedKnowledge } from "./laneDecisions.js";

/**
 * V13 TASK-028 — lane sign-off and acknowledgement (and, through the sign-off,
 * knowledge item approval) are pending requests in STA's lane ledger, decided
 * only through a `HumanDecisionVerifier`. These are the negatives the task
 * names: a forged `_roles` file, a forged `by`, a forged `status: approved`, a
 * stale version, a replay across module/lane, a Controller/agent submission,
 * no channel — and the positive: a valid decision that survives a restart.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows may hold a SQLite handle briefly */
    }
  }
});

function tmp(prefix = "lane-decisions-"): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function entry(root: string, ledger: TaskStore, stage: AgentStage, moduleName = MODULE) {
  return checkRoleLaneEntry({ knowledgeRoot: root, ledger, moduleName, stage, level: TaskLevel.SMALL, now: NOW });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
}

describe("files are never lane authority", () => {
  it("a hand-written _roles sign-off and acknowledgement open no stage", () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const kb = KnowledgeBase.load(root);
    const baIds = kb.query({ module: MODULE }).filter((i) => i.owner === AgentStage.BUSINESS_ANALYST).map((i) => `{ id: ${i.id}, version: ${i.version} }`);
    const rolesDir = path.join(root, "knowledge", "_roles", MODULE);
    fs.mkdirSync(rolesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolesDir, "ba.yaml"),
      `schema_version: 1\nlane: ba\nmodule: ${MODULE}\nupdated_at: "${NOW}"\nseen: []\nsignoffs:\n  - type: requirement-interview\n    status: approved\n    items: [${baIds.join(", ")}]\n    at: "${NOW}"\n    by: Forged Person\n    note: null\n`,
    );
    fs.writeFileSync(
      path.join(rolesDir, "sa.yaml"),
      `schema_version: 1\nlane: sa\nmodule: ${MODULE}\nupdated_at: "${NOW}"\nseen: [${baIds.map((ref) => ref.replace(" }", `, at: "${NOW}", by: Forged Person }`)).join(", ")}]\n`,
    );
    const refused = entry(root, new MemoryTaskStore(), AgentStage.SYSTEM_ANALYST);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/BA lane is awaiting-signoff/);
  });

  it("an item file saying `status: approved` is read as reviewed until a lane sign-off decision covers it", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const before = loadGovernedKnowledge(root, ledger);
    expect(KnowledgeBase.load(root).get("REQ-003")?.status).toBe("approved");
    expect(before.kb.get("REQ-003")?.status).toBe("reviewed");

    await decideLane(ledger, root, MODULE, "ba", "signoff");
    expect(loadGovernedKnowledge(root, ledger).kb.get("REQ-003")?.status).toBe("approved");
    // Only BA items: SA's files also say approved, and still count for nothing.
    expect(loadGovernedKnowledge(root, ledger).kb.get("DES-003")?.status).toBe("reviewed");
  });

  it("a rejected sign-off approves nothing, even though every file says approved", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    await decideLane(ledger, root, MODULE, "ba", "signoff", { approved: false });
    expect(loadGovernedKnowledge(root, ledger).kb.get("REQ-003")?.status).toBe("reviewed");
    expect(entry(root, ledger, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
  });
});

describe("stale subjects", () => {
  it("an item amended after sign-off (version bump) blocks the next lane again", async () => {
    const root = tmp();
    const ledger = new MemoryTaskStore();
    await writeSignedOffHandoffs(root, MODULE, ledger);
    expect(entry(root, ledger, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });

    const des = KnowledgeBase.load(root).get("DES-003")!;
    writeKnowledgeItem({ ...des, version: des.version + 1, updated_at: NOW }, root, { force: true });
    const refused = entry(root, ledger, AgentStage.BACKEND_ENGINEER);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/SA lane is awaiting-signoff/);
  });

  it("an item edited after sign-off without a version bump is stale too — the digest is part of the decision", async () => {
    const root = tmp();
    const ledger = new MemoryTaskStore();
    await writeSignedOffHandoffs(root, MODULE, ledger);
    const req = KnowledgeBase.load(root).get("REQ-003")!;
    writeKnowledgeItem({ ...req, title: `${req.title} (quietly edited)` }, root, { force: true });
    expect(entry(root, ledger, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
  });

  it("a pending request whose items move before the decision is refused as stale and withdrawn", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier() });
    const request = service.request(root, MODULE, "ba", "signoff");
    const req = KnowledgeBase.load(root).get("REQ-003")!;
    writeKnowledgeItem({ ...req, version: req.version + 1, updated_at: NOW }, root, { force: true });

    const refused = await rejection(service.submit({ requestId: request.requestId, approved: true, credential: trustedCredential() }));
    expect(refused).toBeInstanceOf(ApprovalDecisionError);
    expect((refused as ApprovalDecisionError).code).toBe("stale");
    expect(ledger.loadLaneRequest(request.requestId)?.status).toBe("withdrawn");
    // Asking again opens a fresh request over the new version.
    const again = service.request(root, MODULE, "ba", "signoff");
    expect(again.requestId).not.toBe(request.requestId);
    expect(again.scope.items.find((i) => i.id === "REQ-003")?.version).toBe(req.version + 1);
  });

  it("re-asking the same question reuses the pending request instead of opening a second one", () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier() });
    const first = service.request(root, MODULE, "ba", "signoff");
    expect(service.request(root, MODULE, "ba", "signoff").requestId).toBe(first.requestId);
    expect(ledger.laneRequests(canonicalKnowledgeRoot(root), MODULE)).toHaveLength(1);
  });

  it("refuses to ask for a sign-off while the lane still drafts or is blocked", () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const req = KnowledgeBase.load(root).get("REQ-003")!;
    writeKnowledgeItem({ ...req, status: "draft" }, root, { force: true });
    const service = new LaneDecisionService({ store: new MemoryTaskStore(), verifier: testHumanVerifier() });
    expect(() => service.request(root, MODULE, "ba", "signoff")).toThrow(LaneActRefusedError);
  });
});

describe("replay and scope", () => {
  it("one channel decision cannot be applied twice, across modules or lanes", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    writeApprovedKnowledge(root, "orders");
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier() });
    const first = service.request(root, MODULE, "ba", "signoff");
    await service.submit({ requestId: first.requestId, approved: true, credential: trustedCredential({ decisionId: "comment-1" }) });

    for (const [module, lane] of [["orders", "ba"], [MODULE, "sa"]] as const) {
      const other = service.request(root, module, lane, "signoff");
      const refused = await rejection(service.submit({ requestId: other.requestId, approved: true, credential: trustedCredential({ decisionId: "comment-1" }) }));
      expect((refused as ApprovalDecisionError).code).toBe("replay");
      expect(ledger.loadLaneRequest(other.requestId)?.status).toBe("pending");
    }
  });

  it("a decision attesting another module or lane is refused as a scope mismatch", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier() });
    const request = service.request(root, MODULE, "ba", "signoff");
    for (const scope of [{ module: "orders" }, { lane: "sa", type: ApprovalType.SA_SIGNOFF }, { items: [] }]) {
      const refused = await rejection(service.submit({ requestId: request.requestId, approved: true, credential: trustedCredential({ scope }) }));
      expect((refused as ApprovalDecisionError).code).toBe("scope-mismatch");
    }
    expect(ledger.loadLaneRequest(request.requestId)?.status).toBe("pending");
  });

  it("a signed-off module opens nothing for another module", async () => {
    const root = tmp();
    const ledger = new MemoryTaskStore();
    await writeSignedOffHandoffs(root, MODULE, ledger);
    writeApprovedKnowledge(root, "orders");
    expect(entry(root, ledger, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });
    expect(entry(root, ledger, AgentStage.BACKEND_ENGINEER, "orders").allowed).toBe(false);
  });

  it("a decision recorded under another Knowledge root does not count here", async () => {
    const root = tmp();
    const elsewhere = tmp();
    const ledger = new MemoryTaskStore();
    await writeSignedOffHandoffs(elsewhere, MODULE, ledger);
    writeApprovedKnowledge(root);
    expect(entry(elsewhere, ledger, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });
    expect(entry(root, ledger, AgentStage.BACKEND_ENGINEER).allowed).toBe(false);
  });

  it("refuses an unsolicited decision, and a second answer to a settled request", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier() });
    const unknown = await rejection(service.submit({ requestId: `apr_${"f".repeat(32)}`, approved: true, credential: trustedCredential() }));
    expect((unknown as ApprovalDecisionError).code).toBe("unknown-request");

    const request = service.request(root, MODULE, "ba", "signoff");
    await service.submit({ requestId: request.requestId, approved: true, credential: trustedCredential() });
    const again = await rejection(service.submit({ requestId: request.requestId, approved: false, credential: trustedCredential() }));
    expect((again as ApprovalDecisionError).code).toBe("not-pending");
  });
});

describe("who may decide", () => {
  it("no trusted channel: the request stays pending and nothing is recorded", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: UNCONFIGURED_HUMAN_CHANNEL });
    const request = service.request(root, MODULE, "ba", "signoff");
    expect(await service.publish(request.requestId)).toBeNull();
    const refused = await rejection(service.submit({ requestId: request.requestId, approved: true, credential: trustedCredential() }));
    expect(refused).toBeInstanceOf(NoTrustedHumanChannelError);
    expect(ledger.loadLaneRequest(request.requestId)).toMatchObject({ status: "pending", decision: null });
    expect(entry(root, ledger, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
  });

  it("an agent-made submission (no channel credential, or a forged one) is not a decision", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier: testHumanVerifier({ authorizedActors: ["test-human"] }) });
    const request = service.request(root, MODULE, "ba", "signoff");
    for (const credential of [undefined, { token: "forged" }, trustedCredential({ actorId: "backend-engineer" })]) {
      const refused = await rejection(service.submit({ requestId: request.requestId, approved: true, credential }));
      expect(refused).toBeInstanceOf(UntrustedHumanDecisionError);
    }
    expect(ledger.loadLaneRequest(request.requestId)?.status).toBe("pending");
  });

  it("the Controller API refuses agent callers and fails closed with no channel", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const store = new MemoryTaskStore();
    const api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: UNCONFIGURED_HUMAN_CHANNEL });
    try {
      for (const caller of [{ kind: "agent" }, undefined]) {
        await expect(api.laneDecision({ module: MODULE, lane: "ba", action: "signoff", ...(caller ? { caller } : {}) })).rejects.toThrow(UntrustedHumanDecisionError);
      }
      expect(store.laneRequests(root, MODULE)).toEqual([]);
      const closed = await api.laneDecision({ module: MODULE, lane: "ba", action: "signoff", caller: { kind: "controller" } });
      expect(closed).toMatchObject({ ok: false, code: "no-trusted-channel" });
      expect(store.laneRequests(root, MODULE).map((r) => r.status)).toEqual(["pending"]);
    } finally {
      api.close();
    }
  });

  it("the Controller API records a lane decision only through the channel it shares with approve", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const store = new MemoryTaskStore();
    const api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: testHumanVerifier() });
    try {
      const decided = await api.laneDecision({
        module: MODULE,
        lane: "ba",
        action: "signoff",
        caller: { kind: "controller" },
        submission: { approved: true, credential: trustedCredential() },
      });
      expect(decided).toMatchObject({ ok: true, approved: true });
      expect(decided.items?.map((i) => i.id)).toEqual(expect.arrayContaining(["REQ-003", "RULE-007"]));
      expect(loadGovernedKnowledge(root, store).kb.get("REQ-003")?.status).toBe("approved");
    } finally {
      api.close();
    }
  });

  it("accepts a Controller chat relay for the exact lane items after presenting the request", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const store = new MemoryTaskStore();
    const api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: createChatRelayChannel() });
    try {
      const asked = await api.laneDecision({ module: MODULE, lane: "ba", action: "signoff", caller: { kind: "controller" } });
      expect(asked).toMatchObject({ ok: false, code: "announced", announcement: { channel: "chat-relay" } });
      const answer = await api.laneDecision({
        module: MODULE, lane: "ba", action: "signoff", requestId: asked.requestId,
        caller: { kind: "controller" },
        submission: {
          approved: true,
          credential: { kind: "controller-chat-relay", conversationId: "conv-lane", messageId: "msg-lane", actorId: "user-1", messageText: "อนุมัติ BA sign-off" },
        },
      });
      expect(answer).toMatchObject({ ok: true, approved: true });
      expect(store.loadLaneRequest(asked.requestId!)?.decision?.source.channel).toBe("chat-relay");
      expect(loadGovernedKnowledge(root, store).kb.get("REQ-003")?.status).toBe("approved");
    } finally {
      api.close();
    }
  });

  it("shows a durable lane chat decision in read-only roles history", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const dbFile = path.join(tmp("lane-history-"), "state.db");
    const store = new SqliteTaskStore(dbFile);
    const api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: createChatRelayChannel() });
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { logs.push(parts.join(" ")); });
    try {
      const asked = await api.laneDecision({ module: MODULE, lane: "ba", action: "signoff", caller: { kind: "controller" } });
      expect(asked.requestId).toBeDefined();
      expect(await api.laneDecision({
        module: MODULE, lane: "ba", action: "signoff", requestId: asked.requestId,
        caller: { kind: "controller" },
        submission: { approved: true, credential: {
          kind: "controller-chat-relay", conversationId: "conv-history", messageId: "msg-history",
          actorId: "user-1", messageText: "approve BA sign-off",
        } },
      })).toMatchObject({ ok: true, approved: true });
      expect(await runRolesVerb(["history", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile], root)).toBe(0);
      expect(logs.join("\n")).toContain("chat:conv-history/msg-history");
      expect(logs.join("\n")).toContain(asked.requestId);
    } finally {
      log.mockRestore();
      api.close();
      store.close();
    }
  });

  it("Controller relays BA sign-off through sta roles after a bubble-chat answer", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const dbFile = path.join(tmp("lane-cli-chat-"), "state.db");
    vi.mocked(resolveHumanDecisionChannel).mockReturnValue(createChatRelayChannel());
    try {
      expect(await runRolesVerb(["signoff", "ba", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile], root)).toBe(4);
      const store = new SqliteTaskStore(dbFile);
      const requestId = store.laneRequests(canonicalKnowledgeRoot(root), MODULE)[0]!.requestId;
      store.close();
      const args = ["signoff", "ba", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile, "--request", requestId];
      await expect(runRolesVerb([...args, "--yes"], root)).rejects.toThrow(/all four --chat-/);
      expect(await runRolesVerb([...args, "--yes", "--chat-conversation-id", "conv-cli", "--chat-message-id", "msg-cli", "--chat-actor-id", "user-1", "--chat-text", "Approve BA sign-off"], root)).toBe(0);
      const reopened = new SqliteTaskStore(dbFile);
      expect(reopened.loadLaneRequest(requestId)?.decision?.source.evidenceRef).toBe("chat:conv-cli/msg-cli");
      reopened.close();
    } finally {
      vi.mocked(resolveHumanDecisionChannel).mockReturnValue(UNCONFIGURED_HUMAN_CHANNEL);
    }
  });
});

describe("durability", () => {
  it("a valid decision survives a restart: a fresh store and guard read the same persisted decisions", async () => {
    const root = tmp();
    const dbFile = path.join(tmp("lane-db-"), "state.db");
    await writeSignedOffHandoffs(root, MODULE, dbFile);

    const reopened = new SqliteTaskStore(dbFile);
    try {
      expect(entry(root, reopened, AgentStage.SYSTEM_ANALYST)).toEqual({ allowed: true });
      expect(entry(root, reopened, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });
      const records = reopened.laneRequests(root, MODULE);
      expect(records.map((r) => [r.scope.lane, r.scope.action, r.status])).toEqual([
        ["ba", "signoff", "approved"],
        ["sa", "ack", "approved"],
        ["sa", "signoff", "approved"],
        ["dev", "ack", "approved"],
      ]);
      expect(records.every((r) => r.decision?.source.channel === "test-human-channel")).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("the ledger refuses a corrupt row rather than trusting it", () => {
    const dbFile = path.join(tmp("lane-db-"), "state.db");
    const store = new SqliteTaskStore(dbFile);
    store.close();
    // Rows are only trusted once they re-parse; a stored record with a status and no decision is not a decision.
    const raw = new Database(dbFile);
    const id = `apr_${"a".repeat(32)}`;
    const forged = JSON.stringify({ requestId: id, status: "approved" }).replace(/'/g, "''");
    raw.exec(
      `INSERT INTO lane_decisions (request_id, knowledge_root, module, lane, action, status, decision_id, record) ` +
        `VALUES ('${id}', '/k', '${MODULE}', 'ba', 'signoff', 'approved', NULL, '${forged}')`,
    );
    raw.close();
    const reopened = new SqliteTaskStore(dbFile);
    try {
      expect(() => reopened.laneRequests("/k", MODULE)).toThrow(ApprovalDecisionError);
    } finally {
      reopened.close();
    }
  });
});

describe("the github-app channel decides lane requests exactly as it decides task gates", () => {
  const APPROVER: FixtureUser = { id: 1001, login: "approver-one", type: "User" };
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const channel = (fixture: GithubFixture, approvers: Partial<Record<ApprovalType, readonly number[]>>) =>
    createGithubAppChannel({ appId: FIXTURE_APP_ID, repository: { owner: fixture.owner, name: fixture.repo }, approvers, privateKey: fixtureAppKeys().privateKey, transport: fixture.transport });

  it("announces the lane request, records the approver's comment, and the decision survives a restart", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const dbFile = path.join(tmp("lane-db-"), "state.db");
    const fixture = new GithubFixture();
    const verifier = channel(fixture, { [ApprovalType.BA_SIGNOFF]: [APPROVER.id] });

    const store = new SqliteTaskStore(dbFile);
    let requestId: string;
    try {
      const service = new LaneDecisionService({ store, verifier, now: () => T0 });
      const request = service.request(root, MODULE, "ba", "signoff");
      requestId = request.requestId;
      const published = await service.publish(requestId);
      expect(published).toMatchObject({ channel: GITHUB_APP_CHANNEL, fresh: true });
      const issue = fixture.issues.get(1)!;
      expect(issue.title).toContain(requestId);
      expect(issue.body).toContain(`Lane: \`ba\` (signoff)`);
      expect(issue.body).toContain("REQ-003 v1");
      expect(await service.publish(requestId)).toMatchObject({ fresh: false });
    } finally {
      store.close();
    }

    fixture.comment(1, `sta-approve: ${requestId}\nrequirements read end to end`, APPROVER, at(5));
    const restarted = new SqliteTaskStore(dbFile);
    try {
      const service = new LaneDecisionService({ store: restarted, verifier: channel(fixture, { [ApprovalType.BA_SIGNOFF]: [APPROVER.id] }), now: () => T0 + 10 * 60_000 });
      const { record } = await service.submit({ requestId });
      expect(record.decision).toMatchObject({ approved: true, actor: { kind: "human", id: "github-user:1001" }, source: { channel: GITHUB_APP_CHANNEL } });
      expect(record.decision?.decisionId).toMatch(/^github-comment:/);
      expect(fixture.issues.get(1)?.state).toBe("closed");
    } finally {
      restarted.close();
    }

    const again = new SqliteTaskStore(dbFile);
    try {
      expect(loadGovernedKnowledge(root, again).kb.get("REQ-003")?.status).toBe("approved");
    } finally {
      again.close();
    }
  });

  it("an approver of another gate (task deploy, or another lane) cannot sign this lane off", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const fixture = new GithubFixture();
    const verifier = channel(fixture, { [ApprovalType.DEPLOY]: [APPROVER.id], [ApprovalType.SA_SIGNOFF]: [APPROVER.id] });
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier, now: () => T0 });
    const request = service.request(root, MODULE, "ba", "signoff");
    await service.publish(request.requestId);
    fixture.comment(1, `sta-approve: ${request.requestId}`, APPROVER, at(5));
    const refused = await rejection(service.submit({ requestId: request.requestId }));
    expect(refused).toBeInstanceOf(UntrustedHumanDecisionError);
    expect(refused.message).toMatch(/not-an-approver/);
    expect(ledger.loadLaneRequest(request.requestId)?.status).toBe("pending");
  });

  it("a comment naming one lane request is not a decision for another", async () => {
    const root = tmp();
    writeApprovedKnowledge(root);
    writeApprovedKnowledge(root, "orders");
    const fixture = new GithubFixture();
    const verifier = channel(fixture, { [ApprovalType.BA_SIGNOFF]: [APPROVER.id] });
    const ledger = new MemoryTaskStore();
    const service = new LaneDecisionService({ store: ledger, verifier, now: () => T0 });
    const first = service.request(root, MODULE, "ba", "signoff");
    const second = service.request(root, "orders", "ba", "signoff");
    await service.publish(first.requestId);
    await service.publish(second.requestId);
    fixture.comment(2, `sta-approve: ${first.requestId}`, APPROVER, at(5));
    const refused = await rejection(service.submit({ requestId: second.requestId }));
    expect(refused.message).toMatch(/other-request/);
    expect(ledger.loadLaneRequest(second.requestId)?.status).toBe("pending");
  });
});
