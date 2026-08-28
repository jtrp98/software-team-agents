import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import {
  CATEGORY_TO_DOC,
  ContextManager,
  DOC_FILENAME,
  HANDOFF_REFERENCE_MAX_SECTION_RATIO,
  handoffReferencedSections,
  sectionMap,
  selectDocContext,
  type DocKind,
} from "./contextManager.js";
import type { HandoffArtifact } from "../artifacts/schemas.js";
import { ContextLeakageError } from "./contextSelection.js";
import { renderSlicedDocs } from "../runtime/agentRunAssembly.js";
import { sliceModuleDocsWithSavings } from "../runtime/agentRunAssembly.js";
import { buildContextCommand } from "./contextCommand.js";

function handoff(over: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    task_id: "T-1", implements: [], module: "sales-crm", phase: 1,
    constraint_refs: [], contract_refs: { produces: [], consumes: [] },
    decision_refs: [], test_refs: [], artifact_refs: [], open_findings: [], budget: null,
    ...over,
  };
}

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

const TRACE_PLAN = `# plan — sales-crm

## Plan Summary
สามเฟส

## Phase 1: Import
| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-001 (DES-001) — import | pending | backend-engineer | — |

## Phase 2: Reporting
| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-002 (DES-002) — report | pending | backend-engineer | BE-001 |

## Phase 3: Archive
| Task | Status | Owner | Depends on |
|---|---|---|---|
| FE-003 (DES-003) — archive | pending | frontend-engineer | BE-002 |

## Open Questions
ไม่มี
`;

const TRACE_DESIGN = `# design — sales-crm

## Feature-by-Feature Feasibility
- DES-001 covers REQ-001 — import feasible
- DES-002 covers REQ-002 — reporting feasible
- DES-003 covers REQ-003 — archive feasible

## Import Contract — DES-001
${"i".repeat(2_000)}

## Reporting Contract — DES-002
${"r".repeat(6_000)}

## Archive Contract — DES-003
${"a".repeat(6_000)}

## Data Model
${"d".repeat(2_000)}

## Modules
### sales-crm
selected module contract
### billing
${"b".repeat(2_000)}

## Risks & Dependencies
ต้องรักษา backward compatibility

## Open Questions
ห้ามเปิด export จนกว่าจะยืนยัน

## Change Log
- 2026-08-27
`;

