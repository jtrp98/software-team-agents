import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_PROVIDER_REFUSAL_FINGERPRINTS,
  AntigravityAdapter,
  parseAgyEnvelope,
} from "./antigravityAdapter.js";
import { NO_GUARDS, type RuntimeAgentRequest, type SpawnSync } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * Every fixture below is a verbatim shape from
 * `planning/v6/v6-agy-spike-evidence.md` (agy 1.1.24, Windows 11). A fixture
 * invented here would let this suite pass against an envelope no install emits.
 */
const SUCCESS_ENVELOPE = JSON.stringify({
  conversation_id: "11dbde93-bd0b-4643-8e03-6509ae35635b",
  status: "SUCCESS",
  response: "PONG\n",
  duration_seconds: 1.084531,
  num_turns: 1,
  usage: { input_tokens: 5147, output_tokens: 25, thinking_tokens: 23, cache_read_tokens: 8128, total_tokens: 5172 },
});

/** §11 — SUCCESS, empty response, every usage counter zero. */
const SILENT_NOOP_ENVELOPE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  duration_seconds: 0,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
});

/** §6 — `--print-timeout` expiry has no distinct status. */
const TIMEOUT_ENVELOPE = JSON.stringify({
  conversation_id: "a2ebd177-0b91-4d4a-9d6e-908dcbbd32cf",
  status: "ERROR",
  response: "",
  error: "timeout waiting for response",
  duration_seconds: 0,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
});

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(roleText = "you are qa-engineer"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-agy-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "qa-engineer.md"), roleText, "utf8");
  return root;
}

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function recordingSpawn(calls: Call[], over: Partial<SpawnSyncReturns<string>> = {}): SpawnSync {
  return ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: options.env });
    return { status: 0, stdout: SUCCESS_ENVELOPE, stderr: "", pid: 1, output: [], signal: null, ...over } as unknown as SpawnSyncReturns<string>;
  }) as unknown as SpawnSync;
}

function request(root: string, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "qa-engineer",
    cwd: root,
    definitionPath: ".claude/agents/qa-engineer.md",
    prompt: "verify phase 1",
    autonomy: "edit",
    guards: NO_GUARDS,
    ...over,
  };
}

describe("AntigravityAdapter — argv safety", () => {
  it("never emits --dangerously-skip-permissions on a guarded run", async () => {
    const root = fixture();
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn(calls) });
    await adapter.executeAgent(
      request(root, {
        guards: { writeAllow: ["src/**"], writeDeny: [".git/**"], forbidCommands: ["git"], exitChecks: ["code-green"] },
      }),
    );
    expect(calls).toHaveLength(1);
    // The flag bypasses AGY's hook layer entirely: a run carrying it looks
    // normal while enforcing nothing. Asserted, never left to review.
    expect(calls[0]!.args).not.toContain("--dangerously-skip-permissions");
    expect(calls[0]!.args.join(" ")).not.toContain("dangerously");
  });

  it("never emits --dangerously-skip-permissions on an unguarded run either", async () => {
    const root = fixture();
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn(calls) });
    await adapter.executeAgent(request(root));
    expect(calls[0]!.args.join(" ")).not.toContain("dangerously");
  });

  it("asks for the JSON envelope and folds the role definition into the prompt", async () => {
    const root = fixture("ROLE-MARKER-7f3a");
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn(calls) });
    await adapter.executeAgent(request(root));
    const args = calls[0]!.args;
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    // No project agent store was demonstrated, so `--agent` must not appear.
    expect(args).not.toContain("--agent");
    expect(args[args.indexOf("-p") + 1]).toContain("ROLE-MARKER-7f3a");
    expect(args[args.indexOf("-p") + 1]).toContain("verify phase 1");
  });

  it("refuses to run with no role binding rather than executing role-less", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-agy-empty-"));
    roots.push(root);
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn(calls) });
    const result = await adapter.executeAgent(request(root));
    expect(result.status).toBe("ERROR");
    expect(calls).toHaveLength(0);
  });
});

