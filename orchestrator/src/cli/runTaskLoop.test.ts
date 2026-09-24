import { describe, expect, it, vi } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { ApprovalType } from "../gates/approval.js";
import type { AgentExecutor, Orchestrator, OrchestratorStatus } from "../orchestrator/orchestrator.js";
import { runTaskLoop, type RunTaskLoopIo } from "./runTaskLoop.js";

const executor: AgentExecutor = vi.fn();

function fixture(statuses: OrchestratorStatus[], stepResult?: OrchestratorStatus) {
  let cursor = 0;
  const summary = vi.fn(() => "run summary");
  const submitHumanDecision = vi.fn();
  const step = vi.fn(async () => stepResult ?? statuses[++cursor]);
  const orchestrator = {
    taskId: "T-LOOP",
    runLog: { summary },
    status: vi.fn(() => statuses[Math.min(cursor, statuses.length - 1)]),
    submitHumanDecision,
    step,
  } as unknown as Orchestrator;
  const registry = { refreshStateView: vi.fn() };
  const messages: string[] = [];
  const errors: string[] = [];
  const io: RunTaskLoopIo = {
    log: (message) => messages.push(message),
    error: (message) => errors.push(message),
  };
  return { orchestrator, registry, io, messages, errors, submitHumanDecision, step, summary };
}

const REQUEST_ID = "apr_0123456789abcdef0123456789abcdef";

const gate: OrchestratorStatus = {
  kind: "WAITING_FOR_HUMAN",
  from: TaskState.DESIGN,
  to: TaskState.PLAN,
  reason: "schema confirmation required",
  approvalType: ApprovalType.SCHEMA_CONFIRMATION,
  requestId: REQUEST_ID,
};

describe("runTaskLoop", () => {
  it("returns 0 for DEPLOYED and prints the run summary", async () => {
    const f = fixture([{ kind: "DEPLOYED" }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(0);
    expect(f.messages).toEqual(["[orchestrator] task T-LOOP DEPLOYED.", "run summary"]);
  });

  it("returns 1 for BLOCKED", async () => {
    const f = fixture([{ kind: "BLOCKED", reason: "cannot continue" }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(1);
    expect(f.messages).toEqual(["[orchestrator] task T-LOOP BLOCKED: cannot continue"]);
  });

  it("parks on a human gate with its request id and never answers it", async () => {
    const f = fixture([gate, { kind: "DEPLOYED" }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(4);
    expect(f.submitHumanDecision).not.toHaveBeenCalled();
    expect(f.step).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toBe(
      `[orchestrator] parking task T-LOOP on pending request ${REQUEST_ID}. A person resolves it through a trusted channel: ` +
        `node orchestrator/dist/cli.js approve T-LOOP --request ${REQUEST_ID} --yes|--no, then --resume.`,
    );
  });

  it("returns 2 for a gate with no pending request to answer", async () => {
    const f = fixture([{
      kind: "WAITING_FOR_HUMAN",
      from: TaskState.QA,
      to: TaskState.READY_TO_DEPLOY,
      reason: "unknown gate",
      approvalType: null,
      requestId: null,
    }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(2);
    expect(f.submitHumanDecision).not.toHaveBeenCalled();
  });

  it("returns 1 when a running stage does not advance", async () => {
    const running: OrchestratorStatus = { kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER };
    const f = fixture([running], running);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(1);
    expect(f.step).toHaveBeenCalledWith(executor);
    expect(f.messages).toEqual([
      "[orchestrator] running backend-engineer...",
      "[orchestrator] backend-engineer did not advance the task — stopping to avoid a spin loop.",
    ]);
  });
});
