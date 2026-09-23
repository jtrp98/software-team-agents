import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import {
  CodexAdapter,
  codexExecPolicyFor,
  codexPermissionInvocationFor,
  codexPermissionPathsFor,
  extractDeveloperInstructions,
  parseCodexJsonl,
} from "./codexAdapter.js";
import { NO_GUARDS, type RuntimeGuards, type RuntimeWorkRoot } from "./runtimeAdapter.js";
import type { SpawnSync } from "./claudeCodeAdapter.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-"));
}

/** Writes the official binding schema: name/description/developer_instructions in `.codex/agents/<role>.toml`. */
function writeRoleBinding(root: string, role: string, instructions = "you are the role") {
  fs.mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".codex", "agents", `${role}.toml`),
    `name = "${role}"\ndescription = "test binding"\n\ndeveloper_instructions = """\n${instructions}\n"""\n`,
    "utf8",
  );
}

function writeRawBinding(root: string, role: string, content: string) {
  fs.mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.toml`), content, "utf8");
}

function cliResult(status: number | null, stdout: string, error?: NodeJS.ErrnoException, stderr = ""): SpawnSyncReturns<string> {
  return { status, stdout, stderr, error, pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
}

const SOME_GUARDS: RuntimeGuards = {
  writeAllow: ["src/**"],
  writeDeny: [".git/**"],
  forbidCommands: ["git"],
  exitChecks: ["code-green"],
};

function baseRequest(overrides: Partial<Parameters<CodexAdapter["executeAgent"]>[0]> = {}) {
  return {
    role: "backend-engineer",
    cwd: tmpProject(),
    definitionPath: ".codex/agents/backend-engineer.toml",
    prompt: "do the thing",
    autonomy: "propose" as const,
    guards: NO_GUARDS,
    ...overrides,
  };
}

describe("CodexAdapter.executeAgent", () => {
  it("returns ERROR (not throw) when the role's binding file is missing — no native named-agent flag to fall back on", async () => {
    const projectRoot = tmpProject();
    const spawnSync: SpawnSync = () => cliResult(0, "done");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.some((d) => /no role binding found/.test(d))).toBe(true);
  });

  it("folds the role binding content into the prompt sent to `codex exec`", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer", "ROLE-DEFINITION-MARKER");
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    await adapter.executeAgent(baseRequest({ cwd: projectRoot, prompt: "hello world" }));

    expect(capturedArgs[0]).toBe("exec");
    const last = capturedArgs[capturedArgs.length - 1];
    expect(last).toContain("ROLE-DEFINITION-MARKER");
    expect(last).toContain("hello world");
  });

  it("passes an explicit tier model and effort to Codex, and rejects an unknown configured model", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, models: ["gpt-6-astra"], spawnSync });

    await adapter.executeAgent(baseRequest({ cwd: projectRoot, model: "gpt-6-astra", modelExplicit: true, effort: "high" }));
    expect(capturedArgs[capturedArgs.indexOf("--model") + 1]).toBe("gpt-6-astra");
    const configValues = capturedArgs.flatMap((arg, index) => arg === "--config" ? [capturedArgs[index + 1]] : []);
    expect(configValues).toContain('approval_policy="never"');
    expect(configValues).toContain('model_reasoning_effort="high"');

    const refused = await adapter.executeAgent(baseRequest({ cwd: projectRoot, model: "not-a-tier-model", modelExplicit: true }));
    expect(refused.status).toBe("ERROR");
    expect(refused.diagnostics.join(" ")).toContain("configured Codex tier catalogue");
  });

  it("maps autonomy onto sandbox modes and uses the non-interactive approval policy accepted by codex exec", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const table: Array<["read-only" | "propose" | "edit" | "full", string]> = [
      ["read-only", "read-only"],
      ["propose", "workspace-write"],
      ["edit", "workspace-write"],
      ["full", "danger-full-access"],
    ];
    for (const [autonomy, sandbox] of table) {
      let capturedArgs: string[] = [];
      const spawnSync: SpawnSync = (_cmd, args) => {
        capturedArgs = args;
        return cliResult(0, "done");
      };
      const adapter = new CodexAdapter({ projectRoot, spawnSync });
      await adapter.executeAgent(baseRequest({ cwd: projectRoot, autonomy }));
      expect(capturedArgs[capturedArgs.indexOf("--sandbox") + 1]).toBe(sandbox);
      expect(capturedArgs).not.toContain("--ask-for-approval");
      const configValues = capturedArgs.flatMap((arg, index) => arg === "--config" ? [capturedArgs[index + 1]] : []);
      expect(configValues).toContain('approval_policy="never"');
    }
  });

  it("sets STA_ROLE from the request, and does not drop env the caller supplied", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "qa-engineer");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnSync: SpawnSync = (_cmd, _args, options) => {
      capturedEnv = options.env;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    await adapter.executeAgent(
      baseRequest({ cwd: projectRoot, role: "qa-engineer", definitionPath: ".codex/agents/qa-engineer.toml", env: { FOO: "bar" } }),
    );

    expect(capturedEnv?.STA_ROLE).toBe("qa-engineer");
    expect(capturedEnv?.FOO).toBe("bar");
  });

  it("reports OK with plain-text output on a zero exit, and never fabricates usage/cost", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(0, "the agent's output");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("OK");
    expect(result.text).toBe("the agent's output");
    expect(result.usage).toEqual({});
    expect(result.model).toBeUndefined();
  });

  it("reports ERROR when the CLI exits non-zero, preferring stderr for the text", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(1, "", undefined, "it broke");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("ERROR");
    expect(result.text).toBe("it broke");
  });

  // The stderr below is the observed tail of real `codex exec` runs against a stub
  // upstream, MCP noise included — see planning/v6/v6-2-evidence.md for the captures.
  const CODEX_NOISE = [
    "Reading additional input from stdin...",
    `2026-09-06T02:46:46.509637Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\\"https://mcp.figma.com/.well-known/oauth-protected-resource\\",scope=\\"mcp:connect\\"" })`,
    "ERROR: Reconnecting... 5/5",
  ].join("\n");

  it.each([
    ["ERROR: exceeded retry limit, last status: 429 Too Many Requests", "429"],
    ["ERROR: unexpected status 401 Unauthorized: Incorrect API key provided., url: http://127.0.0.1:8791/v1/responses", "401"],
    ["ERROR: unexpected status 403 Forbidden: You do not have access to this model., url: http://127.0.0.1:8792/v1/responses", "403"],
  ])("reports UNAVAILABLE, not ERROR, when the provider refused to serve (%s)", async (errorLine) => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(1, "", undefined, `${CODEX_NOISE}\n${errorLine}`);
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.join(" ")).toContain("provider refused to serve");
    expect(result.diagnostics.join(" ")).toContain(errorLine);
  });

  it("keeps a genuine task failure as ERROR, even though every codex run carries `ERROR: Reconnecting` and MCP auth noise", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(1, "", undefined, `${CODEX_NOISE}\nERROR: the task's own test suite failed with 401 assertions unmet`);
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("ERROR");
  });

  it("keeps a 5xx as ERROR — codex reports it as high demand, which is not a refusal to serve this account", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () =>
      cliResult(1, "", undefined, `${CODEX_NOISE}\nERROR: We're currently experiencing high demand, which may cause temporary errors.`);
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("ERROR");
  });

  it("reports UNAVAILABLE, not ERROR, when the binary is missing (ENOENT)", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("reports UNAVAILABLE when spawn throws outright", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => {
      throw new Error("spawn refused");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("reports TIMEOUT (not ERROR) when the run exceeds its time budget", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("spawnSync codex ETIMEDOUT"), { code: "ETIMEDOUT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("TIMEOUT");
  });

  it("runs a guarded writable request with a native per-run permission profile", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let spawned = false;
    const spawnSync: SpawnSync = () => {
      spawned = true;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, guards: SOME_GUARDS }));

    expect(result.status).toBe("OK");
    expect(spawned).toBe(true);
    expect(result.guards.enforced).toContain("pre-tool-guard");
    expect(result.guards.unenforced).toContain("exit-guard");
  });

  it("allows read-only analysis without claiming native exit enforcement", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let spawned = false;
    const spawnSync: SpawnSync = () => {
      spawned = true;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, autonomy: "read-only", guards: SOME_GUARDS }));

    expect(result.status).toBe("OK");
    expect(spawned).toBe(true);
    expect(result.guards.unenforced).not.toContain("pre-tool-guard");
    expect(result.guards.unenforced).toContain("exit-guard");
  });

  it("reports nothing enforced/unenforced when the request asked for no guards at all", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(0, "done");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, guards: NO_GUARDS }));

    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced).toEqual([]);
  });
});

