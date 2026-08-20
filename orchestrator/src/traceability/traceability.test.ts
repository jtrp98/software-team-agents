import { describe, expect, it } from "vitest";
import { buildTraceChain, checkTraceability, extractIds, type TraceInputs } from "./traceability.js";

const REQUIREMENT_MD = `
# Sales CRM — Requirements

## Core Features
- REQ-001: Users can log in with email and password.
- REQ-002: Users can create an order.
- REQ-003: Admins can export a report.
`;

const DESIGN_MD = `
# Sales CRM — Feasibility & Design

**Contract Version:** 1

## Feature-by-Feature Feasibility
- DES-001 — covers REQ-001: straightforward, standard JWT login.
- DES-002 — covers REQ-002: straightforward, needs an Order model.
`;

function planMd(overrides: { orderChecked?: boolean; loginChecked?: boolean } = {}): string {
  const login = overrides.loginChecked ? "verified" : "pending";
  const order = overrides.orderChecked ? "verified" : "pending";
  return `
# Sales CRM — Implementation Plan

## Phase 1: Auth

| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-001 (DES-001) — implement /login | ${login} | backend-engineer | — |
| FE-001 (DES-001) — build login form | ${login} | frontend-engineer | — |

## Phase 2: Orders

| Task | Status | Owner | Depends on |
|---|---|---|---|
| BE-002 (DES-002) — implement POST /orders | ${order} | backend-engineer | — |
`;
}

function inputs(over: Partial<TraceInputs> = {}): TraceInputs {
  return { requirementMd: REQUIREMENT_MD, designMd: DESIGN_MD, planMd: planMd(), ...over };
}

describe("extractIds", () => {
  it("extracts every REQ id in first-appearance order, deduped", () => {
    expect(extractIds(REQUIREMENT_MD, "REQ")).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });

  it("returns an empty array when the prefix doesn't appear", () => {
    expect(extractIds(REQUIREMENT_MD, "DES")).toEqual([]);
  });
});

describe("buildTraceChain", () => {
  it("marks a requirement with no design coverage as unplanned", () => {
    const chain = buildTraceChain(inputs());
    const req3 = chain.find((e) => e.requirement === "REQ-003")!;
    expect(req3.status).toBe("unplanned");
    expect(req3.design).toEqual([]);
    expect(req3.tasks).toEqual([]);
  });

  it("marks a requirement with design but no tasks as planned", () => {
    const chain = buildTraceChain({ ...inputs(), planMd: "# empty plan\n" });
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    expect(req1.status).toBe("planned");
    expect(req1.design).toEqual(["DES-001"]);
  });

  it("marks a requirement with unchecked tasks as in-progress", () => {
    const chain = buildTraceChain(inputs());
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    expect(req1.status).toBe("in-progress");
    expect(req1.tasks.sort()).toEqual(["BE-001", "FE-001"]);
  });

  it("marks a requirement verified once every one of its tasks is checked", () => {
    const chain = buildTraceChain({ ...inputs(), planMd: planMd({ loginChecked: true }) });
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    expect(req1.status).toBe("verified");
  });

  it("does not verify a requirement just because a different requirement's tasks are checked", () => {
    const chain = buildTraceChain({ ...inputs(), planMd: planMd({ orderChecked: true }) });
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    const req2 = chain.find((e) => e.requirement === "REQ-002")!;
    expect(req1.status).toBe("in-progress");
    expect(req2.status).toBe("verified");
  });

  it("marks a requirement blocked when review.md has a blocking open issue naming its task", () => {
    const reviewMd = `
## Open Issues — all phases
| Issue | Phase | Routes to | Blocking | Rounds |
|---|---|---|---|---|
| BE-001 login validation is wrong | 1 | backend-engineer | blocking | 1 |
`;
    const chain = buildTraceChain({ ...inputs(), planMd: planMd({ loginChecked: true }), reviewMd });
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    expect(req1.status).toBe("blocked");
  });

  it("a non-blocking open issue does not prevent verified", () => {
    const reviewMd = `
## Open Issues — all phases
| Issue | Phase | Routes to | Blocking | Rounds |
|---|---|---|---|---|
| BE-001 minor copy nit | 1 | backend-engineer | non-blocking | 1 |
`;
    const chain = buildTraceChain({ ...inputs(), planMd: planMd({ loginChecked: true }), reviewMd });
    const req1 = chain.find((e) => e.requirement === "REQ-001")!;
    expect(req1.status).toBe("verified");
  });

  it("returns one entry per requirement, in requirement order", () => {
    const chain = buildTraceChain(inputs());
    expect(chain.map((e) => e.requirement)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });
});

describe("checkTraceability", () => {
  it("flags unplanned and planned requirements, not in-progress/verified/blocked ones", () => {
    const chain = buildTraceChain(inputs());
    const result = checkTraceability(chain);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("REQ-003");
    expect(result.problems[0]).toContain("no design.md coverage");
  });

  it("passes when nothing is unplanned or unplanned-but-designed", () => {
    const reqMd = `## Core Features\n- REQ-001: login.\n`;
    const chain = buildTraceChain({
      requirementMd: reqMd,
      designMd: DESIGN_MD,
      planMd: planMd({ loginChecked: true }),
    });
    expect(checkTraceability(chain).ok).toBe(true);
  });
});