const TRACE_REQUIREMENT = `# requirement — sales-crm

## Overview
ระบบขาย

## Target Users & Roles
ผู้ดูแลระบบ

## Core Features
| Rule | Detail |
|---|---|
| REQ-001 | ${"นำเข้า ".repeat(180)} |
| REQ-002 | ${"รายงาน ".repeat(180)} |
| REQ-003 | ${"เก็บถาวร ".repeat(180)} |

## Scope — MVP vs Nice-to-have
MVP คือ import; ส่วนอื่นต้องไม่เดา

## Constraints & Assumptions
ภาษาไทยเป็นข้อมูลหลัก

## Open Questions
timezone ยังไม่ยืนยัน

## Declined / Not Pursuing
ไม่ทำ social login

## References
- นโยบายภายใน

## Change Log
- 2026-08-27
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

/**
 * T-V3TOK-052 — these are correctness properties, not examples of a preferred
 * compression ratio.  Any future slicer may keep more, but it must never make
 * one of these assertions false in order to save bytes.
 */
describe("T-V3TOK-052 slicing safety invariants", () => {
  function fixtureProject(docs: Partial<Record<DocKind, string>>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-slice-safety-"));
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    for (const [doc, body] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, DOC_FILENAME[doc as DocKind]), body, "utf8");
    }
    return root;
  }

  it("property 1: unknown sections are kept", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design", [2]), DESIGN);
    expect(out.kept).toContain("Import Rules");
    expect(out.kept).toContain("KPI & Scoring Rules");
    expect(out.text).toContain("CSV ต้องมี header ตรงตาม spec");
    expect(out.unknownSections).toEqual(expect.arrayContaining(["Import Rules", "KPI & Scoring Rules"]));
  });

  it("property 2: every dropped section is named beside the full-file path", () => {
    const root = fixtureProject({ plan: PLAN });
    try {
      const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
      const selected = cm.forStage(AgentStage.BACKEND_ENGINEER, [2]);
      const plan = selected.find((item) => item.doc === "plan")!;
      const rendered = renderSlicedDocs(selected, cm).join("\n");
      expect(plan.skipped.length).toBeGreaterThan(0);
      for (const heading of plan.skipped) expect(rendered).toContain(heading);
      expect(rendered).toContain(cm.path("plan"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("property 3: every document's always-read anchors remain present", () => {
    const plan = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN);
    for (const heading of ["Plan Summary", "Sequencing Notes", "Unresolved Open Questions"]) {
      expect(plan.kept).toContain(heading);
    }
    const design = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design", [2]), DESIGN);
    for (const heading of ["Feature-by-Feature Feasibility", "Risks & Dependencies", "Unresolved Open Questions"]) {
      expect(design.kept).toContain(heading);
    }
    const review = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "review", [2]), REVIEW);
    expect(review.kept).toContain("Open Issues — all phases");
    expect(review.kept).toContain("Unverified Behaviour — undeployed phases");
  });

  it("property 4: structure mismatches return the whole document with a reason", () => {
    const fixtures = [
      "# ไม่มีหัวข้อระดับสอง\nข้อความทั้งหมดต้องอยู่\n",
      "# design\n\n## ความเป็นไปได้\nเก็บ\n\n## เงื่อนไขเฉพาะ\nเก็บด้วย\n",
      "# design\n\n```md\n## Feature-by-Feature Feasibility\nตัวอย่าง ไม่ใช่โครงสร้างจริง\n```\n",
    ];
    for (const markdown of fixtures) {
      const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "design", [2]), markdown);
      expect(out.fullDocument).toBe(true);
      expect(out.text).toBe(markdown);
      expect(out.reason.length).toBeGreaterThan(0);
    }
  });

  it("property 5: no phase or a missing phase returns the whole plan", () => {
    for (const phases of [undefined, [99]]) {
      const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", phases), PLAN);
      expect(out.fullDocument).toBe(true);
      expect(out.text).toBe(PLAN);
    }
  });

  it("property 6: each document owner reads its document in full", () => {
    const owned: Array<[AgentStage, DocKind, string]> = [
      [AgentStage.PROJECT_MANAGER, "plan", PLAN],
      [AgentStage.SYSTEM_ANALYST, "design", DESIGN],
      [AgentStage.BUSINESS_ANALYST, "requirement", "# req\n\n## Core Features\nREQ-001 — เก็บทั้งหมด\n"],
    ];
    for (const [stage, doc, markdown] of owned) {
      const out = selectDocContext(req(stage, doc, [2]), markdown);
      expect(out.fullDocument).toBe(true);
      expect(out.text).toBe(markdown);
    }
  });

  it("property 7: sliced document payload contains only source preamble and source sections", () => {
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), PLAN);
    const sourceSections = sectionMap(PLAN);
    const lines = PLAN.split(/\r?\n/);
    const expectedParts = [
      lines.slice(0, sourceSections[0].start).join("\n"),
      ...sourceSections
        .filter((section) => out.kept.includes(section.heading))
        .map((section) => lines.slice(section.start, section.end).join("\n")),
    ].filter((part) => part.trim() !== "");
    expect(out.text).toBe(expectedParts.join("\n\n"));
  });

  it("property 7: traceability row/subsection slices contain no invented content", () => {
    const root = fixtureProject({ requirement: TRACE_REQUIREMENT, design: TRACE_DESIGN, plan: TRACE_PLAN });
    try {
      const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
      for (const [doc, source] of [["requirement", TRACE_REQUIREMENT], ["design", TRACE_DESIGN]] as const) {
        const out = cm.read(AgentStage.BACKEND_ENGINEER, doc, [1])!;
        const sourceLines = new Set(source.split(/\r?\n/));
        for (const line of out.text.split(/\r?\n/).filter((candidate) => candidate !== "")) {
          expect(sourceLines.has(line), `${doc}: invented line ${line.slice(0, 80)}`).toBe(true);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("property 8: sta context and sta run receive byte-identical document fragments", async () => {
    const root = fixtureProject({ requirement: "# req\n\nสั้น\n", design: DESIGN, plan: PLAN, review: REVIEW });
    try {
      const command = await buildContextCommand({
        role: "backend-engineer",
        moduleHint: "sales-crm",
        phases: [2],
        projectRoot: root,
        env: {},
      });
      const run = sliceModuleDocsWithSavings(AgentStage.BACKEND_ENGINEER, {
        projectRoot: root,
        moduleName: "sales-crm",
        phases: [2],
      });
      expect(command.context.docs).toEqual(run.docs);
      expect(command.context.docs.join("\n")).toBe(run.docs.join("\n"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("property 9: Thai headings are sliced without losing the requested phase", () => {
    const thai = [
      "# แผนงาน",
      "",
      "## Plan Summary",
      "ภาพรวม",
      "",
      "## เฟส 2: นำเข้าข้อมูล",
      "กฎสำคัญภาษาไทย",
      "",
      "## เฟส 3: รายงาน",
      "ยังไม่เกี่ยวข้อง",
      "",
      "## Unresolved Open Questions",
      "คำถามที่ยังไม่สรุป",
    ].join("\n");
    const out = selectDocContext(req(AgentStage.BACKEND_ENGINEER, "plan", [2]), thai);
    expect(out.fullDocument).toBe(false);
    expect(out.text).toContain("กฎสำคัญภาษาไทย");
    expect(out.text).toContain("คำถามที่ยังไม่สรุป");
    expect(out.text).not.toContain("ยังไม่เกี่ยวข้อง");
  });
});

describe("T-V3TOK-050 traceability-backed design slicing", () => {
  function tracedProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-traced-design-"));
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), TRACE_REQUIREMENT, "utf8");
    fs.writeFileSync(path.join(dir, "design.md"), TRACE_DESIGN, "utf8");
    fs.writeFileSync(path.join(dir, "plan.md"), TRACE_PLAN, "utf8");
    return root;
  }

  it("keeps selected-phase DES contracts and positively drops contracts planned for other phases", () => {
    const cm = new ContextManager({ projectRoot: tracedProject(), moduleName: "sales-crm" });
    const out = cm.read(AgentStage.BACKEND_ENGINEER, "design", [1])!;
    expect(out.fullDocument).toBe(false);
    expect(out.text).toContain("Import Contract — DES-001");
    expect(out.skipped).toEqual(expect.arrayContaining(["Reporting Contract — DES-002", "Archive Contract — DES-003"]));
    expect(out.text).not.toContain("Reporting Contract — DES-002");
    expect(out.bytesAfter / out.bytesBefore).toBeLessThanOrEqual(0.45);
  });

  it("slices Modules only when the current module entry parses exactly", () => {
    const cm = new ContextManager({ projectRoot: tracedProject(), moduleName: "sales-crm" });
    const out = cm.read(AgentStage.BACKEND_ENGINEER, "design", [1])!;
    expect(out.text).toContain("### sales-crm");
    expect(out.text).not.toContain("### billing");
    expect(out.skipped).toContain("Modules > billing");
  });

  it("keeps an unplanned DES section as unknown instead of treating no phase match as proof", () => {
    const root = tracedProject();
    const design = TRACE_DESIGN.replace("## Data Model", "## Future Contract — DES-999\nunknown future rule\n\n## Data Model");
    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "design.md"), design, "utf8");
    const out = new ContextManager({ projectRoot: root, moduleName: "sales-crm" }).read(AgentStage.BACKEND_ENGINEER, "design", [1])!;
    expect(out.text).toContain("unknown future rule");
    expect(out.unknownSections).toContain("Future Contract — DES-999");
    expect(out.skipped).not.toContain("Future Contract — DES-999");
  });

  it("falls back to the complete design when more than 40% of headings are unknown", () => {
    const root = tracedProject();
    const unknown = Array.from({ length: 10 }, (_, index) => `## Custom ${index}\nunknown ${index}\n`).join("\n");
    const design = `${TRACE_DESIGN}\n${unknown}`;
    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "design.md"), design, "utf8");
    const out = new ContextManager({ projectRoot: root, moduleName: "sales-crm" }).read(AgentStage.BACKEND_ENGINEER, "design", [1])!;
    expect(out.fullDocument).toBe(true);
    expect(out.text).toBe(design);
    expect(out.reason).toContain("40%");
  });

  it("renders known drops separately from content kept as unknown", () => {
    const root = tracedProject();
    const design = TRACE_DESIGN.replace("## Data Model", "## Future Contract — DES-999\nunknown future rule\n\n## Data Model");
    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "design.md"), design, "utf8");
    const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
    const rendered = renderSlicedDocs(cm.forStage(AgentStage.BACKEND_ENGINEER, [1]), cm).join("\n");
    expect(rendered).toContain("Known-irrelevant sections not included");
    expect(rendered).toContain("Kept because relevance is unknown");
    expect(rendered).toContain("Future Contract — DES-999");
  });
});

