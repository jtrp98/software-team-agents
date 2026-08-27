import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePlanTasks,
  validatePlanTasks,
  deriveWaves,
  readinessOf,
  checkPlanGraphs,
  planReadinessAdvisory,
  type PlanTaskRow,
} from "./planGraph.js";

function row(over: Partial<PlanTaskRow> & { id: string }): PlanTaskRow {
  return {
    phase: 1,
    designRefs: ["DES-001"],
    dependsOn: [],
    status: "pending",
    owner: "backend-engineer",
    wave: null,
    description: over.id,
    fromCheckbox: false,
    ...over,
  };
}

const TABLE_PLAN = `# Plan

## Plan Summary
Two phases.

## Phase 1: Orders

| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-001 (DES-001) — order CRUD | pending | backend-engineer | — |
| FE-001 (DES-001) — order form | pending | frontend-engineer | BE-001 |

## Phase 2: Billing

| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-002 (DES-002) — billing API | pending | backend-engineer | BE-001 |

## Sequencing Notes
Phase 2 reads Phase 1's models.

## Unresolved Open Questions
—

## Change Log
2026-08-26: created.
`;

describe("parsePlanTasks", () => {
  it("parses ids, DES refs, owners, statuses and dependencies from every phase table", () => {
    const { tasks, problems } = parsePlanTasks(TABLE_PLAN);
    expect(problems).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(["BE-001", "FE-001", "BE-002"]);
    expect(tasks[0].designRefs).toEqual(["DES-001"]);
    expect(tasks[1].dependsOn).toEqual(["BE-001"]);
    expect(tasks[1].owner).toBe("frontend-engineer");
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(tasks[0].phase).toBe(1);
    expect(tasks[2].phase).toBe(2);
  });

  it("still parses a legacy checkbox plan, which then fails loudly instead of silently passing", () => {
    const legacy = "## Phase 1: x\n\n- [ ] BE-001 (DES-001) — old shape\n";
    const { tasks } = parsePlanTasks(legacy);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("BE-001");
    expect(tasks[0].fromCheckbox).toBe(true);
    // No Status/Owner cells ever existed in this shape — the check names the row
    // rather than waving an unmigrated plan through (`sta adopt plan` migrates it).
    const check = validatePlanTasks(tasks);
    expect(check.ok).toBe(false);
    expect(check.errors.join("\n")).toContain("BE-001");
  });

  it("reports a row with no BE-/FE- id instead of dropping it silently", () => {
    const { problems } = parsePlanTasks(
      "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| tidy the CSS | pending | frontend-engineer | — |\n",
    );
    expect(problems.join("\n")).toContain("no BE-/FE- id");
  });

  it("retains explicit Produces/Consumes columns for the existing task graph", () => {
    const { tasks, problems } = parsePlanTasks(
      "## Phase 1: x\n| Task | Status | Owner | Depends on | Produces | Consumes |\n|---|---|---|---|---|---|\n| BE-001 (DES-001) — API | pending | backend-engineer | — | orders/create, orders/read | auth/session |\n",
    );
    expect(problems).toEqual([]);
    expect(tasks[0].produces).toEqual(["orders/create", "orders/read"]);
    expect(tasks[0].consumes).toEqual(["auth/session"]);
  });
});

