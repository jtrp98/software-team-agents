import { describe, expect, it } from "vitest";
import { createProjectRunner } from "./projectRunner.js";
import type { RuntimeWorkspace } from "../runtime/runtimeAdapter.js";

function workspace(opts: { packageJson?: string; gate?: { stdout: string; exitCode: number | null }; fallback?: { exitCode: number | null; stdout?: string; stderr?: string } } = {}): RuntimeWorkspace & { calls: Array<{ command: string; args: readonly string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  return {
    calls,
    readFile: async () => opts.packageJson ?? null,
    writeFile: async () => undefined,
    exists: async () => true,
    runCommand: async (spec) => {
      calls.push(spec);
      if (spec.args.includes("--json")) return { exitCode: opts.gate?.exitCode ?? 1, stdout: opts.gate?.stdout ?? "not json", stderr: "", timedOut: false };
      return { exitCode: opts.fallback?.exitCode ?? 0, stdout: opts.fallback?.stdout ?? "", stderr: opts.fallback?.stderr ?? "", timedOut: false };
    },
  };
}

describe("createProjectRunner", () => {
  it("uses the existing static gate once and returns actionable typecheck evidence", async () => {
    const ws = workspace({ gate: { exitCode: 1, stdout: JSON.stringify({ results: [
      { check: "lint", status: "passed" }, { check: "typecheck", status: "failed", output: "src/broken.ts(4,7): error TS2322" }, { check: "test", status: "skipped" }, { check: "build", status: "skipped" },
    ] }) } });
    const runner = createProjectRunner({ root: "/target", workspace: ws, staticGatePath: "/framework/.claude/scripts/static-analysis-gate.js" });
    expect((await runner("lint"))?.status).toBe("PASS");
    const typecheck = await runner("typecheck");
    expect(typecheck).toMatchObject({ status: "FAIL" });
    expect(typecheck?.outputSummary).toContain("TS2322");
    expect(await runner("unit-tests")).toBeNull();
    expect(await runner("integration-tests")).toBeNull();
    expect(ws.calls.filter((call) => call.args.includes("--json"))).toHaveLength(1);
    expect(ws.calls[0].cwd).toBe("/target");
  });

  it("keeps absent scripts skipped and does not run the test suite twice", async () => {
    const ws = workspace({ packageJson: JSON.stringify({ scripts: { test: "vitest run" } }) });
    const runner = createProjectRunner({ root: "/target", workspace: ws, npmCliPath: "/npm-cli.js" });
    expect(await runner("lint")).toBeNull();
    expect((await runner("unit-tests"))?.status).toBe("PASS");
    expect(await runner("integration-tests")).toBeNull();
    expect(ws.calls).toHaveLength(1);
    expect(ws.calls[0].args.slice(-3)).toEqual(["run", "--silent", "test"]);
  });
});
