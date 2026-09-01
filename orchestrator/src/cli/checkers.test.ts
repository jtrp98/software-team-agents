import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKERS, runChecker, type CheckerDescriptor } from "./checkers.js";
import { parseArgs } from "../cli.js";

const cliSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts"),
  "utf8",
);

/**
 * The frozen expectation for every descriptor. If a message or heading changes,
 * this test fails and the `T-V4-CLI-001` baseline must be re-justified — the two
 * are the oracle for "the 18 blocks still print byte-identically".
 */
const EXPECTED: Record<string, { ok: string; fail: string; notes: CheckerDescriptor["notes"] }> = {
  "--check-contracts": {
    ok: "[orchestrator] contracts/*.yaml agree with the agent registry, and their path rules are sane.",
    fail: "[orchestrator] contracts/*.yaml have problems:",
    notes: "none",
  },
  "--check-layout": {
    ok: "[orchestrator] layout.yaml agrees with the repo.",
    fail: "[orchestrator] layout.yaml and the repo disagree:",
    notes: "none",
  },
  "--check-prompt-budget": {
    ok: "[orchestrator] static prompt budget holds.",
    fail: "[orchestrator] static prompt budget exceeded:",
    notes: "trailing-on-success",
  },
  "--check-workflows": {
    ok: "[orchestrator] workflows/*.yml agree with the classifier.",
    fail: "[orchestrator] workflows/*.yml and the classifier disagree:",
    notes: "none",
  },
  "--check-bindings": {
    ok: "[orchestrator] .codex/agents bindings match the .claude/agents sources.",
    fail: "[orchestrator] codex role bindings have drifted from their sources:",
    notes: "none",
  },
  "--check-profile": {
    ok: "[orchestrator] project.yaml and stacks/ agree with the agent roster.",
    fail: "[orchestrator] project.yaml and the agent roster disagree:",
    notes: "leading",
  },
  "--check-decisions": {
    ok: "[orchestrator] decisions/*.md agree with the schema and cross-link cleanly.",
    fail: "[orchestrator] decisions/*.md have problems:",
    notes: "none",
  },
  "--check-test-pyramid": {
    ok: "[orchestrator] test-pyramid.yaml agrees with its schema.",
    fail: "[orchestrator] test-pyramid.yaml has problems:",
    notes: "none",
  },
  "--check-review-separation": {
    ok: "[orchestrator] no agent can review its own work.",
    fail: "[orchestrator] creator/reviewer separation is broken:",
    notes: "leading",
  },
  "--check-escalation-policy": {
    ok: "[orchestrator] escalation-policy.yaml agrees with the runtime policy.",
    fail: "[orchestrator] escalation-policy.yaml has problems:",
    notes: "leading",
  },
  "--check-workspace": {
    ok: "[orchestrator] workspace.yaml is fine.",
    fail: "[orchestrator] workspace.yaml has problems:",
    notes: "leading",
  },
  "--check-repos": {
    ok: "[orchestrator] repos.yaml is fine.",
    fail: "[orchestrator] repos.yaml has problems:",
    notes: "leading",
  },
  "--check-environments": {
    ok: "[orchestrator] environments.yaml is fine.",
    fail: "[orchestrator] environments.yaml has problems:",
    notes: "leading",
  },
  "--check-doc-structure": {
    ok: "[orchestrator] every module document present has the sections its schema requires.",
    fail: "[orchestrator] module documents have structural problems:",
    notes: "leading",
  },
  "--check-plan": {
    ok: "[orchestrator] every plan.md checked is a valid task graph.",
    fail: "[orchestrator] plan task graphs have problems:",
    notes: "leading",
  },
  "--check-knowledge": {
    ok: "[orchestrator] knowledge/ is consistent.",
    fail: "[orchestrator] knowledge/ has problems:",
    notes: "leading",
  },
  "--check-installation": {
    // T-V5-004 re-justified this baseline: the checker now follows the installer
    // (.agent-team/ first, .sta/ as legacy), so the wording is layout-neutral.
    ok: "[orchestrator] installation metadata (.agent-team/, or legacy .sta/) agrees with the project's real files.",
    fail: "[orchestrator] installation metadata has problems:",
    notes: "leading",
  },
  "--check-roles": {
    ok: "[orchestrator] every role workspace agrees with knowledge/.",
    fail: "[orchestrator] role workspaces have problems:",
    notes: "leading",
  },
};