describe("validatePlanTasks — T-PM10.1", () => {
  it("accepts a valid DAG", () => {
    const check = validatePlanTasks([
      row({ id: "BE-001" }),
      row({ id: "BE-002" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
    ]);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("rejects a duplicate task id, naming both phases", () => {
    const check = validatePlanTasks([row({ id: "BE-001", phase: 1 }), row({ id: "BE-001", phase: 2 })]);
    expect(check.ok).toBe(false);
    expect(check.errors.join("\n")).toContain('duplicate task id "BE-001"');
    expect(check.errors.join("\n")).toContain("phases 1 and 2");
  });

  it("rejects a dependency on a task that does not exist", () => {
    const check = validatePlanTasks([row({ id: "BE-001", dependsOn: ["BE-999"] })]);
    expect(check.errors.join("\n")).toContain("depends on BE-999, which is not a task in this plan");
  });

  it("rejects a cycle with the actual path", () => {
    const check = validatePlanTasks([
      row({ id: "BE-001", dependsOn: ["BE-002"] }),
      row({ id: "BE-002", dependsOn: ["BE-003"] }),
      row({ id: "BE-003", dependsOn: ["BE-001"] }),
    ]);
    expect(check.ok).toBe(false);
    expect(check.errors.join("\n")).toContain("circular dependency");
    expect(check.errors.join("\n")).toContain("BE-001");
  });

  it("rejects a self dependency as its own finding, not just a degenerate cycle", () => {
    const check = validatePlanTasks([row({ id: "BE-001", dependsOn: ["BE-001"] })]);
    expect(check.errors.join("\n")).toContain("depends on itself");
  });

  it("rejects declaring the same dependency twice", () => {
    const check = validatePlanTasks([row({ id: "BE-002", dependsOn: ["BE-001"] }), row({ id: "BE-001" }), { ...row({ id: "FE-001", owner: "frontend-engineer" }), dependsOn: ["BE-001", "BE-001"] }]);
    expect(check.errors.join("\n")).toContain("more than once");
  });

  it("rejects an owner that is not a role in the roster", () => {
    const check = validatePlanTasks([row({ id: "BE-001", owner: "dev-person" })]);
    expect(check.errors.join("\n")).toContain('Owner "dev-person"');
  });

  it("rejects an invalid status value, naming the offending text", () => {
    const { problems } = parsePlanTasks(
      "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 (DES-001) — a | almost done | backend-engineer | — |\n",
    );
    expect(problems.join("\n")).toContain('"almost done"');
  });

  it("rejects an authored wave that does not strictly increase along dependencies", () => {
    const check = validatePlanTasks([
      { ...row({ id: "BE-001" }), wave: 2 },
      { ...row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }), wave: 2 },
    ]);
    expect(check.errors.join("\n")).toContain("must be strictly greater than every dependency's");
  });

  it("rejects a half-authored Wave column — neither legacy nor migrated", () => {
    const check = validatePlanTasks([row({ id: "BE-001" }), { ...row({ id: "FE-001", owner: "frontend-engineer" }), wave: 3 }]);
    expect(check.errors.join("\n")).toContain("author the column for every task or drop it entirely");
  });

  it("rejects a task with no DES traceability", () => {
    const check = validatePlanTasks([{ ...row({ id: "BE-001" }), designRefs: [] }]);
    expect(check.errors.join("\n")).toContain("names no DES-NNN");
  });

  it("rejects a DES ref design.md does not define", () => {
    const check = validatePlanTasks([row({ id: "BE-001", designRefs: ["DES-042"] })], {
      designMd: "## Feature-by-Feature Feasibility\nDES-001 — covers REQ-001: fine.\n",
    });
    expect(check.errors.join("\n")).toContain("cites DES-042, which design.md does not define");
  });

  it("derives waves even when validation fails elsewhere", () => {
    const check = validatePlanTasks([row({ id: "BE-001", owner: "ghost" }), row({ id: "BE-002", dependsOn: ["BE-001"] })]);
    expect(check.ok).toBe(false);
    expect(check.waves.get("BE-001")).toBe(1);
    expect(check.waves.get("BE-002")).toBeGreaterThan(1);
  });
});

describe("deriveWaves — T-PM1.2", () => {
  it("puts independent tasks of one phase in wave 1 together", () => {
    const waves = deriveWaves([row({ id: "BE-001" }), row({ id: "BE-002" }), row({ id: "FE-001", owner: "frontend-engineer" })]);
    expect([...waves.values()]).toEqual([1, 1, 1]);
  });

  it("never places a task before its dependency's wave", () => {
    const waves = deriveWaves([
      row({ id: "BE-001" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
    ]);
    expect(waves.get("FE-001")!).toBeGreaterThan(waves.get("BE-001")!);
  });

  it("keeps later phases behind earlier ones even with no declared dependency", () => {
    const waves = deriveWaves([
      row({ id: "BE-001", phase: 1 }),
      row({ id: "BE-002", phase: 2 }),
    ]);
    expect(waves.get("BE-001")).toBe(1);
    expect(waves.get("BE-002")!).toBeGreaterThan(1);
  });

  it("is deterministic across calls", () => {
    const tasks = [
      row({ id: "BE-001" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
      row({ id: "BE-002", phase: 2 }),
    ];
    expect(deriveWaves(tasks)).toEqual(deriveWaves(tasks));
  });
});

describe("readinessOf — T-PM5.2 / T-PM10.3", () => {
  it("holds a task waiting while its dependency is incomplete", () => {
    const r = readinessOf([
      row({ id: "BE-001" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"], status: "in_progress" }),
      row({ id: "FE-002", owner: "frontend-engineer", dependsOn: ["FE-001"] }),
    ]);
    expect(r.ready.map((t) => t.id)).toEqual(["BE-001"]);
    expect(r.waiting).toEqual([{ task: expect.objectContaining({ id: "FE-002" }), waitingOn: ["FE-001"] }]);
  });

  it("marks a task ready once every dependency is verified", () => {
    const r = readinessOf([
      row({ id: "BE-001", status: "verified" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
    ]);
    expect(r.ready.map((t) => t.id)).toEqual(["FE-001"]);
    expect(r.done.map((t) => t.id)).toEqual(["BE-001"]);
  });

  it("keeps everything downstream of a blocked dependency out of ready, visibly", () => {
    const r = readinessOf([
      row({ id: "BE-001", status: "blocked" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
      row({ id: "BE-002" }),
    ]);
    expect(r.ready.map((t) => t.id)).toEqual(["BE-002"]);
    expect(r.stalledByBlocked.map((t) => t.id)).toEqual(["BE-001", "FE-001"]);
  });

  it("selects several independent ready tasks at once, in document order", () => {
    const r = readinessOf([row({ id: "BE-002" }), row({ id: "BE-001" }), row({ id: "FE-009", owner: "frontend-engineer" })]);
    expect(r.ready.map((t) => t.id)).toEqual(["BE-002", "BE-001", "FE-009"]);
  });

  it("is a pure function — same rows, same answer, no stored state to drift on retry/resume", () => {
    const tasks = [
      row({ id: "BE-001", status: "verified" }),
      row({ id: "BE-002", status: "blocked" }),
      row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }),
      row({ id: "FE-002", owner: "frontend-engineer", dependsOn: ["BE-002"] }),
    ];
    const normalize = (r: ReturnType<typeof readinessOf>) => ({
      ready: r.ready.map((t) => t.id).sort(),
      started: r.started.map((t) => t.id).sort(),
      done: r.done.map((t) => t.id).sort(),
      stalledByBlocked: r.stalledByBlocked.map((t) => t.id).sort(),
      waiting: r.waiting.map((w) => `${w.task.id}<-${w.waitingOn.sort().join(",")}`).sort(),
      waves: [...r.waves.entries()].sort(([a], [b]) => a.localeCompare(b)),
    });
    expect(normalize(readinessOf(tasks))).toEqual(normalize(readinessOf([...tasks].reverse())));
  });
});

describe("checkPlanGraphs", () => {
  function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-graph-"));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  it("passes a well-formed plan and reports its wave count", () => {
    const root = project({ "_docs/module/sales/plan.md": TABLE_PLAN });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("sales/plan.md: 3 task(s), 3 wave(s)");
  });

  it("fails a plan whose dependency points nowhere, naming module, task and target", () => {
    const root = project({
      "_docs/module/sales/plan.md": TABLE_PLAN.replace("| BE-002 (DES-002) — billing API | pending | backend-engineer | BE-001 |", "| BE-002 (DES-002) — billing API | pending | backend-engineer | BE-777 |"),
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/sales\/plan\.md: task BE-002 depends on BE-777/);
  });

  it("cross-checks DES refs against the sibling design.md when one exists", () => {
    const root = project({
      "_docs/module/sales/design.md": "## Feature-by-Feature Feasibility\nDES-001 — covers REQ-001.\n",
      "_docs/module/sales/plan.md": TABLE_PLAN,
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("cites DES-002, which design.md does not define");
  });

  it("scopes to --module <name> and rejects an unknown one", () => {
    const root = project({ "_docs/module/a/plan.md": TABLE_PLAN });
    expect(checkPlanGraphs(root, "a").ok).toBe(true);
    const unknown = checkPlanGraphs(root, "zzz");
    expect(unknown.ok).toBe(false);
    expect(unknown.problems.join("\n")).toContain('module "zzz"');
  });

  it("treats a project before its first module as the normal empty state", () => {
    expect(checkPlanGraphs(project({}))).toEqual({ ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to check."] });
  });
});

describe("planReadinessAdvisory — T-V3TOK-111", () => {
  const withStatus = (id: string, status: string): string =>
    TABLE_PLAN.replace(new RegExp(`\\| ${id} ([^|]*)\\| pending \\|`), `| ${id} $1| ${status} |`);

  it("says nothing about a task the plan considers ready", () => {
    expect(planReadinessAdvisory(TABLE_PLAN, "BE-001")).toBeNull();
  });

  it("names the unfinished dependency and its status", () => {
    const advisory = planReadinessAdvisory(TABLE_PLAN, "FE-001");
    expect(advisory?.waitingOn).toEqual(["BE-001"]);
    expect(advisory?.reason).toContain("BE-001 (pending)");
  });

  it("stops warning once the dependency is verified", () => {
    expect(planReadinessAdvisory(withStatus("BE-001", "verified"), "FE-001")).toBeNull();
  });

  it("reports work sitting behind a blocked dependency", () => {
    const advisory = planReadinessAdvisory(withStatus("BE-001", "blocked"), "FE-001");
    expect(advisory?.reason).toContain("blocked work");
    expect(advisory?.waitingOn).toEqual(["BE-001"]);
  });

  it("reports a row the plan already marks verified or in_progress", () => {
    expect(planReadinessAdvisory(withStatus("BE-001", "verified"), "BE-001")?.reason).toContain("verified");
    expect(planReadinessAdvisory(withStatus("BE-001", "in_progress"), "BE-001")?.reason).toContain("in_progress");
  });

  /** Ad-hoc work is the ordinary case; warning on it would train the operator to ignore the line. */
  it("says nothing about a task id the plan never lists", () => {
    expect(planReadinessAdvisory(TABLE_PLAN, "BE-999")).toBeNull();
  });

  it("says nothing rather than throwing on an unusable plan", () => {
    expect(planReadinessAdvisory("", "BE-001")).toBeNull();
    expect(planReadinessAdvisory("not a plan at all", "BE-001")).toBeNull();
  });
});
