import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { createRunId } from "../run/journal.js";
import { parseCanonicalPlan, renderCanonicalTasks, type PlanTask } from "../docs/planTask.js";
import { TaskRegistry } from "./taskRegistry.js";
import {
  PlanRegistrationError,
  assertPlanUnchanged,
  classificationInputForPlanTask,
  compileAndRegisterPlan,
  runScopeHash,
  type PlanRunScope,
} from "./planCompilation.js";
import { AgentStage, TaskLevel } from "../types.js";

const HASH = "a".repeat(64);
const canonicalFixture = fs.readFileSync(fileURLToPath(new URL("../docs/fixtures/canonical-plan.md", import.meta.url)), "utf8");
const REQUIREMENT = `# Requirement

- REQ-007: Order summary responses stay stable when no line item exists.
- AC-007.2: Zero-total responses for orders with no line items must stay serializable.
- REQ-008: The summary panel communicates an empty order to the user.
- AC-008.1: Users must see an explicit zero figure where the panel would otherwise be blank.
`;
const DESIGN = `# Design

Design evidence format: 1

## Feasibility Summary

Both fixture tasks are independently implementable.

## Feature-by-Feature Feasibility

The two declarations below define the selected behavior.

## Data Model

No fixture schema changes.

## DES-011 — Order summary response
Contract:OrderSummary.v2 — the empty-order response shape.
DEC-011 — keep summary construction behind one serializer boundary.
Evidence EVD-011: claim=DES-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-012: claim=Contract:OrderSummary.v2 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-013: claim=DEC-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: unchanged
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: retain the current empty-order handler.
Material ambiguity: none

## DES-012 — Summary panel rendering
Contract:SummaryPanel.v1 — the rendered summary panel shape.
DEC-012 — keep panel rendering in one component.
Evidence EVD-014: claim=DES-012 | state=confirmed | path=src/panel.tsx | symbol=SummaryPanel | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-015: claim=Contract:SummaryPanel.v1 | state=confirmed | path=src/panel.tsx | symbol=SummaryPanel | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-016: claim=DEC-012 | state=confirmed | path=src/panel.tsx | symbol=SummaryPanel | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: unchanged
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: render the previous panel markup.
Material ambiguity: none

## Modules

Orders service and the summary panel.

## Risks & Dependencies

The per-section decision records are authoritative.

## Unresolved Open Questions

—

## Change Log

- Undated fixture; no human sign-off is implied.
`;
const refs = { requirementMd: REQUIREMENT, designMd: DESIGN };

/** BE-004 from the shared fixture, plus a frontend task that consumes its contract. */
function twoTaskPlan(): string {
  const be = parseCanonicalPlan(canonicalFixture, { requirementMd: "REQ-007 AC-007.2", designMd: "DES-011 Contract:OrderSummary.v2" }).tasks[0]!;
  const fe: PlanTask = {
    ...be,
    id: "FE-010",
    title: "Render the order summary",
    objective: "Show the empty-order total in the summary panel.",
    why: "Users must see a zero total instead of a blank panel.",
    owner: AgentStage.FRONTEND_ENGINEER,
    dependsOn: ["BE-004"],
    traceability: ["REQ-008", "AC-008.1", "DES-012"],
    produces: ["Contract:SummaryPanel.v1"],
    consumes: ["Contract:OrderSummary.v2"],
    scopeAndConstraints: "Only the summary panel component and its styles.",
    retrievalHints:
      "Hypothesis: the summary panel component renders the total; confirm against current source.\n" +
      "Query: Locate the summary panel component and its total rendering.\n" +
      "Provenance: DES-012, Contract:SummaryPanel.v1, Contract:OrderSummary.v2",
    doNotModify: "Backend serializers, routing and unrelated panels.",
    acceptanceCriteria: "AC-008.1: The panel renders a zero total for an empty order.",
    validationAndEvidence: "Verify AC-008.1 with the summary panel component test. Record commands and exit codes.",
    compatibility: "Nonempty-order rendering is unchanged; the panel change reverts independently.",
  };
  return renderCanonicalTasks([be, fe]);
}

let root: string;
let store: SqliteTaskStore;
let ledger: SqliteRunLedger;
let registry: TaskRegistry;
let runId: string;
let planMarkdown: string;

function writeModuleDocs(plan: string): void {
  const dir = path.join(root, "_docs", "module", "orders");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.md"), plan);
  fs.writeFileSync(path.join(dir, "requirement.md"), REQUIREMENT);
  fs.writeFileSync(path.join(dir, "design.md"), DESIGN);
}

