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
    expect(v.status).toBe("passed");
  });

  it("executes only selected levels in fixed order", async () => {
    const order: string[] = [];
    const v = await runDeterministicVerification((id) => {
      order.push(id);
      return pass(id);
    }, { levels: ["unit", "lint", "typecheck", "build"] });
    expect(order).toEqual(["lint", "typecheck", "unit-tests", "build"]);
    expect(v.required).toEqual(order);
    expect(v.passed).toBe(true);
  });

  it("warns by default but fails only after explicit enforcement when required evidence is missing", async () => {
    const warn = await runDeterministicVerification(() => null, { levels: ["lint", "unit"] });
    expect(warn).toMatchObject({ status: "skipped", enforcement: "warn", passed: true });
    expect(renderDeterministicVerification(warn).join("\n")).toContain("SKIPPED (not PASS)");

    const enforce = await runDeterministicVerification(() => null, {
      levels: ["lint", "unit"],
      enforcement: "enforce",
    });
    expect(enforce).toMatchObject({ status: "skipped", enforcement: "enforce", passed: false });
    expect(renderDeterministicVerification(enforce).join("\n")).toContain("BLOCKED by test-pyramid enforcement");
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

  it("renders the recorded change-aware selection and reason", async () => {
    const v = await runDeterministicVerification((id) => pass(id), {
      levels: ["lint", "unit", "build"],
    });
    v.selection = {
      source: "change-scope",
      taskTypes: ["ui-component"],
      levels: ["lint", "unit", "build"],
      reason: "bounded scope resolved every changed file",
    };
    const text = renderDeterministicVerification(v).join("\n");
    expect(text).toContain("verification selection: change-scope; task types: ui-component");
    expect(text).toContain("selection reason: bounded scope resolved every changed file");
  });

  it("renders per-target deterministic results when verification ran across multiple targets (T-V9-015)", () => {
    const v: Parameters<typeof renderDeterministicVerification>[0] = {
      required: ["lint", "typecheck"],
      ran: [
        {
          id: "typecheck",
          status: "PASS",
          durationMs: 25,
          outputSummary: "[api: /t/api] ok\n[web: /t/web] ok",
          targetResults: [
            { targetId: "api", root: "/t/api", status: "PASS", durationMs: 12, outputSummary: "api ok" },
            { targetId: "web", root: "/t/web", status: "PASS", durationMs: 13, outputSummary: "web ok" },
          ],
        },
      ],
      failures: [],
      skipped: [],
      missingRequired: [],
      status: "passed",
      enforcement: "warn",
      passed: true,
    };
    const lines = renderDeterministicVerification(v);
    expect(lines).toContain("- typecheck: PASS (25ms)");
    expect(lines).toContain("  - [api] PASS (12ms) — api ok");
    expect(lines).toContain("  - [web] PASS (13ms) — web ok");
  });

  it("names the failing Target when deterministic verification fails in a multi-target task (T-V9-015)", () => {
    const v: Parameters<typeof renderDeterministicVerification>[0] = {
      required: ["typecheck"],
      ran: [
        {
          id: "typecheck",
          status: "FAIL",
          durationMs: 20,
          outputSummary: "[api: /t/api] ok\n[web: /t/web] error TS2322 in src/app.tsx",
          targetResults: [
            { targetId: "api", root: "/t/api", status: "PASS", durationMs: 10, outputSummary: "api ok" },
            { targetId: "web", root: "/t/web", status: "FAIL", durationMs: 10, outputSummary: "error TS2322 in src/app.tsx" },
          ],
        },
      ],
      failures: [
        {
          id: "typecheck",
          status: "FAIL",
          durationMs: 20,
          outputSummary: "[api: /t/api] ok\n[web: /t/web] error TS2322 in src/app.tsx",
          targetResults: [
            { targetId: "api", root: "/t/api", status: "PASS", durationMs: 10, outputSummary: "api ok" },
            { targetId: "web", root: "/t/web", status: "FAIL", durationMs: 10, outputSummary: "error TS2322 in src/app.tsx" },
          ],
        },
      ],
      skipped: [],
      missingRequired: [],
      status: "failed",
      enforcement: "warn",
      passed: false,
    };
    const text = renderDeterministicVerification(v).join("\n");
    expect(text).toContain("BLOCKED before LLM QA by deterministic check `typecheck` in Target (web):");
    expect(text).toContain("error TS2322 in src/app.tsx");
  });

  it("preserves byte-identical rendering shape for solo tasks (T-V9-015)", () => {
    const v: Parameters<typeof renderDeterministicVerification>[0] = {
      required: ["lint"],
      ran: [
        {
          id: "lint",
          status: "PASS",
          durationMs: 10,
          outputSummary: "lint ok",
        },
      ],
      failures: [],
      skipped: [],
      missingRequired: [],
      status: "passed",
      enforcement: "warn",
      passed: true,
    };
    const lines = renderDeterministicVerification(v);
    expect(lines).toEqual(["- lint: PASS (10ms) — lint ok"]);
  });
});