describe("AntigravityAdapter — model and effort", () => {
  it("passes an explicit model and refuses one its declared catalogue cannot reach", async () => {
    const root = fixture();
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, models: ["gemini-3.1-pro"], spawnSync: recordingSpawn(calls) });

    await adapter.executeAgent(request(root, { model: "gemini-3.1-pro", modelExplicit: true }));
    expect(calls[0]!.args).toContain("--model");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro");

    const refused = await adapter.executeAgent(request(root, { model: "totally-bogus-model-xyz", modelExplicit: true }));
    expect(refused.status).toBe("ERROR");
    expect(calls).toHaveLength(1); // never reached the spawn
  });

  it("drops --effort for a model whose name already carries it, instead of guaranteeing an exit 1", async () => {
    const root = fixture();
    const calls: Call[] = [];
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn(calls) });

    await adapter.executeAgent(request(root, { model: "gemini-3.1-pro-low", modelExplicit: true, effort: "high" }));
    expect(calls[0]!.args).not.toContain("--effort");

    await adapter.executeAgent(request(root, { model: "claude-sonnet-4-6", modelExplicit: true, effort: "low" }));
    expect(calls[1]!.args).not.toContain("--effort");

    await adapter.executeAgent(request(root, { model: "gemini-3.1-pro", modelExplicit: true, effort: "high" }));
    expect(calls[2]!.args).toContain("--effort");
    expect(calls[2]!.args[calls[2]!.args.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("AntigravityAdapter — result classification", () => {
  it("maps a SUCCESS envelope to OK with token usage and no cost", async () => {
    const root = fixture();
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn([]) });
    const result = await adapter.executeAgent(request(root));
    expect(result.status).toBe("OK");
    expect(result.text).toBe("PONG\n");
    expect(result.usage.inputTokens).toBe(5147);
    expect(result.usage.cachedInputTokens).toBe(8128);
    // No cost field exists in the envelope; 0 would claim the run was free.
    expect(result.usage.costUsd).toBeUndefined();
  });

  it("refuses to call a zero-usage, empty SUCCESS a completed turn", async () => {
    const root = fixture();
    const adapter = new AntigravityAdapter({
      projectRoot: root,
      spawnSync: recordingSpawn([], { stdout: SILENT_NOOP_ENVELOPE }),
    });
    const result = await adapter.executeAgent(request(root));
    expect(result.status).toBe("ERROR");
    expect(result.diagnostics.join(" ")).toMatch(/turn did not run/);
  });

  it("maps the print-timeout envelope to TIMEOUT, which has no status of its own", async () => {
    const root = fixture();
    const adapter = new AntigravityAdapter({
      projectRoot: root,
      spawnSync: recordingSpawn([], { status: 1, stdout: TIMEOUT_ENVELOPE }),
    });
    const result = await adapter.executeAgent(request(root));
    expect(result.status).toBe("TIMEOUT");
  });

  it("maps a missing binary to UNAVAILABLE, never a throw", async () => {
    const root = fixture();
    const adapter = new AntigravityAdapter({
      projectRoot: root,
      spawnSync: (() =>
        ({
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnSyncReturns<string>) as unknown as SpawnSync,
    });
    await expect(adapter.executeAgent(request(root))).resolves.toHaveProperty("status", "UNAVAILABLE");
  });

  it("claims no provider-refusal fingerprint, because none was ever observed", () => {
    // The spike declined to exhaust the user's real quota (§10). An invented
    // pattern here would hand real task failures a free retry budget.
    expect(AGY_PROVIDER_REFUSAL_FINGERPRINTS).toEqual([]);
  });
});

describe("AntigravityAdapter — capability honesty", () => {
  it("declares only what a spike transcript backs", () => {
    const adapter = new AntigravityAdapter({ projectRoot: fixture() });
    expect([...adapter.capabilities].sort()).toEqual(
      [RuntimeCapability.MODEL_SELECTION, RuntimeCapability.STRUCTURED_RESULT].sort(),
    );
    for (const unclaimed of [
      RuntimeCapability.PRE_TOOL_GUARD,
      RuntimeCapability.POST_TOOL_GUARD,
      RuntimeCapability.EXIT_GUARD,
      RuntimeCapability.PER_AGENT_EXIT_GUARD,
      RuntimeCapability.PROJECT_LEVEL_BINDING,
      RuntimeCapability.NAMED_AGENTS,
      RuntimeCapability.COST_REPORTING,
      RuntimeCapability.INTERACTIVE_PROMPTS,
    ]) {
      expect(adapter.capabilities.has(unclaimed), unclaimed).toBe(false);
    }
    // A guard file is rendered into the workspace, but its dispatch has never
    // been observed — so the adapter names no in-band guard mechanism.
    expect(adapter.binding.guardConfigPath).toBeNull();
  });

  it("reports every requested guard family unenforced, with an actionable reason", async () => {
    const root = fixture();
    const adapter = new AntigravityAdapter({ projectRoot: root, spawnSync: recordingSpawn([]) });
    const result = await adapter.executeAgent(
      request(root, {
        guards: { writeAllow: ["src/**"], writeDeny: [".git/**"], forbidCommands: ["git"], exitChecks: ["code-green"] },
      }),
    );
    expect(result.guards.enforced).toEqual([]);
    expect(result.guards.unenforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(result.guards.unenforced).toContain(RuntimeCapability.EXIT_GUARD);
    expect(result.guards.reason).toBeTruthy();
  });
});

describe("parseAgyEnvelope", () => {
  it("reads the plain JSON envelope", () => {
    expect(parseAgyEnvelope(SUCCESS_ENVELOPE)?.status).toBe("SUCCESS");
  });

  it("takes the final result event out of a stream-json transcript", () => {
    const stream = [
      JSON.stringify({ event: "init", conversation_id: "x", init: { cwd: "/tmp", tools: [], permission_mode: "request-review" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }),
      JSON.stringify({ event: "result", result: { conversation_id: "x", status: "SUCCESS", response: "PONG\n", usage: { total_tokens: 5 } } }),
    ].join("\n");
    expect(parseAgyEnvelope(stream)?.response).toBe("PONG\n");
  });

  it("returns null when stdout carries no envelope at all", () => {
    // Argument-parsing errors never reach a turn and print plain text on
    // stderr, even under `--output-format json` (§7) — an absent envelope must
    // stay distinguishable from one full of zeros.
    expect(parseAgyEnvelope("Error: -p took \"--output-format\" as its prompt")).toBeNull();
  });
});
