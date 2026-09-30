import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import { testHumanVerifier, trustedCredential } from "../gates/humanDecision.testSupport.js";
import { UntrustedHumanDecisionError, type HumanDecisionVerifier } from "../gates/humanDecision.js";
import { createChatRelayChannel } from "../gates/chatRelayChannel.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import type { AgentExecutorResult } from "../orchestrator/orchestrator.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MockRuntimeAdapter, okResult } from "../runtime/mockAdapter.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import {
  createStaApi,
  CallerAuthorityError,
  StaApiError,
  type StaApi,
} from "./staApi.js";

const trivial = () => classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
const incremental = () => classifyTask({ isIncrementalFeature: true, touchesBackend: true });

const pass: AgentExecutorResult = {
  outcome: { tokens: 10, cost: 0.001, result: "PASS" },
};

function setupTestApi(opts: { withVerifier?: boolean; verifier?: HumanDecisionVerifier } = {}) {
  const store = new MemoryTaskStore();
  const humanDecisionVerifier = opts.verifier ?? (opts.withVerifier ? testHumanVerifier() : undefined);
  const registry = new TaskRegistry({
    stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
    store,
    humanDecisionVerifier,
  });

  const executor = withStageEvidence(async () => pass);

  const api: StaApi = createStaApi({
    store,
    registry,
    humanDecisionVerifier,
    stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
    executorFactory: () => executor,
  });

  return { store, registry, api };
}

