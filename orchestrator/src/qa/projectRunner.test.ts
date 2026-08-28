import { describe, expect, it } from "vitest";
import { createProjectRunner } from "./projectRunner.js";
import type { RuntimeWorkspace } from "../runtime/runtimeAdapter.js";

function workspace(opts: { packageJson?: string; configYaml?: string; gate?: { stdout: string; exitCode: number | null }; fallback?: { exitCode: number | null; stdout?: string; stderr?: string } } = {}): RuntimeWorkspace & { calls: Array<{ command: string; args: readonly string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  return {
    calls,
    readFile: async (relPath) => relPath === ".agent-team/config.yaml" ? opts.configYaml ?? null : relPath === "package.json" ? opts.packageJson ?? null : null,
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

  it("uses resolved profile commands without consulting npmCliPath", async () => {
    const configYaml = `schema_version: 1
target_id: dotnet-fixture
registered_at: 2026-08-27T00:00:00Z
role: dev
stack:
  profile: dotnet
  package_manager: nuget
  commands:
    install: dotnet restore
    build: dotnet build
    test: dotnet test
    lint: dotnet format --verify-no-changes
    typecheck: dotnet build
  schema_paths: []
  source_roots: [.]
  detected_at: 2026-08-27T00:00:00Z
  fingerprint: sha256:fixture
overrides: []
`;
    const ws = workspace({ configYaml, fallback: { exitCode: 0, stdout: "profile command passed" } });
    const runner = createProjectRunner({ root: "/target", workspace: ws, npmCliPath: "/must-not-be-used/npm-cli.js" });

    expect((await runner("lint"))?.status).toBe("PASS");
    expect((await runner("unit-tests"))?.status).toBe("PASS");
    expect((await runner("build"))?.status).toBe("PASS");
    expect(ws.calls).toHaveLength(3);
    expect(ws.calls.map((call) => call.args.at(-1))).toEqual([
      "dotnet format --verify-no-changes",
      "dotnet test",
      "dotnet build",
    ]);
    expect(JSON.stringify(ws.calls)).not.toContain("npm-cli.js");
  });

  it("turns an all-skipped profile gate into a deterministic failure before LLM QA", async () => {
    const ws = workspace({ gate: { exitCode: 2, stdout: JSON.stringify({
      ok: false,
      verification: "unverified",
      profile: "dotnet",
      results: [
        { check: "lint", status: "skipped" },
        { check: "typecheck", status: "skipped" },
        { check: "build", status: "skipped" },
        { check: "test", status: "skipped" },
      ],
    }) } });
    const runner = createProjectRunner({ root: "/target", workspace: ws, staticGatePath: "/target/.claude/scripts/static-analysis-gate.js" });
    const result = await runner("lint");
    expect(result).toMatchObject({ status: "FAIL" });
    expect(result?.outputSummary).toMatch(/dotnet.*every verification command was skipped/);
  });
});
