import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  CATEGORY_TO_DOC,
  ContextManager,
  DOC_FILENAME,
  sectionMap,
  selectDocContext,
  type DocKind,
} from "./contextManager.js";

const PLAN = `# แผนงาน sales-crm

## Plan Summary
สามเฟส รวม 24 tasks

## Phase 1: Auth 🔒 Security gate
- [x] BE-001 login endpoint

## Phase 2: Import
- [ ] BE-010 CSV import
- [ ] FE-010 upload UI

## Phase 3: Reporting
- [ ] BE-020 KPI query

## Sequencing Notes
Phase 2 ต้องรอ Phase 1 เสร็จก่อน

## Unresolved Open Questions
ยังไม่สรุปเรื่อง timezone

## Change Log
- 2026-08-01 สร้างครั้งแรก
`;

const DESIGN = `# design — sales-crm

## Feasibility Summary
ทำได้ทั้งหมด

## Feature-by-Feature Feasibility
- import: ทำได้
- kpi: ทำได้

## Import Rules
CSV ต้องมี header ตรงตาม spec

## KPI & Scoring Rules
score = weight * value

## Data Model
model Deal { id Int }

## Modules
### sales-crm
โมดูลหลัก

## Risks & Dependencies
ต้องมี pg 15

## Unresolved Open Questions
ตัดฟีเจอร์ export ออกจาก scope — ห้าม implement ก่อน amend

## Change Log
- 2026-08-01 สร้าง
`;

const REVIEW = `# review — sales-crm

## Open Issues — all phases
- BE-010 ยัง fail

## Phase 1 verify round 2 (FULL)
✅ ผ่าน

## Unverified Behaviour — undeployed phases
- KPI rounding อ่านโค้ดอย่างเดียว

## Phase 2 verify round 1 (TARGETED)
⚠️ response shape ไม่ตรง
`;

function req(stage: AgentStage, doc: DocKind, phases?: number[]) {
  return { stage, doc, phases, moduleName: "sales-crm" };
}

describe("sectionMap", () => {
  it("finds every `## ` heading and gives each a range", () => {
    const map = sectionMap(PLAN);
    expect(map.map((s) => s.heading)).toEqual([
      "Plan Summary",
      "Phase 1: Auth 🔒 Security gate",
      "Phase 2: Import",
      "Phase 3: Reporting",
      "Sequencing Notes",
      "Unresolved Open Questions",
      "Change Log",
    ]);
  });

  it("does not treat a `## ` inside a fenced block as a heading", () => {
    const doc = "# t\n\n## Real\n\n```md\n## Not a heading\n```\n\n## Also real\n";
    expect(sectionMap(doc).map((s) => s.heading)).toEqual(["Real", "Also real"]);
  });

  it("keeps `###` inside its parent rather than starting a new section", () => {
    const map = sectionMap(DESIGN);
    expect(map.map((s) => s.heading)).not.toContain("sales-crm");
    const modules = map.find((s) => s.heading === "Modules")!;
    const text = DESIGN.split("\n").slice(modules.start, modules.end).join("\n");
    expect(text).toContain("### sales-crm");
  });

  it("returns nothing for a document with no headings at all", () => {
    expect(sectionMap("just a paragraph\n")).toEqual([]);
  });
});

describe("plan.md — §10 slice", () => {
  it("keeps Plan Summary, this run's phase, Sequencing Notes and Open Questions", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN);
    expect(out.fullDocument).toBe(false);
    expect(out.kept).toEqual(["Plan Summary", "Phase 2: Import", "Sequencing Notes", "Unresolved Open Questions"]);
  });

  it("drops the other phases and the Change Log", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN);
    expect(out.skipped).toEqual(["Phase 1: Auth 🔒 Security gate", "Phase 3: Reporting", "Change Log"]);
    expect(out.text).not.toContain("BE-020");
    expect(out.text).toContain("BE-010");
  });

  it("keeps the title preamble, so the slice still says which module it belongs to", () => {
    expect(selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN).text).toContain("# แผนงาน sales-crm");
  });

  it("keeps every phase a multi-phase run touches — §10's rule is 'the phases your run touches'", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [1, 3]), PLAN);
    expect(out.kept).toContain("Phase 1: Auth 🔒 Security gate");
    expect(out.kept).toContain("Phase 3: Reporting");
    expect(out.kept).not.toContain("Phase 2: Import");
  });

  it("measures what it saved", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN);
    expect(out.bytesAfter).toBeLessThan(out.bytesBefore);
  });

  it("lets project-manager read the whole thing — it owns the document", () => {
    const out = selectDocContext(req(AgentStage.PROJECT_MANAGER, "plan", [2]), PLAN);
    expect(out.fullDocument).toBe(true);
    expect(out.text).toBe(PLAN);
    expect(out.reason).toContain("project-manager owns plan.md");
  });
});

