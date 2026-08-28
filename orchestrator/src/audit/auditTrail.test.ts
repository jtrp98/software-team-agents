import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  actorsIn,
  auditTrail,
  decisionTrail,
  describeEvent,
  formatAuditTrail,
  isAgentActor,
  toAuditEntry,
  HUMAN_ACTOR,
  ORCHESTRATOR_ACTOR,
} from "./auditTrail.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { ApprovalType } from "../gates/approval.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { RunLog } from "../observability/runLog.js";

function qaReport(status: "PASS" | "FAIL"): QaReportArtifact {
  return {
    taskId: "T",
    status,
    mode: "FULL",
    requirements: { "REQ-001": status },
    tests: { passed: status === "PASS" ? 10 : 8, failed: status === "PASS" ? 0 : 2 },
    evidence: ["log"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentclaude-audit-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("describeEvent (T37)", () => {
  it("reads WHO/WHY/INPUT/OUTPUT/DECISION out of an assignment", () => {
    expect(describeEvent("AGENT_ASSIGNED", { stage: "backend-engineer", inputs: ["design", "plan"] })).toEqual({
      actor: ORCHESTRATOR_ACTOR,
      reason: null,
      input: "design, plan",
      output: null,
      decision: "assign:backend-engineer",
    });
  });

  it("credits a completion to the agent that ran, and names what it produced", () => {
    const fields = describeEvent("AGENT_COMPLETED", {
      stage: "qa-engineer",
      artifactType: "qa-report",
      packetPath: ".workflow/packets/T-1/qa-engineer-1.json",
      outcome: { result: "PASS", tokens: 1200 },
    });
    expect(fields.actor).toBe("qa-engineer");
    expect(fields.input).toBe("execution-packet:.workflow/packets/T-1/qa-engineer-1.json");
    expect(fields.output).toBe("qa-report, PASS, 1200 tokens");
    // Finishing is a fact, not a choice — so it carries no decision.
    expect(fields.decision).toBeNull();
  });

  it("records both the failure's reason and the routing decision on a failed round", () => {
    const fields = describeEvent("QA_FAILED", {
      stage: "qa-engineer",
      round: 1,
      failure: { owner: "system-analyst", reason: "design.md has no rule for a partial refund" },
      recovery: { kind: "RECOVER", strategy: "return_to_owner", reason: "contract gap" },
    });
    expect(fields.actor).toBe("qa-engineer");
    expect(fields.reason).toContain("partial refund");
    expect(fields.output).toBe("FAIL (round 1)");
    expect(fields.decision).toBe("recover:system-analyst");
  });

  it("falls back to the recovery's own reason when no structured failure was supplied", () => {
    const fields = describeEvent("SECURITY_FAILED", {
      stage: "security",
      round: 2,
      failure: null,
      recovery: { kind: "ESCALATE", strategy: "escalate_to_human", reason: "needs a person" },
    });
    expect(fields.reason).toBe("needs a person");
    expect(fields.decision).toBe("escalate:escalate_to_human");
  });

  it("attributes an approval decision to the person, not the pipeline", () => {
    const fields = describeEvent("APPROVAL_DECIDED", {
      type: "schema-confirmation",
      approved: false,
      by: "jane",
      note: "Refund model is wrong",
    });
    expect(fields.actor).toBe("jane");
    expect(fields.output).toBe("rejected");
    expect(fields.decision).toBe("reject:schema-confirmation");
  });

  it("falls back to a generic human actor when nobody signed the decision", () => {
    expect(describeEvent("APPROVAL_DECIDED", { type: "deploy", approved: true }).actor).toBe(HUMAN_ACTOR);
  });

  it("returns empty fields for an event type it does not know, rather than inventing an actor", () => {
    expect(describeEvent("SOMETHING_NEW", { stage: "backend-engineer" })).toEqual({
      actor: null,
      reason: null,
      input: null,
      output: null,
      decision: null,
    });
  });

  it("tells an agent actor from a bookkeeping one", () => {
    expect(isAgentActor("backend-engineer")).toBe(true);
    expect(isAgentActor(ORCHESTRATOR_ACTOR)).toBe(false);
    expect(isAgentActor(null)).toBe(false);
  });
});

describe("toAuditEntry", () => {
  it("prefers what was stored over what can be derived", () => {
    const entry = toAuditEntry({
      taskId: "T-1",
      at: 5,
      type: "AGENT_ASSIGNED",
      payload: { stage: "backend-engineer", inputs: ["design"] },
      actor: "recorded-actor",
      reason: null,
      input: null,
      output: null,
      decision: null,
    });
    expect(entry.actor).toBe("recorded-actor");
    // The rest were never recorded, so the derivation fills them — which is what
    // makes rows written before T37 readable instead of a wall of nulls.
    expect(entry.input).toBe("design");
    expect(entry.decision).toBe("assign:backend-engineer");
  });
});

describe("audit trail over a real run (T37)", () => {
  function runToDeployed(store: MemoryTaskStore, taskId: string) {
    const orch = new Orchestrator(taskId, classifyTask({ isClearBugFix: true, touchesBackend: true }), { store });
    let calls = 0;
    const executor = (req: { stage: AgentStage }) => {
      if (req.stage === AgentStage.QA_ENGINEER) {
        const first = calls++ === 0;
        return {
          outcome: { tokens: 500, cost: 0.02, result: first ? ("FAIL" as const) : ("PASS" as const) },
          artifactType: ArtifactType.QA_REPORT,
          artifact: qaReport(first ? "FAIL" : "PASS"),
          failure: first
            ? {
                category: "implementation" as const,
                owner: AgentStage.BACKEND_ENGINEER,
                severity: "high" as const,
                retryable: true,
                reason: "API response mismatch on /refunds",
                affected: ["BE-004"],
                requiresHuman: false,
              }
            : undefined,
        };
      }
      return { outcome: { tokens: 100, cost: 0.01, result: "PASS" as const } };
    };
    return { orch, executor };
  }

  it("answers why a task went back to an engineer, from the store alone", async () => {
    const store = new MemoryTaskStore();
    const { orch, executor } = runToDeployed(store, "T-WHY");
    for (let i = 0; i < 12; i++) {
      const status = await orch.step(executor);
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const trail = auditTrail(store, "T-WHY");
    const failed = trail.find((e) => e.type === "QA_FAILED");
    expect(failed).toBeDefined();
    expect(failed!.actor).toBe(AgentStage.QA_ENGINEER);
    expect(failed!.reason).toContain("API response mismatch");
    expect(failed!.decision).toBe(`retry:${AgentStage.BACKEND_ENGINEER}`);

    // WHO acted, across the whole task, in the order they first acted.
    expect(actorsIn(trail)).toContain(ORCHESTRATOR_ACTOR);
    expect(actorsIn(trail)).toContain(AgentStage.QA_ENGINEER);
  });

  it("separates the decisions from everything else that merely happened", async () => {
    const store = new MemoryTaskStore();
    const { orch, executor } = runToDeployed(store, "T-DECIDE");
    for (let i = 0; i < 12; i++) {
      const status = await orch.step(executor);
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const trail = auditTrail(store, "T-DECIDE");
    const decisions = decisionTrail(trail);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.length).toBeLessThan(trail.length);
    // An agent finishing is in the trail but is not a decision.
    expect(decisions.every((e) => e.type !== "AGENT_COMPLETED")).toBe(true);
    expect(trail.some((e) => e.type === "AGENT_COMPLETED")).toBe(true);
  });

  it("records what the agent was handed, not just that it was assigned", () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator(
      "T-INPUT",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesSchema: true, touchesBackend: true }),
      { store },
    );

    for (let i = 0; i < 12; i++) {
      const status = orch.status();
      if (status.kind === "WAITING_FOR_HUMAN" && status.approvalType) {
        orch.decideApproval(status.approvalType, true, { by: "tester" });
        continue;
      }
      if (status.kind !== "RUNNING") break;
      const producesDesign = status.stage === AgentStage.SYSTEM_ANALYST;
      orch.reportCompletion(
        status.stage,
        producesDesign
          ? {
              outcome: { tokens: 1, cost: 0, result: "PASS" },
              artifactType: ArtifactType.DESIGN,
              artifact: {
                taskId: "T-INPUT",
                feasibility: "feasible",
                dataModel: [{ model: "Refund", fields: [{ name: "id", type: "string" }] }],
                risks: [],
                openQuestions: [],
                contract: ["refund status must be REFUNDED"],
              },
            }
          : { outcome: { tokens: 1, cost: 0, result: "PASS" } },
        { start: 0, end: 1 },
      );
    }

    const trail = auditTrail(store, "T-INPUT");
    const nextAssignment = trail.find(
      (e) => e.type === "AGENT_ASSIGNED" && e.decision === `assign:${AgentStage.TEST_PLANNER}`,
    );
    expect(nextAssignment).toBeDefined();
    // The design system-analyst produced is what the next stage is handed.
    expect(nextAssignment!.input).toContain(ArtifactType.DESIGN);

    // And an empty hand-over is recorded as empty rather than invented: the very
    // first stage has nothing upstream of it to be given.
    const firstAssignment = trail.find((e) => e.type === "AGENT_ASSIGNED");
    expect(firstAssignment!.input).toBeNull();
  });

  it("renders a trail a person can read, and a decisions-only view", async () => {
    const store = new MemoryTaskStore();
    const { orch, executor } = runToDeployed(store, "T-FORMAT");
    for (let i = 0; i < 12; i++) {
      const status = await orch.step(executor);
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") break;
    }

    const trail = auditTrail(store, "T-FORMAT");
    const full = formatAuditTrail(trail);
    expect(full).toContain("QA_FAILED");
    expect(full).toContain("why:");
    expect(full).toContain("API response mismatch");

    const decisionsOnly = formatAuditTrail(trail, { decisionsOnly: true });
    expect(decisionsOnly).toContain("decision:");
    expect(decisionsOnly).not.toContain("AGENT_COMPLETED");
  });

  it("says so plainly when a task produced no events", () => {
    expect(formatAuditTrail([])).toBe("(no events recorded for this task)");
  });

  it("T-V3R-081 renders fallback routing and historical nulls without inventing values", () => {
    const routed = new RunLog().record({
      task_id: "T-ROUTE",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 1,
      end_time: 2,
      outcome: {
        tokens: 1, cost: 0, result: "PASS", requested_runtime: "claude-code", runtime: "codex",
        requested_model: "sonnet", model: "gpt-5.6-codex", routing_basis: "role-policy",
        fallback_count: 1, fallback_reason: "requested runner unavailable",
      },
    });
    const historical = new RunLog().record({
      task_id: "T-ROUTE", agent: AgentStage.QA_ENGINEER, start_time: 2, end_time: 3,
      outcome: { tokens: 1, cost: 0, result: "PASS" },
    });
    const rendered = formatAuditTrail([], { runs: [routed, historical] });
    expect(rendered).toContain("runner=claude-code → codex");
    expect(rendered).toContain("model=sonnet → gpt-5.6-codex");
    expect(rendered).toContain("fallback_reason=requested runner unavailable");
    expect(rendered).toContain("runner=not reported → not reported");
    expect(rendered).toContain("model=not reported → not reported");
  });

  it("records a human's answer as the human's, in the trail", () => {
    const store = new MemoryTaskStore();
    const orch = new Orchestrator(
      "T-HUMAN",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesSchema: true, touchesBackend: true }),
      { store },
    );
    // Walk the run to the schema question: the interview gate now comes first on
    // this pipeline, so answer it whenever it appears.
    for (let i = 0; i < 20; i++) {
      const status = orch.status();
      if (status.kind === "WAITING_FOR_HUMAN" && status.approvalType === ApprovalType.REQUIREMENT_INTERVIEW) {
        orch.decideApproval(ApprovalType.REQUIREMENT_INTERVIEW, true, { by: "somchai" });
        continue;
      }
      if (status.kind !== "RUNNING") break;
      orch.reportCompletion(status.stage, { outcome: { tokens: 1, cost: 0, result: "PASS" } }, { start: 0, end: 1 });
    }
    orch.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, true, { by: "somchai" });

    const trail = auditTrail(store, "T-HUMAN");
    const asked = trail.find((e) => e.type === "APPROVAL_REQUIRED");
    const answered = trail.find((e) => e.type === "APPROVAL_DECIDED");
    // The first asked-and-answered question on this pipeline is the interview.
    expect(asked!.actor).toBe(ORCHESTRATOR_ACTOR);
    expect(asked!.decision).toBe(`ask:${ApprovalType.REQUIREMENT_INTERVIEW}`);
    expect(answered!.actor).toBe("somchai");
    expect(answered!.decision).toBe(`approve:${ApprovalType.REQUIREMENT_INTERVIEW}`);
  });
});

