import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_ORDER,
  runDeterministicVerification,
  renderDeterministicVerification,
  type DeterministicCheckResult,
} from "./deterministic.js";

function pass(id: (typeof DETERMINISTIC_ORDER)[number], durationMs = 10): DeterministicCheckResult {
  return { id, status: "PASS", durationMs, outputSummary: `${id} ok` };
}
function fail(id: (typeof DETERMINISTIC_ORDER)[number]): DeterministicCheckResult {
  return { id, status: "FAIL", durationMs: 3, outputSummary: `${id}: error TS2345 somewhere.ts` };
}

describe("runDeterministicVerification", () => {
  it("runs every check in the fixed order when all pass", async () => {
    const order: string[] = [];
    const v = await runDeterministicVerification((id) => {
      order.push(id);
      return pass(id);
    });
    expect(order).toEqual([...DETERMINISTIC_ORDER]);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.skipped).toEqual([]);
  });

  it("stops at the first failure and does not run later checks", async () => {
    const ran: string[] = [];
    const v = await runDeterministicVerification((id) => {
      ran.push(id);
      return id === "typecheck" ? fail(id) : id === "lint" ? pass(id) : null;
    });
    expect(ran).toEqual(["lint", "typecheck"]);
    expect(v.passed).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].id).toBe("typecheck");
  });

  it("records unconfigured checks as skipped, not failed", async () => {
    const v = await runDeterministicVerification((id) => (id === "build" ? pass(id) : null));
    expect(v.passed).toBe(true);
    expect(v.ran.map((r) => r.id)).toEqual(["build"]);
    expect(v.skipped).toEqual(["lint", "typecheck", "unit-tests", "integration-tests"]);
  });

  it("turns a throwing runner into a FAIL instead of crashing the pipeline", async () => {
    const v = await runDeterministicVerification(() => {
      throw new Error("spawn ENOENT");
    });
    expect(v.passed).toBe(false);
    expect(v.failures[0].outputSummary).toMatch(/spawn ENOENT/);
  });
});

describe("renderDeterministicVerification", () => {
  it("says plainly when nothing is configured", async () => {
    const v = await runDeterministicVerification(() => null);
    const text = renderDeterministicVerification(v).join("\n");
    expect(text).toMatch(/no checks configured/);
  });

  it("renders the blocking failure with tool output for the fix round", async () => {
    const v = await runDeterministicVerification((id) => (id === "lint" ? fail(id) : null));
    const text = renderDeterministicVerification(v).join("\n");
    expect(text).toContain("BLOCKED before LLM QA");
    expect(text).toContain("error TS2345");
    expect(text).toContain("SKIPPED");
  });
});
