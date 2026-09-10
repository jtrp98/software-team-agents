import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import type { FindingCategory } from "../artifacts/finding.js";
import {
  describeRepairRoute,
  invalidationSetFor,
  repairQaSignals,
  routeRepair,
  type RepairChangeFacts,
} from "./repairRoute.js";
import { DEFAULT_ESCALATION_POLICY, effectiveMaxRetry } from "../escalation/escalationPolicy.js";
import { MAX_RETRY, ORDINARY_REPAIR_ROUNDS, initTaskRun, recordFailure } from "./retryPolicy.js";
import { decideRecovery } from "./recoveryPolicy.js";
import { transition } from "../state/taskState.js";

const QA_PIPELINE = [AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER];

/** Walk a fresh run up to QA, which is where a QA failure is actually reported from. */
function toQa(run: ReturnType<typeof initTaskRun>) {
  let machine = run.machine;
  if (machine.current !== TaskState.IMPLEMENTATION) machine = transition(machine, TaskState.IMPLEMENTATION);
  machine = transition(machine, TaskState.QA);
  return { ...run, machine };
}

const FULL_PIPELINE = [
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.PROJECT_MANAGER,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.QA_ENGINEER,
];
const DEV_ONLY = [AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER];

const GRAPH = taskGraphFromPlan([
  { id: "BE-004", owner: AgentStage.BACKEND_ENGINEER, phase: 1, dependsOn: [], produces: ["Contract:OrderSummary.v2"], consumes: [] },
  { id: "FE-010", owner: AgentStage.FRONTEND_ENGINEER, phase: 1, dependsOn: [], produces: [], consumes: ["Contract:OrderSummary.v2"] },
  { id: "BE-002", owner: AgentStage.BACKEND_ENGINEER, phase: 1, dependsOn: [], produces: ["Contract:OrderRead.v1"], consumes: [] },
]);

function finding(
  category: FindingCategory,
  overrides: { owner?: AgentStage; retryable?: boolean; requires_human?: boolean; task_id?: string } = {},
) {
  return {
    task_id: overrides.task_id ?? "BE-004",
    category,
    owner: overrides.owner ?? AgentStage.BACKEND_ENGINEER,
    retryable: overrides.retryable ?? true,
    requires_human: overrides.requires_human ?? false,
  };
}

