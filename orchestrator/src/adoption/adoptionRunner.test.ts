import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadKnowledge } from "../knowledge/knowledgeStore.js";
import { checkKnowledge } from "../knowledge/knowledgeBase.js";
import { ALL_ADOPTION_STAGES, type AdoptionStageId } from "./adoptionModel.js";
import {
  AdoptionBlockedError,
  AdoptionNotApprovedError,
  AdoptionNotSettledError,
  acknowledgePreflight,
  approveAdoptionStage,
  initAdoption,
  planAdoption,
  recordAdoptionValidation,
  runAdoptionStage,
} from "./adoptionRunner.js";
import { readAdoptionManifest, readAdoptionState, stagedContractPath } from "./adoptionStore.js";
import { validateAdoption } from "./adoptionValidation.js";
import { rollbackAdoption } from "./rollback.js";

const NOW = "2026-08-20T09:00:00Z";
const roots: string[] = [];

/** A project that has really used the old pipeline: agents, rules, module docs. */
const LEGACY_PROJECT: Record<string, string> = {
  "CLAUDE.md": "# Old Project — Agent Pipeline\n\nThe rules.\n\n## Rules\n- No git, ever.\n",
  "README.md": "# Old Project\n\nIt sells things.\n\n## Install\nnpm i\n",
  ".claude/agents/qa-engineer.md":
    "---\nname: qa-engineer\ndescription: Legacy QA agent.\ntools: Read, Glob, Grep, Bash, AskUserQuestion, Write, Edit\nmodel: sonnet\n---\n\nYou are QA.\n",
  ".claude/agents/code-reviewer.md":
    "---\nname: code-reviewer\ndescription: Reviews diffs.\ntools: Read, Grep\n---\n\nYou review.\n",
  "_docs/module/sales/requirement.md":
    "# Sales — Requirements\n\n## Core Features\n- **REQ-001** — Staff can create an order.\n- **REQ-002** — Staff can see totals.\n\n## Change Log\n2026-01-01: written.\n",
  "_docs/module/sales/design.md":
    "# Sales — Feasibility & Design\n\n**Contract Version:** 2\n\n## Feature-by-Feature Feasibility\n- DES-001 — covers REQ-001: straightforward.\n- DES-002 — covers REQ-002: straightforward.\n\n## Data Model\nmodel Order {\n  id String @id\n  total Int\n}\n\n## Risks & Dependencies\n- None known.\n",
  "_docs/module/sales/plan.md":
    "# Sales — Plan\n\n## Phase 1: Orders\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 (DES-001) — POST /orders | verified | backend-engineer | — |\n| FE-001 (DES-001) — order form | pending | frontend-engineer | BE-001 |\n\n## Phase 2: Totals\n- [ ] BE-002 (DES-002) — nightly totals\n",
};

function project(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-"));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...LEGACY_PROJECT, ...extra })) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* left for the OS */
    }
  }
});

/** Everything up to but not including validation. */
function importEverything(root: string, approver: string | null = "Jaturapat"): void {
  initAdoption(root, NOW);
  acknowledgePreflight("Jaturapat", root, NOW);
  for (const id of ALL_ADOPTION_STAGES) {
    runAdoptionStage(id, root, NOW);
    if (approver) approveAdoptionStage(id, approver, root, NOW);
  }
}

function ids(root: string): string[] {
  return loadKnowledge(root)
    .items.map((i) => i.id)
    .sort();
}

