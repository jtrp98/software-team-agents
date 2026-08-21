import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { ClaudeCodeAdapter, type SpawnSync } from "./claudeCodeAdapter.js";
import { NO_GUARDS, type RuntimeGuards } from "./runtimeAdapter.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-adapter-"));
}

function cliResult(status: number | null, stdout: string, error?: NodeJS.ErrnoException): SpawnSyncReturns<string> {
  return { status, stdout, stderr: "", error, pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
}

function fakeCli(result: object, status = 0): SpawnSync {
  return () => cliResult(status, JSON.stringify(result));
}

const SOME_GUARDS: RuntimeGuards = {
  writeAllow: ["src/**"],
  writeDeny: [".git/**"],
  forbidCommands: ["git"],
  exitChecks: ["code-green"],
};

function baseRequest(overrides: Partial<Parameters<ClaudeCodeAdapter["executeAgent"]>[0]> = {}) {
  return {
    role: "backend-engineer",
    cwd: tmpProject(),
    definitionPath: ".claude/agents/backend-engineer.md",
    prompt: "do the thing",
    autonomy: "propose" as const,
    guards: NO_GUARDS,
    ...overrides,
  };
}

describe("ClaudeCodeAdapter.executeAgent", () => {
  it("spawns `claude -p --agent <role> --output-format json` with the prompt as the last arg", async () => {
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(baseRequest({ prompt: "hello world" }));

    expect(capturedArgs).toContain("--agent");
    expect(capturedArgs).toContain("backend-engineer");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs).toContain("json");
    expect(capturedArgs[capturedArgs.length - 1]).toBe("hello world");
  });

  it("maps autonomy onto Claude Code's own --permission-mode values", async () => {
    const table: Array<["read-only" | "propose" | "edit" | "full", string]> = [
      ["read-only", "plan"],
      ["propose", "default"],
      ["edit", "acceptEdits"],
      ["full", "bypassPermissions"],
    ];
    for (const [autonomy, expected] of table) {
      let capturedArgs: string[] = [];
      const spawnSync: SpawnSync = (_cmd, args) => {
        capturedArgs = args;
        return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
      };
      const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });
      await adapter.executeAgent(baseRequest({ autonomy }));
      const idx = capturedArgs.indexOf("--permission-mode");
      expect(capturedArgs[idx + 1]).toBe(expected);
    }
  });

  it("runs in req.cwd, not the workspace root", async () => {
    let capturedCwd: string | undefined;
    const spawnSync: SpawnSync = (_cmd, _args, options) => {
      capturedCwd = options.cwd;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const projectRoot = tmpProject();
    const backendRepo = tmpProject();
    const adapter = new ClaudeCodeAdapter({ projectRoot, spawnSync });

    await adapter.executeAgent(baseRequest({ cwd: backendRepo }));

    expect(capturedCwd).toBe(backendRepo);
  });

  it("sets AGENTCLAUDE_ROLE from the request, and does not drop env the caller supplied", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnSync: SpawnSync = (_cmd, _args, options) => {
      capturedEnv = options.env;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(baseRequest({ role: "qa-engineer", env: { FOO: "bar" } }));

    expect(capturedEnv?.AGENTCLAUDE_ROLE).toBe("qa-engineer");
    expect(capturedEnv?.FOO).toBe("bar");
  });

  it("reports OK with usage parsed from the CLI's JSON envelope", async () => {
    const spawnSync = fakeCli({ is_error: false, result: "done", total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 } });
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("OK");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.usage.cachedInputTokens).toBe(10);
    expect(result.usage.costUsd).toBe(0.02);
    expect(result.model).toBeUndefined();
  });

  it("reports ERROR (not OK) when the CLI exits non-zero", async () => {
    const spawnSync = fakeCli({ is_error: true, result: "boom" }, 1);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
    expect(result.text).toBe("boom");
  });

  it("reports ERROR when is_error is true even with exit code 0", async () => {
    const spawnSync = fakeCli({ is_error: true, result: "claimed done but is_error" }, 0);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
  });

  it("adds a diagnostic instead of throwing when stdout isn't valid JSON", async () => {
    const spawnSync: SpawnSync = () => cliResult(0, "not json at all");
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("OK");
    expect(result.diagnostics.some((d) => /could not parse/i.test(d))).toBe(true);
    expect(result.usage.inputTokens).toBeUndefined();
  });

  it("reports UNAVAILABLE, not ERROR, when the binary is missing (ENOENT)", async () => {
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("reports UNAVAILABLE when spawn throws outright, rather than crashing the caller", async () => {
    const spawnSync: SpawnSync = () => {
      throw new Error("spawn refused");
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.join(" ")).toMatch(/spawn refused/);
  });

  it("reports TIMEOUT (not ERROR) when the run exceeds its time budget", async () => {
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("TIMEOUT");
  });

  it("reports ERROR (not UNAVAILABLE or TIMEOUT) for any other spawn-level error", async () => {
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
  });
});

