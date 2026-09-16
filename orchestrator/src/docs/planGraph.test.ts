import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveWaves,
  readinessOf,
  checkPlanGraphs,
} from "./planGraph.js";
import { renderCanonicalTasks, type PlanTask } from "./planTask.js";

function row(over: Partial<PlanTask> & { id: string }): PlanTask {
  return {
    version: 1, phase: 1, title: over.id,
    objective: `Implement ${over.id} against the current contract.`,
    why: `The current plan requires ${over.id} to complete its phase.`,
    owner: "backend-engineer", dependsOn: [], traceability: ["REQ-001", "AC-001.1", "DES-001"], produces: [], consumes: [], risk: ["low"], humanGate: [], status: "pending",
    scopeAndConstraints: "Keep the change within the selected task and current module.",
    retrievalHints: "Hypothesis: current source owns the behavior.\nQuery: find the selected contract.\nProvenance: DES-001",
    doNotModify: "Unrelated modules and contracts.", acceptanceCriteria: "AC-001.1: the selected behavior remains deterministic.",
    validationAndEvidence: "Verify AC-001.1 with the focused suite and record its exit code.", compatibility: "Current callers remain unchanged and the patch reverts independently.", ...over,
  };
}

const REQ_MD_CURRENT = "REQ-001\nAC-001.1\n";
const REVISION = "a".repeat(40);
const HASH = "b".repeat(64);
const DESIGN_MD_CURRENT = ["Design evidence format: 1", "", "## DES-001 — Current behavior", "Contract:OrderSummary.v1 — current response contract.", "DEC-001 — retain the current boundary.", `Evidence EVD-001: claim=DES-001 | state=confirmed | path=src/current.ts | symbol=current | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, `Evidence EVD-002: claim=Contract:OrderSummary.v1 | state=confirmed | path=src/current.ts | symbol=current | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, `Evidence EVD-003: claim=DEC-001 | state=confirmed | path=src/current.ts | symbol=current | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, "Compatibility: unchanged", "Data/schema: unchanged", "Migration/backfill: none", "Security: none", "Fallback: restore the current implementation.", "Material ambiguity: none", "", "## DES-002 — Billing behavior", "Contract:Billing.v1 — current billing contract.", "DEC-002 — retain the billing boundary.", `Evidence EVD-004: claim=DES-002 | state=confirmed | path=src/billing.ts | symbol=billing | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, `Evidence EVD-005: claim=Contract:Billing.v1 | state=confirmed | path=src/billing.ts | symbol=billing | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, `Evidence EVD-006: claim=DEC-002 | state=confirmed | path=src/billing.ts | symbol=billing | line=1 | revision=${REVISION} | basis=source | tool=rg | hash=${HASH}`, "Compatibility: unchanged", "Data/schema: unchanged", "Migration/backfill: none", "Security: none", "Fallback: restore the current billing implementation.", "Material ambiguity: none", ""].join("\n");
const CURRENT_PLAN = renderCanonicalTasks([row({ id: "BE-001" }), row({ id: "FE-001", owner: "frontend-engineer", dependsOn: ["BE-001"] }), row({ id: "BE-002", phase: 2, dependsOn: ["BE-001"], traceability: ["REQ-001", "AC-001.1", "DES-002"], retrievalHints: "Hypothesis: current source owns the behavior.\nQuery: find the selected contract.\nProvenance: DES-002" })]);
const TIERED_PLAN = renderCanonicalTasks([row({ id: "BE-001", tier: "T4" })]);

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
    const root = project({ "_docs/module/sales/requirement.md": REQ_MD_CURRENT, "_docs/module/sales/design.md": DESIGN_MD_CURRENT, "_docs/module/sales/plan.md": CURRENT_PLAN });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("sales/plan.md: 3 canonical task(s), format 1; 3 wave(s)");
  });

  it("fails a plan whose dependency points nowhere, naming module, task and target", () => {
    const root = project({
      "_docs/module/sales/requirement.md": REQ_MD_CURRENT,
      "_docs/module/sales/design.md": DESIGN_MD_CURRENT,
      "_docs/module/sales/plan.md": CURRENT_PLAN.replace("Depends on: BE-001", "Depends on: BE-777"),
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/sales\/plan\.md: task FE-001: self\/unknown dependency BE-777/);
  });

  it("cross-checks DES refs against the sibling design.md when one exists", () => {
    const root = project({
      "_docs/module/sales/requirement.md": REQ_MD_CURRENT,
      "_docs/module/sales/design.md": DESIGN_MD_CURRENT.replace(/\n## DES-002[\s\S]*/, "\n"),
      "_docs/module/sales/plan.md": CURRENT_PLAN,
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("task BE-002: unknown trace reference DES-002");
  });

  it("scopes to --module <name> and rejects an unknown one", () => {
    const root = project({ "_docs/module/a/requirement.md": REQ_MD_CURRENT, "_docs/module/a/design.md": DESIGN_MD_CURRENT, "_docs/module/a/plan.md": CURRENT_PLAN });
    expect(checkPlanGraphs(root, "a").ok).toBe(true);
    const unknown = checkPlanGraphs(root, "zzz");
    expect(unknown.ok).toBe(false);
    expect(unknown.problems.join("\n")).toContain('module "zzz"');
  });

  it("treats a project before its first module as the normal empty state", () => {
    expect(checkPlanGraphs(project({}))).toEqual({ ok: true, problems: [], notes: ["no `_docs/module/` yet — nothing to check."] });
  });

  const MODEL_TIERS_YAML = `tiers:
  T1:
    reserved: true
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
  T2:
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
  T3:
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
  T4:
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
  T5:
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
  T6:
    camps:
      anthropic: { model: a, effort: a, notes: a }
      openai: { model: a, effort: a, notes: a }
      google: { model: a, effort: a, notes: a }
      zai: { model: a, effort: a, notes: a }
`;

  it("T-V6-005 — a Knowledge workspace missing model-tiers.yaml reports the packaging-fault wording, not the generic one", () => {
    const root = project({
      "targets.yaml": "schema_version: 1\ntargets: []\n",
      "_docs/module/sales/requirement.md": REQ_MD_CURRENT,
      "_docs/module/sales/design.md": DESIGN_MD_CURRENT,
      "_docs/module/sales/plan.md": TIERED_PLAN,
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("missing from this Knowledge workspace's synced payload");
    expect(result.problems.join("\n")).toContain("software-team-agents ba");
  });

  it("T-V6-005 — [ACCEPTANCE] a plan casting a Tier passes once model-tiers.yaml is synced into the Knowledge workspace", () => {
    const root = project({
      "targets.yaml": "schema_version: 1\ntargets: []\n",
      "_docs/module/sales/requirement.md": REQ_MD_CURRENT,
      "_docs/module/sales/design.md": DESIGN_MD_CURRENT,
      "_docs/module/sales/plan.md": TIERED_PLAN,
      "model-tiers.yaml": MODEL_TIERS_YAML,
    });
    const result = checkPlanGraphs(root);
    expect(result.ok).toBe(true);
  });

  // --- T-V9-009: --check-plan validates a task's Targets: --------------------

  const TARGETS_YAML = `schema_version: 1
targets:
  - target_id: sales-api
    name: Sales API
    remote_url: https://example.com/sales-api.git
    status: active
    type: backend
  - target_id: sales-web
    name: Sales Web
    remote_url: https://example.com/sales-web.git
    status: active
    type: frontend
  - target_id: sales-all
    name: Sales Fullstack
    remote_url: https://example.com/sales-all.git
    status: active
    type: fullstack
  - target_id: sales-worker
    name: Retired worker
    remote_url: https://example.com/sales-worker.git
    status: retired
`;

  const REQ_MD = "REQ-001\nAC-001.1\n";
  const DESIGN_MD = `${DESIGN_MD_CURRENT}\n## Targets\n- sales-api\n- sales-web\n`;

  const CANONICAL_TASK: PlanTask = {
    version: 1,
    id: "BE-101",
    phase: 1,
    title: "Order summary contract",
    objective: "Serve the order summary event through the API contract.",
    why: "The web client renders the summary on its order screen.",
    owner: "backend-engineer",
    dependsOn: [],
    traceability: ["REQ-001", "AC-001.1", "DES-001"],
    produces: ["Contract:OrderSummary.v1"],
    consumes: [],
    risk: ["low"],
    humanGate: [],
    status: "pending",
    scopeAndConstraints: "Keep the response contract stable while the change lands across repositories.",
    retrievalHints: "Hypothesis: The order summary serializer is the boundary; confirm against current source.\nQuery: Locate definitions and references for Contract:OrderSummary.v1.\nProvenance: DES-001, Contract:OrderSummary.v1",
    doNotModify: "Authentication, database schema and unrelated response fields.",
    acceptanceCriteria: "AC-001.1: An empty order returns the documented zero total without an exception.",
    validationAndEvidence: "Verify AC-001.1 with the empty-order regression; record commands, exit codes and response assertions.",
    compatibility: "Existing nonempty orders serialize unchanged and the patch reverts independently.",
  };

  const canonicalPlanFile = (targets?: string[]): string =>
    renderCanonicalTasks([targets === undefined ? CANONICAL_TASK : { ...CANONICAL_TASK, targets }]);

  const targetProject = (planMd: string, extra: Record<string, string> = {}): string =>
    project({
      "targets.yaml": TARGETS_YAML,
      "_docs/module/sales/requirement.md": REQ_MD,
      "_docs/module/sales/design.md": DESIGN_MD,
      "_docs/module/sales/plan.md": planMd,
      ...extra,
    });

  it("T-V9-009 — fails a task naming an unknown Target, naming task id, Target id and the fix", () => {
    const result = checkPlanGraphs(targetProject(canonicalPlanFile(["sales-ghost"])));
    expect(result.ok).toBe(false);
    const problem = result.problems.join("\n");
    expect(problem).toContain('task BE-101: Target "sales-ghost" is not present');
    expect(problem).toContain("targets.yaml");
    expect(problem).toContain('add "sales-ghost" to targets.yaml or remove it');
  });

  it("T-V9-009 — fails a task naming a retired Target", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-worker"]), {
        "_docs/module/sales/design.md": `${DESIGN_MD}- sales-worker\n`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain('task BE-101: Target "sales-worker" is retired');
    expect(result.problems.join("\n")).toContain("reactivate it in targets.yaml");
  });

  it("T-V9-009 — fails a task naming a Target outside the module's declared ## Targets set", () => {
    const result = checkPlanGraphs(targetProject(canonicalPlanFile(["sales-all"])));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(
      'task BE-101: Target "sales-all" is outside module "sales" declared ## Targets (sales-api, sales-web)',
    );
  });

  it("T-V9-009 — fails frontend-engineer against a type: backend Target", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-api"]).replace("Owner: backend-engineer", "Owner: frontend-engineer")),
    );
    expect(result.ok).toBe(false);
    const problem = result.problems.join("\n");
    expect(problem).toContain('Owner "frontend-engineer" is not admitted by Target "sales-api" type "backend"');
    expect(problem).toContain("backend-engineer");
  });

  it("T-V9-009 — passes frontend-engineer and backend-engineer against a declared type: fullstack Target", () => {
    const design = `${DESIGN_MD}- sales-all\n`;
    const frontend = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-all"]).replace("Owner: backend-engineer", "Owner: frontend-engineer"), {
        "_docs/module/sales/design.md": design,
      }),
    );
    expect(frontend.ok).toBe(true);
    const backend = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-all"]), { "_docs/module/sales/design.md": design }),
    );
    expect(backend.ok).toBe(true);
  });

  it("T-V9-009 — a task with no Targets: is unaffected, even where targets.yaml is unreachable", () => {
    const canonical = checkPlanGraphs(
      project({
        "_docs/module/sales/requirement.md": REQ_MD,
        "_docs/module/sales/design.md": DESIGN_MD,
        "_docs/module/sales/plan.md": canonicalPlanFile(undefined),
      }),
    );
    expect(canonical.ok).toBe(true);
    expect(canonical.notes.join("\n")).not.toContain("Target checks");
  });

  it("T-V9-009 — an unreachable targets.yaml skips the Target checks with a note, and the rest of the check is unchanged", () => {
    const result = checkPlanGraphs(
      project({
        "_docs/module/sales/requirement.md": REQ_MD,
        "_docs/module/sales/design.md": DESIGN_MD,
        "_docs/module/sales/plan.md": canonicalPlanFile(["sales-api", "sales-web"]),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join("\n")).toContain("targets.yaml is not reachable");
    expect(result.notes.join("\n")).toContain("Target checks on 1 task(s) declaring Targets: are skipped");
    expect(result.notes.join("\n")).toContain("sales/plan.md: 1 canonical task(s), format 1");
  });

  it("T-V9-009 — a present-but-invalid targets.yaml fails the check instead of skipping", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-api"]), {
        "targets.yaml": "schema_version: 1\ntargets:\n  - target_id: Sales-Api\n    name: Bad id case\n    remote_url: not-a-remote\n    status: retired-unknown\n",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("Target registry is invalid");
  });

  it("T-V9-009 — an untyped Target passes plan validation (schema v1 compatibility), like binding validation", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-api"]), {
        "targets.yaml": "schema_version: 1\ntargets:\n  - target_id: sales-api\n    name: Sales API\n    remote_url: https://example.com/sales-api.git\n    status: active\n",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("V10 TASK-011 — a module declaring no Targets fails the check when its tasks bind one, before any run starts", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(["sales-api"]), {
        "_docs/module/sales/design.md": DESIGN_MD.replace("## Targets\n- sales-api\n- sales-web\n", ""),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain('module "sales" declares no Targets');
    expect(result.problems.join("\n")).toContain("1 task(s) declare Targets:");
    expect(result.problems.join("\n")).toContain("## Targets");
  });

  it("V10 TASK-011 — a module declaring no Targets whose tasks bind none is untouched", () => {
    const result = checkPlanGraphs(
      targetProject(canonicalPlanFile(), {
        "_docs/module/sales/design.md": DESIGN_MD.replace("## Targets\n- sales-api\n- sales-web\n", ""),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.problems.join("\n")).not.toContain("declares no Targets");
  });
});