describe("CodexAdapter.probe", () => {
  it("reports available with the parsed version on success", async () => {
    const spawnSync: SpawnSync = () => cliResult(0, "0.9.0\n");
    const adapter = new CodexAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(true);
    expect(probe.version).toBe("0.9.0");
  });

  it("reports unavailable with a reason when the binary can't be found", async () => {
    const spawnSync: SpawnSync = () => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return cliResult(null, "", err as NodeJS.ErrnoException);
    };
    const adapter = new CodexAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it("never throws even if spawnSync itself throws", async () => {
    const spawnSync: SpawnSync = () => {
      throw new Error("boom");
    };
    const adapter = new CodexAdapter({ projectRoot: tmpProject(), spawnSync });

    const probe = await adapter.probe();

    expect(probe.available).toBe(false);
  });
});

describe("CodexAdapter — declared shape stays conservative after real-install UAT", () => {
  it("addresses a role's official .toml binding inside .codex/agents/, and keeps guardConfigPath null after UAT exposed exec-mode guard gaps", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    expect(adapter.binding.dir).toBe(".codex");
    expect(adapter.binding.definitionPath("business-analyst")).toBe(".codex/agents/business-analyst.toml");
    expect(adapter.binding.guardConfigPath).toBeNull();
  });

  it("claims the verified structured result and per-run pre-tool guard, but no named-agent, native exit, cost, or interactive-prompt capability", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    expect(adapter.capabilities.has("structured-result" as never)).toBe(true);
    expect(adapter.capabilities.has("pre-tool-guard" as never)).toBe(true);
    for (const cap of [
      "named-agents",
      "post-tool-guard",
      "exit-guard",
      "per-agent-exit-guard",
      "cost-reporting",
      "interactive-prompts",
      "parallel-execution",
    ]) {
      expect(adapter.capabilities.has(cap as never)).toBe(false);
    }
  });

  it("declares no reachable models unless the caller states them — no guessed model ids", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    expect(adapter.models.size).toBe(0);

    const withModels = new CodexAdapter({ projectRoot: tmpProject(), models: ["some-model"] });
    expect(withModels.models.has("some-model")).toBe(true);
  });
});

