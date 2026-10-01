import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { addDirArgsFor, ClaudeCodeAdapter, disallowRulesFromGuards, resolveNpmCliScript, type SpawnSync } from "./claudeCodeAdapter.js";
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
  it("spawns `claude -p --agent <role> --output-format json` and sends the prompt through stdin", async () => {
    let capturedArgs: string[] = [];
    let capturedInput: string | undefined;
    const spawnSync: SpawnSync = (_cmd, args, options) => {
      capturedArgs = args;
      capturedInput = options.input as string | undefined;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(baseRequest({ prompt: "hello world" }));

    expect(capturedArgs).toContain("--agent");
    expect(capturedArgs).toContain("backend-engineer");
    expect(capturedArgs).toContain("--output-format");
    expect(capturedArgs).toContain("json");
    expect(capturedArgs).not.toContain("hello world");
    expect(capturedInput).toBe("hello world");
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

  it("carries contract denies as hard --disallowedTools permission rules (OFF10 M4)", async () => {
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(
      baseRequest({
        guards: {
          writeAllow: [],
          writeDeny: [".git/**", "knowledge/_roles/**"],
          forbidCommands: ["git"],
          exitChecks: ["no-hardcoded-secret"],
        },
      }),
    );

    // The equals form is required: claude v2.1.241's space form swallows the
    // following positional prompt.
    const flag = capturedArgs.find((a) => a.startsWith("--disallowedTools="));
    expect(flag).toBeDefined();
    expect(flag).toBe(
      "--disallowedTools=Write(.git/**),Edit(.git/**),Write(knowledge/_roles/**),Edit(knowledge/_roles/**),Bash(git *)",
    );
    // The prompt uses stdin so Windows command-line length cannot discard it.
    expect(capturedArgs).not.toContain("do the thing");
  });

  it("passes no --disallowedTools flag when the request carries no guards", async () => {
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(baseRequest());

    expect(capturedArgs.some((a) => a.startsWith("--disallowedTools="))).toBe(false);
  });

  it("OFF10 M6 — passes --json-schema only on schema-requested runs and surfaces structured_output", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    // Default adapter: no flag, no structured field even when the envelope has one.
    let plainArgs: string[] = [];
    const plain = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      spawnSync: (_cmd, args) => {
        plainArgs = args;
        return cliResult(0, JSON.stringify({ is_error: false, result: "done", structured_output: { verdict: "x" } }));
      },
    });
    const plainResult = await plain.executeAgent(baseRequest());
    expect(plainArgs).not.toContain("--json-schema");
    expect(plainResult.structured).toBeUndefined();

    // Schema-requested run: flag carries the exact JSON, result carries the document.
    let schemaArgs: string[] = [];
    const withSchema = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      outputSchema: schema,
      spawnSync: (_cmd, args) => {
        schemaArgs = args;
        return cliResult(0, JSON.stringify({ is_error: false, result: "summary text", structured_output: { verdict: "pass" } }));
      },
    });
    const result = await withSchema.executeAgent(baseRequest());
    const idx = schemaArgs.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    expect(JSON.parse(schemaArgs[idx + 1])).toEqual(schema);
    expect(result.text).toBe("summary text");
    expect(result.structured).toEqual({ verdict: "pass" });
    expect(schemaArgs).not.toContain("do the thing");
  });

  it("T-V8-031 — recovers Claude Code custom-agent JSON only after local schema validation", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
      required: ["verdict"],
    };
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      outputSchema: schema,
      spawnSync: fakeCli({ is_error: false, result: '{"verdict":"pass"}' }),
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("OK");
    expect(result.structured).toEqual({ verdict: "pass" });
    expect(result.diagnostics.join(" ")).toMatch(/omitted structured_output.*validated it locally/);
  });

  it("T-V8-031 — fails closed when a schema-requested custom-agent result is free-form or invalid", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
      required: ["verdict"],
    };
    for (const resultText of ["```json\n{\"verdict\":\"pass\"}\n```", '{"verdict":"unknown"}']) {
      const adapter = new ClaudeCodeAdapter({
        projectRoot: tmpProject(),
        outputSchema: schema,
        spawnSync: fakeCli({ is_error: false, result: resultText }),
      });

      const result = await adapter.executeAgent(baseRequest());

      expect(result.status).toBe("ERROR");
      expect(result.structured).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("T-V8-031 — refuses an invalid output schema before spawning Claude", async () => {
    let spawned = false;
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      outputSchema: { type: "not-a-json-schema-type" },
      spawnSync: () => {
        spawned = true;
        return cliResult(0, "{}");
      },
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(spawned).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/invalid structured-output schema/);
  });

  it("T-V4-CAST-001 — forwards --model only for an explicit override, and the no-override arg list is byte-identical", async () => {
    const capture = () => {
      let args: string[] = [];
      const spawnSync: SpawnSync = (_cmd, a) => {
        args = a;
        return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
      };
      return { spawnSync, get: () => args };
    };

    // Resolved default reaching the adapter as req.model (frontmatter) — not explicit.
    const a = capture();
    await new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync: a.spawnSync }).executeAgent(
      baseRequest({ model: "opus" }),
    );
    // Same request with no model at all.
    const b = capture();
    await new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync: b.spawnSync }).executeAgent(baseRequest());

    // Per-run isolation dirs differ by design; the claude command line after the wrapper's `--` must not.
    const claudeArgs = (all: string[]) => all.slice(all.indexOf("--") + 1);
    expect(claudeArgs(a.get())).toEqual(claudeArgs(b.get()));
    expect(a.get()).not.toContain("--model");

    // Explicit override → forwarded.
    const c = capture();
    await new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync: c.spawnSync }).executeAgent(
      baseRequest({ model: "opus", modelExplicit: true }),
    );
    const idx = c.get().indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(c.get()[idx + 1]).toBe("opus");
  });

  it("T-V4-CAST-001 — refuses an explicit model outside CLAUDE_CODE_MODELS instead of passing it through", async () => {
    let spawned = false;
    const spawnSync: SpawnSync = () => {
      spawned = true;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ model: "gpt-5", modelExplicit: true }));

    expect(spawned).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/model "gpt-5" is not one Claude Code accepts/);
  });

  it("T-V4-CAST-001 — a cast tier's effort reaches the model as `--effort`", async () => {
    let args: string[] = [];
    const spawnSync: SpawnSync = (_cmd, a) => {
      args = a;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ model: "sonnet", modelExplicit: true, effort: "high" }));

    expect(result.status).toBe("OK");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(result.diagnostics.join(" ")).not.toMatch(/effort/);
  });

  it("an effort set without an explicit model is still applied — req.effort is never a frontmatter default", async () => {
    let args: string[] = [];
    const spawnSync: SpawnSync = (_cmd, a) => {
      args = a;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ effort: "xhigh" }));

    expect(result.status).toBe("OK");
    expect(args).not.toContain("--model");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("refuses an effort Claude Code cannot reach rather than passing it through", async () => {
    let spawned = false;
    const spawnSync: SpawnSync = () => {
      spawned = true;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest({ model: "sonnet", modelExplicit: true, effort: "thinking" }));

    expect(spawned).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/effort "thinking" is not one Claude Code accepts/);
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

  it("sets STA_ROLE from the request, and does not drop env the caller supplied", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnSync: SpawnSync = (_cmd, _args, options) => {
      capturedEnv = options.env;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    await adapter.executeAgent(baseRequest({ role: "qa-engineer", env: { FOO: "bar" } }));

    expect(capturedEnv?.STA_ROLE).toBe("qa-engineer");
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

  it("T-V8-012 reports cache-creation tokens distinctly from cache-read tokens", async () => {
    const spawnSync = fakeCli({
      is_error: false, result: "done", total_cost_usd: 0.03,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 25 },
    });
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.usage.cachedInputTokens).toBe(10);
    expect(result.usage.cacheCreationInputTokens).toBe(25);
  });

  it("T-V8-012 leaves cache-creation tokens undefined (not 0) when the envelope carries none", async () => {
    const spawnSync = fakeCli({ is_error: false, result: "done", total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 } });
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.usage.cacheCreationInputTokens).toBeUndefined();
  });

  it("reports ERROR (not OK) when the CLI exits non-zero", async () => {
    const spawnSync = fakeCli({ is_error: true, result: "boom" }, 1);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
    expect(result.text).toBe("boom");
  });

  // Envelopes below are the observed fields of real `claude -p --output-format json`
  // runs against a stub upstream — see planning/v6/v6-2-evidence.md for the verbatim captures.
  it.each([
    [429, "API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your organization's rate limit"],
    [401, "Invalid API key · Fix external API key"],
    [403, "Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource"],
  ])("reports UNAVAILABLE, not ERROR, when the provider refused to serve (HTTP %i)", async (status, message) => {
    const spawnSync = fakeCli({ is_error: true, terminal_reason: "api_error", api_error_status: status, subtype: "success", type: "result", result: message }, 1);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.join(" ")).toContain(`provider refused to serve (HTTP ${status})`);
    expect(result.diagnostics.join(" ")).toContain(message);
  });

  it("keeps a genuine task failure as ERROR — an is_error envelope with no api_error_status is not a provider refusal", async () => {
    const spawnSync = fakeCli({ is_error: true, result: "the task failed: 429 attempts exceeded in the code under test" }, 1);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
  });

  it("keeps ERROR for an api_error status outside the observed set — no pattern is shipped for a response nobody has seen", async () => {
    const spawnSync = fakeCli({ is_error: true, terminal_reason: "api_error", api_error_status: 500, result: "API Error: 500" }, 1);
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("ERROR");
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

describe("ClaudeCodeAdapter — TASK-031 egress through the loopback allowlist proxy", () => {
  it("routes the isolated claude through the proxy for api.anthropic.com only, and stops it after the run", async () => {
    let captured: NodeJS.ProcessEnv | undefined;
    let requestedHosts: readonly string[] = [];
    let stopped = 0;
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      platform: "win32",
      spawnSync: (_cmd, _args, options) => {
        captured = options.env;
        return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
      },
      startEgressProxy: async (hosts) => {
        requestedHosts = hosts;
        return { url: "http://127.0.0.1:4242", stop: () => { stopped += 1; } };
      },
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(result.status).toBe("OK");
    expect(requestedHosts).toEqual(["api.anthropic.com"]);
    expect(captured?.HTTPS_PROXY).toBe("http://127.0.0.1:4242");
    expect(captured?.HTTP_PROXY).toBe("http://127.0.0.1:4242");
    expect(captured?.NO_PROXY).toBe("");
    expect(captured?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(stopped).toBe(1);
  });

  it("refuses before spawn when the proxy cannot start", async () => {
    let spawned = false;
    const adapter = new ClaudeCodeAdapter({
      projectRoot: tmpProject(),
      platform: "win32",
      spawnSync: () => {
        spawned = true;
        return cliResult(0, "{}");
      },
      startEgressProxy: async () => { throw new Error("no port"); },
    });

    const result = await adapter.executeAgent(baseRequest());

    expect(spawned).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toContain("egress allowlist proxy");
  });
});

describe("ClaudeCodeAdapter — Windows npm-shim resolution", () => {
  function enoentOnce(): { spawnSync: SpawnSync; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const spawnSync: SpawnSync = (cmd, args, options) => {
      calls.push({ cmd, args: [...args], cwd: options.cwd });
      if (cmd === "claude" || cmd === "codex") {
        const err = Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" });
        return cliResult(null, "", err as NodeJS.ErrnoException);
      }
      return cliResult(0, JSON.stringify({ is_error: false, result: "done via resolved" }));
    };
    return { spawnSync, calls };
  }

  it("on win32, the isolation wrapper's ENOENT retries once through the resolved codex entry; the inner claude is the resolved executable", async () => {
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
      resolveCommand: (command) =>
        command === "codex" ? { file: "node-codex", prefixArgs: ["C:/npm/codex.js"] }
          : command === "claude" ? { file: "C:/npm/claude.exe", prefixArgs: [] } : null,
    });

    const result = await adapter.executeAgent(baseRequest({ role: "qa-engineer", env: { FOO: "bar" } }));

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("codex");
    expect(calls[0].args[0]).toBe("sandbox");
    expect(calls[0].args[calls[0].args.indexOf("--") + 1]).toBe("C:/npm/claude.exe");
    expect(calls[1].cmd).toBe("node-codex");
    expect(calls[1].args[0]).toBe("C:/npm/codex.js");
    expect(calls[1].args.slice(1)).toEqual(calls[0].args);
    expect(capturedEnv?.STA_ROLE).toBe("qa-engineer");
    expect(capturedEnv?.FOO).toBe("bar");
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).toMatch(/sta-claude-run-/);
    expect(result.status).toBe("OK");
    expect(result.text).toBe("done via resolved");
  });

  it("on win32, stays UNAVAILABLE when the wrapper cannot be resolved — one attempt only", async () => {
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

  it("off Windows, refuses before any spawn: the isolation wrapper is verified only on win32", async () => {
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
    expect(calls).toHaveLength(0);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toContain("CLAUDE_ISOLATION_UNAVAILABLE");
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
    // `codex` is a known package now: with every probe answering "exists", the
    // native-binary layout wins and resolves instead of returning null.
    expect(
      resolveNpmCliScript("codex", {
        dirs: [npmDir],
        exists: () => true,
        execPath: "node-injected",
      }),
    ).toEqual({
      file: path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.exe"),
      prefixArgs: [],
    });
    expect(resolveNpmCliScript("definitely-unknown", { dirs: [npmDir], exists: () => true })).toBeNull();
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

describe("disallowRulesFromGuards (OFF10 M4 mapping)", () => {
  it("maps deny globs onto both file-mutating tools and forbids onto Bash prefix rules", () => {
    expect(disallowRulesFromGuards({ writeAllow: [], writeDeny: [".git/**"], forbidCommands: ["git"], exitChecks: [] })).toEqual([
      "Write(.git/**)",
      "Edit(.git/**)",
      "Bash(git *)",
    ]);
  });

  it("dedupes and skips blank entries while staying order-stable", () => {
    const rules = disallowRulesFromGuards({
      writeAllow: [],
      writeDeny: [".git/**", "", ".git/**"],
      forbidCommands: [" git ", ""],
      exitChecks: [],
    });
    expect(rules).toEqual(["Write(.git/**)", "Edit(.git/**)", "Bash(git *)"]);
  });

  it("returns nothing for an empty guard set — no flag noise on unguarded runs", () => {
    expect(disallowRulesFromGuards({ writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: [] })).toEqual([]);
  });
});

describe("addDirArgsFor — write roots outside cwd become Claude Code working directories", () => {
  const cwd = path.resolve("/kb");
  const target = path.resolve("/target");
  const reader = path.resolve("/reader");

  it("adds each writable root other than cwd, equals form", () => {
    expect(
      addDirArgsFor({
        cwd,
        autonomy: "edit",
        workRoots: [
          { targetId: "kb", path: cwd, access: "write" },
          { targetId: "be", path: target, access: "write" },
          { targetId: "ro", path: reader, access: "read" },
        ],
      }),
    ).toEqual([`--add-dir=${target}`]);
  });

  it("adds nothing for a read-only run or a run with no extra roots", () => {
    expect(addDirArgsFor({ cwd, autonomy: "read-only", workRoots: [{ targetId: "be", path: target, access: "write" }] })).toEqual([]);
    expect(addDirArgsFor({ cwd, autonomy: "edit" })).toEqual([]);
  });
});

describe("ClaudeCodeAdapter — a direct run (osIsolation: false) spawns claude itself", () => {
  it("runs `claude` with no codex wrapper, no per-run home, and no console window", async () => {
    const calls: { cmd: string; args: string[]; options: Parameters<SpawnSync>[2] }[] = [];
    const spawnSync: SpawnSync = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return cliResult(0, JSON.stringify({ is_error: false, result: "done" }));
    };
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync, platform: "linux" });

    const result = await adapter.executeAgent(baseRequest({ osIsolation: false, prompt: "hi", env: { STA_ROLE: "x" } }));

    expect(result.status).toBe("OK");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("claude");
    expect(calls[0].args).not.toContain("sandbox");
    expect(calls[0].args).toContain("--agent");
    expect(calls[0].options.windowsHide).toBe(true);
    expect(calls[0].options.input).toBe("hi");
    expect(calls[0].options.env!.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(calls[0].options.env!.HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
    expect(calls[0].options.env!.STA_ROLE).toBe("backend-engineer");
  });

  it("reports a missing claude binary, not a missing codex wrapper", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    const adapter = new ClaudeCodeAdapter({ projectRoot: tmpProject(), spawnSync: () => cliResult(null, "", enoent), platform: "linux" });

    const result = await adapter.executeAgent(baseRequest({ osIsolation: false }));

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.join(" ")).toContain("`claude` binary not found");
  });
});
