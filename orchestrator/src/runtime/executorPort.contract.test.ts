import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { OpenCodeAdapter } from "./openCodeAdapter.js";
import { AntigravityAdapter } from "./antigravityAdapter.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS } from "./runtimeAdapter.js";
import {
  CAPABILITY_FOR_OPERATION,
  deterministicAttemptId,
  executeOnlyLifecycle,
  ExecutorPortRefusalError,
  type ExecutorAttemptRef,
  type ExecutorPort,
} from "./executorPort.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import type { RuntimeAdapter, RuntimeAgentRequest, SpawnSync } from "./runtimeAdapter.js";

/**
 * V13 TASK-013 — the executor lifecycle port's contract, stated once and
 * applied to every implementation.
 *
 * `adapterContract.test.ts` pins the probe/execute half of the seam; this
 * suite pins the whole lifecycle on top of it: prepare mints a stable attempt
 * identity before any spawn, execute is tied to that identity, and every
 * lifecycle operation a runtime has not declared is a *typed refusal* — never
 * a fabricated success, never a silent "completed", never a new attempt
 * wearing a resumed one's id. The suite runs the full-lifecycle assertions
 * only against implementations that declare the capabilities, and holds the
 * rest to the refusal contract, which is exactly how TASK-014/015 will be
 * graded when they replace the refusals with implementations.
 *
 * Real runtimes are exercised only through injected spawns — no test here
 * requires any runtime binary to exist on the machine.
 */

const ALL_CAPABILITIES = new Set(Object.values(RuntimeCapability));
const LIFECYCLE_OPERATIONS = ["resume", "cancel", "collectResult", "collectEvidence"] as const;

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
function fakeSpawn(binary: "claude" | "codex" | "opencode" | "agy"): SpawnSync {
  return ((_command: string, args: string[]) => {
    if (args.includes("--version")) return spawnResult({ stdout: `0.0.0-${binary}-test\n` });
    if (args.includes("-p") || args.includes("exec")) {
      return spawnResult({
        stdout:
          binary === "agy"
            ? JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: "done", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } })
            : binary === "claude"
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

let projectRoot: string;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sta-executor-port-"));
});

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** Every implementation the port contract applies to, and whether it declares the full lifecycle today. */
const implementations: { name: string; declaresLifecycle: boolean; make: () => ExecutorPort }[] = [
  { name: "MockRuntimeAdapter (full lifecycle)", declaresLifecycle: true, make: () => new MockRuntimeAdapter() },
  { name: "MockRuntimeAdapter (refusing posture)", declaresLifecycle: false, make: () => new MockRuntimeAdapter({ capabilities: [RuntimeCapability.NAMED_AGENTS] }) },
  { name: "ClaudeCodeAdapter", declaresLifecycle: false, make: () => executeOnlyLifecycle(new ClaudeCodeAdapter({ projectRoot, spawnSync: fakeSpawn("claude") })) },
  { name: "CodexAdapter", declaresLifecycle: false, make: () => executeOnlyLifecycle(new CodexAdapter({ projectRoot, models: ["gpt-5-test"], spawnSync: fakeSpawn("codex") })) },
  { name: "OpenCodeAdapter", declaresLifecycle: false, make: () => executeOnlyLifecycle(new OpenCodeAdapter({ projectRoot, spawnSync: fakeSpawn("opencode") })) },
  { name: "AntigravityAdapter", declaresLifecycle: false, make: () => executeOnlyLifecycle(new AntigravityAdapter({ projectRoot, spawnSync: fakeSpawn("agy") })) },
];

function requestFor(port: ExecutorPort, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "qa-engineer",
    cwd: projectRoot,
    definitionPath: port.binding.definitionPath("qa-engineer"),
    prompt: "port contract check",
    autonomy: "read-only",
    guards: NO_GUARDS,
    ...over,
  };
}