describe("extractDeveloperInstructions", () => {
  it("reads a multiline basic string and trims it", () => {
    expect(
      extractDeveloperInstructions('name = "r"\ndescription = "d"\n\ndeveloper_instructions = """\nline one\nline two\n"""'),
    ).toBe("line one\nline two");
  });

  it("reads a single-line basic string with escapes", () => {
    expect(extractDeveloperInstructions('developer_instructions = "be \\"careful\\", always"')).toBe(
      'be "careful", always',
    );
  });

  it("returns null when absent or empty — never an empty role definition", () => {
    expect(extractDeveloperInstructions('name = "r"\n')).toBeNull();
    expect(extractDeveloperInstructions('developer_instructions = """\n"""\n')).toBeNull();
  });
});

describe("parseCodexJsonl — tolerant over documented event types, absent stays absent", () => {
  it("keeps the last usage fields and model string it actually finds", () => {
    const stdout = [
      '{"type":"thread.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7},"model":"gpt-test"}',
      '{"not json at all',
    ].join("\n");
    const parsed = parseCodexJsonl(stdout);
    expect(parsed.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(parsed.model).toBe("gpt-test");
  });

  it("returns empty usage and no model when nothing carried them — never a fabricated zero", () => {
    const parsed = parseCodexJsonl('{"type":"thread.started"}\nplain noise\n');
    expect(parsed.usage).toEqual({});
    expect(parsed.model).toBeUndefined();
  });

  it("picks up cost only from an explicitly present field", () => {
    const parsed = parseCodexJsonl('{"type":"turn.completed","total_cost_usd":0.25}');
    expect(parsed.usage.costUsd).toBe(0.25);
    expect(parsed.usage.inputTokens).toBeUndefined();
  });

  it.each([
    ["cached_input_tokens", '{"type":"turn.completed","usage":{"cached_input_tokens":166016}}', 166016],
    ["cache_read_input_tokens", '{"type":"turn.completed","usage":{"cache_read_input_tokens":42}}', 42],
  ])("reads cached tokens from the %s JSONL spelling", (_field, stdout, expected) => {
    expect(parseCodexJsonl(stdout).usage.cachedInputTokens).toBe(expected);
  });
});

describe("CodexAdapter v2 — documented machine surfaces (--json, -o/--output-last-message)", () => {
  it("passes --json and -o, takes text from the last-message file, and usage/model from the JSONL stream", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      const oIndex = args.indexOf("-o");
      fs.writeFileSync(args[oIndex + 1], "FINAL MESSAGE", "utf8");
      return cliResult(0, '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}\n');
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(capturedArgs).toContain("--json");
    expect(capturedArgs[capturedArgs.indexOf("-o") + 1]).toMatch(/sta-codex-last-/);
    expect(result.status).toBe("OK");
    expect(result.text).toBe("FINAL MESSAGE");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    // The scratch file must not outlive the run.
    const oPath = capturedArgs[capturedArgs.indexOf("-o") + 1];
    expect(fs.existsSync(oPath)).toBe(false);
  });

  it("falls back to raw output as text when no last-message file was written, and says so", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(0, "plain stream output");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(result.status).toBe("OK");
    expect(result.text).toBe("plain stream output");
    expect(result.diagnostics.some((d) => /last-message file/.test(d))).toBe(true);
  });

  it("fails loudly when a binding has no developer_instructions instead of exec-ing an empty role", async () => {
    const projectRoot = tmpProject();
    writeRawBinding(projectRoot, "backend-engineer", 'name = "backend-engineer"\ndescription = "incomplete"\n');
    const spawnSync: SpawnSync = () => cliResult(0, "should never be reached");
    let spawned = false;
    const spawning: SpawnSync = (...a) => {
      spawned = true;
      return spawnSync(...a);
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync: spawning });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(spawned).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.some((d) => /no developer_instructions/.test(d))).toBe(true);
  });
});

