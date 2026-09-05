import { describe, expect, it } from "vitest";
import { MockRuntimeAdapter, mockBinding } from "./mockAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { detectRuntimeCapabilities, claudeCodeDeepGuardCheck } from "./runtimeCapabilityDetection.js";
import { ClaudeCodeAdapter, type SpawnSync } from "./claudeCodeAdapter.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cap-detect-"));
}

/** A fake `claude --version` so `probe()` reports available, without spawning a real binary. */
const AVAILABLE_SPAWN: SpawnSync = () =>
  ({ status: 0, stdout: "0.0.0-test\n", stderr: "", error: undefined, pid: 1, output: [], signal: null }) as unknown as SpawnSyncReturns<string>;

describe("detectRuntimeCapabilities — unavailable runtime", () => {
  it("marks every claimed capability unverified, with the probe reason, and reports missing-required", async () => {
    const adapter = new MockRuntimeAdapter({
      capabilities: [RuntimeCapability.NAMED_AGENTS, RuntimeCapability.PRE_TOOL_GUARD],
      probe: { available: false, reason: "not installed" },
    });

    const report = await detectRuntimeCapabilities(adapter);

    expect(report.available).toBe(false);
    expect(report.probeReason).toBe("not installed");
    expect(report.checks.every((c) => c.verified === false)).toBe(true);
    expect(report.checks.every((c) => c.reason?.includes("not installed"))).toBe(true);
    expect(report.fallbacks.length).toBeGreaterThan(0);
  });
});

describe("detectRuntimeCapabilities — binding presence", () => {
  it("verifies PROJECT_LEVEL_BINDING and NAMED_AGENTS when the binding directory exists in the workspace", async () => {
    const adapter = new MockRuntimeAdapter({
      capabilities: [RuntimeCapability.PROJECT_LEVEL_BINDING, RuntimeCapability.NAMED_AGENTS],
      binding: mockBinding(".mock"),
      files: { ".mock/agents/backend-engineer.md": "role prompt" },
    });

    const report = await detectRuntimeCapabilities(adapter);

    const byCapability = Object.fromEntries(report.checks.map((c) => [c.capability, c]));
    expect(byCapability[RuntimeCapability.PROJECT_LEVEL_BINDING].verified).toBe(true);
    expect(byCapability[RuntimeCapability.NAMED_AGENTS].verified).toBe(true);
  });

  it("does not verify PROJECT_LEVEL_BINDING or NAMED_AGENTS when the binding directory is absent, and says why", async () => {
    const adapter = new MockRuntimeAdapter({
      capabilities: [RuntimeCapability.PROJECT_LEVEL_BINDING, RuntimeCapability.NAMED_AGENTS],
      binding: mockBinding(".mock"),
      files: {},
    });

    const report = await detectRuntimeCapabilities(adapter);

    const byCapability = Object.fromEntries(report.checks.map((c) => [c.capability, c]));
    expect(byCapability[RuntimeCapability.PROJECT_LEVEL_BINDING].verified).toBe(false);
    expect(byCapability[RuntimeCapability.PROJECT_LEVEL_BINDING].reason).toMatch(/not found/);
    expect(byCapability[RuntimeCapability.NAMED_AGENTS].verified).toBe(false);
    expect(report.missingRequired).toContain(RuntimeCapability.NAMED_AGENTS);
    expect(report.fallbacks.some((f) => /named-agent/.test(f))).toBe(true);
  });
});

describe("detectRuntimeCapabilities — guard capabilities with no config path", () => {
  it("cannot verify any claimed guard capability when binding.guardConfigPath is null", async () => {
    const adapter = new MockRuntimeAdapter({
      capabilities: [RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.EXIT_GUARD],
      binding: { dir: ".mock", definitionPath: (r) => `.mock/agents/${r}.md`, guardConfigPath: null },
    });

    const report = await detectRuntimeCapabilities(adapter);

    const byCapability = Object.fromEntries(report.checks.map((c) => [c.capability, c]));
    expect(byCapability[RuntimeCapability.PRE_TOOL_GUARD].verified).toBe(false);
    expect(byCapability[RuntimeCapability.PRE_TOOL_GUARD].reason).toMatch(/no guard config path/);
    expect(report.missingRequired).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(report.missingRequired).toContain(RuntimeCapability.EXIT_GUARD);
  });
});

