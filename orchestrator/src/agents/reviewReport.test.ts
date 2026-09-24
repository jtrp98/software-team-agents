import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType, ReviewReportArtifactSchema, validateArtifact } from "../artifacts/schemas.js";
import { parseReviewReport } from "./moduleDocs.js";
import { classifyReviewFailure } from "../orchestrator/failureClassifier.js";

/** V13 TASK-006 — review.md is read into the review-report artifact by STA, never taken from the reviewer's claim. */

const TASK = "T-REV";

function reviewMd(opts: {
  rows?: string[];
  roundTask?: string;
  verdict?: string | null;
  reviewed?: string[];
  extraRound?: boolean;
} = {}): string {
  const rows = opts.rows ?? ["| RV-1 | non-blocking | src/orders.ts:12 | backend-engineer | resolved | naming now follows the neighbours |"];
  const verdict = opts.verdict === undefined ? "**Verdict:** ✅ Approved" : opts.verdict;
  const reviewed = opts.reviewed ?? ["src/orders.ts", "src/orders.test.ts"];
  return [
    "# review.md — orders",
    "",
    "## Open Findings — all phases",
    "| ID | Severity | Location | Owner | Status | Finding |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(opts.extraRound ? ["## Review Round 1 — T-OLD", "**Verdict:** ❌ Changes requested", ""] : []),
    `## Review Round 2 — ${opts.roundTask ?? TASK}`,
    ...(verdict === null ? [] : [verdict]),
    "",
    "Notes for this round.",
    "",
    "## Reviewed",
    ...reviewed.map((file) => `- \`${file}\``),
  ].join("\n");
}

describe("parseReviewReport (V13 TASK-006)", () => {
  it("reads a clean, approved round into a schema-valid PASS", () => {
    const parsed = parseReviewReport(TASK, reviewMd());
    expect(parsed.problems).toEqual([]);
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.artifact).toEqual({
      taskId: TASK,
      verdict: "PASS",
      findings: [
        { id: "RV-1", severity: "NON_BLOCKING", location: "src/orders.ts:12", owner: AgentStage.BACKEND_ENGINEER, status: "RESOLVED", description: "naming now follows the neighbours" },
      ],
      reviewed: ["src/orders.ts", "src/orders.test.ts"],
    });
    expect(() => validateArtifact(ArtifactType.REVIEW_REPORT, parsed.artifact)).not.toThrow();
  });

  it("reads a Changes requested round with an open blocking finding into an actionable FAIL", () => {
    const parsed = parseReviewReport(
      TASK,
      reviewMd({
        verdict: "**Verdict:** ❌ Changes requested",
        rows: ["| RV-2 | blocking | server/orders.ts:42-48 | backend-engineer | open | zero-total order is rejected; DES-011 says serialize it |"],
      }),
    );
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.artifact?.verdict).toBe("FAIL");
    expect(classifyReviewFailure(parsed.artifact!)).toMatchObject({
      category: "implementation",
      owner: AgentStage.BACKEND_ENGINEER,
      retryable: true,
      requiresHuman: false,
      affected: ["RV-2"],
    });
  });

  it("never invents a PASS: a missing verdict line reads as FAIL", () => {
    const parsed = parseReviewReport(TASK, reviewMd({ verdict: null }));
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.problems.join(" ")).toMatch(/no literal `\*\*Verdict:\*\*/);
    // FAIL with nothing open and blocking gives no owner anything to fix: not an artifact.
    expect(parsed.artifact).toBeNull();
  });

  it("an unrecognizable verdict line reads as FAIL", () => {
    expect(parseReviewReport(TASK, reviewMd({ verdict: "**Verdict:** looks fine to me" })).verdict).toBe("FAIL");
  });

  it("a PASS that lists nothing reviewed reads as FAIL", () => {
    const parsed = parseReviewReport(TASK, reviewMd({ reviewed: [] }));
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.problems.join(" ")).toMatch(/review that read nothing reviewed nothing/);
  });

  it("a round that reviews another task reads as FAIL", () => {
    const parsed = parseReviewReport(TASK, reviewMd({ roundTask: "T-OTHER" }));
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.problems.join(" ")).toMatch(/current round reviews T-OTHER, not T-REV/);
  });

  it("reads only the current round: an older round's verdict does not count", () => {
    const parsed = parseReviewReport(TASK, reviewMd({ extraRound: true }));
    expect(parsed.verdict).toBe("PASS");
  });

  it("Approved beside an open blocking finding is a contradiction and reads as FAIL, routed to the named owner", () => {
    const parsed = parseReviewReport(
      TASK,
      reviewMd({ rows: ["| RV-3 | blocking | app/orders/page.tsx:7 | frontend-engineer | open | total renders as NaN |"] }),
    );
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.problems.join(" ")).toMatch(/Approved but RV-3 is open and blocking/);
    expect(parsed.artifact?.verdict).toBe("FAIL");
    expect(classifyReviewFailure(parsed.artifact!).owner).toBe(AgentStage.FRONTEND_ENGINEER);
  });

  it("a finding it cannot tie to a file and line is not a finding — the round fails closed", () => {
    const parsed = parseReviewReport(
      TASK,
      reviewMd({ rows: ["| RV-4 | non-blocking | somewhere in the service | backend-engineer | open | vague |"] }),
    );
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.problems.join(" ")).toMatch(/is not path:line/);
    expect(parsed.artifact).toBeNull();
  });

  it("blocking findings owned by two roles are a human decision, not a guessed route", () => {
    const parsed = parseReviewReport(
      TASK,
      reviewMd({
        verdict: "**Verdict:** ❌ Changes requested",
        rows: [
          "| RV-5 | blocking | server/a.ts:1 | backend-engineer | open | a |",
          "| RV-6 | blocking | app/b.tsx:2 | frontend-engineer | open | b |",
        ],
      }),
    );
    expect(classifyReviewFailure(parsed.artifact!)).toMatchObject({ owner: AgentStage.HUMAN, requiresHuman: true });
  });
});

describe("ReviewReportArtifactSchema (V13 TASK-006)", () => {
  const finding = { id: "RV-1", severity: "BLOCKING", location: "src/a.ts:1", owner: AgentStage.BACKEND_ENGINEER, status: "OPEN", description: "x" } as const;

  it("refuses PASS with an open blocking finding", () => {
    expect(ReviewReportArtifactSchema.safeParse({ taskId: "T", verdict: "PASS", findings: [finding], reviewed: ["src/a.ts"] }).success).toBe(false);
  });

  it("refuses FAIL with nothing open and blocking", () => {
    expect(ReviewReportArtifactSchema.safeParse({ taskId: "T", verdict: "FAIL", findings: [{ ...finding, status: "RESOLVED" }], reviewed: ["src/a.ts"] }).success).toBe(false);
  });

  it("refuses an empty reviewed list, a malformed id and a location without a line", () => {
    expect(ReviewReportArtifactSchema.safeParse({ taskId: "T", verdict: "PASS", findings: [], reviewed: [] }).success).toBe(false);
    expect(ReviewReportArtifactSchema.safeParse({ taskId: "T", verdict: "FAIL", findings: [{ ...finding, id: "R1" }], reviewed: ["a"] }).success).toBe(false);
    expect(ReviewReportArtifactSchema.safeParse({ taskId: "T", verdict: "FAIL", findings: [{ ...finding, location: "src/a.ts" }], reviewed: ["a"] }).success).toBe(false);
  });
});
