import { describe, expect, it } from "vitest";
import {
  buildEvidencePackage,
  planRecheck,
  type EvidenceRecord,
  type QaFindingRecord,
} from "./evidence.js";
import { buildQaScope } from "./scope.js";
import { selectQaMode } from "./mode.js";
import { runDeterministicVerification } from "./deterministic.js";

const SCOPE = buildQaScope({ taskId: "T1", changedFiles: ["api/orders.ts"] });
const MODE = selectQaMode("T1", SCOPE, {}, { now: () => 5 });

function finding(overrides: Partial<QaFindingRecord> = {}): QaFindingRecord {
  return {
    id: "F1",
    description: "total is not recalculated after discount",
    owner: "backend-engineer",
    files: ["api/orders.ts"],
    createdAt: 1,
    status: "OPEN",
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "E1",
    kind: "deterministic",
    files: ["api/orders.ts"],
    summary: "typecheck PASS at round 1",
    createdAt: 1,
    ...overrides,
  };
}

describe("planRecheck", () => {
  it("rechecks every open finding", () => {
    const plan = planRecheck([finding(), finding({ id: "F2", files: ["web/Order.tsx"] })], [], ["api/orders.ts"]);
    expect(plan.recheckFindings.map((f) => f.id)).toEqual(["F1", "F2"]);
  });

  it("invalidates evidence the fix touched and keeps the rest fresh", () => {
    const plan = planRecheck(
      [finding()],
      [
        evidence({ id: "TOUCHED", files: ["api/orders.ts"] }),
        evidence({ id: "FRESH", files: ["api/other.ts"] }),
      ],
      ["api/orders.ts"],
    );
    expect(plan.invalidatedEvidence.map((e) => e.id)).toEqual(["TOUCHED"]);
    expect(plan.reusableEvidence.map((e) => e.id)).toEqual(["FRESH"]);
  });

  it("flags fix-touched files no finding mentioned as a cross-boundary signal", () => {
    const plan = planRecheck([finding()], [], ["api/orders.ts", "api/pricing.ts"]);
    expect(plan.newFilesOutsideFindings).toEqual(["api/pricing.ts"]);
  });

  it("reports no new files when the fix stayed inside the findings' file set", () => {
    const plan = planRecheck([finding({ files: ["api/orders.ts", "api/pricing.ts"] })], [], ["api/orders.ts"]);
    expect(plan.newFilesOutsideFindings).toEqual([]);
  });

  it("raises no cross-boundary signal when no finding carries file data", () => {
    const plan = planRecheck([finding({ files: [] })], [], ["anything/new.ts"]);
    expect(plan.newFilesOutsideFindings).toEqual([]);
    expect(plan.recheckFindings).toHaveLength(1);
  });
});

describe("buildEvidencePackage", () => {
  it("leads with mode, scope, intent, criteria and diff — bounded, source-free", async () => {
    const det = await runDeterministicVerification(() => null);
    const pkg = buildEvidencePackage({
      taskId: "T1",
      mode: MODE,
      scope: SCOPE,
      taskIntent: "apply order discounts",
      acceptanceCriteria: ["discount applies once", "total updates"],
      diffSummary: "+12 -3 in api/orders.ts",
      deterministic: det,
      knownRisks: ["rounding on negative totals"],
    });
    expect(pkg).toContain("QA evidence package for T1");
    expect(pkg).toContain("TARGETED");
    expect(pkg).toContain("- discount applies once");
    expect(pkg).toContain("+12 -3 in api/orders.ts");
    expect(pkg).toContain("no checks configured for this project");
    expect(pkg).toContain("rounding on negative totals");
    expect(pkg).not.toContain("export function");
  });

  it("includes the recheck plan with reuse and invalidation on a retry round", async () => {
    const pkg = buildEvidencePackage({
      taskId: "T1",
      mode: MODE,
      scope: SCOPE,
      taskIntent: "x",
      acceptanceCriteria: ["c"],
      diffSummary: "",
      deterministic: await runDeterministicVerification(() => null),
      knownRisks: [],
      recheck: planRecheck([finding()], [evidence(), evidence({ id: "FRESH", files: ["other.ts"] })], ["api/orders.ts"]),
    });
    expect(pkg).toContain("Recheck first (1 open finding(s))");
    expect(pkg).toContain("[F1] (backend-engineer)");
    expect(pkg).toContain("Invalidated evidence");
    expect(pkg).toContain("[E1]");
    expect(pkg).toContain("[FRESH]");
  });

  it("renders the cross-boundary escalation signal when present", () => {
    const pkg = buildEvidencePackage({
      taskId: "T1",
      mode: MODE,
      scope: SCOPE,
      taskIntent: "x",
      acceptanceCriteria: [],
      diffSummary: "",
      knownRisks: [],
      recheck: planRecheck(
        [finding({ files: ["api/orders.ts"] })],
        [],
        ["api/orders.ts", "surprise/new.ts"],
      ),
    });
    expect(pkg).toMatch(/CROSS-BOUNDARY SIGNAL[\s\S]*surprise\/new\.ts/);
    expect(pkg).toMatch(/escalate to FULL/);
  });

  it("truncates past the line cap with an explicit request-more marker", () => {
    const pkg = buildEvidencePackage({
      taskId: "T1",
      mode: MODE,
      scope: buildQaScope({
        taskId: "T1",
        changedFiles: Array.from({ length: 200 }, (_, i) => `f${i}.ts`),
        maxFiles: 1000,
      }),
      taskIntent: "x".repeat(500),
      acceptanceCriteria: Array.from({ length: 80 }, (_, i) => `criterion ${i}`),
      diffSummary: "",
      knownRisks: [],
      maxLines: 30,
    });
    expect(pkg.split("\n").length).toBeLessThanOrEqual(31);
    expect(pkg).toContain("(evidence package truncated");
    expect(pkg).toContain("request specific sections");
  });
});
