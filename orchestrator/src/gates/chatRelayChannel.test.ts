import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { createChatRelayChannel } from "./chatRelayChannel.js";
import { HOST_ACTOR_UNAVAILABLE, HumanDecisionRecordSchema } from "./approval.js";

const credential = (messageId: string, requestId: string) => ({
  kind: "controller-chat-relay",
  conversationId: "conversation-1",
  messageId,
  actorId: "user-1",
  messageText: `approve ${requestId}`,
});

async function pendingTask() {
  const store = new MemoryTaskStore();
  const verifier = createChatRelayChannel();
  const options = { store, humanDecisionVerifier: verifier, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };
  const orch = new Orchestrator("T-CHAT", classifyTask({ isIncrementalFeature: true, touchesBackend: true }), options);
  await orch.step(withStageEvidence(() => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } })));
  return { store, verifier, orch, requestId: orch.pendingApprovalRequest()!.requestId };
}

describe("TASK-001/027 Controller chat relay", () => {
  it.each(["", "text"])("accepts a whole-message %s code block and preserves its original bytes", async (language) => {
    const { orch, store, verifier, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    const messageText = `\`\`\`${language}\r\nreject ${requestId}\r\n\`\`\`\r\n`;
    const submission = { requestId, approved: false, credential: { ...credential("fenced-answer", requestId), messageText } };
    const { decision } = await orch.submitHumanDecision(submission);
    expect(decision).toMatchObject({ approved: false, note: messageText });
    const resumed = Orchestrator.resume("T-CHAT", store, { humanDecisionVerifier: verifier, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
    expect(resumed.approvalLedger[0]).toMatchObject({ status: "rejected", decision: { note: messageText } });
    await expect(resumed.submitHumanDecision(submission)).rejects.toThrow(/already rejected/);
  });

  it("refuses fenced examples, quotes, multiple blocks and wrong-request answers", async () => {
    const { orch, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    const block = `\`\`\`\napprove ${requestId}\n\`\`\``;
    for (const messageText of [
      `Example only:\n${block}`, `${block}\nnot my answer`, `> ${block}`,
      `${block}\n${block}`, `\`\`\`js\napprove ${requestId}\n\`\`\``,
      `\`\`\`\napprove apr_00000000000000000000000000000000\n\`\`\``,
      `\`\`\`\nreject ${requestId}\n\`\`\``,
    ]) {
      await expect(orch.submitHumanDecision({ requestId, approved: true,
        credential: { ...credential("fenced-example", requestId), messageText },
      })).rejects.toThrow(/original answer/);
      expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
    }
  });

  it("records null attribution only with explicit host-unavailable metadata, including durable evidence", async () => {
    const { orch, store, verifier, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    for (const bad of [
      { actorId: null },
      { actorId: null, actorUnavailableReason: "unknown" },
      { actorId: undefined, actorUnavailableReason: HOST_ACTOR_UNAVAILABLE },
      { actorId: "user-1", actorUnavailableReason: HOST_ACTOR_UNAVAILABLE },
    ]) {
      await expect(orch.submitHumanDecision({ requestId, approved: true,
        credential: { ...credential("unknown-actor", requestId), ...bad },
      })).rejects.toThrow(/Controller must provide/);
      expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
    }
    const { decision } = await orch.submitHumanDecision({ requestId, approved: true,
      credential: { ...credential("unknown-actor", requestId), actorId: null, actorUnavailableReason: HOST_ACTOR_UNAVAILABLE },
    });
    expect(decision.actor).toEqual({ kind: "human", id: null, unavailableReason: HOST_ACTOR_UNAVAILABLE });
    expect(HumanDecisionRecordSchema.safeParse({ ...decision, actor: { kind: "human", id: null } }).success).toBe(false);
    expect(HumanDecisionRecordSchema.safeParse({ ...decision, source: { ...decision.source, channel: "other" } }).success).toBe(false);
    const resumed = Orchestrator.resume("T-CHAT", store, { humanDecisionVerifier: verifier, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
    expect(resumed.approvalLedger[0].decision?.actor).toEqual(decision.actor);
    expect(resumed.evidence().find((e) => e.kind === "approval-decision")?.payload)
      .toMatchObject({ actorId: null, actorUnavailableReason: HOST_ACTOR_UNAVAILABLE });
  });

  it("keeps the gate pending until STA publishes and receives an explicit referenced answer", async () => {
    const { store, verifier, orch, requestId } = await pendingTask();
    const submission = { requestId, approved: true, credential: credential("msg-1", requestId) };
    await expect(orch.submitHumanDecision(submission)).rejects.toThrow(/not presented/);
    expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
    expect((await orch.publishPendingApproval())?.channel).toBe("chat-relay");
    await expect(orch.submitHumanDecision({ requestId, approved: true })).rejects.toThrow(/Controller must provide/);
    await expect(orch.submitHumanDecision({ ...submission, requestId: "apr_00000000000000000000000000000000" })).rejects.toThrow(/no approval request/);
    const resumed = Orchestrator.resume("T-CHAT", store, { humanDecisionVerifier: verifier, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
    const { decision } = await resumed.submitHumanDecision(submission);
    expect(decision.source).toEqual({ channel: "chat-relay", evidenceRef: "chat:conversation-1/msg-1" });
    expect(decision.actor.id).toBe("chat-user:user-1");
    expect(store.loadTask("T-CHAT")?.approvals[0]?.status).toBe("approved");
    await expect(resumed.submitHumanDecision(submission)).rejects.toThrow(/already approved/);
  });

  it("rejects malformed relay evidence and a request ID from another pending gate", async () => {
    const { orch, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    for (const badCredential of [null, {}, { ...credential("msg-1", requestId), actorId: "" }, { ...credential("msg-1", requestId), messageText: "" }]) {
      await expect(orch.submitHumanDecision({ requestId, approved: true, credential: badCredential })).rejects.toThrow(/Controller must provide/);
    }
    expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
  });

  it.each(["conversationId", "messageId", "actorId", "messageText"] as const)("refuses missing or malformed %s without decision evidence", async (field) => {
    const { orch, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    const missing: Record<string, unknown> = credential("msg-1", requestId);
    delete missing[field];
    for (const bad of [missing, ...[null, 1, {}, "", " \r\n\t"].map((value) => ({ ...credential("msg-1", requestId), [field]: value }))]) {
      await expect(orch.submitHumanDecision({ requestId, approved: true, credential: bad })).rejects.toThrow(/Controller must provide/);
      expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
      expect(orch.evidence().filter((e) => e.kind === "approval-decision")).toEqual([]);
    }
  });

  it.each([
    ["no human answer", () => "still reviewing", true],
    ["no request", () => "approve", true],
    ["another request", () => "approve apr_00000000000000000000000000000000", true],
    ["request suffix", (id: string) => `approve ${id}extra`, true],
    ["ambiguous answer", (id: string) => `approve or reject ${id}`, true],
    ["quoted directive", (id: string) => `Please reply approve ${id}`, true],
    ["reject relayed as approve", (id: string) => `reject ${id}`, true],
    ["approve relayed as reject", (id: string) => `approve ${id}`, false],
  ] as const)("keeps pending for %s", async (_name, answer, approved) => {
    const { orch, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    await expect(orch.submitHumanDecision({
      requestId, approved, credential: { ...credential("msg-1", requestId), messageText: answer(requestId) },
    })).rejects.toThrow(/original answer/);
    expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
    expect(orch.evidence().filter((e) => e.kind === "approval-decision")).toEqual([]);
  });

  it("requires an explicit boolean answer even with referenced text", async () => {
    const { orch, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    for (const approved of [undefined, null, "true", 1]) {
      await expect(orch.submitHumanDecision({
        requestId, approved: approved as unknown as boolean, credential: credential("msg-1", requestId),
      })).rejects.toThrow(/approve\/reject answer/);
    }
    expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
  });

  it("persists a rejection and its unchanged original text, and refuses replay after resume", async () => {
    const { orch, store, verifier, requestId } = await pendingTask();
    await orch.publishPendingApproval();
    const messageText = `  reject ${requestId}\r\nยังไม่ยืนยันรายละเอียด  \r\n`;
    const submission = { requestId, approved: false, credential: { ...credential("msg-reject", requestId), messageText } };
    const { decision } = await orch.submitHumanDecision(submission);
    expect(decision).toMatchObject({ approved: false, note: messageText });
    const resumed = Orchestrator.resume("T-CHAT", store, { humanDecisionVerifier: verifier, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
    expect(resumed.approvalLedger[0]).toMatchObject({ status: "rejected", decision: { note: messageText } });
    await expect(resumed.submitHumanDecision(submission)).rejects.toThrow(/already rejected/);
  });
});