describe("design.md — §10 slice", () => {
  it("always keeps Feasibility, Risks and Open Questions", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), DESIGN);
    expect(out.kept).toContain("Feature-by-Feature Feasibility");
    expect(out.kept).toContain("Risks & Dependencies");
    expect(out.kept).toContain("Unresolved Open Questions");
  });

  it("keeps the out-of-scope prohibition, which is the point of always reading Open Questions", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), DESIGN);
    expect(out.text).toContain("ห้าม implement ก่อน amend");
  });

  it("keeps contract sections in full — they are contracts, not summaries", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), DESIGN);
    expect(out.kept).toContain("Import Rules");
    expect(out.kept).toContain("KPI & Scoring Rules");
    expect(out.text).toContain("score = weight * value");
  });

  it("drops the Feasibility Summary and the Change Log", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), DESIGN);
    expect(out.skipped).toContain("Feasibility Summary");
    expect(out.skipped).toContain("Change Log");
  });

  /** §7: an engineer works from schema.prisma once it exists, so the Data Model is not its copy to read. */
  it("drops the Data Model for an engineer", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), DESIGN);
    expect(out.skipped).toContain("Data Model");
  });

  it("keeps the Data Model for qa-engineer, which reads it in full every round", () => {
    const out = selectDocContext(req(AgentStage.QA_ENGINEER, "design"), DESIGN);
    expect(out.kept).toContain("Data Model");
  });

  it("keeps the Data Model for project-manager, which writes one task per model", () => {
    const out = selectDocContext(req(AgentStage.PROJECT_MANAGER, "design"), DESIGN);
    expect(out.kept).toContain("Data Model");
  });

  it("lets system-analyst read the whole thing — it owns the document", () => {
    const out = selectDocContext(req(AgentStage.SYSTEM_ANALYST, "design"), DESIGN);
    expect(out.fullDocument).toBe(true);
    expect(out.reason).toContain("system-analyst owns design.md");
  });
});

describe("review.md — §10 slice", () => {
  it("always keeps Open Issues, which most runs are the only part to act on", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "review"), REVIEW);
    expect(out.kept).toContain("Open Issues — all phases");
    expect(out.text).toContain("BE-010 ยัง fail");
  });

  it("keeps Unverified Behaviour, which outlives the round that produced it", () => {
    const out = selectDocContext(req(AgentStage.DEVOPS, "review"), REVIEW);
    expect(out.kept).toContain("Unverified Behaviour — undeployed phases");
  });

  it("keeps the current round and drops closed ones", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "review"), REVIEW);
    expect(out.kept).toContain("Phase 2 verify round 1 (TARGETED)");
    expect(out.skipped).toContain("Phase 1 verify round 2 (FULL)");
  });
});

describe("requirement.md", () => {
  it("is never sliced — it is short, has no per-phase structure, and the rule you skip is the one you get wrong", () => {
    const doc = "# req\n\n## A\nx\n\n## B\ny\n";
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY]) {
      const out = selectDocContext(req(stage, "requirement"), doc);
      expect(out.fullDocument).toBe(true);
      expect(out.text).toBe(doc);
    }
  });
});

/**
 * The safety model: slicing is an optimization, completeness is a correctness
 * requirement, so anything unexpected returns the whole document with a reason.
 */