describe("routeRepair — one deterministic route per category", () => {
  it("sends an implementation defect back to its original owner as a delta repair", () => {
    const route = routeRepair({ finding: finding("implementation"), pipeline: DEV_ONLY, graph: GRAPH });
    expect(route).toMatchObject({
      kind: "delta-repair",
      owner: AgentStage.BACKEND_ENGINEER,
      toState: TaskState.IMPLEMENTATION,
      requiresFullQa: false,
      consumesDefectRetry: true,
    });
    expect(route.reason).toContain("delta repair packet");
  });

  it("routes a test defect the same way — the owner of the code owns its tests", () => {
    expect(routeRepair({ finding: finding("test"), pipeline: DEV_ONLY }).kind).toBe("delta-repair");
  });

  it("sends a contract failure to system-analyst, recompiling only graph descendants", () => {
    const route = routeRepair({ finding: finding("contract"), pipeline: FULL_PIPELINE, graph: GRAPH });
    expect(route).toMatchObject({
      kind: "recompile-descendants",
      owner: AgentStage.SYSTEM_ANALYST,
      toState: TaskState.DESIGN,
      requiresFullQa: true,
    });
    // FE-010 consumes the contract BE-004 produces. BE-002 is a sibling with
    // no edge from BE-004 and must not be recompiled.
    expect(route.invalidates).toEqual(["FE-010"]);
    expect(route.reason).toContain("business-analyst is not rerun for a contract gap");
  });

  it("never rerun business-analyst for a requirement finding with no confirmed missing decision", () => {
    const route = routeRepair({ finding: finding("requirement", { owner: AgentStage.BUSINESS_ANALYST }), pipeline: FULL_PIPELINE });
    expect(route.kind).toBe("escalate");
    expect(route.owner).toBe("human");
    expect(route.reason).toContain("no confirmed missing business decision");
  });

  it("routes to business-analyst once a person has established the decision is genuinely missing", () => {
    const route = routeRepair({
      finding: finding("requirement", { owner: AgentStage.BUSINESS_ANALYST }),
      pipeline: FULL_PIPELINE,
      businessDecisionMissing: true,
      graph: GRAPH,
    });
    expect(route).toMatchObject({
      kind: "business-decision",
      owner: AgentStage.BUSINESS_ANALYST,
      toState: TaskState.REQUIREMENT,
      invalidates: ["FE-010"],
    });
  });

  it("halts and resumes an infrastructure failure without consuming a defect retry", () => {
    const route = routeRepair({ finding: finding("infrastructure"), pipeline: DEV_ONLY, graph: GRAPH });
    expect(route).toMatchObject({ kind: "halt-and-resume", owner: "human", consumesDefectRetry: false, requiresFullQa: false });
    expect(route.reason).toContain("consumes no defect retry");
  });

  it("keeps infrastructure out of the defect lifecycle even when it also claims requires_human", () => {
    const route = routeRepair({ finding: finding("infrastructure", { requires_human: true }), pipeline: DEV_ONLY });
    expect(route.kind).toBe("halt-and-resume");
    expect(route.consumesDefectRetry).toBe(false);
  });

  it("escalates an unclassified failure rather than guessing an owner", () => {
    const route = routeRepair({ finding: finding("unknown"), pipeline: DEV_ONLY });
    expect(route.kind).toBe("escalate");
    expect(route.reason).toContain("no deterministic owner route");
  });

  it("escalates when the finding says a person must decide, or that no retry can help", () => {
    expect(routeRepair({ finding: finding("implementation", { requires_human: true }), pipeline: DEV_ONLY }).kind).toBe("escalate");
    expect(routeRepair({ finding: finding("implementation", { retryable: false }), pipeline: DEV_ONLY }).kind).toBe("escalate");
  });

  it("escalates when the owning stage is not in this task's pipeline", () => {
    const noSa = routeRepair({ finding: finding("contract"), pipeline: DEV_ONLY });
    expect(noSa.kind).toBe("escalate");
    expect(noSa.reason).toContain("not in this task's pipeline");
    const noOwner = routeRepair({ finding: finding("implementation", { owner: AgentStage.FRONTEND_ENGINEER }), pipeline: DEV_ONLY });
    expect(noOwner.kind).toBe("escalate");
  });

  it("records the route and its rationale in one auditable line", () => {
    const line = describeRepairRoute(routeRepair({ finding: finding("contract"), pipeline: FULL_PIPELINE, graph: GRAPH }));
    expect(line).toContain("recompile-descendants -> system-analyst (DESIGN)");
    expect(line).toContain("invalidates FE-010");
    expect(line).toContain("FULL QA required");
    expect(line).toContain("defect retry consumed");
  });
});

describe("FULL QA escalation after a repair", () => {
  it.each<[string, RepairChangeFacts]>([
    ["a schema change", { touchesSchema: true }],
    ["a shared-contract change", { changesSharedContract: true }],
    ["a security-sensitive change", { securitySensitive: true }],
    ["a change outside the finding's scope", { newFilesOutsideFinding: ["src/auth/session.ts"] }],
  ])("requires FULL after %s", (_label, repairChanges) => {
    const route = routeRepair({ finding: finding("implementation"), pipeline: DEV_ONLY, repairChanges });
    expect(route.requiresFullQa).toBe(true);
    expect(repairQaSignals(route)).toEqual({ releaseGateRequiresFull: true });
  });

  it("names the out-of-scope files in the recorded reason", () => {
    const route = routeRepair({
      finding: finding("implementation"),
      pipeline: DEV_ONLY,
      repairChanges: { newFilesOutsideFinding: ["src/auth/session.ts"] },
    });
    expect(route.reason).toContain("src/auth/session.ts");
  });

  it("leaves an in-scope ordinary repair on the bounded round it already had", () => {
    const route = routeRepair({ finding: finding("implementation"), pipeline: DEV_ONLY, repairChanges: {} });
    expect(route.requiresFullQa).toBe(false);
    expect(repairQaSignals(route)).toEqual({});
  });
});

