import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, type SpawnSync } from "./claudeCodeAdapter.js";
import { NO_GUARDS } from "./runtimeAdapter.js";
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS_BY_ROLE, resolveMaxTurns, resolveMaxTurnsFromProject } from "./turnLimits.js";
import { renderZcodeManagedHooks } from "./bindingGenerator.js";
import { measureAlwaysOnInstructionChars } from "./agentRunAssembly.js";
import { AgentStage } from "../types.js";
import {
  DEFAULT_HARD_MAX_ESTIMATED_TOKENS,
  assessContextBudget,
  emptyContextBudgetComposition,
  estimateInputTokens,
  formatBudgetRejection,
  hardCeilingRejection,
  resolveHardContextCeiling,
} from "../context/contextBudget.js";
import { renderRunContextAttribution } from "../observability/contextAttribution.js";
import { RunLog } from "../observability/runLog.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const HOOKS = [path.join(REPO, ".claude/hooks/block-large-read.js"), path.join(REPO, ".codex/hooks/block-large-read.js")];

const roots: string[] = [];
function tmp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

interface HookRun { blocked: boolean; stderr: string }
function runHook(hook: string, root: string, tool: string, input: Record<string, unknown>, env: Record<string, string> = {}): HookRun {
  const proc = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: "test-session", tool_name: tool, tool_input: input, cwd: root }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, STA_READ_LEDGER: path.join(root, "ledger.jsonl"), STA_LARGE_READ_GUARD: "", ...env },
    timeout: 60_000,
  });
  return { blocked: proc.status === 2, stderr: proc.stderr };
}

function largeMarkdown(chars: number): string {
  const lines = ["# Big design"];
  let n = 0;
  while (lines.join("\n").length < chars) {
    lines.push(`## Section ${n}`, ...Array.from({ length: 30 }, (_, i) => `rule ${n}.${i} ${"r".repeat(80)}`));
    n++;
  }
  return lines.join("\n");
}