describe.each(implementations)("$name", ({ declaresLifecycle, make }) => {
  it("prepare mints a stable attempt identity before any spawn", async () => {
    const port = make();
    const req = requestFor(port);
    const first = await port.prepare(req);
    const second = await port.prepare(req);
    // The identity is a fact about the request, not about the clock: the same
    // packet prepares the same attempt, twice.
    expect(first.attemptId.length).toBeGreaterThan(0);
    expect(first.runtimeId).toBe(port.id);
    expect(first.preparedAt).toBeGreaterThan(0);
    expect(second.attemptId).toBe(first.attemptId);
  });

  it("a different packet mints a different attempt identity", async () => {
    const port = make();
    const a = await port.prepare(requestFor(port, { prompt: "packet a" }));
    const b = await port.prepare(requestFor(port, { prompt: "packet b" }));
    expect(b.attemptId).not.toBe(a.attemptId);
  });

  it("execute is tied to a prepared attempt, and an unprepared one is refused", async () => {
    const port = make();
    const prepared = await port.prepare(requestFor(port));
    if (port instanceof MockRuntimeAdapter) {
      const result = await port.execute(prepared);
      expect(result.status).toBe("OK");
    } else {
      // The wrapped real adapters read role definitions through the workspace;
      // give them one so the contract is about the lifecycle, not the fixture.
      await port.workspace.writeFile(port.binding.definitionPath("qa-engineer"), "role text");
      const result = await port.execute(prepared);
      expect(["OK", "ERROR", "TIMEOUT", "UNAVAILABLE"]).toContain(result.status);
    }
    const forged: ExecutorAttemptRef = { runtimeId: port.id, attemptId: `atm_${"0".repeat(32)}` };
    await expect(port.execute({ ...forged, preparedAt: Date.now() })).rejects.toMatchObject({
      name: "ExecutorPortRefusalError",
      code: "unknown-attempt",
      operation: "execute",
    });
  });

  it.each(LIFECYCLE_OPERATIONS)(
    "%s answers with the port's normalized shape or a typed refusal — never an approximation",
    async (operation) => {
      const port = make();
      const capability = CAPABILITY_FOR_OPERATION[operation];
      const ref: ExecutorAttemptRef = { runtimeId: port.id, attemptId: `atm_${"1".repeat(32)}`, taskId: "T-PORT", stage: "qa-engineer" };
      if (declaresLifecycle && port.capabilities.has(capability)) {
        if (operation === "resume") {
          const result = await port.resume(ref);
          expect(result.status).toBe("OK");
          expect(typeof result.text).toBe("string");
        } else if (operation === "cancel") {
          const outcome = await port.cancel(ref);
          expect(["cancelled", "already-finished", "refused"]).toContain(outcome.status);
        } else if (operation === "collectResult") {
          const result = await port.collectResult(ref);
          expect(result === null || typeof result.status === "string").toBe(true);
        } else {
          const evidence = await port.collectEvidence(ref);
          expect(evidence.attemptId).toBe(ref.attemptId);
          expect(evidence.runtimeId).toBe(port.id);
          expect(Array.isArray(evidence.logs)).toBe(true);
          expect(typeof evidence.collectedAt).toBe("number");
        }
      } else {
        // Not declared: the typed refusal is the contract. A success here
        // would be the port pretending a capability into existence.
        await expect(
          operation === "resume"
            ? port.resume(ref)
            : operation === "cancel"
              ? port.cancel(ref)
              : operation === "collectResult"
                ? port.collectResult(ref)
                : port.collectEvidence(ref),
        ).rejects.toMatchObject({
          name: "ExecutorPortRefusalError",
          code: "unsupported-operation",
          operation,
          runtimeId: port.id,
        });
      }
    },
  );

  it("declares only capabilities the enum knows, lifecycle ones included", () => {
    const port = make();
    for (const capability of port.capabilities) {
      expect(ALL_CAPABILITIES.has(capability)).toBe(true);
    }
  });
});