describe("Codex work-root grants", () => {
  const roots: RuntimeWorkRoot[] = [
    { targetId: "backend", path: "C:/repos/backend", access: "write" },
    { targetId: "frontend", path: "C:/repos/frontend", access: "write" },
    { targetId: "docs", path: "C:/repos/docs", access: "read" },
  ];

  it("lands only writable roots as --add-dir pairs in the per-run profile; read roots rely on broad read access", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, autonomy: "edit", workRoots: roots, guards: SOME_GUARDS }));

    expect(capturedArgs).not.toContain("--sandbox");
    const added = capturedArgs.flatMap((arg, index) => arg === "--add-dir" ? [capturedArgs[index + 1]] : []);
    expect(added.map((entry) => path.normalize(entry))).toEqual([
      path.resolve("C:/repos/backend"),
      path.resolve("C:/repos/frontend"),
    ]);
    expect(added).not.toContain("C:/repos/docs");
    // Prompt stays last.
    expect(capturedArgs[capturedArgs.length - 1]).toContain("do the thing");
    expect(result.guards.enforced).toContain("pre-tool-guard");
  });
});

describe("Codex per-run permission profile", () => {
  it("converts trailing trees and expands interior module wildcards without widening to the parent", () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, "_docs", "module", "alpha"), { recursive: true });
    fs.mkdirSync(path.join(root, "_docs", "module", "beta"), { recursive: true });

    expect(codexPermissionPathsFor(root, "src/**")).toEqual(["src"]);
    expect(codexPermissionPathsFor(root, "**")).toEqual(["."]);
    expect(codexPermissionPathsFor(root, "_docs/module/*/requirement.md")).toEqual([
      "_docs/module/alpha/requirement.md",
      "_docs/module/beta/requirement.md",
    ]);
  });

  it("builds broad-read/narrow-write config, keeps protected paths read-only, and never maps guarded full to danger-full-access", () => {
    const root = tmpProject();
    const invocation = codexPermissionInvocationFor({
      cwd: root,
      autonomy: "full",
      guards: { writeAllow: ["**"], writeDeny: [".git/**", "contracts/**"], forbidCommands: [], exitChecks: [] },
    }, "win32");
    const configs = invocation.args.flatMap((arg, index) => arg === "--config" ? [invocation.args[index + 1]] : []);

    expect(invocation.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(invocation.args).not.toContain("--ignore-user-config");
    expect(invocation.args).not.toContain("--sandbox");
    expect(invocation.args).not.toContain("danger-full-access");
    expect(configs).toContain('windows.sandbox="elevated"');
    expect(configs.join("\n")).toContain('":root" = "read"');
    expect(configs.join("\n")).toContain('"." = "write"');
    expect(configs.join("\n")).toContain('".git" = "read"');
    expect(configs.join("\n")).toContain('"contracts" = "read"');
    expect(invocation.guards.enforced).toContain("pre-tool-guard");
  });

  it("fails closed when cwd is a read-only Target", () => {
    const root = tmpProject();
    expect(() => codexPermissionInvocationFor({
      cwd: root,
      autonomy: "edit",
      guards: SOME_GUARDS,
      workRoots: [{ targetId: "docs", path: root, access: "read" }],
    })).toThrow(/bound read-only/);
  });

  it("compiles forbidden executable basenames into strict execpolicy rules", () => {
    const policy = codexExecPolicyFor(["git", "git", "npm"], "win32");
    expect(policy.match(/pattern = \["git"\]/g)).toHaveLength(1);
    expect(policy).toContain('pattern = ["git.exe"]');
    expect(policy).toContain('pattern = ["git.cmd"]');
    expect(policy).toContain('pattern = ["npm"]');
    expect(policy).toContain('decision = "forbidden"');
    expect(() => codexExecPolicyFor(["git status"])).toThrow(/executable basename/);
  });

  it("does not add Windows executable suffixes on other platforms", () => {
    const policy = codexExecPolicyFor(["git"], "linux");
    expect(policy).toContain('pattern = ["git"]');
    expect(policy).not.toContain("git.exe");
  });

  it("uses and cleans an isolated CODEX_HOME whose only rule is the packet command denial", async () => {
    const root = tmpProject();
    writeRoleBinding(root, "backend-engineer");
    let runHome = "";
    let policy = "";
    let config = "";
    let hookScript = "";
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_command, args, options) => {
      capturedArgs = args;
      runHome = options.env?.CODEX_HOME ?? "";
      policy = fs.readFileSync(path.join(runHome, "rules", "sta.rules"), "utf8");
      config = fs.readFileSync(path.join(runHome, "config.toml"), "utf8");
      hookScript = fs.readFileSync(path.join(runHome, "git-guard.cjs"), "utf8");
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot: root, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: root, autonomy: "edit", guards: SOME_GUARDS }));

    expect(result.status).toBe("OK");
    expect(policy).toContain('pattern = ["git"]');
    expect(config).toContain('trust_level = "untrusted"');
    expect(hookScript).toContain("gitExecutable");
    expect(capturedArgs.join("\n")).toContain("hooks.PreToolUse=");
    expect(capturedArgs).not.toContain("--dangerously-bypass-hook-trust");
    expect(runHome).toMatch(/sta-codex-home-/);
    expect(fs.existsSync(runHome)).toBe(false);
  });
});

