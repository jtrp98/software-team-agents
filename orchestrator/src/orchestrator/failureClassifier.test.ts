import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { routeFailure, validateStructuredFailure } from "./failure.js";
import {
  REROUTE_CEILING,
  classifyQaFailure,
  classifySecurityFailure,
  parseOpenIssues,
} from "./failureClassifier.js";

/** A review.md shaped the way `qa-engineer.md` specifies its Open Issues table. */
function review(rows: string[], extra = ""): string {
  return [
    "# sales-crm — Verification & Review",
    "",
    "## Open Issues — all phases",
    "| issue | phase | routes to | blocking | rounds |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Verification Summary (current round)",
    `Phase 2 (FULL) — ❌ ไม่ผ่าน ${extra}`,
    "",
  ].join("\n");
}

describe("parseOpenIssues", () => {
  it("reads the owner, blocking flag, round count and affected ids off a row", () => {
    const rows = parseOpenIssues(
      review(["| BE-004 response shape ไม่ตรง design | Phase 2 | backend-engineer | blocking | 1 |"]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(rows[0].blocking).toBe(true);
    expect(rows[0].rounds).toBe(1);
    expect(rows[0].affected).toEqual(["BE-004"]);
  });

  it("skips the header and separator rows, which name no agent", () => {
    expect(parseOpenIssues(review([]))).toEqual([]);
  });

  it("does not read `non-blocking` as blocking", () => {
    const rows = parseOpenIssues(review(["| FE-010 spacing | Phase 2 | frontend-engineer | non-blocking | 0 |"]));
    expect(rows[0].blocking).toBe(false);
  });

  it("reads a Thai blocking marker and a Thai round count", () => {
    const rows = parseOpenIssues(review(["| BE-004 ผิด | Phase 2 | backend-engineer | บล็อก | 2 รอบ |"]));
    expect(rows[0].blocking).toBe(true);
    expect(rows[0].rounds).toBe(2);
  });

  it("matches the longest role name, so backend-engineer is never read as engineer", () => {
    const rows = parseOpenIssues(review(["| x | Phase 1 | backend-engineer | blocking | 0 |"]));
    expect(rows[0].owner).toBe(AgentStage.BACKEND_ENGINEER);
  });

  it("returns nothing when the document has no Open Issues section at all", () => {
    expect(parseOpenIssues("# r\n\n## Round 1\n❌ ไม่ผ่าน\n")).toEqual([]);
  });
});

describe("classifyQaFailure", () => {
  it("routes an implementation bug to the engineer the QA agent named", () => {
    const failure = classifyQaFailure(
      review(["| BE-004 response shape ไม่ตรง design | Phase 2 | backend-engineer | blocking | 1 |"]),
    )!;
    expect(failure.category).toBe("implementation");
    expect(failure.owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(failure.retryable).toBe(true);
    expect(failure.requiresHuman).toBe(false);
    expect(failure.affected).toEqual(["BE-004"]);
    expect(() => validateStructuredFailure(failure)).not.toThrow();
  });

  /** The distinction that did not exist before T06: a schema gap is not a backend bug. */
  it("classifies a schema gap as a contract failure owned by system-analyst", () => {
    const failure = classifyQaFailure(
      review(["| design.md ไม่ได้ระบุ field discount | Phase 2 | system-analyst | blocking | 0 |"]),
    )!;
    expect(failure.category).toBe("contract");
    expect(failure.owner).toBe(AgentStage.SYSTEM_ANALYST);
  });

  it("classifies a business rule gap as a requirement failure owned by business-analyst", () => {
    const failure = classifyQaFailure(
      review(["| ยังไม่ได้ตัดสินใจเรื่อง refund | Phase 2 | business-analyst | blocking | 0 |"]),
    )!;
    expect(failure.category).toBe("requirement");
    expect(failure.owner).toBe(AgentStage.BUSINESS_ANALYST);
  });

  it("lets blocking rows decide the route and ignores non-blocking noise", () => {
    const failure = classifyQaFailure(
      review([
        "| FE-010 spacing | Phase 2 | frontend-engineer | non-blocking | 0 |",
        "| BE-004 wrong shape | Phase 2 | backend-engineer | blocking | 0 |",
      ]),
    )!;
    expect(failure.owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(failure.severity).toBe("high");
  });

  it("falls back to non-blocking rows when nothing is marked blocking", () => {
    const failure = classifyQaFailure(review(["| FE-010 spacing | Phase 2 | frontend-engineer | no | 0 |"]))!;
    expect(failure.owner).toBe(AgentStage.FRONTEND_ENGINEER);
    expect(failure.severity).toBe("medium");
  });

  it("returns null when the round reports nothing wrong — a pass is not a failure to route", () => {
    expect(classifyQaFailure("# r\n\n## Open Issues — all phases\n(ไม่มี)\n\n## Round 1\n✅ ผ่าน\n")).toBeNull();
  });

  describe("never guessing an owner", () => {
    /** The expensive failure mode: a wrong owner costs two fresh-context runs and fixes the wrong thing. */
    it("escalates when the round failed but no agent is named", () => {
      const failure = classifyQaFailure("# r\n\n## Open Issues — all phases\n\n## Round 1 (FULL)\n❌ ไม่ผ่าน\n")!;
      expect(failure.category).toBe("unknown");
      expect(failure.requiresHuman).toBe(true);
      expect(failure.owner).toBe(AgentStage.HUMAN);
    });

    it("escalates when blocking rows disagree about who owns the failure", () => {
      const failure = classifyQaFailure(
        review([
          "| BE-004 wrong shape | Phase 2 | backend-engineer | blocking | 0 |",
          "| design gap | Phase 2 | system-analyst | blocking | 0 |",
        ]),
      )!;
      expect(failure.category).toBe("unknown");
      expect(failure.requiresHuman).toBe(true);
      expect(failure.reason).toContain("more than one owner");
      // The ids from both rows survive, so the person deciding sees the whole picture.
      expect(failure.affected).toContain("BE-004");
    });
  });

  describe("the two-round ceiling", () => {
    it("stops routing an item back once it has had as many rounds as the ceiling", () => {
      const failure = classifyQaFailure(
        review([`| BE-004 ยังผิดอยู่ | Phase 2 | backend-engineer | blocking | ${REROUTE_CEILING} |`]),
      )!;
      expect(failure.requiresHuman).toBe(true);
      expect(failure.retryable).toBe(false);
      expect(failure.reason).toContain("misrouted, not badly implemented");
      // The owner is still recorded — escalating is not the same as forgetting who it was.
      expect(failure.owner).toBe(AgentStage.BACKEND_ENGINEER);
    });

    it("still routes an item that is below the ceiling", () => {
      const failure = classifyQaFailure(
        review([`| BE-004 | Phase 2 | backend-engineer | blocking | ${REROUTE_CEILING - 1} |`]),
      )!;
      expect(failure.requiresHuman).toBe(false);
    });
  });
});

describe("classifySecurityFailure", () => {
  const SECURITY = [
    "# sales-crm — Security Audit",
    "",
    "## Open Findings — all rounds",
    "- 🔴 🔵 SEC-001 JWT ไม่ได้ verify signature ใน middleware",
    "- 🟡 ⚪ SEC-002 header ขาด X-Frame-Options (ยอมรับความเสี่ยง)",
    "",
  ].join("\n");

  it("reports an unresolved Critical finding as a human stop, not a route", () => {
    const failure = classifySecurityFailure(SECURITY)!;
    expect(failure.severity).toBe("critical");
    expect(failure.requiresHuman).toBe(true);
    expect(failure.retryable).toBe(false);
    expect(failure.affected).toContain("SEC-001");
  });

  it("ignores findings already accepted or fixed — only security closes one, and it did", () => {
    const closed = [
      "# s",
      "",
      "## Open Findings — all rounds",
      "- 🟡 ⚪ SEC-002 accepted",
      "- 🔴 ✅ SEC-003 fixed and re-audited",
      "",
    ].join("\n");
    expect(classifySecurityFailure(closed)).toBeNull();
  });

  /** 🟣 means an engineer claimed a fix; only `security` may close it, so it still blocks. */
  it("treats a claimed fix as still unresolved", () => {
    const claimed = "# s\n\n## Open Findings — all rounds\n- 🟠 🟣 SEC-004 engineer says fixed\n";
    const failure = classifySecurityFailure(claimed)!;
    expect(failure.requiresHuman).toBe(true);
    expect(failure.severity).toBe("high");
  });

  it("returns null when there are no findings at all", () => {
    expect(classifySecurityFailure("# s\n\n## Open Findings — all rounds\n(ไม่พบ)\n")).toBeNull();
  });
});

/** The classifier only supplies facts; routeFailure draws the conclusion. These are the two halves meeting. */
describe("classified failures routed by the orchestrator", () => {
  const PIPELINE = [
    AgentStage.BACKEND_ENGINEER,
    AgentStage.FRONTEND_ENGINEER,
    AgentStage.QA_ENGINEER,
    AgentStage.DEVOPS,
  ];

  it("sends a backend bug back to backend-engineer, not to the front of the pipeline", () => {
    const failure = classifyQaFailure(review(["| BE-004 wrong shape | Phase 2 | backend-engineer | blocking | 0 |"]))!;
    const route = routeFailure(failure, PIPELINE);
    expect(route).toEqual({ kind: "RETRY_STAGE", stage: AgentStage.BACKEND_ENGINEER, reason: failure.reason });
  });

  /** T06 names the owner, T07 gave the machine an edge to reach it — together they replace a blanket escalation. */
  it("recovers a contract failure to system-analyst instead of retrying an engineer", () => {
    const failure = classifyQaFailure(review(["| design gap | Phase 2 | system-analyst | blocking | 0 |"]))!;
    const route = routeFailure(failure, [AgentStage.SYSTEM_ANALYST, ...PIPELINE]);
    expect(route.kind).toBe("RECOVER");
    if (route.kind === "RECOVER") expect(route.stage).toBe(AgentStage.SYSTEM_ANALYST);
  });

  it("escalates an unresolved security finding", () => {
    const failure = classifySecurityFailure("# s\n\n## Open Findings\n- 🔴 🔵 SEC-001 broken auth\n")!;
    expect(routeFailure(failure, PIPELINE).kind).toBe("ESCALATE");
  });

  it("escalates once the ceiling is hit, instead of sending the same item back a third time", () => {
    const failure = classifyQaFailure(
      review([`| BE-004 | Phase 2 | backend-engineer | blocking | ${REROUTE_CEILING} |`]),
    )!;
    expect(routeFailure(failure, PIPELINE).kind).toBe("ESCALATE");
  });
});
