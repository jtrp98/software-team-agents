import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { KnowledgeItemOf } from "../knowledge/knowledgeModel.js";
import { migrateLegacyPlan } from "./legacyPlan.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-plan-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tasks(root: string): Array<KnowledgeItemOf<"task">> {
  return migrateLegacyPlan(root, NOW).items.filter((i): i is KnowledgeItemOf<"task"> => i.kind === "task");
}

const TABLE_PLAN = `# Sales CRM — Implementation Plan

## Plan Summary
Two phases.

## Phase 1: Orders
| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-001 (DES-001) — POST /orders | verified | backend-engineer | — |
| FE-001 (DES-001) — order form | in_progress | frontend-engineer | BE-001 |

## Phase 2: Payments 🔒 Security gate
| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-002 (DES-002) — charge card | pending | backend-engineer | BE-001 |

## Sequencing Notes
Phase 2 handles card data.
`;

const CHECKBOX_PLAN = `# Legacy Plan

## Phase 1: Setup
- [x] BE-001 — create the schema
- [ ] FE-001 — build the page

## Phase 2: Reports
- [ ] BE-002 (DES-004) — nightly rollup
`;

describe("migrateLegacyPlan — T52 table format", () => {
  it("carries every Status cell across as itself", () => {
    const root = project({ "_docs/module/sales-crm/plan.md": TABLE_PLAN });

    const byId = new Map(tasks(root).map((t) => [t.id, t]));

    expect(byId.get("BE-001")?.payload.plan_status).toBe("verified");
    expect(byId.get("FE-001")?.payload.plan_status).toBe("in_progress");
    expect(byId.get("BE-002")?.payload.plan_status).toBe("pending");
  });

  it("reads phase, tag, owner and the design row each task implements", () => {
    const root = project({ "_docs/module/sales-crm/plan.md": TABLE_PLAN });

    const fe = tasks(root).find((t) => t.id === "FE-001")!;

    expect(fe.payload.phase).toBe(1);
    expect(fe.payload.tag).toBe("frontend");
    expect(fe.payload.agent).toBe(AgentStage.FRONTEND_ENGINEER);
    expect(fe.owner).toBe(AgentStage.FRONTEND_ENGINEER);
    expect(fe.title).toBe("order form");
    expect(fe.relations).toEqual([
      { type: "implements", to: "DES-001" },
      { type: "depends-on", to: "BE-001" },
    ]);
  });

  it("carries a phase's security gate onto every task in it, and only that phase", () => {
    const root = project({ "_docs/module/sales-crm/plan.md": TABLE_PLAN });

    const byId = new Map(tasks(root).map((t) => [t.id, t]));

    expect(byId.get("BE-002")?.sensitive).toBe(true);
    expect(byId.get("BE-001")?.sensitive).toBe(false);
  });

  it("files every task under its module, as a draft nobody has approved yet", () => {
    const root = project({ "_docs/module/sales-crm/plan.md": TABLE_PLAN });

    for (const task of tasks(root)) {
      expect(task.module).toBe("sales-crm");
      expect(task.status).toBe("draft");
      expect(task.version).toBe(1);
    }
  });

  it("leaves produces/consumes and the orchestrator id empty rather than inventing them", () => {
    const root = project({ "_docs/module/sales-crm/plan.md": TABLE_PLAN });

    const be = tasks(root).find((t) => t.id === "BE-001")!;

    expect(be.payload.produces).toEqual([]);
    expect(be.payload.consumes).toEqual([]);
    expect(be.payload.contract_version).toBeNull();
    expect(be.payload.orchestrator_task_id).toBeNull();
  });

  it("imports an unrecognised Status as pending and says so, rather than dropping the task", () => {
    const root = project({
      "_docs/module/m/plan.md": `## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a | almost done | backend-engineer | — |\n`,
    });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toHaveLength(1);
    expect((result.items[0] as KnowledgeItemOf<"task">).payload.plan_status).toBe("pending");
    expect(result.notes.some((n) => n.includes('Status "almost done"'))).toBe(true);
  });
});