describe("T87 — the dry run", () => {
  it("says what every stage would write, before adoption has even started", () => {
    const root = project();

    const plan = planAdoption(root, NOW);

    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
    expect(plan.stages.map((s) => s.id)).toEqual([...ALL_ADOPTION_STAGES]);
    expect(plan.totals.create).toBeGreaterThan(0);
    expect(plan.totals.update + plan.totals.unchanged + plan.totals.conflict).toBe(0);
  });

  it("names the staged contract for a mapped agent and the unmapped file for the other", () => {
    const root = project();

    const agents = planAdoption(root, NOW).stages.find((s) => s.id === "legacy-agents")!;

    expect(agents.writes.map((w) => w.path)).toEqual([
      "knowledge/_adoption/contracts/qa-engineer.yaml",
      "knowledge/_adoption/contracts/UNMAPPED.yaml",
    ]);
    expect(agents.notes.some((n) => n.includes("code-reviewer") && n.includes("no role of this name"))).toBe(true);
  });

  it("carries T86's findings, so a dry run also answers whether the project is in a state to be adopted", () => {
    const root = project({
      "_docs/module/sales/review.md": "## Open Issues\n| Issue | Routes to |\n|---|---|\n| totals wrong | backend-engineer |\n",
    });

    expect(planAdoption(root, NOW).preflight.blockers).toEqual([expect.stringContaining("1 open QA issue(s)")]);
  });

  it("predicts exactly what the apply then does, action for action", () => {
    const root = project();
    const planned = planAdoption(root, NOW);
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);

    for (const id of ALL_ADOPTION_STAGES) runAdoptionStage(id, root, NOW);

    // Every path the plan said it would create exists, and nothing else was written.
    const promised = planned.stages.flatMap((s) => s.writes.filter((w) => w.action === "create").map((w) => w.path));
    for (const rel of promised) {
      expect(fs.existsSync(path.join(root, ...rel.split("/")))).toBe(true);
    }
    const manifest = readAdoptionManifest(root).manifest!;
    expect(new Set(manifest.entries.map((e) => e.path))).toEqual(new Set(promised));
  });

  it("reports a second run as unchanged rather than as work to do", () => {
    const root = project();
    importEverything(root);

    const plan = planAdoption(root, NOW);

    expect(plan.totals.create).toBe(0);
    expect(plan.totals.unchanged).toBeGreaterThan(0);
  });
});

describe("T86 — the gate before anything is written", () => {
  it("starts blocked, and refuses to run a stage until a person acknowledges what is in flight", () => {
    const root = project({
      "_docs/module/sales/review.md": "## Open Issues\n| Issue | Routes to |\n|---|---|\n| totals wrong | backend-engineer |\n",
    });

    const state = initAdoption(root, NOW);

    expect(state.status).toBe("blocked");
    expect(state.preflight?.blockers).toHaveLength(1);
    expect(() => runAdoptionStage("legacy-docs", root, NOW)).toThrow(AdoptionBlockedError);
    expect(fs.existsSync(path.join(root, "knowledge", "sales"))).toBe(false);
  });

  it("still records the check when a clean project has nothing in flight, and moves straight to importing", () => {
    const root = project();

    const state = initAdoption(root, NOW);

    expect(state.status).toBe("importing");
    expect(state.preflight?.blockers).toEqual([]);
    expect(state.preflight?.notes.length).toBeGreaterThan(0);
  });

  it("does not re-run detection on a second init, which would discard an acknowledgement", () => {
    const root = project({
      "_docs/module/sales/review.md": "## Open Issues\n| Issue | Routes to |\n|---|---|\n| totals wrong | backend-engineer |\n",
    });
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);

    const again = initAdoption(root, NOW);

    expect(again.preflight?.acknowledged_by).toBe("Jaturapat");
    expect(again.status).toBe("importing");
  });
});

