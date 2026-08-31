import { describe, expect, it, vi } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { ApprovalType } from "../gates/approval.js";
import type { AgentExecutor, Orchestrator, OrchestratorStatus } from "../orchestrator/orchestrator.js";
import { runTaskLoop, type RunTaskLoopIo } from "./runTaskLoop.js";

const executor: AgentExecutor = vi.fn();

function fixture(statuses: OrchestratorStatus[], stepResult?: OrchestratorStatus) {
  let cursor = 0;
  const summary = vi.fn(() => "run summary");
  const decideApproval = vi.fn(() => { cursor++; });
  const provideHumanApproval = vi.fn(() => { cursor++; });
  const step = vi.fn(async () => stepResult ?? statuses[++cursor]);
  const orchestrator = {
    taskId: "T-LOOP",
    runLog: { summary },
    status: vi.fn(() => statuses[Math.min(cursor, statuses.length - 1)]),
    decideApproval,
    provideHumanApproval,
    step,
  } as unknown as Orchestrator;
  const registry = { refreshStateView: vi.fn() };
  const messages: string[] = [];
  const errors: string[] = [];
  const confirm = vi.fn(async () => true);
  const io: RunTaskLoopIo = {
    log: (message) => messages.push(message),
    error: (message) => errors.push(message),
    confirm,
    isTTY: true,
    actor: "alice",
  };
  return { orchestrator, registry, io, messages, errors, confirm, decideApproval, provideHumanApproval, step, summary };
}

const gate: OrchestratorStatus = {
  kind: "WAITING_FOR_HUMAN",
  from: TaskState.DESIGN,
  to: TaskState.PLAN,
  reason: "schema confirmation required",
  approvalType: ApprovalType.SCHEMA_CONFIRMATION,
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

  it("records a known TTY approval and continues to DEPLOYED", async () => {
    const f = fixture([gate, { kind: "DEPLOYED" }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(0);
    expect(f.confirm).toHaveBeenCalledWith("Approve schema-confirmation?");
    expect(f.decideApproval).toHaveBeenCalledWith(ApprovalType.SCHEMA_CONFIRMATION, true, { by: "alice" });
  });

  it("returns 3 for a TTY rejection and records the decision", async () => {
    const f = fixture([gate]);
    f.confirm.mockResolvedValue(false);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(3);
    expect(f.decideApproval).toHaveBeenCalledWith(ApprovalType.SCHEMA_CONFIRMATION, false, { by: "alice" });
    expect(f.messages.at(-1)).toBe("[orchestrator] rejected — task T-LOOP is stopped and the decision is recorded. Resuming will not ask again; revisit it deliberately if that was wrong.");
  });

  it("returns 4 without prompting when no TTY is attached", async () => {
    const f = fixture([gate]);
    f.io.isTTY = false;
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(4);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toBe("[orchestrator] no terminal attached — parking task T-LOOP with the gate unanswered. Resolve it with: node orchestrator/dist/cli.js approve T-LOOP --yes|--no (or rerun this command in an interactive terminal), then --resume.");
  });

  it("returns 2 for an unresolvable gate", async () => {
    const f = fixture([{
      kind: "WAITING_FOR_HUMAN",
      from: TaskState.QA,
      to: TaskState.READY_TO_DEPLOY,
      reason: "unknown gate",
      approvalType: null,
    }]);
    await expect(runTaskLoop(f.orchestrator, f.registry, executor, f.io)).resolves.toBe(2);
    expect(f.confirm).not.toHaveBeenCalled();
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
