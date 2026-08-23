import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { Orchestrator, type AgentExecutorRequest } from "../orchestrator/orchestrator.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { checkGate, type GateContext } from "../gates/gatePolicy.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { withQaOptimization } from "./optimized.js";
import { selectQaMode, type QaRiskSignals } from "./mode.js";
import { planRecheck } from "./evidence.js";
import { buildQaScope } from "./scope.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";

/**
 * QA08 โ€” the QA optimization regression suite.
 *
 * One test per case in TASKS_QA_OPTIMIZATION.md's list. These are not unit
 * tests of the modules (their own files do that); each one exercises a
 * *routing promise* end to end โ€” change list in, mode decision + gate
 * behaviour out โ€” because the thing being regression-protected is that
 * spending fewer tokens never came at the cost of verification coverage.
 */

let changed: () => string[] = () => ["src/small.ts"];
let signals: () => QaRiskSignals = () => ({});

function resetChangeSet(files: string[]) {
  changed = () => files;
}
function setSignals(s: QaRiskSignals) {
  signals = () => s;
}

function qaArtifact(mode: "FULL" | "TARGETED", status: "PASS" | "FAIL" = "PASS"): QaReportArtifact {
  return {
    taskId: "T-QA",
    status,
    mode,
    requirements: { R1: status === "PASS" ? "PASS" : "FAIL" },
    tests: { passed: status === "PASS" ? 2 : 1, failed: status === "PASS" ? 0 : 1 },
    evidence: ["evidence pointer"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };
}

describe("QA08 routing table", () => {
  it("small isolated change โ’ TARGETED", async () => {
    resetChangeSet(["src/small.ts"]);
    setSignals({});
    const decision = selectQaMode("T", buildQaScope({ taskId: "T", changedFiles: changed() }), signals());
    expect(decision.mode).toBe("TARGETED");
  });

  it.each([
    ["architecture/shared contract", { changesSharedContract: true }],
    ["schema change", { touchesSchema: true }],
    ["security-sensitive change", { securitySensitive: true }],
    ["cross-target change", { crossTargetImpact: true }],
  ])("%s โ’ FULL", (_label, s) => {
    const decision = selectQaMode(
      "T",
      buildQaScope({ taskId: "T", changedFiles: ["src/a.ts"] }),
      s,
    );
    expect(decision.mode).toBe("FULL");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("failed deterministic check blocks before LLM QA runs", async () => {
    resetChangeSet(["src/small.ts"]);
    setSignals({});
    let qaRan = false;
    const exec = withQaOptimization({
      inner: () => {
        qaRan = true;
        return Promise.resolve({ outcome: { tokens: 1, cost: 0, result: "PASS" } });
      },
      changedFiles: changed,
      deterministicRunner: (id) =>
        id === "unit-tests" ? { id, status: "FAIL", durationMs: 4, outputSummary: "3 tests failed" } : null,
    });
    const result = await exec({
      stage: AgentStage.QA_ENGINEER,
      taskId: "T",
      context: [],
    });
    expect(qaRan).toBe(false);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("unit-tests");
  });
});

describe("QA08 retry/recheck routing", () => {
  it("TARGETED round that finds unexpected impact escalates to FULL", () => {
    const previousFindings = [
      { id: "F1", description: "wrong total", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" as const },
    ];
    const fixTouched = ["api/orders.ts", "web/OrderSummary.tsx"];
    const plan = planRecheck(previousFindings, [], fixTouched);
    expect(plan.newFilesOutsideFindings).toContain("web/OrderSummary.tsx");

    // And mode selection honours that signal when the wrapper sets it.
    const decision = selectQaMode("T", buildQaScope({ taskId: "T", changedFiles: fixTouched }), {
      crossTargetImpact: true,
    });
    expect(decision.mode).toBe("FULL");
  });

  it("QA fail โ’ fix โ’ targeted recheck keeps the recheck plan and stays TARGETED when confined", async () => {
    const captured: AgentExecutorRequest[] = [];
    const exec = withQaOptimization({
      inner: (req) => {
        if (req.stage === AgentStage.QA_ENGINEER) captured.push(req);
        return Promise.resolve({ outcome: { tokens: 1, cost: 0, result: "PASS" } });
      },
      changedFiles: () => ["api/orders.ts"],
      previousRound: () => ({
        findings: [
          { id: "F1", description: "wrong total", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" },
        ],
        evidence: [{ id: "E1", kind: "deterministic", files: ["api/orders.ts"], summary: "typecheck r1", createdAt: 1 }],
      }),
    });
    await exec({ stage: AgentStage.QA_ENGINEER, taskId: "T", context: [], qaRound: 2 });

    expect(captured).toHaveLength(1);
    const pkg = captured[0].context.find((c) => c.source === "qa-evidence")!.content;
    expect(pkg).toContain("Recheck first");
    expect(pkg).toContain("[F1]");
    // The touched evidence is named for regeneration โ€” the stale half of QA06.
    expect(pkg).toContain("Invalidated evidence");
  });

  it("stale evidence is invalidated while untouched evidence stays reusable", () => {
    const evidence = [
      { id: "E-TYPECHECK", kind: "deterministic" as const, files: ["api/orders.ts"], summary: "typecheck PASS r1", createdAt: 1 },
      { id: "E-LINT", kind: "deterministic" as const, files: ["other/module.ts"], summary: "lint PASS r1", createdAt: 1 },
    ];
    const plan = planRecheck([{ id: "F1", description: "x", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" as const }], evidence, [
      "api/orders.ts",
    ]);
    expect(plan.invalidatedEvidence.map((e) => e.id)).toEqual(["E-TYPECHECK"]);
    expect(plan.reusableEvidence.map((e) => e.id)).toEqual(["E-LINT"]);
  });

  it("unchanged evidence is reused on an identical re-run scope", () => {
    const plan = planRecheck([], [{ id: "E1", kind: "deterministic", files: ["a.ts"], summary: "s", createdAt: 1 }], ["b.ts"]);
    expect(plan.reusableEvidence).toHaveLength(1);
    expect(plan.invalidatedEvidence).toHaveLength(0);
  });

  it("wrapper keeps a confined retry TARGETED and records no escalation signal", async () => {
    let seenMode = "";
    const exec = withQaOptimization({
      inner: (req) => {
        seenMode = req.context.find((c) => c.source === "qa-evidence")!.content.includes("CROSS-BOUNDARY") ? "FULL-ish" : "TARGETED";
        return Promise.resolve({ outcome: { tokens: 1, cost: 0, result: "PASS" } });
      },
      changedFiles: () => ["api/orders.ts"],
      previousRound: () => ({
        findings: [{ id: "F1", description: "x", owner: "backend-engineer", files: ["api/orders.ts"], createdAt: 1, status: "OPEN" }],
        evidence: [],
      }),
    });
    await exec({ stage: AgentStage.QA_ENGINEER, taskId: "T", context: [], qaRound: 1 });
    expect(seenMode).toBe("TARGETED");
  });
});

describe("QA08 gate enforcement (conditional final FULL QA)", () => {
  const QA_PASS_EDGE = [TaskState.QA, TaskState.READY_TO_DEPLOY] as const;

  it("low-risk task closes with a TARGETED report + recorded TARGETED decision", () => {
    const ctx: GateContext = {
      qaReport: qaArtifact("TARGETED"),
      qaModeDecision: selectQaMode("T", buildQaScope({ taskId: "T", changedFiles: ["a.ts"] }), {}),
    };
    expect(checkGate(QA_PASS_EDGE[0], QA_PASS_EDGE[1], ctx).allowed).toBe(true);
  });

  it("high-risk task cannot slip a TARGETED report past its FULL decision", () => {
    const ctx: GateContext = {
      qaReport: qaArtifact("TARGETED"),
      qaModeDecision: selectQaMode("T", buildQaScope({ taskId: "T", changedFiles: [] }), { touchesSchema: true }),
    };
    const gate = checkGate(QA_PASS_EDGE[0], QA_PASS_EDGE[1], ctx);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/re-run qa-engineer in FULL mode/);
  });

  it("a FULL report satisfies a FULL decision", () => {
    const ctx: GateContext = {
      qaReport: qaArtifact("FULL"),
      qaModeDecision: selectQaMode("T", buildQaScope({ taskId: "T", changedFiles: [] }), undefined),
    };
    expect(checkGate(QA_PASS_EDGE[0], QA_PASS_EDGE[1], ctx).allowed).toBe(true);
  });

  it("no recorded decision preserves V1 behaviour exactly", () => {
    expect(checkGate(QA_PASS_EDGE[0], QA_PASS_EDGE[1], { qaReport: qaArtifact("TARGETED") }).allowed).toBe(true);
  });
});

describe("QA08 orchestrator integration (decision persists; mode lands in the run log)", () => {
  function newTask() {
    const store = new MemoryTaskStore();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator(`T-QA-${Math.random().toString(36).slice(2, 7)}`, classification, { store });
    return { store, orch };
  }

  it("a FULL decision + TARGETED report leaves the task WAITING_FOR_HUMAN, and both survive persistence", async () => {
    const { store, orch } = newTask();
    const exec = withQaOptimization({
      inner: async (req) => {
        if (req.stage === AgentStage.BACKEND_ENGINEER) {
          return { outcome: { tokens: 10, cost: 0, result: "PASS" } };
        }
        // The QA agent answered PASS but in the wrong mode for this decision.
        return {
          outcome: { tokens: 10, cost: 0, result: "PASS" },
          artifactType: ArtifactType.QA_REPORT,
          artifact: qaArtifact("TARGETED"),
        };
      },
      changedFiles: () => ["src/a.ts"],
      riskSignals: () => ({ securitySensitive: true }), // forces FULL
    });

    await orch.step(exec); // backend
    const status = await orch.step(exec); // qa
    expect(status.kind).toBe("WAITING_FOR_HUMAN");

    // The decision and its reasons are part of persisted gate evidenceโ€ฆ
    const stored = store.loadTask(orch.taskId)!;
    expect(stored.gateContext.qaModeDecision?.mode).toBe("FULL");
    expect(stored.gateContext.qaModeDecision?.reasons).toContain("security-sensitive change");

    // โ€ฆand the run log carries the mode the round actually ran in (QA07).
    const runs = store.runsForTask(orch.taskId).filter((r) => r.agent === AgentStage.QA_ENGINEER);
    expect(runs).toHaveLength(1);
    expect(runs[0].qa_mode).toBe("TARGETED");
  });

  it("matching TARGETED decision + TARGETED report closes QA normally", async () => {
    const { orch } = newTask();
    const exec = withQaOptimization({
      inner: async (req) => {
        if (req.stage === AgentStage.BACKEND_ENGINEER) {
          return { outcome: { tokens: 10, cost: 0, result: "PASS" } };
        }
        void req;
        return {
          outcome: { tokens: 10, cost: 0, result: "PASS" },
          artifactType: ArtifactType.QA_REPORT,
          artifact: qaArtifact("TARGETED"),
        };
      },
      changedFiles: () => ["src/a.ts"],
    });
    await orch.step(exec);
    const status = await orch.step(exec);
    // Past QA entirely โ€” this minimal pipeline has no devops stage, so a PASS
    // round with a matching decision carries the task all the way through.
    expect(orch.machine.current).toBe(TaskState.DEPLOYED);
    expect(status.kind).toBe("DEPLOYED");
  });
});
