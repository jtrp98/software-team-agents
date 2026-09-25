import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
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
 * V13 TASK-013/TASK-014 — the executor lifecycle port's contract, stated once
 * and applied to every implementation.
 *
 * `adapterContract.test.ts` pins the probe/execute half of the seam; this
 * suite pins the whole lifecycle on top of it: prepare mints a stable attempt
 * identity before any spawn, execute is tied to that identity, and every
 * lifecycle operation a runtime has not declared is a *typed refusal* — never
 * a fabricated success, never a silent "completed", never a new attempt
 * wearing a resumed one's id. Since TASK-014 the four real adapters implement
 * the lifecycle natively (the shared `SingleShotLifecycle` over their one
 * spawn-and-parse path), so the full-lifecycle assertions now grade them too:
 * resume, cancel and recovery are answered in the port's normalized shape,
 * with evidence (exit status, session reference, changed files) the adapter
 * computed itself.
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
const createdFixtures: string[] = [];

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sta-executor-port-"));
});

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  for (const dir of createdFixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh fixture per construction — the real adapters journal attempts, so tests must not share attempt state. */
function makeFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-executor-port-"));
  createdFixtures.push(root);
  return root;
}

function writeBindingFile(root: string, relPath: string, content: string): void {
  fs.mkdirSync(path.join(root, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(root, relPath), content, "utf8");
}

const TOML_BINDING =
  'name = "qa-engineer"\ndescription = "contract fixture"\n\ndeveloper_instructions = """\ncontract fixture instructions\n"""\n';

const fixtureRootByPort = new WeakMap<ExecutorPort, string>();

/** Builds a real adapter over a fresh fixture root, with the binding files its execute path reads. */
function realAdapterFixture(
  writeBindings: (root: string) => void,
  build: (root: string) => RuntimeAdapter,
): ExecutorPort {
  const root = makeFixtureRoot();
  writeBindings(root);
  const port = build(root) as ExecutorPort;
  fixtureRootByPort.set(port, root);
  return port;
}

/** Every implementation the port contract applies to, and whether it declares the full lifecycle today. */
const implementations: { name: string; declaresLifecycle: boolean; make: () => ExecutorPort }[] = [
  { name: "MockRuntimeAdapter (full lifecycle)", declaresLifecycle: true, make: () => new MockRuntimeAdapter() },
  { name: "MockRuntimeAdapter (refusing posture)", declaresLifecycle: false, make: () => new MockRuntimeAdapter({ capabilities: [RuntimeCapability.NAMED_AGENTS] }) },
  {
    name: "ClaudeCodeAdapter",
    declaresLifecycle: true,
    make: () =>
      realAdapterFixture(
        (root) => writeBindingFile(root, ".claude/agents/qa-engineer.md", "role text"),
        (root) => new ClaudeCodeAdapter({ projectRoot: root, spawnSync: fakeSpawn("claude"), journalRoot: path.join(root, "attempts") }),
      ),
  },
  {
    name: "CodexAdapter",
    declaresLifecycle: true,
    make: () =>
      realAdapterFixture(
        (root) => writeBindingFile(root, ".codex/agents/qa-engineer.toml", TOML_BINDING),
        (root) => new CodexAdapter({ projectRoot: root, models: ["gpt-5-test"], spawnSync: fakeSpawn("codex"), journalRoot: path.join(root, "attempts") }),
      ),
  },
  {
    name: "OpenCodeAdapter",
    declaresLifecycle: true,
    make: () =>
      realAdapterFixture(
        (root) => {
          writeBindingFile(root, ".opencode/agent/qa-engineer.md", "role text");
          // V13 TASK-014 — without the sta-guards plugin the adapter refuses
          // every run before spawn, so the fixture ships the real-install shape.
          writeBindingFile(root, ".opencode/plugin/sta-guards.js", "export const StaGuards = async () => ({});\n");
        },
        (root) => new OpenCodeAdapter({ projectRoot: root, spawnSync: fakeSpawn("opencode"), journalRoot: path.join(root, "attempts") }),
      ),
  },
  {
    name: "AntigravityAdapter",
    declaresLifecycle: true,
    make: () =>
      realAdapterFixture(
        (root) => writeBindingFile(root, ".claude/agents/qa-engineer.md", "role text"),
        (root) => new AntigravityAdapter({ projectRoot: root, spawnSync: fakeSpawn("agy"), journalRoot: path.join(root, "attempts") }),
      ),
  },
];

function requestFor(port: ExecutorPort, over: Partial<RuntimeAgentRequest> = {}): RuntimeAgentRequest {
  return {
    role: "qa-engineer",
    cwd: fixtureRootByPort.get(port) ?? projectRoot,
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
      if (declaresLifecycle && port.capabilities.has(capability)) {
        const prepared = await port.prepare(requestFor(port));
        if (operation === "resume") {
          const result = await port.resume(prepared);
          expect(result.status).toBe("OK");
          expect(typeof result.text).toBe("string");
        } else if (operation === "cancel") {
          const outcome = await port.cancel(prepared);
          expect(["cancelled", "already-finished", "refused"]).toContain(outcome.status);
        } else if (operation === "collectResult") {
          const result = await port.collectResult(prepared);
          expect(result === null || typeof result.status === "string").toBe(true);
        } else {
          const evidence = await port.collectEvidence(prepared);
          expect(evidence.attemptId).toBe(prepared.attemptId);
          expect(evidence.runtimeId).toBe(port.id);
          expect(Array.isArray(evidence.logs)).toBe(true);
          expect(typeof evidence.collectedAt).toBe("number");
        }
        // A reference this adapter never prepared is refused typed — a mock may
        // answer canned outcomes, but the real adapters never approximate one.
        const forged: ExecutorAttemptRef = { runtimeId: port.id, attemptId: `atm_${"9".repeat(32)}` };
        if (port instanceof MockRuntimeAdapter) return;
        if (operation === "cancel") {
          const outcome = await port.cancel(forged);
          expect(outcome).toMatchObject({ status: "refused" });
        } else {
          await expect(
            operation === "resume"
              ? port.resume(forged)
              : operation === "collectResult"
                ? port.collectResult(forged)
                : port.collectEvidence(forged),
          ).rejects.toMatchObject({
            name: "ExecutorPortRefusalError",
            code: "unknown-attempt",
            operation,
            runtimeId: port.id,
          });
        }
      } else {
        // Not declared: the typed refusal is the contract. A success here
        // would be the port pretending a capability into existence.
        const ref: ExecutorAttemptRef = { runtimeId: port.id, attemptId: `atm_${"1".repeat(32)}`, taskId: "T-PORT", stage: "qa-engineer" };
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

describe("V13 TASK-014 — the single-shot lifecycle on the real adapters", () => {
  /** The per-binary success envelope, each carrying its runtime's native session reference. */
  function sessionSpawn(binary: "claude" | "codex" | "opencode" | "agy"): SpawnSync {
    return ((_command: string, args: string[]) => {
      if (args.includes("--version")) return spawnResult({ stdout: `0.0.0-${binary}-test\n` });
      if (args.includes("-p") || args.includes("exec") || args.includes("--format")) {
        const stdout =
          binary === "agy"
            ? JSON.stringify({ conversation_id: "conv-agy-test", status: "SUCCESS", response: "done", duration_seconds: 1, num_turns: 1, usage: { total_tokens: 7 } })
            : binary === "claude"
              ? JSON.stringify({ result: "done", is_error: false, session_id: "sess-claude-test", usage: {} })
              : binary === "opencode"
                ? `${JSON.stringify({ type: "step_start", sessionID: "ses-opencode-test", part: { id: "p1", type: "step-start" } })}\n${JSON.stringify({ type: "text", part: { type: "text", text: "done" } })}\n`
                : "done";
        return spawnResult({ stdout });
      }
      return spawnResult({});
    }) as unknown as SpawnSync;
  }

  function makePort(binary: "claude" | "codex" | "opencode" | "agy", spawn: SpawnSync, root: string): ExecutorPort {
    let port: ExecutorPort;
    switch (binary) {
      case "claude":
        port = new ClaudeCodeAdapter({ projectRoot: root, spawnSync: spawn, journalRoot: path.join(root, "attempts") });
        break;
      case "codex":
        port = new CodexAdapter({ projectRoot: root, models: [], spawnSync: spawn, journalRoot: path.join(root, "attempts") });
        break;
      case "opencode":
        port = new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn, journalRoot: path.join(root, "attempts") });
        break;
      case "agy":
        port = new AntigravityAdapter({ projectRoot: root, spawnSync: spawn, journalRoot: path.join(root, "attempts") });
        break;
    }
    fixtureRootByPort.set(port, root);
    return port;
  }

  function writeBindingsFor(binary: "claude" | "codex" | "opencode" | "agy", root: string): void {
    if (binary === "codex") writeBindingFile(root, ".codex/agents/qa-engineer.toml", TOML_BINDING);
    else if (binary === "opencode") {
      writeBindingFile(root, ".opencode/agent/qa-engineer.md", "role text");
      writeBindingFile(root, ".opencode/plugin/sta-guards.js", "export const StaGuards = async () => ({});\n");
    } else writeBindingFile(root, ".claude/agents/qa-engineer.md", "role text");
  }

  const SESSION_REFS: Record<string, RegExp> = {
    claude: /^sess-claude-test$/,
    codex: /^$/, // no verified session id in the codex JSONL stream — none is invented
    opencode: /^ses-opencode-test$/,
    agy: /^conv-agy-test$/,
  };

  for (const binary of ["claude", "codex", "opencode", "agy"] as const) {
    describe(`${binary}`, () => {
      it("execute → collectEvidence records exit status, the native session reference and run-changed files — never the agent's own report", async () => {
        const root = makeFixtureRoot();
        writeBindingsFor(binary, root);
        // A git fixture so the pre/post snapshots can diff the run's changes.
        execFileSync("git", ["init"], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
        writeBindingFile(root, "base.txt", "committed base\n");
        execFileSync("git", ["add", "base.txt"], { cwd: root });
        execFileSync("git", ["commit", "-m", "initial"], { cwd: root });

        const spawn = ((_command: string, args: string[]) => {
          // The "run" itself changes a file — the evidence must see it from the
          // filesystem, not from anything the agent said.
          fs.mkdirSync(path.join(root, "src"), { recursive: true });
          fs.writeFileSync(path.join(root, "src", "run-output.ts"), "changed by the run\n", "utf8");
          return (sessionSpawn(binary) as unknown as (c: string, a: string[]) => SpawnSyncReturns<string>)(_command, args);
        }) as unknown as SpawnSync;

        const port = makePort(binary, spawn, root);
        const prepared = await port.prepare(requestFor(port, { taskId: "T-EVIDE", stage: "qa-engineer" }));
        const result = await port.execute(prepared);
        expect(result.status).toBe("OK");
        expect(result.exitCode).toBe(0);

        const evidence = await port.collectEvidence(prepared);
        expect(evidence.attemptId).toBe(prepared.attemptId);
        expect(evidence.runtimeId).toBe(port.id);
        expect(evidence.result).toMatchObject({ status: "OK", exitCode: 0 });
        // Exit status and logs ride the evidence; the journal is the durable log reference.
        expect(evidence.logs.some((line) => line.includes("attempts"))).toBe(true);
        expect(evidence.logs.join("\n")).toContain("status OK");
        // The native session reference — absent for codex (none verified), present for the rest.
        if (binary === "codex") expect(evidence.sessionRef).toBeUndefined();
        else expect(evidence.sessionRef).toMatch(SESSION_REFS[binary]);
        // The changed file the spawn wrote, captured from the git snapshots.
        expect(evidence.changedFiles).toContain("src/run-output.ts");
      });

      it("resume after a finished attempt returns the stored result and never spawns twice", async () => {
        const root = makeFixtureRoot();
        writeBindingsFor(binary, root);
        let spawns = 0;
        const inner = sessionSpawn(binary);
        const spawn = ((_command: string, args: string[]) => {
          spawns += 1;
          return (inner as unknown as (c: string, a: string[]) => SpawnSyncReturns<string>)(_command, args);
        }) as unknown as SpawnSync;
        const port = makePort(binary, spawn, root);
        const prepared = await port.prepare(requestFor(port));
        await port.execute(prepared);
        expect(spawns).toBe(1);
        const resumed = await port.resume(prepared);
        expect(resumed.status).toBe("OK");
        // Re-running a finished attempt would duplicate its side effects — the
        // stored result is the answer, and the spawn count proves it.
        expect(spawns).toBe(1);
      });

      it("resume of an interrupted attempt re-runs the persisted packet in a fresh adapter instance (crash recovery)", async () => {
        const root = makeFixtureRoot();
        writeBindingsFor(binary, root);
        const journalRoot = path.join(root, "attempts");
        const first = makePort(binary, sessionSpawn(binary), root);
        // Prepare in one "process" — the owning one dies before execute.
        const prepared = await first.prepare(requestFor(first, { taskId: "T-RECOVER", stage: "qa-engineer" }));
        expect(prepared.attemptId).toMatch(/^atm_/);

        // A brand-new adapter instance (same journal root, same workspace) —
        // the recovered process — resumes the attempt from the journal.
        const second = makePort(binary, sessionSpawn(binary), root);
        const resumed = await second.resume({ runtimeId: second.id, attemptId: prepared.attemptId });
        expect(resumed.status).toBe("OK");

        const evidence = await second.collectEvidence({ runtimeId: second.id, attemptId: prepared.attemptId });
        expect(evidence.result).toMatchObject({ status: "OK" });
        expect(evidence.logs.join("\n")).toContain("fresh-session resume");
      });

      it("cancel before execute marks the attempt cancelled — execute and resume refuse it typed", async () => {
        const root = makeFixtureRoot();
        writeBindingsFor(binary, root);
        const port = makePort(binary, sessionSpawn(binary), root);
        const prepared = await port.prepare(requestFor(port));
        const outcome = await port.cancel(prepared);
        expect(outcome.status).toBe("already-finished");
        expect(outcome.detail).toMatch(/cancelled/i);
        await expect(port.execute(prepared)).rejects.toMatchObject({
          name: "ExecutorPortRefusalError",
          code: "attempt-cancelled",
          operation: "execute",
        });
        await expect(port.resume(prepared)).rejects.toMatchObject({
          name: "ExecutorPortRefusalError",
          code: "attempt-cancelled",
          operation: "resume",
        });
      });

      it("cancel after finish reports already-finished", async () => {
        const root = makeFixtureRoot();
        writeBindingsFor(binary, root);
        const port = makePort(binary, sessionSpawn(binary), root);
        const prepared = await port.prepare(requestFor(port));
        await port.execute(prepared);
        expect(await port.cancel(prepared)).toMatchObject({ status: "already-finished" });
      });
    });
  }
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

  it("lifts a probe/execute-only adapter with honest refusals, identity intact", async () => {
    // The four real adapters now implement the port natively; the wrapper
    // remains the honest lift for any probe/execute-only adapter (e.g. the
    // unwired ApiAdapter) — it adds no capability the wrapped adapter
    // did not claim.
    const adapter: RuntimeAdapter = new MockRuntimeAdapter({ capabilities: [RuntimeCapability.NAMED_AGENTS] });
    const port = executeOnlyLifecycle(adapter);
    expect(port.id).toBe(adapter.id);
    expect(port.displayName).toBe(adapter.displayName);
    expect(port.binding).toBe(adapter.binding);
    expect(port.capabilities).toBe(adapter.capabilities);
    expect(port.models).toBe(adapter.models);
    expect(port.workspace).toBe(adapter.workspace);
    const ref: ExecutorAttemptRef = { runtimeId: port.id, attemptId: "atm_x" };
    await expect(port.resume(ref)).rejects.toBeInstanceOf(ExecutorPortRefusalError);
  });
});