describe("detectRuntimeCapabilities — generic guard check (no deep checker registered)", () => {
  it("does not verify a guard capability just because the config file exists — file presence is not proof", async () => {
    const adapter = new MockRuntimeAdapter({
      id: "some-other-runtime",
      capabilities: [RuntimeCapability.PRE_TOOL_GUARD],
      binding: { dir: ".mock", definitionPath: (r) => `.mock/agents/${r}.md`, guardConfigPath: ".mock/guards.json" },
      files: { ".mock/guards.json": "{}" },
    });

    const report = await detectRuntimeCapabilities(adapter);

    const check = report.checks.find((c) => c.capability === RuntimeCapability.PRE_TOOL_GUARD)!;
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/no deep guard checker registered/);
  });

  it("reports the config file missing distinctly from present-but-unverifiable", async () => {
    const adapter = new MockRuntimeAdapter({
      id: "some-other-runtime",
      capabilities: [RuntimeCapability.PRE_TOOL_GUARD],
      binding: { dir: ".mock", definitionPath: (r) => `.mock/agents/${r}.md`, guardConfigPath: ".mock/guards.json" },
      files: {},
    });

    const report = await detectRuntimeCapabilities(adapter);

    const check = report.checks.find((c) => c.capability === RuntimeCapability.PRE_TOOL_GUARD)!;
    expect(check.reason).toMatch(/not found or empty/);
  });
});

describe("detectRuntimeCapabilities — claude-code deep guard check", () => {
  it("verifies exactly the hook axes this framework's real settings.json wires (T109 review note)", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-path-permissions.js" }] }],
          SubagentStop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }, { command: "node .claude/hooks/block-secret-leak.js" }] }],
          Stop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }] }],
        },
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(projectRoot, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".claude", "agents", "backend-engineer.md"), "x", "utf8");

    const adapter = new ClaudeCodeAdapter({ projectRoot, spawnSync: AVAILABLE_SPAWN });
    const report = await detectRuntimeCapabilities(adapter);

    const byCapability = Object.fromEntries(report.checks.map((c) => [c.capability, c]));
    expect(byCapability[RuntimeCapability.PRE_TOOL_GUARD].verified).toBe(true);
    expect(byCapability[RuntimeCapability.EXIT_GUARD].verified).toBe(true);
    expect(byCapability[RuntimeCapability.PER_AGENT_EXIT_GUARD].verified).toBe(true);
    // This project's own settings.json wires no PostToolUse hook (CLAUDE.md's
    // hook table has none) — ClaudeCodeAdapter still claims POST_TOOL_GUARD as
    // a product capability, so this is exactly the gap capability detection
    // exists to surface.
    expect(byCapability[RuntimeCapability.POST_TOOL_GUARD].verified).toBe(false);
    expect(report.missingRequired).not.toContain(RuntimeCapability.PRE_TOOL_GUARD);
  });

  it("does not verify PRE_TOOL_GUARD when PreToolUse is wired but not to block-path-permissions.js", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-git.js" }] }] } }),
      "utf8",
    );

    const result = await claudeCodeDeepGuardCheck(
      { readFile: async (p: string) => (p.endsWith("settings.json") ? fs.readFileSync(path.join(projectRoot, p), "utf8") : null) } as never,
      ".claude/settings.json",
    );

    expect(result.verified.has(RuntimeCapability.PRE_TOOL_GUARD)).toBe(false);
    expect(result.reason).toMatch(/block-path-permissions/);
  });
});