describe("CodexAdapter — OFF10 M6, --output-schema on schema-requested runs only", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  it("writes the schema to a temp file, passes --output-schema, and parses the -o body as structured", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let capturedArgs: string[] = [];
    let capturedSchemaBody = "";
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      const sIdx = args.indexOf("--output-schema");
      capturedSchemaBody = fs.readFileSync(args[sIdx + 1], "utf8");
      const oIdx = args.indexOf("-o");
      fs.writeFileSync(args[oIdx + 1], '{"verdict":"pass"}', "utf8");
      return cliResult(0, "{}");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync, outputSchema: schema });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(capturedArgs).toContain("--output-schema");
    expect(JSON.parse(capturedSchemaBody)).toEqual(schema);
    // The -o file IS the structured document; text keeps the raw form.
    expect(result.structured).toEqual({ verdict: "pass" });
    expect(result.text).toBe('{"verdict":"pass"}');
    // Both scratch files are gone after the run.
    for (const f of [capturedArgs[capturedArgs.indexOf("--output-schema") + 1], capturedArgs[capturedArgs.indexOf("-o") + 1]]) {
      expect(fs.existsSync(f)).toBe(false);
    }
  });

  it("stays silent-by-default and reports a diagnostic when a schema run returns non-JSON", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    // Default adapter: no flag even though this stdout would parse as JSON.
    let plainArgs: string[] = [];
    const plain = new CodexAdapter({
      projectRoot,
      spawnSync: (_cmd, args) => {
        plainArgs = args;
        return cliResult(0, "{}");
      },
    });
    await plain.executeAgent(baseRequest({ cwd: projectRoot }));
    expect(plainArgs).not.toContain("--output-schema");

    // Schema run whose final message is prose: structured absent + diagnostic.
    const withSchema = new CodexAdapter({
      projectRoot,
      spawnSync: (_cmd, args) => {
        const oIdx = args.indexOf("-o");
        fs.writeFileSync(args[oIdx + 1], "just prose, not JSON", "utf8");
        return cliResult(0, "{}");
      },
      outputSchema: schema,
    });
    const result = await withSchema.executeAgent(baseRequest({ cwd: projectRoot }));
    expect(result.status).toBe("OK");
    expect(result.structured).toBeUndefined();
    expect(result.diagnostics.some((d) => /did not parse as JSON/.test(d))).toBe(true);
  });
});