describe("T81 — the flow, end to end", () => {
  it("imports every legacy document into knowledge/ and leaves the originals untouched", () => {
    const root = project();
    const before = Object.keys(LEGACY_PROJECT).map((rel) => [rel, fs.readFileSync(path.join(root, ...rel.split("/")), "utf8")]);

    importEverything(root);

    expect(ids(root)).toEqual([
      "BE-001",
      "BE-002",
      "DB-Order",
      "DES-001",
      "DES-002",
      "DES-DOC-README",
      "DES-RULES-CLAUDE",
      "FE-001",
      "REQ-001",
      "REQ-002",
    ]);
    // Nothing legacy moved, changed or disappeared.
    for (const [rel, content] of before) {
      expect(fs.readFileSync(path.join(root, ...rel.split("/")), "utf8")).toBe(content);
    }
  });

  it("keeps the traceability chain intact across the three document stages", () => {
    const root = project();
    importEverything(root);

    const items = new Map(loadKnowledge(root).items.map((i) => [i.id, i]));

    expect(items.get("DES-001")?.relations).toEqual([{ type: "refines", to: "REQ-001" }]);
    expect(items.get("BE-001")?.relations).toEqual([{ type: "implements", to: "DES-001" }]);
    expect(items.get("FE-001")?.relations).toEqual([
      { type: "implements", to: "DES-001" },
      { type: "depends-on", to: "BE-001" },
    ]);
    // Every relation target exists, so --check-knowledge has nothing to report.
    expect(checkKnowledge(root).problems).toEqual([]);
  });

  it("asks for an approval per stage and refuses to validate without them", () => {
    const root = project();
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);
    for (const id of ALL_ADOPTION_STAGES) runAdoptionStage(id, root, NOW);

    expect(readAdoptionState(root).state?.status).toBe("pending_approval");
    expect(() => recordAdoptionValidation("Jaturapat", root, NOW)).toThrow(AdoptionNotApprovedError);

    for (const id of ALL_ADOPTION_STAGES) approveAdoptionStage(id, "Jaturapat", root, NOW);

    expect(readAdoptionState(root).state?.status).toBe("pending_validation");
    expect(recordAdoptionValidation("Jaturapat", root, NOW).status).toBe("adopted");
  });

  it("refuses to validate while a stage has not run, and writes nothing when it refuses", () => {
    const root = project();
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);
    runAdoptionStage("legacy-docs", root, NOW);
    approveAdoptionStage("legacy-docs", "Jaturapat", root, NOW);

    expect(() => recordAdoptionValidation("Jaturapat", root, NOW)).toThrow(AdoptionNotSettledError);
    expect(readAdoptionState(root).state?.validated_by).toBeNull();
  });

  it("refuses to approve a stage that has not run", () => {
    const root = project();
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);

    expect(() => approveAdoptionStage("legacy-plan", "Jaturapat", root, NOW)).toThrow(AdoptionNotSettledError);
  });

  it("stages the converted contract with its differences in the file, and never writes to contracts/", () => {
    const root = project();
    importEverything(root);

    const staged = fs.readFileSync(stagedContractPath("qa-engineer", root), "utf8");

    expect(staged).toContain("STAGED, NOT INSTALLED");
    expect(staged).toContain("name: qa-engineer");
    expect(staged).toContain("description: Legacy QA agent.");
    expect(fs.existsSync(path.join(root, "contracts"))).toBe(false);
  });

  it("records the unmapped agent rather than dropping it", () => {
    const root = project();
    importEverything(root);

    const unmapped = fs.readFileSync(path.join(root, "knowledge", "_adoption", "contracts", "UNMAPPED.yaml"), "utf8");

    expect(unmapped).toContain("code-reviewer");
    expect(unmapped).toContain(".claude/agents/code-reviewer.md");
  });

  it("re-running a stage over a reviewed item leaves it alone and records the disagreement", () => {
    const root = project();
    importEverything(root);
    recordAdoptionValidation("Jaturapat", root, NOW);
    // A person edits the legacy requirement after approving the import of it.
    fs.writeFileSync(
      path.join(root, "_docs", "module", "sales", "requirement.md"),
      "# Sales — Requirements\n\n## Core Features\n- **REQ-001** — Staff can create an order, and cancel it.\n",
      "utf8",
    );

    runAdoptionStage("legacy-docs", root, NOW);

    const state = readAdoptionState(root).state!;
    const stage = state.stages.find((s) => s.id === "legacy-docs")!;
    expect(stage.conflict_ids).toEqual(["REQ-001"]);
    expect(loadKnowledge(root).items.find((i) => i.id === "REQ-001")?.title).toBe("Staff can create an order.");
    expect(checkKnowledge(root).ok).toBe(false);
  });

  it("clears a stage's approval and the validation when a re-run lands something new", () => {
    const root = project();
    importEverything(root);
    recordAdoptionValidation("Jaturapat", root, NOW);
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "runbook.md"), "# Runbook\n\nWhen it breaks, do this.\n", "utf8");

    runAdoptionStage("legacy-docs", root, NOW);

    const state = readAdoptionState(root).state!;
    expect(state.validated_by).toBeNull();
    expect(state.stages.find((s) => s.id === "legacy-docs")?.approved_by).toBeNull();
    expect(state.status).toBe("pending_approval");
  });
});