describe("block-large-read.js (runtime guard; Claude and Codex mirror are byte-identical)", () => {
  it("the Codex mirror is a byte copy of the Claude hook", () => {
    expect(fs.readFileSync(HOOKS[1], "utf8")).toBe(fs.readFileSync(HOOKS[0], "utf8"));
  });

  for (const hook of HOOKS) {
    describe(path.relative(REPO, hook), () => {
      it("Case A/F — refuses a whole read of a ~400k-char Markdown file, with its section index and no body", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "design.md");
        fs.writeFileSync(file, largeMarkdown(400_000));
        const whole = runHook(hook, root, "Read", { file_path: file });
        expect(whole.blocked).toBe(true);
        expect(whole.stderr).toMatch(/Large File Context Policy/);
        expect(whole.stderr).toMatch(/## Section 3 — lines \d+-\d+/);
        expect(whole.stderr).not.toMatch(/rule 3\.1 r/);
        expect(whole.stderr.length).toBeLessThan(20_000);
        // Default-limit Read (2000 lines) is still a whole-file-sized window: refused too.
        expect(runHook(hook, root, "Read", { file_path: file, offset: 1 }).blocked).toBe(true);
        // A second refusal of the same file does not resend the index.
        expect(runHook(hook, root, "Read", { file_path: file }).stderr).toMatch(/already shown earlier in this session/);
      });

      it("Case A — allows a bounded window, and records it in the ledger with its range", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "design.md");
        fs.writeFileSync(file, largeMarkdown(400_000));
        expect(runHook(hook, root, "Read", { file_path: file, offset: 100, limit: 120 }).blocked).toBe(false);
        const ledger = fs.readFileSync(path.join(root, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(ledger.at(-1)).toMatchObject({ tool: "Read", path: file, startLine: 100, endLine: 219, decision: "allow", duplicate: false });
      });

      it("Case E — a file exactly at the threshold reads whole; one character over does not", () => {
        const root = tmp("sta-lr-");
        const at = path.join(root, "at.md");
        const over = path.join(root, "over.md");
        fs.writeFileSync(at, "a".repeat(1_000));
        fs.writeFileSync(over, "a".repeat(1_001));
        const env = { STA_LARGE_FILE_CHARS: "1000", STA_MAX_READ_WINDOW_CHARS: "400" };
        expect(runHook(hook, root, "Read", { file_path: at }, env).blocked).toBe(false);
        expect(runHook(hook, root, "Read", { file_path: over }, env).blocked).toBe(true);
      });

      it("Case C — small files stay a plain Read", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "small.md");
        fs.writeFileSync(file, "# small\n" + "s".repeat(2_000));
        expect(runHook(hook, root, "Read", { file_path: file }).blocked).toBe(false);
      });

      it("Case I — a 1 MB JSON fixture, a generated .ts and a log are protected the same way", () => {
        const root = tmp("sta-lr-");
        const json = path.join(root, "rows.json");
        fs.writeFileSync(json, JSON.stringify(Array.from({ length: 12_000 }, (_, i) => ({ id: i, payload: "p".repeat(60) })), null, 2));
        const ts = path.join(root, "generated.ts");
        fs.writeFileSync(ts, Array.from({ length: 20_000 }, (_, i) => `export const g${i} = ${i};`).join("\n"));
        const log = path.join(root, "build.log");
        fs.writeFileSync(log, Array.from({ length: 30_000 }, (_, i) => `[info] step ${i} ok`).join("\n"));
        for (const file of [json, ts, log]) {
          const refused = runHook(hook, root, "Read", { file_path: file });
          expect(refused.blocked, file).toBe(true);
          expect(refused.stderr, file).toMatch(/Line windows of ≤40,000 chars/);
          expect(runHook(hook, root, "Read", { file_path: file, offset: 10, limit: 50 }).blocked, file).toBe(false);
        }
      });

      it("refuses paging past max_file_read_share, but still allows re-reading an already-read range", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "design.md");
        const text = largeMarkdown(200_000);
        fs.writeFileSync(file, text);
        const total = text.split("\n").length;
        const step = 300;
        let refusedAt = -1;
        for (let start = 1; start <= total; start += step) {
          if (runHook(hook, root, "Read", { file_path: file, offset: start, limit: step }).blocked) {
            refusedAt = start;
            break;
          }
        }
        expect(refusedAt).toBeGreaterThan(1);
        expect(refusedAt).toBeLessThan(total * 0.6);
        expect(runHook(hook, root, "Read", { file_path: file, offset: 1, limit: step }).blocked).toBe(false);
        const last = fs.readFileSync(path.join(root, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
        expect(last).toMatchObject({ decision: "allow", duplicate: true });
      });

      it("refuses a bare shell dump of a large file; piped/filtered commands pass", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "design.md");
        fs.writeFileSync(file, largeMarkdown(150_000));
        expect(runHook(hook, root, "Bash", { command: `cat "${file}"` }).blocked).toBe(true);
        expect(runHook(hook, root, "Bash", { command: `cd "${root}" && cat design.md` }).blocked).toBe(true);
        expect(runHook(hook, root, "PowerShell", { command: `Get-Content "${file}"` }).blocked).toBe(true);
        expect(runHook(hook, root, "PowerShell", { command: `Get-Content "${file}" -TotalCount 50` }).blocked).toBe(false);
        expect(runHook(hook, root, "Bash", { command: `grep -n "Section 4" "${file}" | head` }).blocked).toBe(false);
        expect(runHook(hook, root, "Bash", { command: `sed -n '10,40p' "${file}"` }).blocked).toBe(false);
      });

      it("a person can switch it off for their own session", () => {
        const root = tmp("sta-lr-");
        const file = path.join(root, "design.md");
        fs.writeFileSync(file, largeMarkdown(150_000));
        expect(runHook(hook, root, "Read", { file_path: file }, { STA_LARGE_READ_GUARD: "off" }).blocked).toBe(false);
      });
    });
  }
});

