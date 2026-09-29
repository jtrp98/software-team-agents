import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { createChatRelayChannel } from "./chatRelayChannel.js";

const credential = (messageId: string) => ({
  kind: "controller-chat-relay",
  conversationId: "conversation-1",
  messageId,
  actorId: "user-1",
  messageText: "Approve this pending request",
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
  it("keeps the gate pending until STA publishes and receives an explicit referenced answer", async () => {
    const { store, verifier, orch, requestId } = await pendingTask();
    const submission = { requestId, approved: true, credential: credential("msg-1") };
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
    for (const badCredential of [null, {}, { ...credential("msg-1"), actorId: "" }, { ...credential("msg-1"), messageText: "" }]) {
      await expect(orch.submitHumanDecision({ requestId, approved: true, credential: badCredential })).rejects.toThrow(/Controller must provide/);
    }
    expect(orch.pendingApprovalRequest()?.requestId).toBe(requestId);
  });
});