describe("T88 — validation", () => {
  it("accounts for every item the legacy material implies", () => {
    const root = project();
    importEverything(root);

    const report = validateAdoption(root, NOW);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    for (const stage of report.stages) {
      expect(stage.missingItems).toEqual([]);
      expect(stage.onDiskCount).toBe(stage.derivedCount);
    }
  });

  it("catches an imported item that has since been deleted from knowledge/", () => {
    const root = project();
    importEverything(root);
    fs.rmSync(path.join(root, "knowledge", "sales", "task", "BE-001.yaml"));

    const report = validateAdoption(root, NOW);

    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([expect.stringContaining("BE-001 is implied by the legacy material but is not in knowledge/")]);
  });

  it("catches a staged contract that never got written", () => {
    const root = project();
    importEverything(root);
    fs.rmSync(stagedContractPath("qa-engineer", root));

    expect(validateAdoption(root, NOW).problems).toEqual([
      expect.stringContaining("legacy agent qa-engineer was converted but no staged contract was written"),
    ]);
  });

  it("reports a stage that has not run as waiting, not as a failure", () => {
    const root = project();
    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);
    runAdoptionStage("legacy-docs", root, NOW);

    const report = validateAdoption(root, NOW);

    expect(report.problems).toEqual([]);
    expect(report.notes.some((n) => n.includes("legacy-plan: has not run yet"))).toBe(true);
  });

  it("does not count a deliberately untouched reviewed item as dropped", () => {
    const root = project();
    importEverything(root);
    fs.writeFileSync(
      path.join(root, "_docs", "module", "sales", "requirement.md"),
      "# Sales — Requirements\n\n## Core Features\n- **REQ-001** — Staff can create an order, and cancel it.\n",
      "utf8",
    );
    runAdoptionStage("legacy-docs", root, NOW);

    const report = validateAdoption(root, NOW);

    expect(report.problems).toEqual([]);
    expect(report.notes.some((n) => n.includes("REQ-001 was left as a person had it"))).toBe(true);
  });

  it("says there is nothing to validate before adoption has started", () => {
    const root = project();

    expect(validateAdoption(root, NOW).problems).toEqual(["adoption has not started — there is nothing to validate"]);
  });
});

