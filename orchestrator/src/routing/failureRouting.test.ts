import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { CATEGORY_DESTINATION, routeByCategory, stagesFromAffected } from "./failureRouting.js";
import { classifyQaFailure, parseOpenIssues } from "../orchestrator/failureClassifier.js";

const FULL_PIPELINE = [
  AgentStage.BUSINESS_ANALYST,
  AgentStage.SYSTEM_ANALYST,
  AgentStage.PROJECT_MANAGER,
  AgentStage.TEST_PLANNER,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
  AgentStage.DEVOPS,
];

/** A review.md shaped the way `qa-engineer.md` specifies its Open Issues table. */
function review(rows: string[], header = "| issue | phase | routes to | blocking | rounds |"): string {
  return [
    "# sales-crm — Verification & Review",
    "",
    "## Open Issues — all phases",
    header,
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Round 3 — Phase 2 (FULL) ❌",
  ].join("\n");
}

describe("routeByCategory (T38)", () => {
  it("routes each of TASKS.md's five categories to the role that owns it", () => {
    const at = (category: Parameters<typeof routeByCategory>[0]) =>
      routeByCategory(category, { pipeline: FULL_PIPELINE }).stage;

    expect(at("implementation")).toBe(AgentStage.BACKEND_ENGINEER);
    expect(at("contract")).toBe(AgentStage.SYSTEM_ANALYST);
    expect(at("requirement")).toBe(AgentStage.BUSINESS_ANALYST);
    expect(at("infrastructure")).toBe(AgentStage.DEVOPS);
    expect(at("test")).toBe(AgentStage.QA_ENGINEER);
  });

  it("refuses to route an unknown category rather than picking something plausible", () => {
    const decision = routeByCategory("unknown", { pipeline: FULL_PIPELINE });
    expect(decision.stage).toBeNull();
    expect(decision.basis).toBe("none");
    expect(decision.reason).toContain("human decision");
  });

  it("lets the affected ids override the declared preference order", () => {
    const decision = routeByCategory("implementation", { pipeline: FULL_PIPELINE, affected: ["FE-010"] });
    expect(decision.stage).toBe(AgentStage.FRONTEND_ENGINEER);
    expect(decision.basis).toBe("affected-ids");
  });

  it("falls back to backend-first when the ids name both sides", () => {
    const decision = routeByCategory("implementation", {
      pipeline: FULL_PIPELINE,
      affected: ["BE-004", "FE-010"],
    });
    expect(decision.stage).toBe(AgentStage.BACKEND_ENGINEER);
    expect(decision.basis).toBe("pipeline-order");
    expect(decision.reason).toContain("§6a");
  });

  it("only considers destinations this task's pipeline actually has", () => {
    const frontendOnly = [AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER];
    const decision = routeByCategory("implementation", { pipeline: frontendOnly });
    expect(decision.stage).toBe(AgentStage.FRONTEND_ENGINEER);
    expect(decision.basis).toBe("category");
  });

  it("returns nothing when the category's destinations are all absent from the pipeline", () => {
    const decision = routeByCategory("requirement", {
      pipeline: [AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER],
    });
    expect(decision.stage).toBeNull();
    expect(decision.reason).toContain("has none of them");
  });

  it("without a pipeline, answers with the category's canonical destination", () => {
    expect(routeByCategory("contract").stage).toBe(AgentStage.SYSTEM_ANALYST);
    expect(routeByCategory("implementation").stage).toBe(AgentStage.BACKEND_ENGINEER);
  });

  it("reads a role off an id prefix, and ignores prefixes that name no role", () => {
    expect(stagesFromAffected(["BE-004"])).toEqual([AgentStage.BACKEND_ENGINEER]);
    expect(stagesFromAffected(["REQ-001", "DES-002"])).toEqual([
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
    ]);
    // TEST-001 names an artifact, not an owner — test-planner chose the level and
    // qa-engineer ran it, and the id cannot tell them apart.
    expect(stagesFromAffected(["TEST-001"])).toEqual([]);
    expect(stagesFromAffected([])).toEqual([]);
  });

  it("keeps `unknown` deliberately unmapped", () => {
    expect(CATEGORY_DESTINATION.unknown).toEqual([]);
  });
});