function register(overrides: { scope?: PlanRunScope; plan?: string; classificationFor?: Parameters<typeof compileAndRegisterPlan>[0]["classificationFor"] } = {}) {
  return compileAndRegisterPlan({
    registry, store, ledger,
    planMarkdown: overrides.plan ?? planMarkdown,
    references: refs,
    scope: overrides.scope ?? { kind: "all" },
    runId, module: "orders", boundary: "qa",
    targetId: "orders-target", targetRoot: path.join(root, "target"), knowledgeRoot: root,
    baseBranch: "main", baseSha: "abc1234", runBranch: `sta/run/${runId}`,
    configHash: HASH, staVersion: "2.0.0", now: () => 1_000,
    ...(overrides.classificationFor ? { classificationFor: overrides.classificationFor } : {}),
    taskContextFor: () => ({ projectRoot: root, docsRoot: root, workflow: "test:bounded-run" }),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-plan-registration-"));
  fs.mkdirSync(path.join(root, "target"), { recursive: true });
  planMarkdown = twoTaskPlan();
  writeModuleDocs(planMarkdown);
  store = new SqliteTaskStore(path.join(root, "state.db"));
  ledger = new SqliteRunLedger(store, { projectRoot: root });
  registry = new TaskRegistry({ store, stateViewPath: path.join(root, ".workflow", "state.yaml") });
  runId = createRunId();
});

afterEach(() => {
  try { registry.close(); } catch { /* already closed */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T-V8-017 — atomic whole-plan registration", () => {
  it("registers every task, its classification, dependencies and contracts under one run identity", () => {
    const result = register();
    expect(result.run.status).toBe("REGISTERED");
    expect(result.run.task_order).toEqual(["BE-004", "FE-010"]);
    expect(result.planHash).toBe(runScopeHash(parseCanonicalPlan(planMarkdown, refs).tasks));
    expect(result.tasks.map((t) => [t.task_id, t.owner, t.status, t.position])).toEqual([
      ["BE-004", AgentStage.BACKEND_ENGINEER, "PLANNED", 0],
      ["FE-010", AgentStage.FRONTEND_ENGINEER, "PLANNED", 1],
    ]);
    // The contract edge survives into the ledger, which is what M2 required
    // the graph constructor to stop dropping.
    expect(result.tasks[0]!.produces).toEqual(["Contract:OrderSummary.v2"]);
    expect(result.tasks[1]!.consumes).toEqual(["Contract:OrderSummary.v2"]);
    expect(result.tasks[1]!.produces).toEqual(["Contract:SummaryPanel.v1"]);
    expect(result.tasks[1]!.depends_on).toEqual(["BE-004"]);

    // Task rows exist too, with the pipeline the classifier produced.
    expect(store.loadTask("BE-004")?.classification.pipeline).toContain(AgentStage.BACKEND_ENGINEER);
    expect(store.loadTask("FE-010")?.dependsOn).toEqual(["BE-004"]);
    expect(store.listTasks().map((t) => t.taskId).sort()).toEqual(["BE-004", "FE-010"]);

    // No per-task --register-only step was involved, and the trace says what one transaction did.
    expect(result.trace[0]).toContain(`plan_hash=${result.planHash}`);
    expect(result.trace.filter((line) => line.startsWith("registered "))).toHaveLength(2);

    // The human-readable view is written once, after the commit.
    expect(fs.existsSync(path.join(root, ".workflow", "state.yaml"))).toBe(true);
  });

  it("makes readiness come from the fixed DAG, not from a plan.md re-read", () => {
    register();
    expect(ledger.readiness(runId).ready).toEqual(["BE-004"]);
    // Editing plan.md afterwards changes nothing about the frozen run.
    fs.writeFileSync(path.join(root, "_docs", "module", "orders", "plan.md"), canonicalFixture);
    expect(ledger.readiness(runId)).toEqual({
      ready: ["BE-004"], waiting: [{ task_id: "FE-010", waiting_on: ["BE-004"] }], blocked: [], settled: [],
    });
  });

  it("selects an explicit task scope and orders it by the graph, not by the selection", () => {
    const result = register({ scope: { kind: "tasks", taskIds: ["FE-010", "BE-004"] } });
    expect(result.run.task_order).toEqual(["BE-004", "FE-010"]);
  });

  it("selects a phase scope", () => {
    expect(register({ scope: { kind: "phase", phase: 1 } }).run.task_order).toEqual(["BE-004", "FE-010"]);
    // Nothing in phase 2 exists, and an empty scope is a refusal, not an empty run.
    const fresh = new TaskRegistry({ store });
    expect(() => compileAndRegisterPlan({
      registry: fresh, store, ledger, planMarkdown, references: refs, scope: { kind: "phase", phase: 2 },
      runId: createRunId(), module: "orders", boundary: "qa", targetId: "t", targetRoot: root, knowledgeRoot: root,
      baseBranch: "main", baseSha: "abc1234", runBranch: "sta/run/x", configHash: HASH, staVersion: "2.0.0",
      taskContextFor: () => ({ projectRoot: root, docsRoot: root }),
    })).toThrow(/selected scope contains no task/);
  });
});

describe("T-V8-017 — every refusal leaves no registration state", () => {
  const expectNothingRegistered = () => {
    expect(ledger.listRuns()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  };

  it("refuses a legacy table plan with a conversion path instead of reinterpreting it", () => {
    const legacy = "# Plan\n\n## Phase 1\n\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-004 — Preserve | pending | backend-engineer | none |\n";
    expect(() => register({ plan: legacy })).toThrow(PlanRegistrationError);
    expect(() => register({ plan: legacy })).toThrow(/migrateLegacyTaskTable/);
    expectNothingRegistered();
  });

  it("refuses an invalid plan and names every problem", () => {
    expect(() => register({ plan: planMarkdown.replace("Owner: backend-engineer", "Owner: nobody") })).toThrow(/not registrable/);
    expectNothingRegistered();
  });

  it("refuses a cycle", () => {
    const cyclic = planMarkdown.replace("Depends on: none", "Depends on: FE-010");
    expect(() => register({ plan: cyclic })).toThrow(PlanRegistrationError);
    expectNothingRegistered();
  });

  it("refuses an unknown task id in an explicit scope", () => {
    expect(() => register({ scope: { kind: "tasks", taskIds: ["BE-004", "NOPE-1"] } })).toThrow(/not in this plan: NOPE-1/);
    expectNothingRegistered();
  });

  it("refuses a scope whose dependency is neither selected nor already registered", () => {
    expect(() => register({ scope: { kind: "tasks", taskIds: ["FE-010"] } })).toThrow(/not dependency-closed/);
    expect(() => register({ scope: { kind: "tasks", taskIds: ["FE-010"] } })).toThrow(/FE-010 depends on BE-004/);
    expectNothingRegistered();
  });

  it("refuses to re-register a task whose immutable metadata already exists", () => {
    register();
    const second = createRunId();
    expect(() => compileAndRegisterPlan({
      registry, store, ledger, planMarkdown, references: refs, scope: { kind: "all" },
      runId: second, module: "orders", boundary: "qa", targetId: "t", targetRoot: root, knowledgeRoot: root,
      baseBranch: "main", baseSha: "abc1234", runBranch: `sta/run/${second}`, configHash: HASH, staVersion: "2.0.0",
      taskContextFor: () => ({ projectRoot: root, docsRoot: root }),
    })).toThrow(/already registered/);
    expect(ledger.listRuns().map((r) => r.run_id)).toEqual([runId]);
  });

  it("rolls back the whole unit when the last task fails, leaving no partial graph", () => {
    // Fault injected at the *second* task, after the first has really been
    // written — otherwise "nothing was registered" would prove only that
    // nothing was ever attempted.
    let beVisibleMidTransaction = false;
    expect(() =>
      register({
        classificationFor: (task) => {
          if (task.id !== "FE-010") return classificationInputForPlanTask(task);
          beVisibleMidTransaction = store.loadTask("BE-004") !== null && ledger.readRun(runId) !== null;
          throw new Error("simulated failure while registering the last task");
        },
      }),
    ).toThrow(/simulated failure/);
    expect(beVisibleMidTransaction).toBe(true);
    expectNothingRegistered();
    expect(ledger.eventsForRun(runId)).toEqual([]);
    // A retry after the fault is cleared still registers cleanly: the failed
    // attempt left no immutable metadata to collide with.
    expect(register().run.task_order).toEqual(["BE-004", "FE-010"]);
  });

  it("refuses a classification that contradicts the plan's authored risk", () => {
    const schemaPlan = planMarkdown.replace("Risk: shared-contract\nHuman gate: none", "Risk: schema\nHuman gate: schema");
    expect(() =>
      register({
        plan: schemaPlan,
        classificationFor: (task) => ({ ...classificationInputForPlanTask(task), touchesSchema: false, isIncrementalFeature: true }),
      }),
    ).toThrow(/declares a schema change but the supplied classification does not/);
    expectNothingRegistered();
  });
});

describe("T-V8-017 — derived classification and drift", () => {
  it("derives the risk half from the plan and leaves work kind to the caller", () => {
    const [be] = parseCanonicalPlan(planMarkdown, refs).tasks;
    expect(classificationInputForPlanTask(be!)).toMatchObject({
      isIncrementalFeature: true, touchesSchema: false, touchesSensitiveArea: false,
      isProductionDeployOrMigration: false, touchesBackend: true, touchesFrontend: false,
    });
    const schema: PlanTask = { ...be!, risk: ["schema"], humanGate: ["schema"] };
    expect(classificationInputForPlanTask(schema).touchesSchema).toBe(true);
    const security: PlanTask = { ...be!, risk: ["security", "critical"], humanGate: ["security"] };
    expect(classificationInputForPlanTask(security).touchesSensitiveArea).toBe(true);
    const deploy: PlanTask = { ...be!, humanGate: ["migration"] };
    expect(classificationInputForPlanTask(deploy).isProductionDeployOrMigration).toBe(true);
    // The caller's explicit value wins over the derived default.
    expect(classificationInputForPlanTask(be!, { isIncrementalFeature: false, isClearBugFix: true }).isClearBugFix).toBe(true);
  });

  it("a schema-risk plan registers as LARGE_CRITICAL with the human gate intact", () => {
    const schemaPlan = planMarkdown.replace("Risk: shared-contract\nHuman gate: none", "Risk: schema\nHuman gate: schema");
    register({ plan: schemaPlan });
    const stored = store.loadTask("BE-004")!;
    expect(stored.classification.level).toBe(TaskLevel.LARGE_CRITICAL);
    expect(stored.classification.requiresHumanApproval).toBe(true);
    expect(stored.classification.sensitiveGate).toBe(true);
  });

  it("refuses to resume against an edited plan, and accepts an unchanged one", () => {
    const { run } = register();
    expect(() => assertPlanUnchanged(run, planMarkdown, refs)).not.toThrow();
    const edited = planMarkdown.replace("Objective: Return the existing order summary", "Objective: Return a recomputed order summary");
    expect(() => assertPlanUnchanged(run, edited, refs)).toThrow(/plan_hash drifted/);
    // A status-only edit is not semantic drift — that is the documented hash rule.
    expect(() => assertPlanUnchanged(run, planMarkdown.replace(/Status: pending/, "Status: in_progress"), refs)).not.toThrow();
    // A task vanishing from the plan is named, not silently ignored.
    expect(() => assertPlanUnchanged(run, canonicalFixture, { requirementMd: "REQ-007 AC-007.2", designMd: "DES-011 Contract:OrderSummary.v2" })).toThrow(
      /FE-010 disappeared/,
    );
  });

  it("produces a deterministic order for the same plan every time", () => {
    const first = register();
    const orders = new Set([first.run.task_order.join(",")]);
    for (let i = 0; i < 5; i += 1) {
      const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v8-plan-order-"));
      const isolatedStore = new SqliteTaskStore(path.join(isolatedRoot, "state.db"));
      const isolatedLedger = new SqliteRunLedger(isolatedStore, { projectRoot: isolatedRoot });
      const isolatedRegistry = new TaskRegistry({ store: isolatedStore });
      const docs = path.join(isolatedRoot, "_docs", "module", "orders");
      fs.mkdirSync(docs, { recursive: true });
      fs.writeFileSync(path.join(docs, "plan.md"), planMarkdown);
      fs.writeFileSync(path.join(docs, "requirement.md"), REQUIREMENT);
      fs.writeFileSync(path.join(docs, "design.md"), DESIGN);
      const id = createRunId();
      try {
        const result = compileAndRegisterPlan({
          registry: isolatedRegistry, store: isolatedStore, ledger: isolatedLedger, planMarkdown, references: refs,
          scope: { kind: "all" }, runId: id, module: "orders", boundary: "qa", targetId: "t",
          targetRoot: isolatedRoot, knowledgeRoot: isolatedRoot, baseBranch: "main", baseSha: "abc1234",
          runBranch: `sta/run/${id}`, configHash: HASH, staVersion: "2.0.0",
          taskContextFor: () => ({ projectRoot: isolatedRoot, docsRoot: isolatedRoot }),
        });
        orders.add(result.run.task_order.join(","));
        expect(result.planHash).toBe(first.planHash);
      } finally {
        isolatedRegistry.close();
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
      }
    }
    expect([...orders]).toEqual(["BE-004,FE-010"]);
  });
});