describe("T89 — rollback", () => {
  it("leaves the project exactly as it was before adoption", () => {
    const root = project();
    const beforeFiles = walk(root);
    importEverything(root);
    recordAdoptionValidation("Jaturapat", root, NOW);
    expect(walk(root)).not.toEqual(beforeFiles);

    rollbackAdoption(root);

    expect(walk(root)).toEqual(beforeFiles);
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });

  it("reports what it would remove and removes nothing on a dry run", () => {
    const root = project();
    importEverything(root);
    const before = walk(root);

    const report = rollbackAdoption(root, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.deleted.length).toBeGreaterThan(0);
    expect(walk(root)).toEqual(before);
  });

  it("undoes one stage and leaves the others, so a rejected checkpoint is re-runnable", () => {
    const root = project();
    importEverything(root);

    rollbackAdoption(root, { stage: "legacy-plan" });

    expect(ids(root)).toEqual([
      "DB-Order",
      "DES-001",
      "DES-002",
      "DES-DOC-README",
      "DES-RULES-CLAUDE",
      "REQ-001",
      "REQ-002",
    ]);
    // The state file survives a partial rollback: it is how the rest is still tracked.
    expect(readAdoptionState(root).state).not.toBeNull();
  });

  it("re-imports cleanly after a per-stage rollback", () => {
    const root = project();
    importEverything(root);
    rollbackAdoption(root, { stage: "legacy-plan" });

    runAdoptionStage("legacy-plan", root, NOW);

    expect(ids(root)).toContain("BE-001");
    expect(validateAdoption(root, NOW).problems).toEqual([]);
  });

  it("restores a file that existed before adoption, rather than deleting it", () => {
    // The distinction that matters: a path adoption *created* is deleted on
    // rollback, and a path it *replaced* is put back. So this starts from a
    // draft item the project already had — a hand-written REQ-001 that the docs
    // stage then legitimately re-derives over.
    const root = project();
    const target = path.join(root, "knowledge", "sales", "requirement", "REQ-001.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = [
      "schema_version: 1",
      "id: REQ-001",
      "kind: requirement",
      "title: Written by hand before adoption",
      "version: 1",
      "status: draft",
      "owner: business-analyst",
      "module: sales",
      "repo: null",
      "sensitive: false",
      `created_at: "${NOW}"`,
      `updated_at: "${NOW}"`,
      "sources:",
      "  - type: human",
      "    locator: Jaturapat",
      `    captured_at: "${NOW}"`,
      "    digest: null",
      "relations: []",
      "payload:",
      "  acceptance_criteria: []",
      "  actors: []",
      "  priority: null",
      "  assumption_unconfirmed: true",
      "body: an item this project already had",
      "",
    ].join("\n");
    fs.writeFileSync(target, original, "utf8");

    initAdoption(root, NOW);
    acknowledgePreflight("Jaturapat", root, NOW);
    runAdoptionStage("legacy-docs", root, NOW);
    expect(fs.readFileSync(target, "utf8")).not.toBe(original);

    const report = rollbackAdoption(root, { stage: "legacy-docs" });

    expect(report.restored).toContain("knowledge/sales/requirement/REQ-001.yaml");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("refuses a manifest path outside knowledge/ and still rolls back the rest", () => {
    const root = project();
    importEverything(root);
    const manifestPath = path.join(root, "knowledge", "_adoption", "MANIFEST.yaml");
    const raw = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(
      manifestPath,
      raw.replace("  - path: knowledge/sales", "  - path: src/index.ts\n    action: created\n    backup: null\n    stage: legacy-plan\n    at: \"2026-08-20T09:00:00Z\"\n  - path: knowledge/sales"),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");

    const report = rollbackAdoption(root);

    expect(report.refused).toEqual([{ path: "src/index.ts", reason: expect.stringContaining("outside knowledge/") }]);
    expect(fs.readFileSync(path.join(root, "src", "index.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });

  it("does nothing, and says so, when there is no manifest", () => {
    const root = project();

    expect(rollbackAdoption(root)).toEqual({
      deleted: [],
      restored: [],
      alreadyGone: [],
      refused: [],
      prunedDirs: [],
      removedAdoptionDir: false,
      dryRun: false,
    });
  });

  it("treats a file somebody already removed as done rather than as an error", () => {
    const root = project();
    importEverything(root);
    fs.rmSync(path.join(root, "knowledge", "sales", "task", "BE-001.yaml"));

    const report = rollbackAdoption(root);

    expect(report.alreadyGone).toContain("knowledge/sales/task/BE-001.yaml");
    expect(fs.existsSync(path.join(root, "knowledge"))).toBe(false);
  });
});

/** Every file in the project, relative and sorted — the before/after comparison rollback has to satisfy. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  visit(root);
  return out.sort();
}

/** Guards the assumption every stage list in this file rests on. */
describe("stage list", () => {
  it("runs docs before design before plan, so relations resolve as they land", () => {
    const expected: AdoptionStageId[] = ["legacy-agents", "legacy-docs", "legacy-design", "legacy-plan"];
    expect([...ALL_ADOPTION_STAGES]).toEqual(expected);
  });
});