describe("Case G — every file-reading agent receives the Large File Context Policy", () => {
  const agentsDir = path.join(REPO, ".claude/agents");
  const agents = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
  const claudeMd = fs.readFileSync(path.join(REPO, "CLAUDE.md"), "utf8");
  const preamble = fs.readFileSync(path.join(REPO, ".claude/shared/agent-preamble.md"), "utf8");
  const policy = fs.readFileSync(path.join(REPO, "policies/documentation.md"), "utf8");

  it("the always-on CLAUDE.md and the shared preamble carry the rule, and the policy section exists", () => {
    expect(claudeMd).toMatch(/large file is never read whole[^\n]*§10a/);
    expect(claudeMd).not.toMatch(/read it whole — slicing is an optimization/);
    expect(preamble).toMatch(/large file, whole \(`policies\/documentation\.md` §10a\)/);
    expect(policy).toMatch(/^## 10a\. Large File Context Policy/m);
    expect(policy).not.toMatch(/Read the whole document once/);
  });

  it("every agent with a file-reading tool references the shared preamble (a new unprotected role fails here)", () => {
    expect(agents.length).toBeGreaterThanOrEqual(12);
    for (const file of agents) {
      const text = fs.readFileSync(path.join(agentsDir, file), "utf8");
      const tools = /^tools:\s*(.*)$/m.exec(text)?.[1] ?? "*";
      const readsFiles = tools === "*" || /\b(Read|Grep|Glob|Bash|PowerShell)\b/.test(tools);
      if (readsFiles) expect(text, file).toMatch(/\.claude\/shared\/agent-preamble\.md/);
    }
  });

  it("the runtime guard is registered for Read and shell tools on every hook-carrying runtime (role-agnostic)", () => {
    type Entry = { matcher?: string; hooks: { command?: string; args?: string[] }[] };
    const matcherFor = (entries: Entry[]): string | undefined =>
      entries.find((entry) => entry.hooks.some((hook) => `${hook.command ?? ""} ${(hook.args ?? []).join(" ")}`.includes("block-large-read.js")))?.matcher;
    const claude = JSON.parse(fs.readFileSync(path.join(REPO, ".claude/settings.json"), "utf8")) as { hooks: { PreToolUse: Entry[] } };
    const codex = JSON.parse(fs.readFileSync(path.join(REPO, ".codex/hooks.json"), "utf8")) as { hooks: { PreToolUse: Entry[] } };
    const zcode = renderZcodeManagedHooks().events.PreToolUse as unknown as Entry[];
    for (const [name, entries] of [["claude", claude.hooks.PreToolUse], ["codex", codex.hooks.PreToolUse], ["zcode", zcode]] as const) {
      const matcher = matcherFor(entries);
      expect(matcher, name).toBeDefined();
      for (const tool of ["Read", "Bash", "PowerShell"]) expect(matcher!.split("|"), `${name}:${tool}`).toContain(tool);
    }
    // No role condition: the hook never consults STA_ROLE, so every role — and an unassigned session — is covered.
    expect(fs.readFileSync(HOOKS[0], "utf8")).not.toMatch(/STA_ROLE/);
  });
});

describe("Case D — effective initial context = packet + always-on prefix, without double counting", () => {
  it("assesses X + Y while the composition still accounts for exactly X", () => {
    const composition = emptyContextBudgetComposition();
    composition.task = 7_800;
    const assessment = assessContextBudget(7_800, composition, { chars: 20_000, source: "role" }, "reject", 12_400);
    expect(assessment).toMatchObject({ promptChars: 7_800, alwaysOnChars: 12_400, contextChars: 20_200, overflowChars: 200, rejected: true });
    expect(assessment.estimatedInputTokens).toBe(estimateInputTokens(20_200));
    // Composition must still equal the packet alone; adding the prefix into it is refused.
    const inflated = { ...composition, task: 20_200 };
    expect(() => assessContextBudget(7_800, inflated, null, "warn", 12_400)).toThrow(/invariant failed/);
    // No always-on measurement = historical behaviour.
    expect(assessContextBudget(7_800, composition, { chars: 20_000, source: "role" }).contextChars).toBe(7_800);
  });

  it("measures CLAUDE.md plus the role body (frontmatter excluded), preferring the execution root", () => {
    const framework = tmp("sta-fw-");
    const target = tmp("sta-target-");
    fs.mkdirSync(path.join(framework, ".claude/agents"), { recursive: true });
    fs.writeFileSync(path.join(framework, "CLAUDE.md"), "c".repeat(100));
    fs.writeFileSync(path.join(framework, ".claude/agents/system-analyst.md"), "---\nname: system-analyst\n---\n" + "b".repeat(40));
    expect(measureAlwaysOnInstructionChars(framework, AgentStage.SYSTEM_ANALYST)).toBe(140);
    fs.writeFileSync(path.join(target, "CLAUDE.md"), "t".repeat(10));
    expect(measureAlwaysOnInstructionChars(framework, AgentStage.SYSTEM_ANALYST, target)).toBe(50);
    expect(measureAlwaysOnInstructionChars(framework, AgentStage.QA_ENGINEER)).toBeNull();
  });
});

describe("hard context ceiling — fails before the model, in either budget mode", () => {
  const scope = { taskId: "T-1", role: "system-analyst", stage: "system-analyst", runtime: "claude", model: "opus" };
  it("rejects just above the ceiling, admits at it, names contributors and a remedy; 0 disables", () => {
    expect(resolveHardContextCeiling(null)).toBe(DEFAULT_HARD_MAX_ESTIMATED_TOKENS);
    expect(resolveHardContextCeiling({ schema_version: 1, context_budget: { hard_max_estimated_tokens: 0 } })).toBeNull();
    const composition = emptyContextBudgetComposition();
    composition.docs = 500_000;
    composition.task = 11_443;
    const warn = assessContextBudget(511_443, composition, null, "warn", 16_000);
    const rejection = hardCeilingRejection(warn, composition, DEFAULT_HARD_MAX_ESTIMATED_TOKENS, scope)!;
    expect(rejection).toMatchObject({ budgetType: "hard_ceiling", configuredLimit: 100_000 });
    const message = formatBudgetRejection(rejection);
    expect(message).toMatch(/contributors: module documents 500000 chars/);
    expect(message).toMatch(/always-on instructions \(CLAUDE\.md \+ role definition\) 16000 chars/);
    expect(message).toMatch(/recommended: .*bounded ranges/);
    const atCeiling = emptyContextBudgetComposition();
    atCeiling.task = 400_000;
    expect(hardCeilingRejection(assessContextBudget(400_000, atCeiling, null), atCeiling, 100_000, scope)).toBeNull();
    atCeiling.task = 400_001;
    expect(hardCeilingRejection(assessContextBudget(400_001, atCeiling, null), atCeiling, 100_000, scope)).not.toBeNull();
    expect(hardCeilingRejection(warn, composition, null, scope)).toBeNull();
  });
});

function cliResult(status: number, stdout: string): SpawnSyncReturns<string> {
  return { status, stdout, stderr: "", pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
}

describe("Case H — per-role turn limits reach the runtime invocation", () => {
  it("resolves defaults per role, config default/role overrides, and 0 as no limit", () => {
    expect(resolveMaxTurns(null, "system-analyst")).toBe(DEFAULT_MAX_TURNS_BY_ROLE["system-analyst"]);
    expect(resolveMaxTurns(null, "backend-engineer")).toBe(DEFAULT_MAX_TURNS_BY_ROLE["backend-engineer"]);
    expect(resolveMaxTurns(null, "some-new-role")).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(null, undefined)).toBe(DEFAULT_MAX_TURNS);
    const config = { schema_version: 1 as const, max_turns: { default: 30, roles: { "system-analyst": 12, "backend-engineer": 0 } } };
    expect(resolveMaxTurns(config, "system-analyst")).toBe(12);
    expect(resolveMaxTurns(config, "qa-engineer")).toBe(30);
    expect(resolveMaxTurns(config, "backend-engineer")).toBeUndefined();
    const root = tmp("sta-turns-");
    fs.mkdirSync(path.join(root, ".sta"));
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), "schema_version: 1\nmax_turns:\n  roles:\n    reviewer: 9\n", "utf8");
    expect(resolveMaxTurnsFromProject(root, "reviewer")).toBe(9);
    expect(resolveMaxTurnsFromProject(tmp("sta-no-config-"), "reviewer")).toBe(DEFAULT_MAX_TURNS_BY_ROLE.reviewer);
  });

  it("the Claude adapter passes --max-turns, reports num_turns, and marks a max-turns stop as an error", async () => {
    let args: string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const spawn: SpawnSync = (_cmd, a, options) => {
      args = a;
      env = options.env ?? {};
      // Stand in for the guard hook writing one bounded read to the ledger.
      fs.writeFileSync(env.STA_READ_LEDGER!, `${JSON.stringify({ tool: "Read", path: "/k/design.md", startLine: 1208, endLine: 1283, chars: 7_740, fileChars: 413_133, decision: "allow" })}\n`);
      return cliResult(0, JSON.stringify({ is_error: false, result: "done", num_turns: 6, usage: { input_tokens: 10 } }));
    };
    const cwd = tmp("sta-claude-");
    const adapter = new ClaudeCodeAdapter({ projectRoot: cwd, spawnSync: spawn });
    const request = { role: "system-analyst", cwd, definitionPath: ".claude/agents/system-analyst.md", prompt: "p", autonomy: "propose" as const, guards: NO_GUARDS };
    const ok = await adapter.executeAgent({ ...request, maxTurns: 12 });
    expect(args[args.indexOf("--max-turns") + 1]).toBe("12");
    expect(env.STA_LARGE_FILE_CHARS).toBe("100000");
    expect(ok).toMatchObject({ status: "OK", turns: 6 });
    expect(ok.reads).toMatchObject({ reads: 1, readChars: 7_740, blockedReads: 0 });

    await adapter.executeAgent(request);
    expect(args).not.toContain("--max-turns");

    const stopped: SpawnSync = () => cliResult(0, JSON.stringify({ is_error: false, subtype: "error_max_turns", num_turns: 12 }));
    const limited = await new ClaudeCodeAdapter({ projectRoot: cwd, spawnSync: stopped }).executeAgent({ ...request, maxTurns: 12 });
    expect(limited).toMatchObject({ status: "ERROR", maxTurnsReached: true, turns: 12 });
    expect(limited.diagnostics.join(" ")).toMatch(/turn limit \(--max-turns 12, 12 turns taken\)/);
  });
});