describe("StaApi (V13 TASK-021)", () => {
  describe("status operation", () => {
    it("returns overview of all tasks when no taskId is provided", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });
      registry.create({ taskId: "TASK-2", classification: trivial() });

      const overview = await api.status();
      expect("tasks" in overview).toBe(true);
      if ("tasks" in overview) {
        expect(overview.tasks).toHaveLength(2);
        expect(overview.tasks.map((t) => t.taskId)).toEqual(["TASK-1", "TASK-2"]);
        expect(overview.tasks[0].nextAction).toBeDefined();
        expect(overview.tasks[0].state).toBe(TaskState.CREATED);
      }
    });

    it("returns semantic status for a specific task without leaking internal execution packet or worktree details", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      const status = await api.status({ taskId: "TASK-1" });
      expect("taskId" in status).toBe(true);
      if ("taskId" in status) {
        expect(status.taskId).toBe("TASK-1");
        expect(status.state).toBe(TaskState.CREATED);
        expect(status.kind).toBe("RUNNING");
        expect(status.currentStage).toBe(AgentStage.FRONTEND_ENGINEER);
        expect(status.nextAction).toContain(AgentStage.FRONTEND_ENGINEER);
        expect(status.requiredGate).toBeNull();
        expect(status.waitingOn).toEqual([]);
        expect(status.progress.pipeline).toBeDefined();
        // Assert no leaking of internal adapter commands or worktree paths
        expect((status as unknown as Record<string, unknown>).packet).toBeUndefined();
        expect((status as unknown as Record<string, unknown>).worktreeRoot).toBeUndefined();
        expect((status as unknown as Record<string, unknown>).adapterCommand).toBeUndefined();
      }
    });
  });

  describe("execute operation and caller authority enforcement", () => {
    it("executes the next stage through STA control plane when valid", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      const res = await api.execute({ taskId: "TASK-1" });
      expect(res.ok).toBe(true);
      expect(res.taskId).toBe("TASK-1");
      expect(res.executedStage).toBe(AgentStage.FRONTEND_ENGINEER);
      expect(res.status).toBeDefined();
    });

    it("a workflow step refuses a caller-chosen role and points at a direct run", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ role: "security" } as Record<string, unknown>),
        }),
      ).rejects.toThrow(CallerAuthorityError);

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ role: "security" } as Record<string, unknown>),
        }),
      ).rejects.toThrow(/workflow step takes its role .* direct run/);
    });

    it("a workflow step refuses caller-chosen paths and points at a direct run", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ paths: ["src/**"] } as Record<string, unknown>),
        }),
      ).rejects.toThrow(CallerAuthorityError);

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ paths: ["src/**"] } as Record<string, unknown>),
        }),
      ).rejects.toThrow(/workflow step takes its write scope .* direct run/);
    });

    it("a workflow step refuses an executor command and points at a direct run", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ command: "node build.js" } as Record<string, unknown>),
        }),
      ).rejects.toThrow(CallerAuthorityError);

      await expect(
        api.execute({
          taskId: "TASK-1",
          ...({ command: "node build.js" } as Record<string, unknown>),
        }),
      ).rejects.toThrow(/does not take an executor command.*direct run/);
    });

    it("runs a direct task on a named runtime with no workflow task at all", async () => {
      const store = new MemoryTaskStore();
      const codex = new MockRuntimeAdapter({ id: "codex", respond: () => okResult({ text: "done directly" }) });
      const api = createStaApi({
        store,
        projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sta-api-direct-")),
        runtimeRegistry: new RuntimeRegistry([codex]),
        stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
      });

      const result = await api.execute({ runtime: "codex", task: "rename a variable", role: "backend-engineer", permissions: { write: true } });

      expect(result).toMatchObject({ status: "completed", output: "done directly", run: { runtime: "codex", depth: 0 } });
      expect(codex.requests[0].role).toBe("backend-engineer");
      expect(store.listTasks()).toEqual([]);
      expect(api.runs.run(result.run.runId)?.status).toBe("completed");
    });

    it("rejects caller trying to impersonate a governed role", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(
        api.execute({
          taskId: "TASK-1",
          caller: { role: "backend-engineer" },
        }),
      ).rejects.toThrow(CallerAuthorityError);

      await expect(
        api.execute({
          taskId: "TASK-1",
          caller: { role: "backend-engineer" },
        }),
      ).rejects.toThrow(/Controller cannot impersonate governed role "backend-engineer"/);
    });

    it("rejects caller trying to impersonate human authority on execute", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(
        api.execute({
          taskId: "TASK-1",
          caller: { kind: "human" },
        }),
      ).rejects.toThrow(CallerAuthorityError);

      await expect(
        api.execute({
          taskId: "TASK-1",
          caller: { kind: "human" },
        }),
      ).rejects.toThrow(/Controller cannot impersonate human authority/);
    });
  });

  describe("approve operation and human gate boundary", () => {
    async function setupWaitingTask(withVerifier: boolean) {
      const ctx = setupTestApi({ withVerifier });
      ctx.registry.create({ taskId: "TASK-GATE", classification: incremental() });
      // Execute the first stage (system-analyst); transition to DESIGN opens the human approval request
      await ctx.api.execute({ taskId: "TASK-GATE" });
      const status = await ctx.api.status({ taskId: "TASK-GATE" });
      const pendingGate = "requiredGate" in status ? status.requiredGate : null;
      expect(pendingGate).not.toBeNull();
      return { ...ctx, pendingGate: pendingGate! };
    }

    it.each([false, true])("accepts a Controller-relayed chat answer only for the pending request (unknownActor=%s)", async (unknownActor) => {
      const { api, registry } = setupTestApi({ verifier: createChatRelayChannel() });
      registry.create({ taskId: "TASK-CHAT", classification: incremental() });
      await api.execute({ taskId: "TASK-CHAT" });
      const status = await api.status({ taskId: "TASK-CHAT" });
      const gate = "requiredGate" in status ? status.requiredGate! : null;
      expect(gate?.announcement?.channel).toBe("chat-relay");
      const submission = {
        requestId: gate!.requestId,
        approved: true,
        credential: { kind: "controller-chat-relay", conversationId: "conv-1", messageId: "msg-1", actorId: unknownActor ? null : "user-1", ...(unknownActor ? { actorUnavailableReason: "host-does-not-expose-actor" } : {}), messageText: `approve ${gate!.requestId}` },
      };
      expect(gate!.prompt).toContain(`approve ${gate!.requestId}`);
      expect(gate!.prompt).toContain("cannot independently authenticate");
      expect(await api.approve({ taskId: "TASK-CHAT", requestId: gate!.requestId, submission: undefined as unknown as typeof submission, caller: { kind: "controller" } }))
        .toMatchObject({ ok: false, code: "refused" });
      for (const invalid of [
        { ...submission, requestId: "apr_00000000000000000000000000000000" },
        { ...submission, approved: undefined },
        { ...submission, credential: { ...submission.credential, actorId: "" } },
        { ...submission, credential: { ...submission.credential, messageText: "still reviewing" } },
        { ...submission, credential: { ...submission.credential, messageText: `reject ${gate!.requestId}` } },
      ]) {
        expect(await api.approve({ taskId: "TASK-CHAT", requestId: gate!.requestId, submission: invalid, caller: { kind: "controller" } }))
          .toMatchObject({ ok: false, code: "refused" });
        expect(registry.resume("TASK-CHAT").pendingApprovalRequest()?.requestId).toBe(gate!.requestId);
      }
      expect(await api.approve({ taskId: "TASK-CHAT", requestId: gate!.requestId, submission, caller: { kind: "controller" } }))
        .toMatchObject({ ok: true, approved: true });
      expect(await api.approve({ taskId: "TASK-CHAT", requestId: gate!.requestId, submission, caller: { kind: "controller" } }))
        .toMatchObject({ ok: false });
    });

    it("rejects approval when caller is not human", async () => {
      const { api, pendingGate } = await setupWaitingTask(true);

      await expect(
        api.approve({
          taskId: "TASK-GATE",
          requestId: pendingGate.requestId,
          submission: {
            requestId: pendingGate.requestId,
            approved: true,
            credential: trustedCredential(),
          },
          caller: { kind: "bot" },
        }),
      ).rejects.toThrow(UntrustedHumanDecisionError);

      await expect(
        api.approve({
          taskId: "TASK-GATE",
          requestId: pendingGate.requestId,
          submission: {
            requestId: pendingGate.requestId,
            approved: true,
            credential: trustedCredential(),
          },
          caller: { kind: "bot" },
        }),
      ).rejects.toThrow(/Chat approval must be relayed by Controller/);
    });

    it("fails closed with no-trusted-channel when human decision verifier is unconfigured", async () => {
      const { api, pendingGate } = await setupWaitingTask(false);

      const res = await api.approve({
        taskId: "TASK-GATE",
        requestId: pendingGate.requestId,
        submission: {
          requestId: pendingGate.requestId,
          approved: true,
        },
        caller: { kind: "controller" },
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("no-trusted-channel");
      expect(res.denialReason).toContain("no trusted human identity channel is configured");
    });

    it("accepts valid human approval through configured channel", async () => {
      const { api, pendingGate } = await setupWaitingTask(true);

      const res = await api.approve({
        taskId: "TASK-GATE",
        requestId: pendingGate.requestId,
        submission: {
          requestId: pendingGate.requestId,
          approved: true,
          credential: trustedCredential({ actorId: "golf" }),
        },
        caller: { kind: "controller" },
      });

      expect(res.ok).toBe(true);
      expect(res.approved).toBe(true);

      const statusAfter = await api.status({ taskId: "TASK-GATE" });
      if ("requiredGate" in statusAfter) {
        expect(statusAfter.requiredGate).toBeNull();
      }
    });
  });

  describe("result and cancel operations", () => {
    it("returns result with completion status and evidence refs", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await api.execute({ taskId: "TASK-1" });
      const res = await api.result({ taskId: "TASK-1" });

      expect(res.taskId).toBe("TASK-1");
      expect(res.evidenceRefs.length).toBeGreaterThan(0);
      expect(res.latestAttempt).toBeDefined();
    });

    it("cancels task with explicit reason and reflects in status", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      const cancelRes = await api.cancel({ taskId: "TASK-1", reason: "Scope changed by user" });
      expect(cancelRes.ok).toBe(true);
      expect(cancelRes.status).toBe("CANCELLED");
      expect(cancelRes.reason).toBe("Scope changed by user");

      const status = await api.status({ taskId: "TASK-1" });
      if ("kind" in status) {
        expect(status.kind).toBe("CANCELLED");
        expect(status.cancelled).toBe(true);
        expect(status.cancelReason).toBe("Scope changed by user");
      }
    });

    it("rejects cancel with empty reason", async () => {
      const { registry, api } = setupTestApi();
      registry.create({ taskId: "TASK-1", classification: trivial() });

      await expect(api.cancel({ taskId: "TASK-1", reason: "" })).rejects.toThrow(StaApiError);
      await expect(api.cancel({ taskId: "TASK-1", reason: "   " })).rejects.toThrow(/Cancel requires an explicit non-empty reason/);
    });
  });

  describe("no direct file-writing API surface", () => {
    it("does not expose any writeFile, modifyFile, or command execution methods on StaApi", () => {
      const { api } = setupTestApi();
      const apiKeys = Object.keys(api);
      expect(apiKeys).toContain("status");
      expect(apiKeys).toContain("plan");
      expect(apiKeys).toContain("execute");
      expect(apiKeys).toContain("result");
      expect(apiKeys).toContain("approve");
      expect(apiKeys).toContain("cancel");
      expect(apiKeys).toContain("close");

      expect((api as unknown as Record<string, unknown>).writeFile).toBeUndefined();
      expect((api as unknown as Record<string, unknown>).modifyFile).toBeUndefined();
      expect((api as unknown as Record<string, unknown>).runCommand).toBeUndefined();
      expect((api as unknown as Record<string, unknown>).shell).toBeUndefined();
    });
  });
});
