import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { OpenCodeAdapter } from "./openCodeAdapter.js";
import type { RuntimeAdapter, RuntimeAgentRequest, RuntimeGuardReport, RuntimeWorkRoot, SpawnSync } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * T-V1-05 — the runtime conformance suite: one mandatory-case matrix run
 * against every real adapter through its public port, producing a
 * deterministic compatibility report per runtime.
 *
 * VERDICTS
 *
 *   ENFORCED             — the requested axis reached a mechanism this run
 *                          actually had wired (permission rules, hooks,
 *                          plugin, sandbox grants), confirmed through the
 *                          adapter's own guard accounting plus the spawn
 *                          surface it produced.
 *   REPORTED_UNENFORCED  — the adapter could not enforce the axis in-band but
 *                          said so in `RuntimeGuardReport.unenforced` with an
 *                          actionable reason. Honest incompleteness passes;
 *                          silent absence does not.
 *   PASS                 — non-guard behaviour observed through the port.
 *   COVERED_ELSEWHERE    — the axis is enforced by the orchestrator before any
 *                          runtime is involved; the row names the owning
 *                          deterministic suite instead of duplicating it.
 *   FAIL                 — neither enforced nor honestly reported. Never
 *                          tolerated by the expectations below.
 *
 * SCOPE HONESTY
 *
 * Injected spawns, never installed binaries: this suite proves what the
 * adapter *code* does with a request — which flags, env and wiring it
 * produces, and whether its guard accounting lies — deterministically, on
 * every machine CI runs on. Whether a given machine's installation honours
 * those surfaces is `sta doctor`'s capability probe's job, and a support
 * level (T-V1-04) rises only when both agree.
 */

const ROLE = "qa-engineer";
const PROMPT = "conformance marker PROMPT-7f3a";
const INSTRUCTIONS_MARKER = "conformance role instructions";

const GUARDS = {
  writeAllow: ["src/**"],
  writeDeny: [".git/**"],
  forbidCommands: ["git"],
  exitChecks: ["code-green"] as const,
};

const KNOWLEDGE_ROOT = "/tmp/sta-conformance-knowledge";
const TARGET_ROOT = "/tmp/sta-conformance-target";
const WORK_ROOTS: readonly RuntimeWorkRoot[] = [{ targetId: "target-a", path: TARGET_ROOT, access: "write" }];
// Exactly what `runtimeExecutor.ts` puts in `req.env` for a Target-write run —
// this suite mirrors the production caller, never an invented request shape.
const EXECUTOR_ENV = {
  AGENTCLAUDE_KNOWLEDGE_ROOT: KNOWLEDGE_ROOT,
  AGENTCLAUDE_WRITABLE_WORK_ROOTS: JSON.stringify([TARGET_ROOT]),
};

/** The mandatory case list, in report order — T-V1-05's contract with itself. */
const MANDATORY_CASES = [
  "agent-launch",
  "workspace-detection",
  "role-contract-loading",
  "context-injection",
  "knowledge-binding",
  "target-binding",
  "allowed-write-guard",
  "forbidden-write-guard",
  "state-changing-git-protection",
  "hook-plugin-execution",
  "exit-handling",
  "failure-propagation",
  "approval-signoff-protection",
  "retry-recovery",
] as const;

type Verdict = "ENFORCED" | "REPORTED_UNENFORCED" | "PASS" | "COVERED_ELSEWHERE" | "FAIL";

interface ConformanceRow {
  readonly caseId: string;
  readonly verdict: Verdict;
  /** What earned the verdict, or which suite owns a COVERED_ELSEWHERE case. */
  readonly detail?: string;
}

interface CapturedCall {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv | undefined;
}

/** Records every spawn and answers each binary's well-shaped success envelope. */
function capturingSpawn(binary: "claude" | "codex" | "opencode", calls: CapturedCall[]): SpawnSync {
  return ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: options.env });
    const stdout =
      binary === "claude"
        ? JSON.stringify({ result: "done", is_error: false, usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0 })
        : binary === "opencode"
          ? `${JSON.stringify({ type: "text", part: { type: "text", text: "done" } })}\n`
          : "";
    return {
      status: 0,
      stdout,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    } as unknown as SpawnSyncReturns<string>;
  }) as unknown as SpawnSync;
}

