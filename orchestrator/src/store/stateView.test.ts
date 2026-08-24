import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { MAX_RETRY } from "../retry/retryPolicy.js";
import { newPersistedTask, type PersistedTask } from "./taskStore.js";
import { renderStateYaml, writeStateView, writeStateViewFromStore } from "./stateView.js";
import { StateViewSchemaError } from "./stateSchema.js";
import { MemoryTaskStore } from "./memoryStore.js";
import { ApprovalType } from "../gates/approval.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";

function task(taskId: string, overrides: Partial<PersistedTask> = {}): PersistedTask {
  const classification = classifyTask({ isIncrementalFeature: true, touchesBackend: true });
  return {
    ...newPersistedTask({
      taskId,
      classification,
      machine: initTaskMachine(classification.pipeline, classification.requiresHumanApproval),
      now: 1_700_000_000_000,
    }),
    ...overrides,
  };
}

/** The whole point of the view is that a person (and a parser) can read it — so the tests parse it, not grep it. */
function renderAndParse(tasks: PersistedTask[]): any {
  return parse(renderStateYaml(tasks, { now: 1_700_000_000_000 }));
}

describe("state view", () => {
  it("emits valid YAML with one entry per task", () => {
    const doc = renderAndParse([task("T-1"), task("T-2")]);
    expect(doc.tasks.map((t: any) => t.task_id)).toEqual(["T-1", "T-2"]);
    expect(doc.schema_version).toBe(1);
  });

  it("says which agent is up and what the retry budget looks like", () => {
    const t = task("T-1");
    // cursor 2: pipeline is [system-analyst, test-planner, backend-engineer, qa-engineer] (T20).
    const doc = renderAndParse([{ ...t, machine: { ...t.machine, current: TaskState.IMPLEMENTATION }, pipelineCursor: 2, retries: { qa: 2, security: 0 } }]);

    expect(doc.tasks[0].status).toBe("RUNNING");
    expect(doc.tasks[0].current_agent).toBe(AgentStage.BACKEND_ENGINEER);
    expect(doc.tasks[0].retry).toEqual({ qa: 2, security: 0, max: MAX_RETRY });
  });

  it("shows a blocked task with the reason it blocked on", () => {
    const t = task("T-1");
    const doc = renderAndParse([
      { ...t, machine: { ...t.machine, current: TaskState.BLOCKED }, blockedReason: "qa retry limit (3) exceeded" },
    ]);

    expect(doc.tasks[0].status).toBe("BLOCKED");
    expect(doc.tasks[0].reason).toBe("qa retry limit (3) exceeded");
  });

  it("shows what a dependency-blocked task is waiting on", () => {
    const doc = renderAndParse([task("T-1"), task("T-2", { dependsOn: ["T-1"] })]);
    expect(doc.tasks[1].status).toBe("WAITING_FOR_DEPENDENCY");
    expect(doc.tasks[1].waiting_on).toEqual(["T-1"]);
  });

  it("quotes values that would otherwise change meaning as YAML", () => {
    const t = task("T-1");
    const doc = renderAndParse([{ ...t, machine: { ...t.machine, current: TaskState.BLOCKED }, blockedReason: "no: yes" }]);
    expect(doc.tasks[0].reason).toBe("no: yes");
  });

  it("announces in the file itself that it is generated", () => {
    expect(renderStateYaml([task("T-1")])).toContain("# GENERATED FILE — do not edit.");
  });

  it("creates the directory it writes into", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-view-"));
    try {
      const file = path.join(dir, "nested", ".workflow", "state.yaml");
      writeStateView(file, [task("T-1")]);
      expect(parse(fs.readFileSync(file, "utf8")).tasks[0].task_id).toBe("T-1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders an empty store without producing broken YAML", () => {
    expect(parse(renderStateYaml([]))).toEqual({
      schema_version: 1,
      generated_at: expect.any(String),
      tasks: [],
    });
  });
});

describe("state view — T02 fields", () => {
  it("labels the phase from the engineer holding IMPLEMENTATION, not from the state alone", () => {
    const t = task("T-1");
    const backend = { ...t, machine: { ...t.machine, current: TaskState.IMPLEMENTATION }, pipelineCursor: 2 };
    expect(renderAndParse([backend]).tasks[0].phase).toBe("backend");
  });

  it("falls back to the neutral phase label when no agent holds the state", () => {
    const t = task("T-1");
    const orphan = {
      ...t,
      machine: { ...t.machine, current: TaskState.IMPLEMENTATION },
      pipelineCursor: 99,
    };
    expect(renderAndParse([orphan]).tasks[0].phase).toBe("implementation");
  });

  it("maps the remaining states to their phase", () => {
    const t = task("T-1");
    const phaseFor = (current: TaskState) =>
      renderAndParse([{ ...t, machine: { ...t.machine, current }, pipelineCursor: 99 }]).tasks[0].phase;

    expect(phaseFor(TaskState.DESIGN)).toBe("design");
    expect(phaseFor(TaskState.QA_FAILED)).toBe("qa");
    expect(phaseFor(TaskState.READY_TO_DEPLOY)).toBe("deploy");
    expect(phaseFor(TaskState.DEPLOYED)).toBe("done");
  });

  it("says which agent runs next, and reports no previous run until one has finished", () => {
    const doc = renderAndParse([task("T-1")]);
    expect(doc.tasks[0].next.agent).toBe(AgentStage.SYSTEM_ANALYST);
    expect(doc.tasks[0].previous).toBeNull();
  });

  it("reports the last finished agent and how it went", () => {
    const doc = parse(
      renderStateYaml([task("T-1")], {
        now: 1_700_000_000_000,
        previousRun: () => ({ agent: AgentStage.QA_ENGINEER, result: "FAIL" }),
      }),
    );
    expect(doc.tasks[0].previous).toEqual({ agent: AgentStage.QA_ENGINEER, result: "FAIL" });
  });

  it("takes `previous` from the store's own run log when generated from a store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-prev-"));
    try {
      const file = path.join(dir, "state.yaml");
      const store = new MemoryTaskStore();
      const orch = new Orchestrator("T-1", classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true }), { store });
      await orch.step(() => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }));

      writeStateViewFromStore(file, store);
      const doc = parse(fs.readFileSync(file, "utf8"));
      // A copy tweak has no design phase (T-UX11): the one stage is frontend-engineer.
      expect(doc.tasks[0].previous).toEqual({ agent: AgentStage.FRONTEND_ENGINEER, result: "PASS" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write a document that violates its own schema, leaving no file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-invalid-"));
    try {
      const file = path.join(dir, "state.yaml");
      const broken = { ...task("T-1"), classification: { ...task("T-1").classification, level: "VIBES" as any } };

      expect(() => writeStateView(file, [broken])).toThrow(StateViewSchemaError);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("approval ledger in the view (T08)", () => {
  function taskWithApprovals(approvals: PersistedTask["approvals"]): PersistedTask {
    const base = newPersistedTask({
      taskId: "T-1",
      classification: classifyTask({ isIncrementalFeature: true, touchesBackend: true }),
      machine: initTaskMachine(
        classifyTask({ isIncrementalFeature: true, touchesBackend: true }).pipeline,
        false,
      ),
      now: 0,
    });
    return { ...base, approvals };
  }

  const pending: PersistedTask["approvals"] = [
    {
      type: ApprovalType.SCHEMA_CONFIRMATION,
      required: true,
      status: "pending",
      from: null,
      to: null,
      reason: "DESIGN_APPROVED required before development can start",
      requestedAt: 0,
      decidedAt: null,
      decidedBy: null,
      note: null,
    },
  ];

  it("renders an outstanding decision in T08's shape", () => {
    const yaml = renderStateYaml([taskWithApprovals(pending)], { now: 0 });
    expect(yaml).toContain("approval:");
    expect(yaml).toContain("type: schema-confirmation");
    expect(yaml).toContain("status: pending");
  });

  it("shows null when nothing is outstanding", () => {
    const yaml = renderStateYaml([taskWithApprovals([])], { now: 0 });
    expect(yaml).toContain("approval: null");
  });

  /** A rejection has to be visible as an answer, not as an empty gate. */
  it("keeps a rejection in the ledger with who decided it and when", () => {
    const rejected: PersistedTask["approvals"] = [
      { ...pending[0], status: "rejected", decidedAt: 1_700_000_000_000, decidedBy: "jaturapat" },
    ];
    const yaml = renderStateYaml([taskWithApprovals(rejected)], { now: 0 });
    expect(yaml).toContain("status: rejected");
    expect(yaml).toContain("decided_by: jaturapat");
    expect(yaml).toContain("decided_at:");
    // Answered, so nothing is outstanding any more.
    expect(yaml).toContain("approval: null");
  });

  it("still validates against the published schema with a ledger present", () => {
    expect(() => renderStateYaml([taskWithApprovals(pending)], { now: 0 })).not.toThrow();
  });
});
