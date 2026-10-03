import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexPreToolGuardScript } from "./codexPreToolGuard.js";
import type { RuntimeAgentRequest } from "./runtimeAdapter.js";

let fixture: string;
let root: string;
let home: string;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pre-tool-"));
  root = path.join(fixture, "project");
  home = path.join(fixture, "home");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
});
afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

function check(tool: string, command: string, overrides: Partial<RuntimeAgentRequest> = {}) {
  const req: RuntimeAgentRequest = { cwd: root, prompt: "test", autonomy: "edit", guards: { writeAllow: ["src/**"], writeDeny: ["src/private/**"], forbidCommands: ["git"], exitChecks: [] }, ...overrides };
  const script = path.join(home, "guard.cjs");
  fs.writeFileSync(script, codexPreToolGuardScript(req, home));
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } }), encoding: "utf8", windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
}
function patch(...headers: string[]) {
  return ["*** Begin Patch", ...headers, "+export {};", "*** End Patch"].join("\n");
}

describe("Codex adapter-owned PreToolUse guard", () => {
  it("allows a patch within the grant without modifying any file itself", () => {
    expect(check("apply_patch", patch("*** Add File: src/order.ts"))).toBeUndefined();
    expect(fs.existsSync(path.join(root, "src/order.ts"))).toBe(false);
  });
  it.each(["../escape.ts", "contracts/backend-engineer.yaml", ".git/config", "src/private/order.ts", "_docs/requirement.md", ".codex/hooks.json"])("denies %s before the tool runs", (file) => {
    expect(check("apply_patch", patch(`*** Add File: ${file}`)).permissionDecision).toBe("deny");
  });
  it("checks both the source and destination of a move", () => {
    expect(check("apply_patch", patch("*** Update File: src/order.ts", "*** Move to: contracts/order.ts")).permissionDecision).toBe("deny");
    expect(check("apply_patch", patch("*** Delete File: src/private/order.ts")).permissionDecision).toBe("deny");
  });
  it("denies read-only requests and unsupported patch envelopes", () => {
    expect(check("apply_patch", patch("*** Add File: src/order.ts"), { autonomy: "read-only" }).permissionDecision).toBe("deny");
    expect(check("apply_patch", "not a patch").permissionDecision).toBe("deny");
  });
  it("blocks symlink destinations, including a not-yet-created file", () => {
    const outside = path.join(fixture, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync(outside, path.join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(check("apply_patch", patch("*** Add File: src/linked/new.ts")).permissionDecisionReason).toMatch(/symlink/);
  });
  it("allows simple read commands", () => {
    expect(check("Bash", "rg --files")).toBeUndefined();
    expect(check("Bash", "Get-Content src/order.ts -TotalCount 50")).toBeUndefined();
  });
  it.each(["git status", "Set-Content src/order.ts hi", "node -e writeFile()", "cat src/order.ts > outside.ts", "rg --pre malicious src", "Get-Content src/order.ts; Set-Content outside.ts hi", "powershell -Command evil", "rg --files\nSet-Content outside.ts hi"])("refuses opaque or writing shell: %s", (command) => {
    expect(check("Bash", command).permissionDecision).toBe("deny");
  });
  it("blocks unsupported MCP writers and malformed tool input", () => {
    expect(check("mcp__filesystem__write_file", "{}").permissionDecision).toBe("deny");
    const script = path.join(home, "guard.cjs");
    const result = spawnSync(process.execPath, [script], { input: "not JSON", encoding: "utf8", windowsHide: true });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
