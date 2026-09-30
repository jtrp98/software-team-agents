import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../runtime/claudeCodeAdapter.js";
import { CodexAdapter } from "../runtime/codexAdapter.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import type { SpawnSync } from "../runtime/runtimeAdapter.js";
import { createSta, RUN_ID_ENV, RUN_STORE_ENV } from "./execute.js";

// Keep the Codex permission profile off the real account's approval directory.
vi.mock("../gates/humanChannelConfig.js", () => ({
  approvalChannelDir: () => path.join(os.tmpdir(), "sta-test-approval-channel"),
}));

/**
 * Adapter-level coverage of `sta.execute`: the real Claude Code and Codex
 * adapters, with only the process spawn faked. It shows a direct run reaches
 * each vendor CLI with no persona, with the run's own identity in its
 * environment, and with no parent role leaking through.
 */

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function proc(stdout: string): SpawnSyncReturns<string> {
  return { status: 0, stdout, stderr: "", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
}

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input?: string;
}

function recordingSpawn(stdout: (args: string[]) => string, into: Spawned[]): SpawnSync {
  return (command, args, options) => {
    into.push({ command, args: [...args], env: { ...options.env }, input: options.input });
    return proc(stdout(args));
  };
}

describe("sta.execute through the real runtime adapters", () => {
  it("Claude controller → STA → Codex CLI executor: no persona, run identity in the env, parent role cleared", async () => {
    const workspace = tmp("sta-adapter-ws-");
    const spawned: Spawned[] = [];
    const codex = new CodexAdapter({
      projectRoot: workspace,
      spawnSync: recordingSpawn((args) => {
        const out = args[args.indexOf("-o") + 1];
        fs.writeFileSync(out, "codex finished", "utf8");
        return "";
      }, spawned),
    });
    // The controller is a Claude Code session: its own process carries a
    // workflow role that must not reach the child it delegates to.
    const sta = createSta({
      registry: new RuntimeRegistry([codex]),
      runStore: path.join(tmp("sta-adapter-store-"), "runs"),
      env: { STA_ROLE: "backend-engineer" },
      cwd: workspace,
    });

    const result = await sta.execute({ runtime: "codex", task: "list the exported functions" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toBe("codex finished");
    const [call] = spawned;
    expect(call.command).toBe("codex");
    expect(call.args[0]).toBe("exec");
    const prompt = call.args[call.args.length - 1];
    expect(prompt.startsWith("list the exported functions")).toBe(true);
    expect(call.env[RUN_ID_ENV]).toBe(result.run.runId);
    expect(call.env[RUN_STORE_ENV]).toBe(sta.store.dir);
    expect(call.env.STA_ROLE).toBe("");
  });

  it("Codex controller → STA → Claude Code executor: `claude -p` with no --agent", async () => {
    const workspace = tmp("sta-adapter-ws-");
    const spawned: Spawned[] = [];
    const claude = new ClaudeCodeAdapter({
      projectRoot: workspace,
      spawnSync: recordingSpawn(() => JSON.stringify({ is_error: false, result: "claude finished" }), spawned),
      startEgressProxy: async () => ({ url: "http://127.0.0.1:1", stop: () => undefined }),
    });
    const sta = createSta({ registry: new RuntimeRegistry([claude]), runStore: path.join(tmp("sta-adapter-store-"), "runs"), env: {}, cwd: workspace });

    const result = await sta.execute({ runtime: "claude-code", task: "explain the retry policy" });

    expect(result.status).toBe("completed");
    const [call] = spawned;
    expect(call.args).toContain("-p");
    expect(call.args).not.toContain("--agent");
    expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(call.input).toContain("explain the retry policy");
    expect(call.env.STA_ROLE).toBe("");
    expect(call.env[RUN_ID_ENV]).toBe(result.run.runId);
  });

  it("a named persona still resolves through the runtime's own binding", async () => {
    const workspace = tmp("sta-adapter-ws-");
    const spawned: Spawned[] = [];
    const claude = new ClaudeCodeAdapter({
      projectRoot: workspace,
      spawnSync: recordingSpawn(() => JSON.stringify({ is_error: false, result: "ok" }), spawned),
      startEgressProxy: async () => ({ url: "http://127.0.0.1:1", stop: () => undefined }),
    });
    const sta = createSta({ registry: new RuntimeRegistry([claude]), runStore: path.join(tmp("sta-adapter-store-"), "runs"), env: {}, cwd: workspace });

    await sta.execute({ runtime: "claude-code", task: "review", role: "reviewer" });

    expect(spawned[0].args[spawned[0].args.indexOf("--agent") + 1]).toBe("reviewer");
    expect(spawned[0].env.STA_ROLE).toBe("reviewer");
  });
});
