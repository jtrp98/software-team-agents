import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter, parseOpenCodeJsonl } from "./openCodeAdapter.js";
import { NO_GUARDS, type RuntimeAgentRequest, type SpawnSync } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * Unit contract for the OpenCode adapter. Everything runs through injected
 * spawns; nothing here needs `opencode` on the machine.
 *
 * The NDJSON fixtures mirror what 1.18.21 actually emitted during manual
 * testing: `text` events carry message parts, the final `step_finish` carries
 * tokens/cost/reason.
 */

const SPIKE_NDJSON = [
  JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "ses_x", part: { id: "p1", type: "step-start" } }),
  JSON.stringify({
    type: "text",
    timestamp: 2,
    part: { id: "p2", type: "text", text: "SPIKE_OK" },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: 3,
    part: {
      id: "p3",
      reason: "stop",
      type: "step-finish",
      tokens: { total: 6041, input: 6019, output: 16, reasoning: 6, cache: { write: 0, read: 3 } },
      cost: 0,
    },
  }),
  "",
].join("\n");

function spawnResult(over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
    ...over,
  } as unknown as SpawnSyncReturns<string>;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function projectWithBinding(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-opencode-adapter-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opencode", "agent", "qa-engineer.md"),
    "---\ndescription: verifies work\nmode: all\npermission:\n  bash:\n    \"git *\": deny\n---\n\nRole text.\n",
    "utf8",
  );
  return root;
}

function requestFor(root: string, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "qa-engineer",
    cwd: root,
    definitionPath: ".opencode/agent/qa-engineer.md",
    prompt: "spike check",
    autonomy: "read-only",
    guards: NO_GUARDS,
    ...over,
  };
}

describe("parseOpenCodeJsonl", () => {
  it("joins text parts in order and lifts tokens/cost from step_finish (spike shape)", () => {
    const parsed = parseOpenCodeJsonl(SPIKE_NDJSON);
    expect(parsed.text).toBe("SPIKE_OK");
    expect(parsed.usage).toEqual({ inputTokens: 6019, outputTokens: 16, cachedInputTokens: 3, costUsd: 0 });
    expect(parsed.finishReason).toBe("stop");
  });

  it("never throws on garbage lines and keeps absent fields undefined, never zero", () => {
    const parsed = parseOpenCodeJsonl("not json\n{broken\n\n{\"type\":\"other\"}\n");
    expect(parsed.text).toBe("");
    expect(parsed.usage).toEqual({});
    expect(parsed.model).toBeUndefined();
  });
});

