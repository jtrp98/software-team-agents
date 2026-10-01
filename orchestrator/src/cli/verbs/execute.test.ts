import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli.js";
import { MockRuntimeAdapter, okResult } from "../../runtime/mockAdapter.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import type { RuntimeAgentRequest } from "../../runtime/runtimeAdapter.js";
import { RUN_ID_ENV, RUN_STORE_ENV } from "../../execute/execute.js";

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Runs `sta …` in-process and returns its exit code and the JSON it printed. */
async function sta(argv: string[], registry: RuntimeRegistry, cwd: string): Promise<{ code: number; json: any }> {
  const printed: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
  try {
    const code = await runCli(argv, cwd, { createRuntimeRegistry: () => registry });
    return { code, json: JSON.parse(printed.join("\n")) };
  } finally {
    spy.mockRestore();
  }
}

/** What a spawned `sta execute` inside an executor sees: the executor's environment. */
async function asChildProcess<T>(env: Readonly<Record<string, string>> | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const savedStore = process.env[RUN_STORE_ENV];
afterEach(() => {
  if (savedStore === undefined) delete process.env[RUN_STORE_ENV];
  else process.env[RUN_STORE_ENV] = savedStore;
});

describe("sta execute", () => {
  it("runs one task on the named runtime and prints the normalized result", async () => {
    const root = tmp("sta-cli-exec-");
    const codex = new MockRuntimeAdapter({ id: "codex", respond: () => okResult({ text: "patched" }) });

    const { code, json } = await sta(["execute", "--runtime", "codex", "--task", "fix the typo", "--write"], new RuntimeRegistry([codex]), root);

    expect(code).toBe(0);
    expect(json).toMatchObject({ status: "completed", output: "patched", run: { depth: 0, runtime: "codex", parentRunId: null } });
    expect(codex.requests[0].autonomy).toBe("edit");
    expect(fs.existsSync(path.join(root, ".workflow", "runs", json.run.rootRunId, `${json.run.runId}.json`))).toBe(true);
  });

  it("a `sta execute` from inside a run becomes that run's child through the environment alone", async () => {
    const root = tmp("sta-cli-exec-");
    let child: any;
    const claude = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ text: "leaf" }) });
    const registry = new RuntimeRegistry([claude]);
    const codex = new MockRuntimeAdapter({
      id: "codex",
      respond: async (req: RuntimeAgentRequest) => {
        child = await asChildProcess(req.env, () => sta(["execute", "--runtime", "claude-code", "--task", "sub-task"], registry, root));
        return okResult({ text: `child said ${child.json.output}` });
      },
    });
    registry.register(codex);

    const { json } = await sta(["execute", "--runtime", "codex", "--task", "parent task"], registry, root);

    expect(json.output).toBe("child said leaf");
    expect(child.json.run).toMatchObject({ parentRunId: json.run.runId, rootRunId: json.run.runId, depth: 1 });
    expect(claude.requests[0].env![RUN_ID_ENV]).toBe(child.json.run.runId);
  });

  it("--writable-target reaches the run: a Target the workspace does not map is refused before anything runs", async () => {
    const root = tmp("sta-cli-exec-");
    const claude = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ text: "never" }) });

    const { code, json } = await sta(
      ["execute", "--runtime", "claude-code", "--task", "BE-005", "--role", "backend-engineer", "--writable-target", "backend"],
      new RuntimeRegistry([claude]),
      root,
    );

    expect(code).toBe(1);
    expect(json).toMatchObject({ status: "failed", error: { code: "target_not_mapped" } });
    expect(claude.requests).toHaveLength(0);
  });

  it("a declared side effect exits 3 and waits; approve + resume completes it", async () => {
    const root = tmp("sta-cli-exec-");
    const codex = new MockRuntimeAdapter({ id: "codex", respond: () => okResult({ text: "migrated" }) });
    const registry = new RuntimeRegistry([codex]);

    const waiting = await sta(["execute", "--runtime", "codex", "--task", "run the migration", "--write", "--action", "migration"], registry, root);
    expect(waiting.code).toBe(3);
    expect(codex.requests).toHaveLength(0);

    const approved = await sta(["execute", "approve", waiting.json.run.runId, "--request", waiting.json.request.requestId, "--yes", "--by", "golf"], registry, root);
    expect(approved.json).toMatchObject({ ok: true, approved: true });

    const resumed = await sta(["execute", "resume", waiting.json.run.runId], registry, root);
    expect(resumed).toMatchObject({ code: 0, json: { status: "completed", output: "migrated" } });

    const shown = await sta(["execute", "show", waiting.json.run.runId], registry, root);
    expect(shown.json).toHaveLength(1);
  });
});