describe("T-V3TOK-051 traceability-backed requirement slicing", () => {
  function tracedProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-traced-requirement-"));
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), TRACE_REQUIREMENT, "utf8");
    fs.writeFileSync(path.join(dir, "design.md"), TRACE_DESIGN, "utf8");
    fs.writeFileSync(path.join(dir, "plan.md"), TRACE_PLAN, "utf8");
    return root;
  }

  it("keeps only the trace-linked rule rows for a selected phase plus every always-read section", () => {
    const out = new ContextManager({ projectRoot: tracedProject(), moduleName: "sales-crm" }).read(
      AgentStage.BACKEND_ENGINEER,
      "requirement",
      [1],
    )!;
    expect(out.fullDocument).toBe(false);
    expect(out.text).toContain("REQ-001");
    expect(out.text).not.toContain("REQ-002");
    expect(out.text).not.toContain("REQ-003");
    expect(out.text).toContain("## Scope — MVP vs Nice-to-have");
    expect(out.text).toContain("## References");
    expect(out.text).toContain("## Open Questions");
    expect(out.bytesAfter / out.bytesBefore).toBeLessThanOrEqual(0.6);
  });

  it("business-analyst and system-analyst still read requirement.md in full", () => {
    const cm = new ContextManager({ projectRoot: tracedProject(), moduleName: "sales-crm" });
    for (const stage of [AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST]) {
      const out = cm.read(stage, "requirement", [1])!;
      expect(out.fullDocument).toBe(true);
      expect(out.text).toBe(TRACE_REQUIREMENT);
    }
  });

  it("fails open for missing REQ ids, missing phase, and incomplete DES → REQ relationships", () => {
    const root = tracedProject();
    const cm = new ContextManager({ projectRoot: root, moduleName: "sales-crm" });
    expect(cm.read(AgentStage.BACKEND_ENGINEER, "requirement")?.fullDocument).toBe(true);

    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "requirement.md"), "# req\n\n## Scope\nall\n", "utf8");
    const noIds = new ContextManager({ projectRoot: root, moduleName: "sales-crm" }).read(AgentStage.BACKEND_ENGINEER, "requirement", [1])!;
    expect(noIds.fullDocument).toBe(true);
    expect(noIds.reason).toContain("no REQ-NNN");

    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "requirement.md"), TRACE_REQUIREMENT, "utf8");
    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "design.md"), TRACE_DESIGN.replace("DES-001 covers REQ-001", "DES-001 has no requirement"), "utf8");
    const broken = new ContextManager({ projectRoot: root, moduleName: "sales-crm" }).read(AgentStage.BACKEND_ENGINEER, "requirement", [1])!;
    expect(broken.fullDocument).toBe(true);
    expect(broken.reason).toContain("incomplete");
  });
});