describe("OpenCodeAdapter", () => {
  function okSpawn(stdout = SPIKE_NDJSON): { spawn: SpawnSync; calls: { cmd: string; args: string[] }[] } {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn = ((_command: string, args: string[]) => {
      calls.push({ cmd: _command, args });
      if (args.includes("--version")) return spawnResult({ stdout: "1.18.21\n" });
      return spawnResult({ stdout });
    }) as unknown as SpawnSync;
    return { spawn, calls };
  }

  it("probe answers without throwing and reports the binary version", async () => {
    const { spawn } = okSpawn();
    const adapter = new OpenCodeAdapter({ projectRoot: projectWithBinding(), spawnSync: spawn });
    await expect(adapter.probe()).resolves.toEqual({ available: true, version: "1.18.21" });
  });

  it("runs headless with --format json + --agent and parses the envelope", async () => {
    const root = projectWithBinding();
    const { spawn, calls } = okSpawn();
    const adapter = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn });

    const result = await adapter.executeAgent(requestFor(root));

    expect(result.status).toBe("OK");
    expect(result.text).toBe("SPIKE_OK");
    expect(result.usage.inputTokens).toBe(6019);
    const runCall = calls.find((c) => c.args.includes("run"))!;
    expect(runCall.cmd).toBe("opencode");
    const flagOrder = runCall.args;
    expect(flagOrder.indexOf("--format")).toBeGreaterThan(-1);
    expect(flagOrder[flagOrder.indexOf("--format") + 1]).toBe("json");
    expect(flagOrder.indexOf("--agent")).toBeGreaterThan(-1);
    expect(flagOrder[flagOrder.indexOf("--agent") + 1]).toBe("qa-engineer");
    expect(flagOrder[flagOrder.length - 1]).toBe("spike check");
    expect(runCall.args.includes("--auto")).toBe(false);
  });

  it("splits req.model into -m plus --variant for a #effort suffix", async () => {
    const root = projectWithBinding();
    const { spawn, calls } = okSpawn();
    const adapter = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn });
    await adapter.executeAgent(requestFor(root, { model: "opencode/x-preview-f-free#max" }));
    const args = calls.find((c) => c.args.includes("run"))!.args;
    expect(args[args.indexOf("-m") + 1]).toBe("opencode/x-preview-f-free");
    expect(args[args.indexOf("--variant") + 1]).toBe("max");
  });

  it("refuses to run when the binding is missing — silent default-agent fallback is worse than an error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-opencode-empty-"));
    roots.push(root);
    const { spawn, calls } = okSpawn();
    const adapter = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn });

    const result = await adapter.executeAgent(requestFor(root));

    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join("\n")).toMatch(/silently fall back|sta init\/sync/);
    expect(calls.some((c) => c.args.includes("run"))).toBe(false);
  });

  it("maps ENOENT to UNAVAILABLE and ETIMEDOUT to TIMEOUT", async () => {
    const enoent = ((_command: string) =>
      spawnResult({
        status: null,
        error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
        pid: 0,
      })) as unknown as SpawnSync;
    const adapter = new OpenCodeAdapter({ projectRoot: projectWithBinding(), spawnSync: enoent });
    const result = await adapter.executeAgent(requestFor(projectWithBinding()));
    expect(result.status).toBe("UNAVAILABLE");

    const timeout = ((_command: string) =>
      spawnResult({
        status: null,
        error: Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" }),
        pid: 0,
      })) as unknown as SpawnSync;
    const adapter2 = new OpenCodeAdapter({ projectRoot: projectWithBinding(), spawnSync: timeout });
    const result2 = await adapter2.executeAgent(requestFor(projectWithBinding()));
    expect(result2.status).toBe("TIMEOUT");
  });

  it("maps provider/auth failures to UNAVAILABLE so task retry budgets survive them", async () => {
    const root = projectWithBinding();
    const providerFailed = ((_command: string, args: string[]) => {
      if (args.includes("--version")) return spawnResult({ stdout: "1.18.21\n" });
      return spawnResult({ status: 1, stderr: "Error: Provider finish_reason: network_error" });
    }) as unknown as SpawnSync;
    const adapter = new OpenCodeAdapter({ projectRoot: root, spawnSync: providerFailed });
    const result = await adapter.executeAgent(requestFor(root));
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.diagnostics.join("\n")).toMatch(/provider\/auth failure/);
  });

  it("reports pre/post guard enforced only when the sta-guards plugin exists; exit checks stay unenforced", async () => {
    const root = projectWithBinding();
    const { spawn } = okSpawn();
    const noPlugin = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn });
    const guarded: RuntimeAgentRequest = requestFor(root, {
      guards: { writeAllow: [], writeDeny: ["**"], forbidCommands: ["git"], exitChecks: ["code-green"] },
    });

    const withoutPlugin = await noPlugin.executeAgent(guarded);
    expect(withoutPlugin.guards.enforced).toEqual([]);
    expect(withoutPlugin.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(withoutPlugin.guards.unenforced).toContain(RuntimeCapability.EXIT_GUARD);

    fs.mkdirSync(path.join(root, ".opencode", "plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opencode", "plugin", "sta-guards.js"), "export const StaGuards = async () => ({});\n", "utf8");
    const withPlugin = await noPlugin.executeAgent(guarded);
    expect(withPlugin.guards.enforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(withPlugin.guards.unenforced).toContain(RuntimeCapability.EXIT_GUARD);
    expect(withPlugin.guards.reason).toMatch(/Stop-hook|post-hoc/);
  });

  it("unguarded requests produce an empty guard report either way", async () => {
    const root = projectWithBinding();
    const { spawn } = okSpawn();
    const adapter = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn });
    const result = await adapter.executeAgent(requestFor(root));
    expect(result.guards).toEqual({ enforced: [], unenforced: [] });
  });
});
