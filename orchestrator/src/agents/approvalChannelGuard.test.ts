import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_CHANNEL_DIR_NAME } from "./pathPermissions.js";
import { renderAgyManagedHooks, renderZcodeManagedHooks } from "../runtime/bindingGenerator.js";

/**
 * V13 TASK-027 — no role agent, on any runtime, may read the github-app key or
 * change the approver list. The floor is one generated rule
 * (`approvalChannelDenial` in `pathPermissions.ts`'s guard block) that every
 * host calls before its write-only checks; these tests drive each real host
 * file the way its runtime does.
 */

const REPO = path.resolve(import.meta.dirname, "../../..");
const CLAUDE_HOOK = path.join(REPO, ".claude/hooks/block-path-permissions.js");
const CODEX_HOOK = path.join(REPO, ".codex/hooks/block-path-permissions.js");
const AGY_WRAPPER = path.join(REPO, ".agents/hooks/sta-guard.js");
const OPENCODE_PLUGIN = pathToFileURL(path.join(REPO, ".opencode/plugin/sta-guards.js")).href;

const channelDir = path.join(os.userInfo().homedir, APPROVAL_CHANNEL_DIR_NAME);
const keyFile = path.join(channelDir, "github-app.private-key.pem");
const configFile = path.join(channelDir, "github-app.json");

const roots: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-approval-guard-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function claudeLike(hook: string, root: string, tool: string, input: Record<string, unknown>, role?: string): { blocked: boolean; stderr: string } {
  const proc = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, STA_ROLE: role ?? "" },
  });
  return { blocked: proc.status === 2, stderr: proc.stderr ?? "" };
}

/** What a role agent would try: read the key, change the allowlist — via file tools and via the shell. */
const ATTEMPTS: Array<{ tool: string; input: Record<string, unknown> }> = [
  { tool: "Read", input: { file_path: keyFile } },
  { tool: "Write", input: { file_path: configFile, content: "{}" } },
  { tool: "Edit", input: { file_path: configFile, old_string: "[1001]", new_string: "[1001, 666]" } },
  { tool: "Grep", input: { pattern: "BEGIN", path: channelDir } },
  { tool: "Glob", input: { pattern: `${channelDir.replace(/\\/g, "/")}/**` } },
  { tool: "Bash", input: { command: `cat ~/${APPROVAL_CHANNEL_DIR_NAME}/github-app.private-key.pem` } },
  { tool: "Bash", input: { command: `echo '{}' > "$HOME/${APPROVAL_CHANNEL_DIR_NAME}/github-app.json"` } },
  { tool: "PowerShell", input: { command: `Get-Content $env:USERPROFILE\\${APPROVAL_CHANNEL_DIR_NAME}\\github-app.private-key.pem` } },
];