describe("classifyQaFailure routes by a stated category when no role is named (T38)", () => {
  it("sends a row that says `contract` to system-analyst", () => {
    const failure = classifyQaFailure(
      review(["| refund rule undefined in design.md | Phase 2 | contract | blocking | 1 |"]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure).not.toBeNull();
    expect(failure!.owner).toBe(AgentStage.SYSTEM_ANALYST);
    expect(failure!.category).toBe("contract");
    expect(failure!.requiresHuman).toBe(false);
    // The route says why it went where it went, so a wrong one is visible rather than mysterious.
    expect(failure!.reason).toContain("routed by category");
  });

  it("uses the affected ids to pick a side within `implementation`", () => {
    const failure = classifyQaFailure(
      review(["| FE-010 spacing wrong on the refund modal | Phase 2 | implementation | blocking | 0 |"]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure!.owner).toBe(AgentStage.FRONTEND_ENGINEER);
  });

  it("reads a `Type:` label as well as a bare cell", () => {
    const failure = classifyQaFailure(
      review(["| missing rate limit on the upload route | Phase 3 | Type: infrastructure | blocking | 0 |"]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure!.owner).toBe(AgentStage.DEVOPS);
  });

  it("still stops for a person when the rows name neither a role nor a category", () => {
    const failure = classifyQaFailure(review(["| something is wrong somewhere | Phase 2 | ??? | blocking | 1 |"]));
    expect(failure!.requiresHuman).toBe(true);
    expect(failure!.owner).toBe(AgentStage.HUMAN);
    // Unchanged from before T38: a row stating nothing routable is not a row at
    // all, so this is the pre-existing "names no agent" stop, not a new one.
    expect(failure!.reason).toContain("names no agent to route it to");
  });

  it("stops for a person when the stated categories disagree, exactly as conflicting owners do", () => {
    const failure = classifyQaFailure(
      review([
        "| refund rule undefined | Phase 2 | contract | blocking | 0 |",
        "| deploy script broken | Phase 2 | infrastructure | blocking | 0 |",
      ]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure!.requiresHuman).toBe(true);
    expect(failure!.reason).toContain("more than one problem category");
  });

  it("stops for a person when the stated category has nowhere to go in this pipeline", () => {
    const failure = classifyQaFailure(
      review(["| requirement is ambiguous | Phase 1 | requirement | blocking | 0 |"]),
      { pipeline: [AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER] },
    );
    expect(failure!.requiresHuman).toBe(true);
    expect(failure!.reason).toContain("has none of them");
  });

  it("a named role still wins over a stated category — a person's decision is the stronger signal", () => {
    const failure = classifyQaFailure(
      review(["| BE-004 response shape | Phase 2 | backend-engineer / contract | blocking | 0 |"]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure!.owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(failure!.reason).not.toContain("routed by category");
  });

  it("applies the two-round ceiling to a category-routed item as well", () => {
    const failure = classifyQaFailure(
      review(["| refund rule still undefined | Phase 2 | contract | blocking | 2 |"]),
      { pipeline: FULL_PIPELINE },
    );
    expect(failure!.requiresHuman).toBe(true);
    expect(failure!.retryable).toBe(false);
    expect(failure!.reason).toContain("ceiling");
  });

  it("keeps a category-only row in parseOpenIssues instead of dropping it as ownerless", () => {
    const rows = parseOpenIssues(review(["| refund rule undefined | Phase 2 | contract | blocking | 1 |"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBeNull();
    expect(rows[0].category).toBe("contract");
  });

  it("does not read a category out of prose that merely mentions the word", () => {
    // "implementation" appears inside a sentence, not as a stated type — the same
    // standard the owner column is held to.
    const rows = parseOpenIssues(
      review(["| the implementation of this looks off to me | Phase 2 | ??? | blocking | 0 |"]),
    );
    expect(rows).toEqual([]);
  });
});