describe("failing open when the structure is not what §10 expects", () => {
  it("returns the whole plan when no phase was given", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan"), PLAN);
    expect(out.fullDocument).toBe(true);
    expect(out.reason).toContain("no phase given");
  });

  it("returns the whole plan when the requested phase has no section", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [9]), PLAN);
    expect(out.fullDocument).toBe(true);
    expect(out.reason).toContain("phase 9");
    expect(out.text).toBe(PLAN);
  });

  it("returns the whole design when none of the always-read sections are recognizable", () => {
    const renamed = "# d\n\n## ความเป็นไปได้\nx\n\n## ข้อจำกัด\ny\n";
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), renamed);
    expect(out.fullDocument).toBe(true);
    expect(out.reason).toContain("passed through whole");
  });

  it("returns the whole review when there is no Open Issues section to anchor on", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "review"), "# r\n\n## Round 1\n✅\n");
    expect(out.fullDocument).toBe(true);
    expect(out.reason).toContain("Open Issues");
  });

  it("returns a heading-less document untouched", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design"), "just prose\n");
    expect(out.fullDocument).toBe(true);
    expect(out.text).toBe("just prose\n");
  });

  it("passes security.md and deploy.md through, since §10 gives them no rule", () => {
    for (const doc of ["security", "deploy"] as DocKind[]) {
      const out = selectDocContext(req(AgentStage.DEVOPS, doc), "# s\n\n## A\nx\n");
      expect(out.fullDocument).toBe(true);
    }
  });

  /** A phase heading written the Thai way still has to match, or every real document falls back to whole. */
  it("matches a Thai phase heading", () => {
    const thai = "# แผน\n\n## Plan Summary\nx\n\n## เฟส 2: นำเข้าข้อมูล\n- [ ] BE-010\n\n## เฟส 3: รายงาน\n- [ ] BE-020\n";
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), thai);
    expect(out.fullDocument).toBe(false);
    expect(out.kept).toContain("เฟส 2: นำเข้าข้อมูล");
    expect(out.skipped).toContain("เฟส 3: รายงาน");
  });
});

describe("ContextManager against real files", () => {
  function fixtureProject(docs: Partial<Record<DocKind, string>>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ctx-"));
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    for (const [doc, body] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, DOC_FILENAME[doc as DocKind]), body, "utf8");
    }
    return root;
  }

  it("reads and slices a document off disk", () => {
    const cm = new ContextManager({ projectRoot: fixtureProject({ plan: PLAN }), moduleName: "sales-crm" });
    const out = cm.read(AgentStage.BACKEND_ENGINEER, "plan", [2])!;
    expect(out.kept).toContain("Phase 2: Import");
    expect(out.text).not.toContain("BE-020");
  });

  it("returns null for a document that does not exist, rather than an empty string", () => {
    const cm = new ContextManager({ projectRoot: fixtureProject({}), moduleName: "sales-crm" });
    expect(cm.read(AgentStage.BACKEND_ENGINEER, "plan", [1])).toBeNull();
  });

  /** The composition T05 asks for: the policy picks the documents, §10 picks how much of each. */
  it("gives a stage only the documents its context policy allows", () => {
    const root = fixtureProject({ plan: PLAN, design: DESIGN, review: REVIEW, requirement: "# req\n\nสั้น\n" });
    const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });

    const backend = cm.forStage(AgentStage.BACKEND_ENGINEER, [2]).map((s) => s.doc);
    expect(backend).toEqual(expect.arrayContaining(["plan", "design", "requirement", "review"]));

    // setup's policy is design-only, so nothing else reaches it however many docs exist.
    expect(cm.forStage(AgentStage.SETUP).map((s) => s.doc)).toEqual(["design"]);
  });

  it("never hands a stage a document its policy excludes", () => {
    const root = fixtureProject({ plan: PLAN, design: DESIGN, review: REVIEW });
    const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
    // system-analyst reads requirements and the QA report — not plan.md.
    expect(cm.forStage(AgentStage.SYSTEM_ANALYST, [2]).map((s) => s.doc)).not.toContain("plan");
  });

  it("reports what the slicing saved, so a filter that stops working is visible", () => {
    const root = fixtureProject({ plan: PLAN, design: DESIGN, review: REVIEW, requirement: "# req\n\nสั้น\n" });
    const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
    const selected = cm.forStage(AgentStage.BACKEND_ENGINEER, [2]);
    const savings = cm.savings(selected);
    expect(savings.bytesAfter).toBeLessThan(savings.bytesBefore);
    expect(savings.savedPct).toBeGreaterThan(0);
  });

  it("maps every artifact category that has a backing document", () => {
    expect(CATEGORY_TO_DOC["plan"]).toBe("plan");
    expect(CATEGORY_TO_DOC["qa-report"]).toBe("review");
    expect(CATEGORY_TO_DOC["security-report"]).toBe("security");
    expect(CATEGORY_TO_DOC["backend-code"]).toBeUndefined();
  });
});