describe("invalidationSetFor", () => {
  it("returns graph descendants only — never the task itself or its dependencies", () => {
    expect(invalidationSetFor(GRAPH, "BE-004")).toEqual(["FE-010"]);
    expect(invalidationSetFor(GRAPH, "FE-010")).toEqual([]);
  });

  it("returns nothing rather than guessing when no graph or no such task is available", () => {
    expect(invalidationSetFor(undefined, "BE-004")).toEqual([]);
    expect(invalidationSetFor(GRAPH, "BE-999")).toEqual([]);
  });
});

describe("ordinary and hard retry ceilings", () => {
  it("gives every ordinary severity exactly two automatic rounds", () => {
    for (const severity of ["low", "medium", "high"] as const) {
      expect(effectiveMaxRetry(severity)).toBe(ORDINARY_REPAIR_ROUNDS);
      expect(DEFAULT_ESCALATION_POLICY.severity[severity].max_retry).toBe(2);
    }
  });

  it("keeps the global hard ceiling above the ordinary one as defense in depth", () => {
    expect(MAX_RETRY).toBe(3);
    expect(ORDINARY_REPAIR_ROUNDS).toBeLessThan(MAX_RETRY);
  });

  it("critical still never retries automatically", () => {
    expect(effectiveMaxRetry("critical")).toBe(0);
    expect(DEFAULT_ESCALATION_POLICY.severity.critical.stop_pipeline).toBe(true);
  });

  it("stops an ordinary repair after the second failed round rather than granting a third", () => {
    let run = initTaskRun([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    const failure = {
      category: "implementation" as const,
      owner: AgentStage.BACKEND_ENGINEER,
      severity: "medium" as const,
      retryable: true,
      reason: "empty order still throws",
      affected: ["BE-004"],
      requiresHuman: false,
    };
    const decisions = [];
    for (let round = 1; round <= 3; round++) {
      run = toQa(run);
      run = recordFailure(run, "qa");
      decisions.push(decideRecovery({ failure, kind: "qa", run, pipeline: QA_PIPELINE, currentState: TaskState.QA }));
    }
    expect(decisions[0].kind).toBe("RETRY");
    expect(decisions[1].kind).toBe("RETRY");
    expect(decisions[2].kind).toBe("ESCALATE");
    expect(decisions[2].reason).toContain("allows at most 2 automatic round(s)");
    // The reported ceiling is the one the failure actually has, not the global budget.
    expect(decisions[0]).toMatchObject({ max: 2 });
  });
});

describe("infrastructure does not consume a defect retry", () => {
  const infrastructure = {
    category: "infrastructure" as const,
    owner: AgentStage.BACKEND_ENGINEER,
    severity: "high" as const,
    retryable: true,
    reason: "provider returned 429 for the whole round",
    affected: ["BE-004"],
    requiresHuman: false,
  };

  it("leaves the qa budget untouched across repeated provider failures", () => {
    let run = initTaskRun(QA_PIPELINE, false);
    for (let i = 0; i < 5; i++) {
      run = toQa(run);
      run = recordFailure(run, "qa", { countsAsDefect: false });
      // Never BLOCKED: an outage that repeats cannot exhaust a budget it
      // never touches, which is the whole point of the exemption.
      expect(run.machine.current).toBe(TaskState.IMPLEMENTATION);
    }
    expect(run.retries.qa).toBe(0);
  });

  it("still counts an ordinary defect — the exemption is category-specific, not a general opt-out", () => {
    let run = initTaskRun(QA_PIPELINE, false);
    run = toQa(run);
    run = recordFailure(run, "qa");
    expect(run.retries.qa).toBe(1);
  });

  it("halts and resumes rather than routing a provider outage to an engineer", () => {
    let run = initTaskRun(QA_PIPELINE, false);
    run = toQa(run);
    run = recordFailure(run, "qa", { countsAsDefect: false });
    const action = decideRecovery({
      failure: infrastructure,
      kind: "qa",
      run,
      pipeline: QA_PIPELINE,
      currentState: TaskState.QA,
    });
    expect(action.kind).toBe("ESCALATE");
    expect(action.reason).toContain("without consuming a qa defect retry");
    expect(action.reason).toContain("resume the same stage");
  });
});