describe("SqliteTaskStore schema migration (T37)", () => {
  it("stores and reads the audit columns", () => {
    const file = path.join(tempDir(), "state.db");
    const store = new SqliteTaskStore(file);
    store.appendEvent({
      taskId: "T-1",
      at: 1,
      type: "QA_FAILED",
      payload: { round: 1 },
      actor: "qa-engineer",
      decision: "retry:backend-engineer",
    });
    expect(store.eventsForTask("T-1")[0]).toMatchObject({
      actor: "qa-engineer",
      decision: "retry:backend-engineer",
      reason: null,
    });
    store.close();
  });

  it("migrates a v2 database in place instead of refusing it", () => {
    const file = path.join(tempDir(), "old.db");
    // Build a database exactly as the pre-T37 build would have written one.
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, agent TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, duration INTEGER NOT NULL, model TEXT, tokens INTEGER NOT NULL, cost REAL NOT NULL, result TEXT NOT NULL, retry_count INTEGER NOT NULL, failure_reason TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, context_chars INTEGER);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO events (task_id, at, type, payload) VALUES (?, ?, ?, ?)").run(
      "T-OLD",
      1,
      "AGENT_ASSIGNED",
      JSON.stringify({ stage: "backend-engineer", inputs: ["design"] }),
    );
    legacy.pragma("user_version = 2");
    legacy.close();

    const store = new SqliteTaskStore(file);
    const events = store.eventsForTask("T-OLD");
    expect(events).toHaveLength(1);
    // The old row survives with nulls, and the trail derives the rest from its payload —
    // history written before T37 is readable, not a cutoff.
    expect(events[0].actor).toBeNull();
    expect(toAuditEntry(events[0]).decision).toBe("assign:backend-engineer");

    // The file is genuinely at v3 now, so reopening it is not a second migration.
    store.appendEvent({ taskId: "T-OLD", at: 2, type: "TASK_DEPLOYED", payload: {}, actor: "orchestrator" });
    expect(store.eventsForTask("T-OLD")[1].actor).toBe("orchestrator");
    store.close();

    const reopened = new SqliteTaskStore(file);
    expect(reopened.eventsForTask("T-OLD")).toHaveLength(2);
    reopened.close();
  });

  it("still refuses a database written by a newer build", () => {
    const file = path.join(tempDir(), "future.db");
    const fresh = new SqliteTaskStore(file);
    fresh.close();
    const bumped = new Database(file);
    bumped.pragma("user_version = 99");
    bumped.close();

    expect(() => new SqliteTaskStore(file)).toThrow(/refusing to read it/);
  });

  it("still refuses a v1 database, where a silent misread would corrupt cost accounting", () => {
    const file = path.join(tempDir(), "v1.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);`);
    legacy.pragma("user_version = 1");
    legacy.close();

    expect(() => new SqliteTaskStore(file)).toThrow(/schema version 1/);
  });
});
