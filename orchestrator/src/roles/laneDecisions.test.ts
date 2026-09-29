import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { ApprovalDecisionError, ApprovalType } from "../gates/approval.js";
import { createChatRelayChannel } from "../gates/chatRelayChannel.js";
import { resolveHumanDecisionChannel } from "../gates/humanChannelConfig.js";
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
      expect(asked.items).toEqual(store.loadLaneRequest(asked.requestId!)!.scope.items);
      expect(asked.items!.every((item) => /^[0-9a-f]{64}$/.test(item.digest))).toBe(true);
      expect(asked.prompt).toContain(`approve ${asked.requestId}`);
      expect(asked.prompt).toContain("cannot independently authenticate");
      const answer = await api.laneDecision({
        module: MODULE, lane: "ba", action: "signoff", requestId: asked.requestId,
        caller: { kind: "controller" },
        submission: {
          approved: true,
          credential: { kind: "controller-chat-relay", conversationId: "conv-lane", messageId: "msg-lane", actorId: "user-1", messageText: `approve ${asked.requestId}` },
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
          actorId: "user-1", messageText: `approve ${asked.requestId}`,
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

  it.each([[true, false], [false, false], [true, true], [false, true]])("synthetic lane CLI relay approved=%s unknownActor=%s persists with displayed digests", async (approved, unknownActor) => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const dbFile = path.join(tmp("lane-cli-chat-"), "state.db");
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => { logs.push(parts.join(" ")); });
    vi.mocked(resolveHumanDecisionChannel).mockReturnValue(createChatRelayChannel());
    try {
      expect(await runRolesVerb(["signoff", "ba", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile], root)).toBe(4);
      const store = new SqliteTaskStore(dbFile);
      const requestId = store.laneRequests(canonicalKnowledgeRoot(root), MODULE)[0]!.requestId;
      const request = store.loadLaneRequest(requestId)!;
      for (const item of request.scope.items) expect(logs.join("\n")).toContain(`${item.id} v${item.version} sha256:${item.digest}`);
      expect(logs.join("\n")).toContain(`approve ${requestId}`);
      expect(logs.join("\n")).toContain("cannot independently authenticate");
      store.close();
      const args = ["signoff", "ba", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile, "--request", requestId];
      await expect(runRolesVerb([...args, "--yes"], root)).rejects.toThrow(/Controller relay requires/);
      const relay = ["--chat-conversation-id", "conv-cli", "--chat-message-id", "msg-cli", ...(unknownActor ? ["--chat-actor-unavailable"] : ["--chat-actor-id", "user-1"]), "--chat-text"];
      expect(await runRolesVerb([...args, "--yes", ...relay, "still reviewing"], root)).toBe(6);
      expect(await runRolesVerb([...args, approved ? "--yes" : "--no", ...relay, `${approved ? "approve" : "reject"} ${requestId}`], root)).toBe(approved ? 0 : 3);
      const reopened = new SqliteTaskStore(dbFile);
      expect(reopened.loadLaneRequest(requestId)?.decision?.source.evidenceRef).toBe("chat:conv-cli/msg-cli");
      expect(reopened.loadLaneRequest(requestId)?.decision?.actor.id).toBe(unknownActor ? null : "chat-user:user-1");
      expect(reopened.loadLaneRequest(requestId)?.status).toBe(approved ? "approved" : "rejected");
      reopened.close();
    } finally {
      log.mockRestore();
      vi.mocked(resolveHumanDecisionChannel).mockReturnValue(UNCONFIGURED_HUMAN_CHANNEL);
    }
  });
});

