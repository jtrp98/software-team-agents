import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { CodexAdapter } from "./codexAdapter.js";
import { NO_GUARDS, type RuntimeGuards } from "./runtimeAdapter.js";
import type { SpawnSync } from "./claudeCodeAdapter.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-"));
}

function writeRoleBinding(root: string, role: string, content = "you are the role") {
  fs.mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "agents", `${role}.md`), content, "utf8");
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
    definitionPath: ".codex/agents/backend-engineer.md",
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
      baseRequest({ cwd: projectRoot, role: "qa-engineer", definitionPath: ".codex/agents/qa-engineer.md", env: { FOO: "bar" } }),
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
  it("addresses a role's definition inside .codex/agents/, and declares no guard config path", () => {
    const adapter = new CodexAdapter({ projectRoot: tmpProject() });
    expect(adapter.binding.dir).toBe(".codex");
    expect(adapter.binding.definitionPath("business-analyst")).toBe(".codex/agents/business-analyst.md");
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
