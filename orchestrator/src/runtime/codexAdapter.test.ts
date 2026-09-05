import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { CodexAdapter, addDirArgsFor, extractDeveloperInstructions, parseCodexJsonl, unreadableWorkRootCaveat } from "./codexAdapter.js";
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

  it("maps autonomy onto sandbox/approval flags", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const table: Array<["read-only" | "propose" | "edit" | "full", string, string]> = [
      ["read-only", "read-only", "on-request"],
      ["propose", "workspace-write", "on-request"],
      ["edit", "workspace-write", "on-failure"],
      ["full", "danger-full-access", "never"],
    ];
    for (const [autonomy, sandbox, approval] of table) {
      let capturedArgs: string[] = [];
      const spawnSync: SpawnSync = (_cmd, args) => {
        capturedArgs = args;
        return cliResult(0, "done");
      };
      const adapter = new CodexAdapter({ projectRoot, spawnSync });
      await adapter.executeAgent(baseRequest({ cwd: projectRoot, autonomy }));
      expect(capturedArgs[capturedArgs.indexOf("--sandbox") + 1]).toBe(sandbox);
      expect(capturedArgs[capturedArgs.indexOf("--ask-for-approval") + 1]).toBe(approval);
    }
  });

  it("sets AGENTCLAUDE_ROLE from the request, and does not drop env the caller supplied", async () => {
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

    expect(capturedEnv?.AGENTCLAUDE_ROLE).toBe("qa-engineer");
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

  it("reports every requested guard axis unenforced — no guard mechanism is claimed at all", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    const spawnSync: SpawnSync = () => cliResult(0, "done");
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, guards: SOME_GUARDS }));

    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced.length).toBeGreaterThan(0);
    expect(result.guards.reason).toMatch(/no guard mechanism/);
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

describe("CodexAdapter — declared shape stays conservative (T110 is a partial implementation)", () => {
  it("addresses a role's official .toml binding inside .codex/agents/, and declares no guard config path", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    expect(adapter.binding.dir).toBe(".codex");
    expect(adapter.binding.definitionPath("business-analyst")).toBe(".codex/agents/business-analyst.toml");
    expect(adapter.binding.guardConfigPath).toBeNull();
  });

  it("does not claim NAMED_AGENTS, guard, structured-result, cost, or interactive-prompt capabilities", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    for (const cap of [
      "named-agents",
      "pre-tool-guard",
      "post-tool-guard",
      "exit-guard",
      "per-agent-exit-guard",
      "structured-result",
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

describe("addDirArgsFor — OFF10 M5, preflight write roots as sandbox-native grants", () => {
  const roots: RuntimeWorkRoot[] = [
    { targetId: "backend", path: "C:/repos/backend", access: "write" },
    { targetId: "frontend", path: "C:/repos/frontend", access: "write" },
    { targetId: "docs", path: "C:/repos/docs", access: "read" },
  ];

  it("adds exactly the write roots, once per root, under workspace-write autonomies", () => {
    expect(addDirArgsFor(roots, "propose")).toEqual(["--add-dir", "C:/repos/backend", "--add-dir", "C:/repos/frontend"]);
    expect(addDirArgsFor(roots, "edit")).toEqual(["--add-dir", "C:/repos/backend", "--add-dir", "C:/repos/frontend"]);
  });

  it("adds nothing for autonomies where an add is meaningless or misleading", () => {
    // read-only sandbox ignores adds; danger-full-access makes them imply a boundary that isn't one.
    expect(addDirArgsFor(roots, "read-only")).toEqual([]);
    expect(addDirArgsFor(roots, "full")).toEqual([]);
  });

  it("handles absent/empty root lists", () => {
    expect(addDirArgsFor(undefined, "edit")).toEqual([]);
    expect(addDirArgsFor([], "propose")).toEqual([]);
  });

  it("surfaces — never swallows — the read-root caveat when it is live", () => {
    expect(unreadableWorkRootCaveat(roots, "edit")).toMatch(/1 read-only work root\(s\) \(docs\).*no documented per-directory read grant/);
    expect(unreadableWorkRootCaveat(roots.filter((r) => r.access === "write"), "edit")).toBeNull();
    expect(unreadableWorkRootCaveat(roots, "read-only")).toBeNull();
  });

  it("lands --add-dir pairs in the spawned args, and states the read-root caveat for a mixed-root editing run", async () => {
    const projectRoot = tmpProject();
    writeRoleBinding(projectRoot, "backend-engineer");
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, "done");
    };
    const adapter = new CodexAdapter({ projectRoot, spawnSync });

    const result = await adapter.executeAgent(baseRequest({ cwd: projectRoot, autonomy: "edit", workRoots: roots }));

    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs[capturedArgs.indexOf("--add-dir") + 1]).toBe("C:/repos/backend");
    expect(capturedArgs[capturedArgs.indexOf("--add-dir", capturedArgs.indexOf("--add-dir") + 1) + 1]).toBe("C:/repos/frontend");
    // Prompt stays last.
    expect(capturedArgs[capturedArgs.length - 1]).toContain("do the thing");
    expect(result.diagnostics.some((d) => /1 read-only work root\(s\) \(docs\)/.test(d))).toBe(true);
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