function enoentSpawn(): SpawnSync {
  return ((_command: string) =>
    ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      pid: 0,
      output: [],
      signal: null,
    }) as unknown as SpawnSyncReturns<string>) as unknown as SpawnSync;
}

interface Implementation {
  readonly id: string;
  readonly binary: "claude" | "codex" | "opencode";
  /** `resolveCommand: () => null` keeps the Windows npm-shim retry out — this suite measures surfaces, not PATH resolution. */
  readonly make: (projectRoot: string, spawn: SpawnSync) => RuntimeAdapter;
}

const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    id: "claude-code",
    binary: "claude",
    make: (root, spawn) => new ClaudeCodeAdapter({ projectRoot: root, spawnSync: spawn, resolveCommand: () => null }),
  },
  {
    id: "codex",
    binary: "codex",
    make: (root, spawn) => new CodexAdapter({ projectRoot: root, models: [], spawnSync: spawn }),
  },
  {
    id: "opencode",
    binary: "opencode",
    make: (root, spawn) => new OpenCodeAdapter({ projectRoot: root, spawnSync: spawn, resolveCommand: () => null }),
  },
];

const createdFixtures: string[] = [];
afterAll(() => {
  for (const dir of createdFixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Materialises one project exactly as `sta init` ships it: role bindings in
 * every runtime's native format plus each runtime's guard wiring. The guard
 * accounting under test reads these files — their presence is part of what a
 * real install looks like, so the fixture must ship them.
 */
function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { deny: [] },
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node .claude/hooks/block-outside-repo.js" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/require-green-before-stop.js" }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "node .claude/hooks/require-green-before-stop.js" }] }],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(root, ".claude", "agents", `${ROLE}.md`), "role text");
  fs.mkdirSync(path.join(root, ".codex", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".codex", "agents", `${ROLE}.toml`),
    `name = "${ROLE}"\ndescription = "conformance fixture"\n\ndeveloper_instructions = """\n${INSTRUCTIONS_MARKER}\n"""\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(root, ".opencode", "agent"), { recursive: true });
  fs.mkdirSync(path.join(root, ".opencode", "plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "agent", `${ROLE}.md`), "role text");
  fs.writeFileSync(path.join(root, ".opencode", "plugin", "sta-guards.js"), "// sta-guards plugin shipped by init\n");
}

function newFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-conformance-"));
  createdFixtures.push(root);
  writeFixture(root);
  return root;
}

/**
 * Runs the whole matrix against one implementation and returns its report.
 * Every row is earned by actual `executeAgent` round-trips through the public
 * port — nothing is asserted from an adapter's static capability claims alone.
 */
async function runConformance(impl: Implementation): Promise<ConformanceRow[]> {
  const root = newFixture();
  const calls: CapturedCall[] = [];
  const adapter = impl.make(root, capturingSpawn(impl.binary, calls));

  const request: RuntimeAgentRequest = {
    role: ROLE,
    cwd: root,
    knowledgeRoot: KNOWLEDGE_ROOT,
    workRoots: WORK_ROOTS,
    definitionPath: adapter.binding.definitionPath(ROLE),
    prompt: PROMPT,
    autonomy: "edit",
    guards: GUARDS,
    env: EXECUTOR_ENV,
  };

  const result = await adapter.executeAgent(request);
  // The NUL separator keeps distinct argv elements distinct — a prompt that
  // happened to contain "--agent" must not fuse with flag positions.
  const surface = calls.map((c) => c.args.join("\u0000")).join("\n");
  const env = calls[0]?.env ?? {};
  const guards: RuntimeGuardReport = result.guards;

  const preToolEnforced = guards.enforced.includes(RuntimeCapability.PRE_TOOL_GUARD);
  const preToolHonestlyUnenforced =
    !preToolEnforced && guards.unenforced.includes(RuntimeCapability.PRE_TOOL_GUARD) && !!guards.reason;
  const exitEnforced = guards.enforced.includes(RuntimeCapability.EXIT_GUARD);
  const exitHonestlyUnenforced =
    !exitEnforced &&
    (guards.unenforced.includes(RuntimeCapability.EXIT_GUARD) || guards.unenforced.includes(RuntimeCapability.PER_AGENT_EXIT_GUARD)) &&
    !!guards.reason;
  const claudeSurfaceRules = impl.id === "claude-code" && surface.includes(`Write(${GUARDS.writeDeny[0]})`) && surface.includes(`Bash(${GUARDS.forbidCommands[0]} *)`);

  const guardVerdict = (): ConformanceRow["verdict"] =>
    preToolEnforced ? "ENFORCED" : preToolHonestlyUnenforced ? "REPORTED_UNENFORCED" : "FAIL";

  const failureStatus = await (async (): Promise<string> => {
    const failing = impl.make(newFixture(), enoentSpawn());
    const r = await failing.executeAgent({
      role: ROLE,
      cwd: root,
      definitionPath: failing.binding.definitionPath(ROLE),
      prompt: PROMPT,
      autonomy: "edit",
      guards: { writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: [] },
    });
    return r.status;
  })();

  return [
    { caseId: "agent-launch", verdict: result.status === "OK" ? "PASS" : "FAIL", detail: `status ${result.status}` },
    {
      caseId: "workspace-detection",
      verdict: (await adapter.workspace.exists(request.definitionPath)) === true && (await adapter.workspace.exists(".claude/absent.md")) === false ? "PASS" : "FAIL",
    },
    {
      caseId: "role-contract-loading",
      verdict:
        impl.id === "codex"
          ? surface.includes(INSTRUCTIONS_MARKER)
            ? "PASS"
            : "FAIL"
          : surface.split("\u0000").includes("--agent") && surface.split("\u0000").includes(ROLE)
            ? "PASS"
            : "FAIL",
      detail: impl.id === "codex" ? "developer_instructions folded from the binding into the prompt" : "--agent <role> names the binding entry",
    },
    { caseId: "context-injection", verdict: surface.includes(PROMPT) ? "PASS" : "FAIL" },
    {
      caseId: "knowledge-binding",
      verdict: env.AGENTCLAUDE_KNOWLEDGE_ROOT === KNOWLEDGE_ROOT ? "PASS" : "FAIL",
      detail: "caller env reaches the child process undropped",
    },
    {
      caseId: "target-binding",
      verdict: surface.includes(TARGET_ROOT) || (env.AGENTCLAUDE_WRITABLE_WORK_ROOTS ?? "").includes(TARGET_ROOT) ? "PASS" : "FAIL",
      detail: impl.id === "codex" ? "OS-enforced --add-dir sandbox grant" : "AGENTCLAUDE_WRITABLE_WORK_ROOTS carried to the pre-tool guard",
    },
    { caseId: "allowed-write-guard", verdict: guardVerdict(), detail: guards.reason ?? "write scope active for this run" },
    {
      caseId: "forbidden-write-guard",
      verdict: preToolEnforced && (impl.id !== "claude-code" || surface.includes(`Write(${GUARDS.writeDeny[0]})`)) ? "ENFORCED" : preToolHonestlyUnenforced ? "REPORTED_UNENFORCED" : "FAIL",
      detail: impl.id === "claude-code" ? "--disallowedTools carries the deny globs" : (guards.reason ?? "plugin enforces the deny list"),
    },
    {
      caseId: "state-changing-git-protection",
      verdict: preToolEnforced && (impl.id !== "claude-code" || surface.includes(`Bash(${GUARDS.forbidCommands[0]} *)`)) ? "ENFORCED" : preToolHonestlyUnenforced ? "REPORTED_UNENFORCED" : "FAIL",
      detail: impl.id === "claude-code" ? "Bash(git *) permission rule rides --disallowedTools" : (guards.reason ?? "binding bash globs + plugin"),
    },
    {
      caseId: "hook-plugin-execution",
      verdict:
        adapter.binding.guardConfigPath !== null
          ? preToolEnforced
            ? "ENFORCED"
            : "FAIL"
          : guards.reason
            ? "REPORTED_UNENFORCED"
            : "FAIL",
      detail: adapter.binding.guardConfigPath ?? guards.reason,
    },
    {
      caseId: "exit-handling",
      verdict: exitEnforced ? "ENFORCED" : exitHonestlyUnenforced ? "REPORTED_UNENFORCED" : "FAIL",
      detail: exitEnforced ? "Stop/SubagentStop hooks wired and confirmed by guard accounting" : (guards.reason ?? "exit checks reported unenforced"),
    },
    {
      caseId: "failure-propagation",
      verdict: failureStatus === "UNAVAILABLE" ? "PASS" : "FAIL",
      detail: "ENOENT spawn maps to UNAVAILABLE, never a throw",
    },
    {
      caseId: "approval-signoff-protection",
      verdict: "COVERED_ELSEWHERE",
      detail: "orchestrator refuses before any launch — src/roles/roleApproval.test.ts",
    },
    {
      caseId: "retry-recovery",
      verdict: "COVERED_ELSEWHERE",
      detail: "orchestrator escalation policy decides rounds — src/escalation/escalationPolicy.test.ts",
    },
  ];
}

describe("T-V1-05 runtime conformance — one matrix, every runtime", () => {
  for (const impl of IMPLEMENTATIONS) {
    describe(`compatibility report — ${impl.id}`, () => {
      it("covers every mandatory case, in order, with no silent failures", async () => {
        const report = await runConformance(impl);
        expect(report.map((r) => r.caseId)).toEqual([...MANDATORY_CASES]);
        const failed = report.filter((r) => r.verdict === "FAIL");
        expect(failed, failed.map((r) => `${r.caseId}: ${r.detail ?? "no detail"}`).join("; ")).toEqual([]);
      });

      const expectations: Record<string, Partial<Record<string, Verdict>>> = {
        "claude-code": {
          "allowed-write-guard": "ENFORCED",
          "forbidden-write-guard": "ENFORCED",
          "state-changing-git-protection": "ENFORCED",
          "hook-plugin-execution": "ENFORCED",
          "exit-handling": "ENFORCED",
        },
        codex: {
          "allowed-write-guard": "REPORTED_UNENFORCED",
          "forbidden-write-guard": "REPORTED_UNENFORCED",
          "state-changing-git-protection": "REPORTED_UNENFORCED",
          "hook-plugin-execution": "REPORTED_UNENFORCED",
          "exit-handling": "REPORTED_UNENFORCED",
        },
        opencode: {
          "allowed-write-guard": "ENFORCED",
          "forbidden-write-guard": "ENFORCED",
          "state-changing-git-protection": "ENFORCED",
          "hook-plugin-execution": "ENFORCED",
          "exit-handling": "REPORTED_UNENFORCED",
        },
      };

      it(`earns its declared guard verdicts (${JSON.stringify(expectations[impl.id])})`, async () => {
        const report = await runConformance(impl);
        for (const [caseId, expected] of Object.entries(expectations[impl.id])) {
          const row = report.find((r) => r.caseId === caseId);
          expect(row?.verdict, `${impl.id} ${caseId}`).toBe(expected);
          if (expected === "REPORTED_UNENFORCED") {
            expect(row?.detail, `${impl.id} ${caseId} owes an actionable reason`).toBeTruthy();
          }
        }
      });

      it("is deterministic — same fixture, same report", async () => {
        expect(await runConformance(impl)).toEqual(await runConformance(impl));
      });
    });
  }

  it("keeps the shared axes shared — launch, binding, context and workspace containment pass identically everywhere", async () => {
    for (const impl of IMPLEMENTATIONS) {
      const report = await runConformance(impl);
      for (const caseId of ["agent-launch", "workspace-detection", "context-injection", "knowledge-binding", "target-binding", "failure-propagation"] as const) {
        expect(report.find((r) => r.caseId === caseId)?.verdict, `${impl.id} ${caseId}`).toBe("PASS");
      }
    }
  });

  it("reports the orchestrator-owned axes as covered elsewhere, naming the owning suites", async () => {
    for (const impl of IMPLEMENTATIONS) {
      const report = await runConformance(impl);
      for (const caseId of ["approval-signoff-protection", "retry-recovery"] as const) {
        const row = report.find((r) => r.caseId === caseId);
        expect(row?.verdict, `${impl.id} ${caseId}`).toBe("COVERED_ELSEWHERE");
        expect(row?.detail).toMatch(/src\/\w[\w/.]*\.test\.ts/);
      }
    }
  });
});