describe("approval-channel guard floor — every runtime (V13 TASK-027)", () => {
  for (const [name, hook] of [["Claude Code / ZCode", CLAUDE_HOOK], ["Codex", CODEX_HOOK]] as const) {
    it(`${name}: denies reading the key and changing the allowlist, for every role and none`, () => {
      const root = workspace();
      for (const role of [undefined, "backend-engineer", "devops", "qa-engineer"]) {
        for (const attempt of ATTEMPTS) {
          const verdict = claudeLike(hook, root, attempt.tool, attempt.input, role);
          expect(verdict.blocked, `${attempt.tool} ${JSON.stringify(attempt.input)} as ${role ?? "unassigned"}`).toBe(true);
          expect(verdict.stderr).toMatch(/human-owned STA approval channel/);
        }
      }
      // Ordinary reads and commands are untouched.
      expect(claudeLike(hook, root, "Read", { file_path: path.join(root, "src", "x.ts") }).blocked).toBe(false);
      expect(claudeLike(hook, root, "Bash", { command: "npm test" }).blocked).toBe(false);
    });
  }

  it("Claude Code / ZCode / Codex: a symlink inside the workspace does not launder the path", () => {
    const root = workspace();
    const outside = workspace();
    const secretDir = path.join(outside, APPROVAL_CHANNEL_DIR_NAME);
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, "github-app.json"), "{}");
    fs.symlinkSync(secretDir, path.join(root, "innocent"), "junction");
    for (const hook of [CLAUDE_HOOK, CODEX_HOOK]) {
      expect(claudeLike(hook, root, "Read", { file_path: path.join(root, "innocent", "github-app.json") }).blocked).toBe(true);
      expect(claudeLike(hook, root, "Write", { file_path: "innocent/github-app.json", content: "{}" }, "backend-engineer").blocked).toBe(true);
    }
  });

  it("Claude Code, Codex and ZCode route reads and shell tools to the guard, not only writes", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(REPO, ".claude/settings.json"), "utf8"));
    const codex = JSON.parse(fs.readFileSync(path.join(REPO, ".codex/hooks.json"), "utf8"));
    const matcherFor = (entries: Array<{ matcher?: string; hooks: Array<{ args?: string[]; command?: string }> }>) =>
      entries.find((e) => e.hooks.some((h) => `${h.command ?? ""} ${(h.args ?? []).join(" ")}`.includes("block-path-permissions.js")))!.matcher!;
    for (const matcher of [
      matcherFor(settings.hooks.PreToolUse),
      matcherFor(codex.hooks.PreToolUse),
      matcherFor(renderZcodeManagedHooks().events.PreToolUse),
    ]) {
      const tools = matcher.split("|");
      for (const tool of ["Read", "Grep", "Glob", "Bash", "PowerShell", "Write", "Edit"]) expect(tools).toContain(tool);
    }
    const zcodeFile = JSON.parse(fs.readFileSync(path.join(REPO, ".zcode/config.json"), "utf8"));
    expect(zcodeFile.hooks).toEqual(renderZcodeManagedHooks());
  });

  it("OpenCode: the plugin refuses every tool that names the channel, before its write-only filter", async () => {
    const root = workspace();
    const { StaGuards } = (await import(OPENCODE_PLUGIN)) as {
      StaGuards: (ctx: { project: { worktree: string } }) => Promise<{ "tool.execute.before": (i: { tool: string }, o: { args: unknown }) => Promise<void> }>;
    };
    const hooks = await StaGuards({ project: { worktree: root } });
    const call = (tool: string, args: unknown) => hooks["tool.execute.before"]({ tool }, { args });
    await expect(call("read", { filePath: keyFile })).rejects.toThrow(/human-owned STA approval channel/);
    await expect(call("edit", { filePath: configFile, oldString: "a", newString: "b" })).rejects.toThrow(/approval channel/);
    await expect(call("write", { filePath: configFile, content: "{}" })).rejects.toThrow(/approval channel/);
    await expect(call("bash", { command: `cat ~/${APPROVAL_CHANNEL_DIR_NAME}/github-app.private-key.pem` })).rejects.toThrow(/approval channel/);
    await expect(call("grep", { pattern: "x", path: channelDir })).rejects.toThrow(/approval channel/);
    await expect(call("read", { filePath: path.join(root, "src", "x.ts") })).resolves.toBeUndefined();
    await expect(call("bash", { command: "npm test" })).resolves.toBeUndefined();
  });

  it("Antigravity: the wrapper denies the channel for view_file, run_command and writes, and registers those tools", () => {
    const root = workspace();
    const invoke = (tool: string, parameters: Record<string, unknown>) => {
      const proc = spawnSync(process.execPath, [AGY_WRAPPER], {
        input: JSON.stringify({ tool_name: tool, tool_info: { parameters } }),
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, STA_WORKSPACE_ROOT: root, STA_ROLE: "" },
      });
      return JSON.parse(proc.stdout) as { decision: string; reason?: string };
    };
    expect(invoke("view_file", { AbsolutePath: keyFile })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/approval channel/) });
    expect(invoke("run_command", { CommandLine: `type %USERPROFILE%\\${APPROVAL_CHANNEL_DIR_NAME}\\github-app.json` })).toMatchObject({ decision: "deny" });
    expect(invoke("write_to_file", { TargetFile: configFile })).toMatchObject({ decision: "deny" });
    expect(invoke("run_command", { CommandLine: "npm test" })).toMatchObject({ decision: "allow" });
    const registered = renderAgyManagedHooks().PreToolUse.map((r) => r.matcher);
    for (const tool of ["view_file", "run_command", "grep_search", "list_dir", "find_by_name", "write_to_file"]) expect(registered).toContain(tool);
  });
});