function captureConsole(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...p: unknown[]) => out.push(p.join(" "));
  console.error = (...p: unknown[]) => err.push(p.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

describe("CHECKERS table (T-V4-CLI-002)", () => {
  it("carries the ok message, fail heading and notes mode for every descriptor", () => {
    const actual = Object.fromEntries(
      CHECKERS.map((c) => [c.cliFlag, { ok: c.okMessage, fail: c.failHeading, notes: c.notes }]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("is a plain array of 18 rows in the same order the if-chain evaluated", () => {
    expect(CHECKERS).toHaveLength(18);
    expect(CHECKERS.map((c) => c.cliFlag)).toEqual(Object.keys(EXPECTED));
  });

  it("has a descriptor for every `--check-*` flag parseArgs accepts, and no extra", () => {
    // Every `arg === "--check-…"` branch in parseArgs, straight from the source.
    const acceptedByParseArgs = [
      ...new Set([...cliSource.matchAll(/arg === "(--check-[a-z-]+)"/g)].map((m) => m[1])),
    ].sort();
    const inTable = CHECKERS.map((c) => c.cliFlag).sort();
    expect(inTable).toEqual(acceptedByParseArgs);
  });

  it("each descriptor's flag is the CliArgs field parseArgs sets for its cliFlag", () => {
    for (const c of CHECKERS) {
      const args = parseArgs([c.cliFlag], "/repo") as unknown as Record<string, unknown>;
      expect(args[c.flag]).toBe(true);
    }
  });
});

describe("runChecker output (T-V4-CLI-002)", () => {
  const base: CheckerDescriptor = {
    flag: "checkContracts",
    cliFlag: "--check-x",
    run: () => ({ ok: true, problems: [], notes: [] }),
    okMessage: "[orchestrator] ok.",
    failHeading: "[orchestrator] bad:",
    notes: "none",
  };

  it("success: prints only the ok message on stdout, exit 0", () => {
    const { out, err } = captureConsole(() => {
      expect(runChecker(base, "/root", undefined)).toBe(0);
    });
    expect(out).toEqual(["[orchestrator] ok."]);
    expect(err).toEqual([]);
  });

  it("failure: prints the heading then `  - <problem>` on stderr, exit 1", () => {
    const d = { ...base, run: () => ({ ok: false, problems: ["p1", "p2"], notes: ["ignored"] }) };
    const { out, err } = captureConsole(() => {
      expect(runChecker(d, "/root", undefined)).toBe(1);
    });
    expect(out).toEqual([]);
    expect(err).toEqual(["[orchestrator] bad:", "  - p1", "  - p2"]);
  });

  it("notes 'leading': `[orchestrator] note: <n>` before the ok/fail branch, both paths", () => {
    const ok = { ...base, notes: "leading" as const, run: () => ({ ok: true, problems: [], notes: ["n1"] }) };
    expect(captureConsole(() => runChecker(ok, "/r", undefined)).out).toEqual([
      "[orchestrator] note: n1",
      "[orchestrator] ok.",
    ]);
    const bad = { ...base, notes: "leading" as const, run: () => ({ ok: false, problems: ["p"], notes: ["n1"] }) };
    const cap = captureConsole(() => runChecker(bad, "/r", undefined));
    expect(cap.out).toEqual(["[orchestrator] note: n1"]);
    expect(cap.err).toEqual(["[orchestrator] bad:", "  - p"]);
  });

  it("notes 'trailing-on-success': `  - <n>` after the ok message, success path only", () => {
    const ok = {
      ...base,
      notes: "trailing-on-success" as const,
      run: () => ({ ok: true, problems: [], notes: ["n1", "n2"] }),
    };
    expect(captureConsole(() => runChecker(ok, "/r", undefined)).out).toEqual([
      "[orchestrator] ok.",
      "  - n1",
      "  - n2",
    ]);
    const bad = {
      ...base,
      notes: "trailing-on-success" as const,
      run: () => ({ ok: false, problems: ["p"], notes: ["n1"] }),
    };
    const cap = captureConsole(() => runChecker(bad, "/r", undefined));
    expect(cap.out).toEqual([]);
    expect(cap.err).toEqual(["[orchestrator] bad:", "  - p"]);
  });

  it("notes 'none': notes are never printed", () => {
    const d = { ...base, run: () => ({ ok: true, problems: [], notes: ["never shown"] }) };
    expect(captureConsole(() => runChecker(d, "/r", undefined)).out).toEqual(["[orchestrator] ok."]);
  });

  it("passes moduleName through to run (only --check-plan reads it)", () => {
    let seen: string | undefined = "unset";
    const d: CheckerDescriptor = {
      ...base,
      run: (_root, moduleName) => {
        seen = moduleName;
        return { ok: true, problems: [], notes: [] };
      },
    };
    captureConsole(() => runChecker(d, "/r", "sales-crm"));
    expect(seen).toBe("sales-crm");
  });

  it("a hypothetical 19th checker is exactly one self-contained row", () => {
    const nineteenth: CheckerDescriptor = {
      flag: "checkRoles",
      cliFlag: "--check-teapot",
      run: () => ({ ok: true, problems: [], notes: [] }),
      okMessage: "[orchestrator] teapot is a teapot.",
      failHeading: "[orchestrator] teapot problems:",
      notes: "none",
    };
    // No production code changed: the loop in runCli would pick it up from
    // `[...CHECKERS, nineteenth]` unmodified.
    const { out } = captureConsole(() => {
      for (const c of [...CHECKERS.slice(0, 0), nineteenth]) {
        if (c.cliFlag === "--check-teapot") runChecker(c, "/r", undefined);
      }
    });
    expect(out).toEqual(["[orchestrator] teapot is a teapot."]);
  });
});