describe("context telemetry persistence", () => {
  it("round-trips through the SQLite run table and stays absent on unmeasured runs", () => {
    const dir = tmp("sta-telemetry-db-");
    const store = new SqliteTaskStore(path.join(dir, "state.db"));
    try {
      const log = new RunLog();
      const context_telemetry = {
        packet_chars: 100, always_on_chars: 50, effective_initial_chars: 150, effective_initial_estimated_tokens: 38,
        hard_ceiling_estimated_tokens: 100_000, max_turns: 80, turns: 4, max_turns_reached: false,
        tool_reads: { reads: 1, readChars: 900, duplicateReads: 0, blockedReads: 0, largest: [{ path: "/k/d.md", startLine: 1, endLine: 20, chars: 900 }] },
      };
      store.appendRun(log.record({ task_id: "T-TEL", agent: AgentStage.SYSTEM_ANALYST, start_time: 0, end_time: 1, outcome: { tokens: 0, cost: 0, result: "PASS", context_telemetry } }));
      store.appendRun(log.record({ task_id: "T-TEL", agent: AgentStage.SYSTEM_ANALYST, start_time: 1, end_time: 2, outcome: { tokens: 0, cost: 0, result: "PASS" } }));
      const [measured, unmeasured] = store.runsForTask("T-TEL");
      expect(measured.context_telemetry).toEqual(context_telemetry);
      expect("context_telemetry" in unmeasured).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("token observability — per-run attribution", () => {
  it("separates packet, always-on, retrieval, turns and runtime usage, and labels estimates", () => {
    const log = new RunLog();
    const run = log.record({
      task_id: "T-1", agent: AgentStage.SYSTEM_ANALYST, start_time: 0, end_time: 1,
      outcome: {
        tokens: 0, cost: 0, result: "PASS", input_tokens: 21_000, output_tokens: 3_000, cache_read_tokens: 90_000, cache_creation_tokens: 20_000, context_chars: 31_200,
        context_telemetry: {
          packet_chars: 31_200, always_on_chars: 49_600, effective_initial_chars: 80_800, effective_initial_estimated_tokens: 20_200,
          hard_ceiling_estimated_tokens: 100_000, max_turns: 80, turns: 6, max_turns_reached: false,
          tool_reads: { reads: 2, readChars: 36_000, duplicateReads: 0, blockedReads: 1, largest: [{ path: "/k/design.md", startLine: 1200, endLine: 1480, chars: 27_600 }] },
        },
      },
    });
    const text = renderRunContextAttribution(run).join("\n");
    expect(text).toMatch(/Execution packet: +31,200 chars \(~7,800 tokens est\.\)/);
    expect(text).toMatch(/Always-on instructions: +49,600 chars \(~12,400 tokens est\.\)/);
    expect(text).toMatch(/Effective initial context: 80,800 chars \(~20,200 tokens est\./);
    expect(text).toMatch(/design\.md lines 1200-1480: 27,600 chars \(~6,900 tokens est\.\)/);
    expect(text).toMatch(/blocked large reads 1/);
    expect(text).toMatch(/Model turns: 6 \/ limit 80/);
    expect(text).toMatch(/Usage \(runtime-reported\): input 21,000, output 3,000, cache-read 90,000, cache-created 20,000/);
  });
});
