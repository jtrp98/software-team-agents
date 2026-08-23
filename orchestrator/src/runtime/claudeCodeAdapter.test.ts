import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { ClaudeCodeAdapter, resolveNpmCliScript, type SpawnSync } from "./claudeCodeAdapter.js";
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

describe("ClaudeCodeAdapter — Windows npm-shim resolution", () => {
  function enoentOnce(): { spawnSync: SpawnSync; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const spawnSync: SpawnSync = (cmd, args, options) => {
      calls.push({ cmd, args: [...args], cwd: options.cwd });
      if (cmd === "claude") {
        const err = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
        return cliResult(null, "", err as NodeJS.ErrnoException);
      }
      return cliResult(0, JSON.stringify({ is_error: false, result: "done via resolved" }));
    };
    return { spawnSync, calls };
  }

  it("on win32, an ENOENT from the bare command retries once through the resolved entry, keeping args/env/cwd", async () => {
    const { spawnSync, calls } = enoentOnce();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const instrumented: SpawnSync = (cmd, args, options) => {
      capturedEnv = options.env;
      return spawnSync(cmd, args, options);
    };
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      spawnSync: instrumented,
      platform: "win32",
      resolveCommand: (command) => (command === "claude" ? { file: "node-resolved", prefixArgs: ["C:\\npm\\cli.js"] } : null),
    });

    const result = await adapter.executeAgent(baseRequest({ role: "qa-engineer", env: { FOO: "bar" } }));

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("claude");
    expect(calls[1].cmd).toBe("node-resolved");
    expect(calls[1].args[0]).toBe("C:\\npm\\cli.js");
    expect(calls[1].args.slice(1)).toEqual(calls[0].args);
    expect(capturedEnv?.AGENTCLAUDE_ROLE).toBe("qa-engineer");
    expect(capturedEnv?.FOO).toBe("bar");
    expect(result.status).toBe("OK");
    expect(result.text).toBe("done via resolved");
  });

  it("on win32, stays UNAVAILABLE when the resolver finds nothing — one attempt only", async () => {
    const { spawnSync, calls } = enoentOnce();
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      spawnSync,
      platform: "win32",
      resolveCommand: () => null,
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.some((d) => /shim/i.test(d))).toBe(true);
  });

  it("never consults the resolver off Windows", async () => {
    const { spawnSync, calls } = enoentOnce();
    let resolverCalls = 0;
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      spawnSync,
      platform: "linux",
      resolveCommand: () => {
        resolverCalls += 1;
        return { file: "node-resolved", prefixArgs: [] };
      },
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(resolverCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("probe() reports available through the resolved entry too", async () => {
    const { spawnSync, calls } = enoentOnce();
    // probe parses stdout as the version line, not JSON — swap the success shape.
    const versionedSpawn: SpawnSync = (cmd, args, options) => {
      const r = spawnSync(cmd, args, options);
      if (r.error) return r;
      return cliResult(0, "2.1.239 (via shim)\n");
    };
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      spawnSync: versionedSpawn,
      platform: "win32",
      resolveCommand: () => ({ file: "node-resolved", prefixArgs: ["cli.js"] }),
    });

    const probe = await adapter.probe();

    expect(probe.available).toBe(true);
    expect(probe.version).toBe("2.1.239 (via shim)");
    expect(calls.map((c) => c.cmd)).toEqual(["claude", "node-resolved"]);
  });
});

describe("resolveNpmCliScript", () => {
  function probeOver(files: string[], dirs: string[], execPath = "node-injected") {
    return { dirs, exists: (p: string) => files.includes(p), execPath };
  }

  it("finds the native-binary layout current npm packages ship, and spawns it directly", () => {
    const npmDir = path.join("C:", "Users", "x", "AppData", "Roaming", "npm");
    const exe = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const found = resolveNpmCliScript("claude", probeOver([path.join(npmDir, "claude.cmd"), exe], [npmDir]));
    expect(found).toEqual({ file: exe, prefixArgs: [] });
  });

  it("falls back to the node-script layout through the injected node executable", () => {
    const npmDir = path.join("C:", "Users", "x", "AppData", "Roaming", "npm");
    const jsEntry = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const found = resolveNpmCliScript("claude", probeOver([path.join(npmDir, "claude.ps1"), jsEntry], [npmDir]));
    expect(found).toEqual({ file: "node-injected", prefixArgs: [jsEntry] });
  });

  it("requires the shim marker — a bare dependency checkout of the package is not the user's `claude`", () => {
    const projectDir = path.join("C:", "some", "project");
    const jsEntry = path.join(projectDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const found = resolveNpmCliScript("claude", probeOver([jsEntry], [projectDir]));
    expect(found).toBeNull();
  });

  it("returns null when a shim exists but neither entry layout does, and for unknown commands", () => {
    const npmDir = path.join("C:", "npm");
    expect(resolveNpmCliScript("claude", probeOver([path.join(npmDir, "claude.cmd")], [npmDir]))).toBeNull();
    expect(
      resolveNpmCliScript("codex", {
        dirs: [npmDir],
        exists: () => true,
        execPath: "node-injected",
      }),
    ).toBeNull();
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
