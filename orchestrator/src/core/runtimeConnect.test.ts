import { describe, expect, it } from "vitest";
import { MockRuntimeAdapter } from "../runtime/mockAdapter.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { detectRuntimes, knownUnavailable, securityRolesFor, type CommandRunner } from "./runtimeConnect.js";

describe("Runtime Connect (no Codex sandbox — owner decision 2026-10-03)", () => {
  it("reports Codex hooks and mandatory post-run checks without claiming write certification", () => {
    expect(securityRolesFor("claude-code")).toMatchObject({ commander: true, engineer: true, reviewer: true, qa: true });
    expect(securityRolesFor("codex")).toMatchObject({ commander: true, engineer: true, reviewer: true, qa: true });
    expect(securityRolesFor("zcode")).toMatchObject({ commander: true, engineer: true, reviewer: true, qa: true });
    for (const id of ["antigravity"]) {
      expect(securityRolesFor(id), id).toMatchObject({ commander: true, engineer: false, reviewer: true, qa: true });
    }
    expect(securityRolesFor("codex").detail).toMatch(/PreToolUse hooks/);
    expect(securityRolesFor("codex").detail).toMatch(/mandatory post-run/);
    expect(securityRolesFor("codex").detail).toMatch(/remain uncertified/);
  });

  it("detects all four pool runtimes with no sandbox state or setup action anywhere", async () => {
    const registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: [] }),
      new MockRuntimeAdapter({ id: "codex", models: [] }),
      new MockRuntimeAdapter({ id: "antigravity", models: [], probe: { available: false, reason: "spawn agy ENOENT" } }),
      new MockRuntimeAdapter({ id: "zcode", models: [] }),
    ]);
    const runner: CommandRunner = (command) => command === "claude"
      ? { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }
      : { status: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    const statuses = await detectRuntimes(registry, runner, 1);
    expect(statuses.map((s) => s.runtimeId)).toEqual(["claude-code", "codex", "antigravity", "zcode"]);
    expect(statuses.find((s) => s.runtimeId === "antigravity")!.state).toBe("NOT_INSTALLED");
    expect(statuses.find((s) => s.runtimeId === "codex")).toMatchObject({ authentication: "ok", state: "CONNECTED", backgroundReady: true });
    expect(JSON.stringify(statuses)).not.toMatch(/sandbox/i);
    expect(knownUnavailable(statuses)).toEqual({ antigravity: expect.stringMatching(/^NOT_INSTALLED/) });
  });

  it("a runtime that needs a login is skipped by routing with that reason", async () => {
    const registry = new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: [] }), new MockRuntimeAdapter({ id: "codex", models: [] }),
      new MockRuntimeAdapter({ id: "antigravity", models: [] }), new MockRuntimeAdapter({ id: "zcode", models: [] })]);
    const runner: CommandRunner = (command) => command === "claude"
      ? { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }
      : { status: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    const statuses = await detectRuntimes(registry, runner, 1);
    expect(knownUnavailable(statuses)["claude-code"]).toMatch(/^AUTH_REQUIRED/);
  });
});