describe("T-V3TOK-092 handoff-reference narrowing", () => {
  function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-handoff-slice-"));
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirement.md"), TRACE_REQUIREMENT, "utf8");
    fs.writeFileSync(
      path.join(dir, "design.md"),
      TRACE_DESIGN.replace("## Data Model", "## Future Contract — DES-999\n" + "future ".repeat(500) + "\n\n## Data Model"),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "plan.md"), TRACE_PLAN, "utf8");
    return root;
  }

  it("keeps referenced and always-read sections while dropping unreferenced unknown excess", () => {
    const cm = new ContextManager({ projectRoot: project(), moduleName: "sales-crm" });
    const normal = cm.forStage(AgentStage.BACKEND_ENGINEER, [1]);
    const refs = handoffReferencedSections(
      AgentStage.BACKEND_ENGINEER,
      handoff({ contract_refs: { produces: ["design.md#Import-Contract-%E2%80%94-DES-001"], consumes: [] } }),
    );
    const narrowed = cm.forStage(AgentStage.BACKEND_ENGINEER, [1], undefined, refs);
    const normalDesign = normal.find((doc) => doc.doc === "design")!;
    const narrowedDesign = narrowed.find((doc) => doc.doc === "design")!;
    expect(normalDesign.text).toContain("Future Contract — DES-999");
    expect(narrowedDesign.text).not.toContain("Future Contract — DES-999");
    expect(narrowedDesign.text).toContain("Import Contract — DES-001");
    expect(narrowedDesign.text).toContain("## Risks & Dependencies");
    expect(narrowedDesign.text).toContain("## Open Questions");
    expect(narrowedDesign.bytesAfter).toBeLessThan(normalDesign.bytesAfter);
    expect(narrowedDesign.skipped).toContain("Future Contract — DES-999");
  });

  it("rejects an explicitly qualified reference outside CONTEXT_POLICY", () => {
    expect(() => handoffReferencedSections(
      AgentStage.SYSTEM_ANALYST,
      handoff({ constraint_refs: ["security.md#Open-Findings"] }),
    )).toThrow(ContextLeakageError);
  });

  it("falls back to the normal slice when references cover more than the declared ratio", () => {
    expect(HANDOFF_REFERENCE_MAX_SECTION_RATIO).toBe(0.6);
    const cm = new ContextManager({ projectRoot: project(), moduleName: "sales-crm" });
    const normal = cm.forStage(AgentStage.BACKEND_ENGINEER, [1]);
    const allDesignHeadings = sectionMap(normal.find((doc) => doc.doc === "design")!.text)
      .map((section) => `design.md#${encodeURIComponent(section.heading.replace(/\s+/g, "-"))}`);
    const refs = handoffReferencedSections(
      AgentStage.BACKEND_ENGINEER,
      handoff({ contract_refs: { produces: allDesignHeadings, consumes: [] } }),
    );
    const broad = cm.forStage(AgentStage.BACKEND_ENGINEER, [1], undefined, refs);
    expect(broad.find((doc) => doc.doc === "design")!.text).toBe(normal.find((doc) => doc.doc === "design")!.text);
  });

  it("does not change any no-handoff ContextManager output", () => {
    const cm = new ContextManager({ projectRoot: project(), moduleName: "sales-crm" });
    expect(cm.forStage(AgentStage.BACKEND_ENGINEER, [1])).toEqual(
      cm.forStage(AgentStage.BACKEND_ENGINEER, [1], undefined, undefined),
    );
  });

  it("falls back to the normal slice for a minimal handoff with no references", () => {
    const cm = new ContextManager({ projectRoot: project(), moduleName: "sales-crm" });
    const normal = cm.forStage(AgentStage.BACKEND_ENGINEER, [1]);
    const minimal = cm.forStage(
      AgentStage.BACKEND_ENGINEER,
      [1],
      undefined,
      handoffReferencedSections(AgentStage.BACKEND_ENGINEER, handoff()),
    );
    expect(minimal).toEqual(normal);
  });
});