describe("migrateLegacyPlan — legacy checkbox format", () => {
  it("reads checkbox phases when a phase has no table", () => {
    const root = project({ "_docs/module/legacy/plan.md": CHECKBOX_PLAN });

    const byId = new Map(tasks(root).map((t) => [t.id, t]));

    expect([...byId.keys()].sort()).toEqual(["BE-001", "BE-002", "FE-001"]);
    expect(byId.get("BE-001")?.payload.plan_status).toBe("verified");
    expect(byId.get("FE-001")?.payload.plan_status).toBe("pending");
    expect(byId.get("BE-002")?.payload.phase).toBe(2);
  });

  it("keeps the raw checkbox line and says the status came from a tick, not from qa-engineer", () => {
    const root = project({ "_docs/module/legacy/plan.md": CHECKBOX_PLAN });

    const be = tasks(root).find((t) => t.id === "BE-001")!;

    expect(be.body).toBe("- [x] BE-001 — create the schema");
    expect(be.sources[0].note).toContain("checkbox");
    expect(be.sources[0].note).toContain("not a T52 Status cell");
  });

  it("reads both formats in one project, table phases and checkbox phases alike", () => {
    const root = project({
      "_docs/module/sales-crm/plan.md": TABLE_PLAN,
      "_docs/module/legacy/plan.md": CHECKBOX_PLAN,
    });

    const all = tasks(root);

    expect(all.filter((t) => t.module === "sales-crm")).toHaveLength(3);
    expect(all.filter((t) => t.module === "legacy")).toHaveLength(3);
  });
});