describe("durability", () => {
  it.each([false, true])("synthetic chat BA sign-off and separate SA ack survive SQLite reopen and block stale items (unknownActor=%s)", async (unknownActor) => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const dbFile = path.join(tmp("lane-chat-handoff-"), "state.db");
    const relay = (requestId: string, messageId: string, approved = true) => ({
      approved,
      credential: { kind: "controller-chat-relay", conversationId: "synthetic-handoff", messageId, actorId: unknownActor ? null : "fixture-user",
        ...(unknownActor ? { actorUnavailableReason: "host-does-not-expose-actor" } : {}),
        messageText: `${approved ? "approve" : "reject"} ${requestId}` },
    });
    let store = new SqliteTaskStore(dbFile);
    let api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: createChatRelayChannel() });
    const reopen = () => {
      api.close();
      store.close();
      store = new SqliteTaskStore(dbFile);
      api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: createChatRelayChannel() });
    };
    try {
      const ba = { module: MODULE, lane: "ba" as const, action: "signoff" as const, caller: { kind: "controller" } };
      const asked = await api.laneDecision(ba);
      const requestId = asked.requestId!;
      expect(entry(root, store, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
      for (const submission of [
        undefined,
        { ...relay(requestId, "ba-message"), credential: undefined },
        { ...relay(requestId, "ba-message"), credential: { ...relay(requestId, "ba-message").credential, messageText: "still reviewing" } },
        { ...relay(requestId, "ba-message"), credential: { ...relay(requestId, "ba-message").credential, messageText: `reject ${requestId}` } },
      ]) {
        expect(await api.laneDecision({ ...ba, requestId, submission })).toMatchObject({ ok: false, code: "refused" });
        expect(store.loadLaneRequest(requestId)).toMatchObject({ status: "pending", decision: null });
      }
      expect(await api.laneDecision({ ...ba, module: "other-module", requestId, submission: relay(requestId, "ba-message") }))
        .toMatchObject({ ok: false, code: "refused" });
      const redirected = { ...relay(requestId, "ba-message"), requestId: "apr_00000000000000000000000000000000" };
      expect(await api.laneDecision({ ...ba, requestId, submission: redirected }))
        .toMatchObject({ ok: false, code: "refused", denialReason: expect.stringContaining("override") });
      expect(store.loadLaneRequest(requestId)).toMatchObject({ status: "pending", decision: null });
      expect(await api.laneDecision({ ...ba, requestId, submission: relay(requestId, "ba-message") })).toMatchObject({ ok: true });
      reopen();
      expect(store.loadLaneRequest(requestId)?.scope.items).toEqual(asked.items);
      expect(entry(root, store, AgentStage.SYSTEM_ANALYST).allowed).toBe(false); // BA approval does not acknowledge for SA.
      expect(await api.laneDecision({ ...ba, requestId, submission: relay(requestId, "ba-message") })).toMatchObject({ ok: false });

      const sa = { ...ba, lane: "sa" as const, action: "ack" as const };
      const ack = await api.laneDecision(sa);
      expect(ack.items).toEqual(asked.items);
      expect(await api.laneDecision({ ...sa, requestId: ack.requestId, submission: relay(ack.requestId!, "ba-message") }))
        .toMatchObject({ ok: false, code: "refused" }); // The same chat reference cannot answer both acts.
      expect(store.loadLaneRequest(ack.requestId!)?.status).toBe("pending");
      expect(await api.laneDecision({ ...sa, requestId: ack.requestId, submission: relay(ack.requestId!, "sa-message") }))
        .toMatchObject({ ok: true });
      reopen();
      expect(entry(root, store, AgentStage.SYSTEM_ANALYST)).toEqual({ allowed: true });
      const records = store.laneRequests(canonicalKnowledgeRoot(root), MODULE);
      expect(records.map((r) => r.decision?.source.evidenceRef)).toEqual([
        "chat:synthetic-handoff/ba-message", "chat:synthetic-handoff/sa-message",
      ]);
      const historyLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        expect(await runRolesVerb(["history", "--module", MODULE, "--knowledge-root", root, "--state-db", dbFile], root)).toBe(0);
        const history = historyLog.mock.calls.flat().join("\n");
        if (unknownActor) expect(history).toContain("unknown actor (host-does-not-expose-actor)");
        for (const record of records) {
          expect(history).toContain(record.requestId);
          expect(history).toContain(record.decision!.source.evidenceRef);
          for (const item of record.scope.items) expect(history).toContain(item.digest);
        }
      } finally {
        historyLog.mockRestore();
      }
      const req = KnowledgeBase.load(root).get("REQ-003")!;
      writeKnowledgeItem({ ...req, title: `${req.title} edited after acknowledgement` }, root, { force: true });
      expect(entry(root, store, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
    } finally {
      api.close();
      store.close();
    }
  });

  it.each(["version", "digest"] as const)("chat lane decision refuses a stale pending %s", async (change) => {
    const root = tmp();
    writeApprovedKnowledge(root);
    const store = new MemoryTaskStore();
    const api = createStaApi({ projectRoot: root, store, humanDecisionVerifier: createChatRelayChannel() });
    try {
      const lane = { module: MODULE, lane: "ba" as const, action: "signoff" as const, caller: { kind: "controller" } };
      const asked = await api.laneDecision(lane);
      const req = KnowledgeBase.load(root).get("REQ-003")!;
      writeKnowledgeItem({ ...req, ...(change === "version" ? { version: req.version + 1 } : { title: `${req.title} edited` }) }, root, { force: true });
      expect(await api.laneDecision({ ...lane, requestId: asked.requestId, submission: {
        approved: true, credential: { kind: "controller-chat-relay", conversationId: "fixture", messageId: "stale", actorId: "fixture-user", messageText: `approve ${asked.requestId}` },
      } })).toMatchObject({ ok: false, code: "refused", denialReason: expect.stringContaining("stale") });
      expect(store.loadLaneRequest(asked.requestId!)).toMatchObject({ status: "withdrawn", decision: null });
      expect(entry(root, store, AgentStage.SYSTEM_ANALYST).allowed).toBe(false);
    } finally {
      api.close();
    }
  });

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
