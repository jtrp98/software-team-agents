import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frameworkGuardRegistrations, mergeFrameworkGuards } from "./guardSettings.js";

const FRAMEWORK = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: "Write", hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/block-write.js"] }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/block-shell.js"] }] },
    ],
    SubagentStop: [
      { hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/green.js"] }] },
    ],
    Stop: [
      { hooks: [
        { type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/green.js"] },
        { type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/secrets.js"] },
      ] },
    ],
  },
});

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function originalBytesAreSubsequence(original: string, merged: string): boolean {
  const before = Buffer.from(original);
  const after = Buffer.from(merged);
  let cursor = 0;
  for (const byte of after) {
    if (cursor < before.length && byte === before[cursor]) cursor += 1;
  }
  return cursor === before.length;
}

describe("T-V3-02 guard settings merge", () => {
  it("adds all registrations to a file with no hooks while preserving every original byte", () => {
    const project = '{\r\n  "permissions": { "allow": ["Read(*)"] },\r\n  "unknown": "keep  two spaces"\r\n}';
    const result = mergeFrameworkGuards(project, FRAMEWORK);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(originalBytesAreSubsequence(project, result.content!)).toBe(true);
    expect((result.content!.match(/\.claude\/hooks\//g) ?? [])).toHaveLength(5);
    expect(JSON.parse(result.content!).permissions).toEqual({ allow: ["Read(*)"] });
  });

  it("preserves helper-shaped Graphify PreToolUse/PostToolUse entries byte-for-byte", () => {
    const project = `{
  "hooks": {
    "PreToolUse": [ { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "graphify hint" } ] } ],
    "PostToolUse": [ { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "graphify update" } ] } ]
  },
  "permissions": { "deny": ["WebFetch"] },
  "projectOnly": { "spacing": "untouched" }
}`;
    const result = mergeFrameworkGuards(project, FRAMEWORK);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(originalBytesAreSubsequence(project, result.content!)).toBe(true);
    expect(result.content).toContain('{ "type": "command", "command": "graphify hint" }');
    expect(result.content).toContain('{ "type": "command", "command": "graphify update" }');
    expect(JSON.parse(result.content!).hooks.PostToolUse).toHaveLength(1);
  });

  it("adds only the missing registration to a partial Framework shape", () => {
    const framework = JSON.parse(FRAMEWORK) as { hooks: Record<string, unknown[]> };
    const project = JSON.stringify({ hooks: { PreToolUse: [framework.hooks.PreToolUse![0]] } });
    const result = mergeFrameworkGuards(project, FRAMEWORK);
    expect(result).toMatchObject({ ok: true, changed: true });
    const parsed = JSON.parse(result.content!) as { hooks: Record<string, unknown[]> };
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(originalBytesAreSubsequence(project, result.content!)).toBe(true);
  });

  it("is byte-identical when every Framework registration is already present", () => {
    const result = mergeFrameworkGuards(FRAMEWORK, FRAMEWORK);
    expect(result).toEqual({ ok: true, changed: false, content: FRAMEWORK });
  });

  it.each([
    ["empty file", "", /not valid JSON/],
    ["non-object hooks", '{"hooks":[]}', /hooks must be an object/],
    ["non-array event", '{"hooks":{"PreToolUse":{}}}', /PreToolUse must be an array/],
  ])("refuses the unmergeable %s shape", (_name, project, expected) => {
    const result = mergeFrameworkGuards(project, FRAMEWORK);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expected);
  });

  it("enumerates registrations from the template in one place", () => {
    const templates = fs.mkdtempSync(path.join(os.tmpdir(), "sta-guard-template-"));
    roots.push(templates);
    fs.mkdirSync(path.join(templates, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(templates, ".claude", "settings.json"), FRAMEWORK, "utf8");
    expect(frameworkGuardRegistrations(templates).map((entry) => `${entry.event}:${entry.hookPath}`)).toEqual([
      "PreToolUse:.claude/hooks/block-write.js",
      "PreToolUse:.claude/hooks/block-shell.js",
      "SubagentStop:.claude/hooks/green.js",
      "Stop:.claude/hooks/green.js",
      "Stop:.claude/hooks/secrets.js",
    ]);
  });
});
