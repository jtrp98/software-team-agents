import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { benchmarkContextSlicing, describeBenchmark, estimatedTokens } from "./tokenBenchmark.js";

const REQUIREMENT = `# requirement — sales-crm

## Core Features
REQ-001: staff เห็นกะของตัวเอง

## References
- (สมมติฐาน — ยังไม่ยืนยัน) ไม่มี timezone อื่นนอกจาก Asia/Bangkok
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

## Change Log
- 2026-08-01 สร้างครั้งแรก
`;

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

describe("estimatedTokens (T116)", () => {
  it("divides by the documented chars-per-token constant, rounded", () => {
    expect(estimatedTokens(400)).toBe(100);
    expect(estimatedTokens(1)).toBe(0);
  });
});

describe("benchmarkContextSlicing (T116)", () => {
  const DOCS = { requirement: REQUIREMENT, design: DESIGN, plan: PLAN };

  it("shows a real byte reduction for a role whose plan/design read is sliced by phase", () => {
    const report = benchmarkContextSlicing(DOCS, [{ stage: AgentStage.BACKEND_ENGINEER, phases: [2] }]);
    const be = report.roles[0];
    expect(be.stage).toBe(AgentStage.BACKEND_ENGINEER);
    expect(be.bytesAfter).toBeLessThan(be.bytesBefore);
    expect(be.savedPct).toBeGreaterThan(0);
    // requirement.md is always read whole (§10) — present in the breakdown, not sliced.
    const reqDoc = be.docs.find((d) => d.doc === "requirement")!;
    expect(reqDoc.fullDocument).toBe(true);
    const planDoc = be.docs.find((d) => d.doc === "plan")!;
    expect(planDoc.fullDocument).toBe(false);
  });

  it("reports zero savings, not a crash, for a document §10 always reads in full (requirement.md, any role)", () => {
    // system-analyst's policy reads requirement.md and nothing else document-backed —
    // and §10 reads requirement.md whole for every stage, so this is the cleanest
    // case of "the mechanism ran and correctly found nothing to cut".
    const report = benchmarkContextSlicing({ requirement: REQUIREMENT }, [{ stage: AgentStage.SYSTEM_ANALYST }]);
    const sa = report.roles[0];
    expect(sa.savedPct).toBe(0);
    expect(sa.docs).toEqual([{ doc: "requirement", bytesBefore: REQUIREMENT.length, bytesAfter: REQUIREMENT.length, fullDocument: true, reason: expect.any(String) }]);
  });

  it("contributes nothing for a stage with no context policy, rather than throwing", () => {
    const report = benchmarkContextSlicing(DOCS, [{ stage: AgentStage.HUMAN }]);
    expect(report.roles[0]).toMatchObject({ bytesBefore: 0, bytesAfter: 0, savedPct: 0, docs: [] });
  });

  it("skips a document the caller never supplied, instead of treating it as empty savings", () => {
    const report = benchmarkContextSlicing({ plan: PLAN }, [{ stage: AgentStage.BACKEND_ENGINEER, phases: [2] }]);
    const be = report.roles[0];
    expect(be.docs.map((d) => d.doc)).toEqual(["plan"]);
  });

  it("totals across every role, and estimates tokens saved from the same byte totals", () => {
    const report = benchmarkContextSlicing(DOCS, [
      { stage: AgentStage.BACKEND_ENGINEER, phases: [2] },
      { stage: AgentStage.FRONTEND_ENGINEER, phases: [2] },
    ]);
    const summedBefore = report.roles.reduce((n, r) => n + r.bytesBefore, 0);
    const summedAfter = report.roles.reduce((n, r) => n + r.bytesAfter, 0);
    expect(report.totals.bytesBefore).toBe(summedBefore);
    expect(report.totals.bytesAfter).toBe(summedAfter);
    expect(report.totals.estTokensSaved).toBe(estimatedTokens(summedBefore - summedAfter));
  });

  it("describeBenchmark renders one line per role plus a total, and flags any doc passed through whole", () => {
    const report = benchmarkContextSlicing(DOCS, [{ stage: AgentStage.BACKEND_ENGINEER, phases: [2] }]);
    const lines = describeBenchmark(report);
    expect(lines).toHaveLength(2); // one role + TOTAL
    expect(lines[0]).toContain("passed through whole: requirement");
    expect(lines[1]).toContain("TOTAL");
  });
});