describe("migrateLegacyPlan — what it declines to do", () => {
  it("skips a row with no BE-/FE- id and says why, because an id is the identity", () => {
    const root = project({
      "_docs/module/m/plan.md": `## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| tidy the CSS | pending | frontend-engineer | — |\n`,
    });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toHaveLength(0);
    expect(result.notes.some((n) => n.includes("no BE-/FE- id"))).toBe(true);
  });

  it("imports a duplicated task id once and reports the duplicate", () => {
    const root = project({
      "_docs/module/m/plan.md": `## Phase 1: x\n- [ ] BE-001 — first\n\n## Phase 2: y\n- [ ] BE-001 — again\n`,
    });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toHaveLength(1);
    expect(result.notes.some((n) => n.includes("BE-001") && n.includes("more than once"))).toBe(true);
  });

  it("says a plan with no phase heading produced nothing, rather than returning silence", () => {
    const root = project({ "_docs/module/m/plan.md": "# Plan\n\nSome prose, no phases.\n" });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toHaveLength(0);
    expect(result.notes.some((n) => n.includes("no `## Phase N` heading"))).toBe(true);
  });

  it("returns a note, not an error, for a project with no module docs at all", () => {
    const root = project({ "README.md": "# nothing here" });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toEqual([]);
    expect(result.notes).toEqual(["no `module/` under _docs — no legacy plan.md to migrate"]);
  });

  it("owns a task with no side to project-manager rather than guessing an engineer", () => {
    const root = project({
      "_docs/module/m/plan.md": `## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a thing | pending | — | — |\n`,
    });

    // BE- says backend, so this checks the fallback through an id the tag rules cannot read.
    const withoutSide = project({
      "_docs/module/m/plan.md": `## Phase 1: x\n- [ ] BE-XY — a thing\n`,
    });

    expect(tasks(root)[0].owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(tasks(withoutSide)[0].payload.tag).toBe("backend");
  });

  it("finds module docs under a nested docsRoot (T113 pilot finding: not every project's _docs/ sits at the repo root)", () => {
    const root = project({
      "_docs/hkt/module/crm/plan.md": `## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a thing | pending | — | — |\n`,
    });

    const result = migrateLegacyPlan(root, NOW, path.join(root, "_docs", "hkt"));

    expect(result.items).toHaveLength(1);
    // The locator stays relative to projectRoot (not docsRoot), so git history
    // (T63) and the digest still resolve against a real repo-relative path.
    expect(result.items[0].sources[0].locator).toMatch(/^_docs\/hkt\/module\/crm\/plan\.md/);
  });

  it("does not find the same docs at the default docsRoot once one is given explicitly", () => {
    const root = project({
      "_docs/hkt/module/crm/plan.md": `## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 — a thing | pending | — | — |\n`,
    });

    expect(migrateLegacyPlan(root, NOW).items).toHaveLength(0);
  });
});

describe("migrateLegacyPlan — a [tag] checkbox with no BE-/FE- id (T113 pilot finding)", () => {
  it("synthesizes a BE-/FE- shaped id from the tag instead of dropping the task", () => {
    const root = project({
      "_docs/module/crm/plan.md": [
        "## Phase 1: x",
        "- [ ] [backend] เพิ่ม 3 คอลัมน์ใหม่",
        "- [x] [frontend] scaffold the review page",
      ].join("\n"),
    });

    const result = migrateLegacyPlan(root, NOW);
    const items = result.items.filter((i): i is KnowledgeItemOf<"task"> => i.kind === "task");

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("BE-crm-P1-01");
    expect(items[0].owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(items[0].payload.tag).toBe("backend");
    expect(items[0].payload.plan_status).toBe("pending");
    expect(items[0].title).toBe("เพิ่ม 3 คอลัมน์ใหม่");
    expect(items[1].id).toBe("FE-crm-P1-01");
    expect(items[1].payload.plan_status).toBe("verified");
    expect(result.notes.some((n) => n.includes("synthesized BE-crm-P1-01"))).toBe(true);
  });

  it("numbers sequentially per tag within a phase, and resets in the next phase", () => {
    const root = project({
      "_docs/module/crm/plan.md": [
        "## Phase 1: x",
        "- [ ] [backend] first",
        "- [ ] [backend] second",
        "## Phase 2: y",
        "- [ ] [backend] third",
      ].join("\n"),
    });

    const items = migrateLegacyPlan(root, NOW).items.filter((i): i is KnowledgeItemOf<"task"> => i.kind === "task");

    expect(items.map((i) => i.id)).toEqual(["BE-crm-P1-01", "BE-crm-P1-02", "BE-crm-P2-01"]);
  });

  it("marks the source note as synthesized, distinctly from a real legacy id", () => {
    const root = project({
      "_docs/module/crm/plan.md": "## Phase 1: x\n- [ ] [backend] untagged item\n- [ ] BE-001 — a real id\n",
    });

    const items = migrateLegacyPlan(root, NOW).items.filter((i): i is KnowledgeItemOf<"task"> => i.kind === "task");
    const synthesized = items.find((i) => i.id === "BE-crm-P1-01")!;
    const real = items.find((i) => i.id === "BE-001")!;

    expect(synthesized.sources[0].note).toContain("id synthesized from a [tag] prefix");
    expect(real.sources[0].note).not.toContain("synthesized");
  });

  it("still skips a checkbox with neither an id nor a [tag] prefix", () => {
    const root = project({ "_docs/module/crm/plan.md": "## Phase 1: x\n- [ ] no id, no tag, just prose\n" });

    const result = migrateLegacyPlan(root, NOW);

    expect(result.items).toEqual([]);
    expect(result.notes.some((n) => n.includes("has no BE-/FE- id — skipped"))).toBe(true);
  });

  it("applies the same fallback to a table row's Task cell, not just checkboxes", () => {
    const root = project({
      "_docs/module/crm/plan.md":
        "## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| [backend] no explicit id | pending | — | — |\n",
    });

    const items = migrateLegacyPlan(root, NOW).items.filter((i): i is KnowledgeItemOf<"task"> => i.kind === "task");

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("BE-crm-P1-01");
    expect(items[0].title).toBe("no explicit id");
  });
});