describe("CodexAdapter — Windows npm-shim resolution", () => {
  function enoentOnce(): { spawnSync: SpawnSync; calls: Array<{ cmd: string; args: string[] }> } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSync: SpawnSync = (cmd, args, options) => {
      calls.push({ cmd, args: [...args] });
      void options;
      if (cmd === "codex") {
        const err = Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" });
        return cliResult(null, "", err as NodeJS.ErrnoException);
      }
      return cliResult(0, "done via resolved");
    };
    return { spawnSync, calls };
  }

  it("on win32, an ENOENT from the bare command retries once through the resolved entry, keeping args", async () => {
    const { spawnSync, calls } = enoentOnce();
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const adapter = new CodexAdapter({
      projectRoot,
      spawnSync,
      platform: "win32",
      resolveCommand: (command) => (command === "codex" ? { file: "node-resolved", prefixArgs: ["C:\npm\bin\codex.js"] } : null),
    });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, env: { FOO: "bar" } }));

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("codex");
    expect(calls[1].cmd).toBe("node-resolved");
    expect(calls[1].args[0]).toBe("C:\npm\bin\codex.js");
    expect(calls[1].args.slice(1)).toEqual(calls[0].args);
    expect(result.status).toBe("OK");
    expect(result.text).toBe("done via resolved");
  });

  it("on win32, stays UNAVAILABLE with the shim hint when the resolver finds nothing — one attempt only", async () => {
    const { spawnSync, calls } = enoentOnce();
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const adapter = new CodexAdapter({
      projectRoot,
      spawnSync,
      platform: "win32",
      resolveCommand: () => null,
    });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.some((d) => /shim spawnSync cannot execute/.test(d))).toBe(true);
  });

  it("on non-win32, an ENOENT is UNAVAILABLE without a resolve attempt", async () => {
    const { spawnSync, calls } = enoentOnce();
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const adapter = new CodexAdapter({
      projectRoot,
      spawnSync,
      platform: "linux",
      resolveCommand: () => {
        throw new Error("resolver must not be consulted off win32");
      },
    });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot }));

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("UNAVAILABLE");
  });
});