describe("the full lifecycle against the mock — success, resume, cancel, evidence", () => {
  it("prepare → execute → collectResult → collectEvidence carry one attempt identity end to end", async () => {
    const port: ExecutorPort = new MockRuntimeAdapter({
      respond: (_req, index) => okResult({ text: `run ${index}` }),
    });
    const prepared = await port.prepare(requestFor(port, { taskId: "T-LIFE", stage: "qa-engineer" }));
    const result = await port.execute(prepared);
    expect(result).toMatchObject({ status: "OK", text: "run 0" });

    const collected = await port.collectResult(prepared);
    expect(collected).toMatchObject({ status: "OK", text: "run 0" });

    const evidence = await port.collectEvidence(prepared);
    expect(evidence).toMatchObject({
      attemptId: prepared.attemptId,
      runtimeId: port.id,
      sessionRef: expect.stringMatching(/^mock-session-/),
    });
    expect(evidence.result).toMatchObject({ text: "run 0" });
    expect(evidence.logs.length).toBeGreaterThan(0);
  });

  it("resume continues the same attempt id and never mints a new one", async () => {
    const mock = new MockRuntimeAdapter();
    const port: ExecutorPort = mock;
    const prepared = await port.prepare(requestFor(port));
    const resumed = await port.resume(prepared);
    expect(resumed.status).toBe("OK");
    // The reference the runtime was handed is the one the caller persisted —
    // the adapter invents nothing.
    expect(mock.lifecycleRefs).toEqual([prepared]);
    expect(mock.requests).toEqual([]); // a resume is not a fresh execute
  });

  it("cancel reports an honest outcome for an in-flight and a finished attempt", async () => {
    const port: ExecutorPort = new MockRuntimeAdapter();
    const prepared = await port.prepare(requestFor(port));
    expect(await port.cancel(prepared)).toMatchObject({ status: "cancelled" });
    await port.execute(prepared);
    expect(await port.cancel(prepared)).toMatchObject({ status: "already-finished" });
  });

  it("a mock that does not declare the lifecycle refuses it typed", async () => {
    const port: ExecutorPort = new MockRuntimeAdapter({ capabilities: [RuntimeCapability.NAMED_AGENTS] });
    const ref: ExecutorAttemptRef = { runtimeId: port.id, attemptId: "atm_x" };
    for (const operation of LIFECYCLE_OPERATIONS) {
      await expect(
        operation === "resume" ? port.resume(ref) : operation === "cancel" ? port.cancel(ref) : operation === "collectResult" ? port.collectResult(ref) : port.collectEvidence(ref),
      ).rejects.toBeInstanceOf(ExecutorPortRefusalError);
    }
  });
});

describe("the deterministic attempt id", () => {
  it("is stable across identical requests and sensitive to the packet bytes", () => {
    const port = new MockRuntimeAdapter();
    const req = requestFor(port, { prompt: "same" });
    expect(deterministicAttemptId(port.id, req)).toBe(deterministicAttemptId(port.id, req));
    expect(deterministicAttemptId(port.id, { ...req, prompt: "different" })).not.toBe(deterministicAttemptId(port.id, req));
    expect(deterministicAttemptId("other", req)).not.toBe(deterministicAttemptId(port.id, req));
  });
});

describe("the port boundary — STA Core holds no runtime's command or session vocabulary", () => {
  /**
   * The lifecycle port's reason to exist, enforced: the modules STA Core runs
   * on name no runtime binary, flag, or envelope field. Runtime-specific
   * vocabulary lives in the adapter modules the composition root wires in —
   * a match below means a provider detail leaked past the port.
   */
  const CORE_MODULES = [
    "runtimeExecutor.ts",
    "runtimeAdapter.ts",
    "executorPort.ts",
    "runtimeCapabilities.ts",
    "runtimeRouting.ts",
    "runtimeRegistry.ts",
  ];

  /** Binary names and envelope/session formats of the five executors — the vocabulary the port exists to keep out of Core. */
  const RUNTIME_VOCABULARY: [string, RegExp][] = [
    ["claude CLI flags", /["'`](-p|--print|—print|is_error|total_cost_usd|session_id)["'`]/],
    ["codex CLI flags", /["'`](exec|dangerously-bypass-hook-trust|conversation_id|developer_instructions)["'`]/],
    ["opencode envelope", /["'`](part\.type|tool\.execute\.before)["'`]/],
    ["antigravity envelope", /["'`](conversation_id|num_turns|artifactDirectoryPath)["'`]/],
  ];

  it("no core module names a runtime's commands or session format", () => {
    const violations: string[] = [];
    for (const module of CORE_MODULES) {
      const content = fs.readFileSync(path.join(__dirname, module), "utf8");
      for (const [name, pattern] of RUNTIME_VOCABULARY) {
        if (pattern.test(content)) violations.push(`${module} names ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the wrapped four stay available through the port without new wiring", () => {
    // The conformance round (TASK-014) replaces these wrappers with real
    // lifecycle implementations; until then the port's refusal contract keeps
    // them honest. This pins that the wrapper surfaces every RuntimeAdapter
    // fact the core already depends on.
    const adapter: RuntimeAdapter = new MockRuntimeAdapter();
    const port = executeOnlyLifecycle(adapter);
    expect(port.id).toBe(adapter.id);
    expect(port.displayName).toBe(adapter.displayName);
    expect(port.binding).toBe(adapter.binding);
    expect(port.capabilities).toBe(adapter.capabilities);
    expect(port.models).toBe(adapter.models);
    expect(port.workspace).toBe(adapter.workspace);
  });
});