describe("ClaudeCodeAdapter — guard report reflects the actual workspace, not a static claim", () => {
  function writeSettings(root: string, hooks: Record<string, unknown[]>) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks }), "utf8");
  }

  it("reports nothing enforced/unenforced when the request asked for no guards at all", async () => {
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ guards: NO_GUARDS }));

    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced).toEqual([]);
  });

  it("reports every requested guard axis unenforced when .claude/settings.json is missing", async () => {
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ guards: SOME_GUARDS }));

    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced.length).toBeGreaterThan(0);
    expect(result.guards.reason).toMatch(/no .*settings\.json/);
  });

  it("reports PRE_TOOL_GUARD/EXIT_GUARD/PER_AGENT_EXIT_GUARD enforced when settings.json wires all three hook events", async () => {
    const projectRoot = tmpProject();
    writeSettings(projectRoot, { PreToolUse: [{}], Stop: [{}], SubagentStop: [{}] });
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const adapter = new ClaudeCodeAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ guards: SOME_GUARDS }));

    expect(result.guards.enforced).toEqual(
      expect.arrayContaining(["pre-tool-guard", "exit-guard", "per-agent-exit-guard"]),
    );
    expect(result.guards.unenforced).toEqual([]);
    expect(result.guards.reason).toBeUndefined();
  });

  it("reports per-agent-exit-guard unenforced when settings.json wires Stop but not SubagentStop", async () => {
    const projectRoot = tmpProject();
    writeSettings(projectRoot, { PreToolUse: [{}], Stop: [{}] });
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const adapter = new ClaudeCodeAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ guards: SOME_GUARDS }));

    expect(result.guards.enforced).toContain("exit-guard");
    expect(result.guards.unenforced).toContain("per-agent-exit-guard");
  });
});

describe("ClaudeCodeAdapter.probe", () => {
  it("reports available with the parsed version on success", async () => {
    const spawnSync: SpawnSync = () => cliResult(0, "2.1.0\n");
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(true);
    expect(probe.version).toBe("2.1.0");
  });

  it("reports unavailable with a reason when the binary can't be found", async () => {
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it("never throws even if spawnSync itself throws", async () => {
    const spawnSync: SpawnSync = () => {
      throw new Error("boom");
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(false);
  });
});

describe("ClaudeCodeAdapter — declared shape", () => {
  it("addresses a role's definition inside .claude/agents/, and never asks the caller to parse frontmatter", () => {
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject() });
    expect(adapter.binding.dir).toBe(".claude");
    expect(adapter.binding.definitionPath("business-analyst")).toBe(".claude/agents/business-analyst.md");
    expect(adapter.binding.guardConfigPath).toBe(".claude/settings.json");
  });

  it("does not claim PARALLEL_EXECUTION — reserved for T35, unimplemented here", () => {
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject() });
    expect(adapter.capabilities.has("parallel-execution" as never)).toBe(false);
  });
});
