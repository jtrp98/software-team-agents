import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { OpenCodeAdapter } from "./openCodeAdapter.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS } from "./runtimeAdapter.js";
import type { RuntimeAdapter, RuntimeAgentRequest, SpawnSync } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * OFF04 โ€” the Runtime port's contract, stated once and applied to every
 * implementation.
 *
 * `runtimeAdapter.ts` is the seam that keeps the orchestrator core provider-
 * blind. A contract that lives only in each adapter's own tests is not a
 * contract โ€” it is three private dialects. Everything asserted below is a
 * promise the core makes to itself about what *any* RuntimeAdapter does:
 * identity is stable, bindings address roles, capability claims stay inside the
 * declared enum, probes answer instead of throwing, and an unreachable runtime
 * comes back as `UNAVAILABLE` rather than as an exception or a task failure.
 *
 * Real runtimes are exercised only through injected spawns โ€” no test here
 * requires `claude`/`codex` to exist on the machine (that is T111's
 * capability-verification job against real installations).
 */

const ALL_CAPABILITIES = new Set(Object.values(RuntimeCapability));

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

/** A spawn that answers `--version` for its binary and a well-formed run result otherwise. */
function fakeSpawn(binary: "claude" | "codex" | "opencode"): SpawnSync {
  return ((_command: string, args: string[]) => {
    if (args.includes("--version")) return spawnResult({ stdout: `0.0.0-${binary}-test\n` });
    if (args.includes("-p") || args.includes("exec")) {
      return spawnResult({
        stdout:
          binary === "claude"
            ? JSON.stringify({ result: "done", is_error: false, usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0 })
            : binary === "opencode"
              ? JSON.stringify({ type: "text", part: { type: "text", text: "done" } }) + "\n"
              : "done",
      });
    }
    if (args.includes("--format")) {
      return spawnResult({ stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "done" } })}\n` });
    }
    return spawnResult({});
  }) as unknown as SpawnSync;
}

/** The exact shape node reports when the binary does not exist. */
function enoentSpawn(): SpawnSync {
  return ((_command: string) =>
    spawnResult({
      status: null,
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      pid: 0,
    })) as unknown as SpawnSync;
}

let projectRoot: string;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sta-adapter-contract-"));
});

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const implementations: [string, () => RuntimeAdapter][] = [
  ["MockRuntimeAdapter", () => new MockRuntimeAdapter()],
  ["ClaudeCodeAdapter", () => new ClaudeCodeAdapter({ projectRoot, spawnSync: fakeSpawn("claude") })],
  ["CodexAdapter", () => new CodexAdapter({ projectRoot, models: ["gpt-5-test"], spawnSync: fakeSpawn("codex") })],
  ["OpenCodeAdapter", () => new OpenCodeAdapter({ projectRoot, spawnSync: fakeSpawn("opencode") })],
];

describe.each(implementations)("RuntimeAdapter contract โ€” %s", (_name, make) => {
  it("carries stable, non-empty identity", () => {
    const adapter = make();
    expect(adapter.id.length).toBeGreaterThan(0);
    expect(adapter.displayName.length).toBeGreaterThan(0);
  });

  it("addresses any role under its binding directory", () => {
    const adapter = make();
    const p = adapter.binding.definitionPath("qa-engineer");
    expect(p).toContain(adapter.binding.dir);
    expect(p).toContain("qa-engineer");
  });

  it("claims only capabilities the enum knows", () => {
    const adapter = make();
    for (const cap of adapter.capabilities) {
      expect(ALL_CAPABILITIES.has(cap)).toBe(true);
    }
  });

  it("never throws from probe()", async () => {
    const adapter = make();
    await expect(adapter.probe()).resolves.toHaveProperty("available");
  });

  it("exposes the workspace port", async () => {
    const adapter = make();
    expect(typeof adapter.workspace.readFile).toBe("function");
    expect(typeof adapter.workspace.writeFile).toBe("function");
    expect(typeof adapter.workspace.exists).toBe("function");
    expect(typeof adapter.workspace.runCommand).toBe("function");
  });

  it("returns a fully-shaped agent result for a normal run", async () => {
    const adapter = make();
    if (!(adapter instanceof MockRuntimeAdapter)) {
      // Both real adapters read role definitions through the workspace; give
      // them one so the contract is about the runtime call, not the fixture.
      await adapter.workspace.writeFile(
        adapter.binding.definitionPath("qa-engineer"),
        // Schema-valid for whichever binding format this runtime uses.
        adapter.id === "codex"
          ? 'name = "qa-engineer"\ndescription = "contract fixture"\n\ndeveloper_instructions = """\nrole text\n"""\n'
          : "role text",
      );
    }
    const request: RuntimeAgentRequest = {
      role: "qa-engineer",
      cwd: projectRoot,
      definitionPath: adapter.binding.definitionPath("qa-engineer"),
      prompt: "contract check",
      autonomy: "read-only",
      guards: NO_GUARDS,
    };
    const result = await adapter.executeAgent(request);
    for (const field of ["status", "exitCode", "text", "usage", "guards", "diagnostics"] as const) {
      expect(result).toHaveProperty(field);
    }
    expect(["OK", "ERROR", "TIMEOUT", "UNAVAILABLE"]).toContain(result.status);
  });
});

describe("an unreachable runtime is UNAVAILABLE, never a throw", () => {
  function requestFor(adapter: RuntimeAdapter): RuntimeAgentRequest {
    return {
      role: "qa-engineer",
      cwd: projectRoot,
      definitionPath: adapter.binding.definitionPath("qa-engineer"),
      prompt: "contract check",
      autonomy: "read-only",
      guards: NO_GUARDS,
    };
  }

  it("ClaudeCodeAdapter maps a failed spawn to UNAVAILABLE", async () => {
    const adapter = new ClaudeCodeAdapter({ projectRoot, spawnSync: enoentSpawn(), resolveCommand: () => null });
    const result = await adapter.executeAgent(requestFor(adapter));
    expect(result.status).toBe('UNAVAILABLE');
  });

  it("CodexAdapter maps a failed spawn to UNAVAILABLE", async () => {
    const adapter = new CodexAdapter({ projectRoot, models: ["gpt-5-test"], spawnSync: enoentSpawn() });
    // Schema-valid binding: extraction must succeed so the run actually reaches the spawn.
    await adapter.workspace.writeFile(
      adapter.binding.definitionPath("qa-engineer"),
      'name = "qa-engineer"\ndescription = "contract fixture"\n\ndeveloper_instructions = """\nrole text\n"""\n',
    );
    const result = await adapter.executeAgent(requestFor(adapter));
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("OpenCodeAdapter maps a failed spawn to UNAVAILABLE", async () => {
    const adapter = new OpenCodeAdapter({ projectRoot, spawnSync: enoentSpawn() });
    // The binding must exist or the adapter fails fast before ever spawning.
    await adapter.workspace.writeFile(adapter.binding.definitionPath("qa-engineer"), "role text");
    const result = await adapter.executeAgent(requestFor(adapter));
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("MockRuntimeAdapter can model the same outcome", async () => {
    const adapter = new MockRuntimeAdapter({
      respond: () => okResult({ status: "UNAVAILABLE", exitCode: null }),
    });
    const result = await adapter.executeAgent(requestFor(adapter));
    expect(result.status).toBe('UNAVAILABLE');
  });
});


