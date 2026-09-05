import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESIGN_MCP_SERVER_URL,
  CLAUDE_DESIGN_READ_TOOLS,
  CLAUDE_DESIGN_WRITE_TOOLS,
  selectClaudeDesignTools,
} from "./claudeDesignMcp.js";

/**
 * Every branch of the Claude Design allowlist selector is fail-closed and
 * provable without a credential. These tests ensure nobody can widen the tool
 * surface (or sneak a canvas mutation into a read-only run) without a
 * deliberate constant change that shows up in this file's diff.
 */

describe("CLAUDE_DESIGN_MCP_SERVER_URL", () => {
  it("pins the official Anthropic endpoint — no unofficial proxy may be configured instead", () => {
    expect(CLAUDE_DESIGN_MCP_SERVER_URL).toBe("https://api.anthropic.com/v1/design/mcp");
  });
});

describe("selectClaudeDesignTools", () => {
  it("allows every read tool in read mode, preserving requested order", () => {
    const selection = selectClaudeDesignTools([...CLAUDE_DESIGN_READ_TOOLS].reverse(), "read");
    expect(selection.allowed).toEqual([...CLAUDE_DESIGN_READ_TOOLS].reverse());
    expect(selection.refused).toEqual([]);
  });

  it("refuses a canvas write tool in read mode with an actionable reason", () => {
    for (const tool of CLAUDE_DESIGN_WRITE_TOOLS) {
      const selection = selectClaudeDesignTools([tool], "read");
      expect(selection.allowed).toEqual([]);
      expect(selection.refused).toHaveLength(1);
      expect(selection.refused[0].tool).toBe(tool);
      expect(selection.refused[0].reason).toMatch(/read-only/);
    }
  });

  it("refuses unknown tools in both modes — unheard-of is unsafe by default", () => {
    for (const mode of ["read", "write"] as const) {
      const selection = selectClaudeDesignTools(["delete_everything"], mode);
      expect(selection.allowed).toEqual([]);
      expect(selection.refused[0].reason).toMatch(/fail-closed/);
    }
  });

  it("treats an empty request as valid, refusing nothing", () => {
    expect(selectClaudeDesignTools([], "read")).toEqual({ allowed: [], refused: [] });
    expect(selectClaudeDesignTools([], "write")).toEqual({ allowed: [], refused: [] });
  });

  it("write mode admits both allowlists — inspecting a project before iterating must not need a second run", () => {
    const selection = selectClaudeDesignTools([...CLAUDE_DESIGN_READ_TOOLS, ...CLAUDE_DESIGN_WRITE_TOOLS], "write");
    expect(selection.allowed.sort()).toEqual([...CLAUDE_DESIGN_READ_TOOLS, ...CLAUDE_DESIGN_WRITE_TOOLS].sort());
    expect(selection.refused).toEqual([]);
  });

  it("keeps refusals beside allowances when a request mixes both", () => {
    const selection = selectClaudeDesignTools(["read_file", "generate", "mystery_tool"], "read");
    expect(selection.allowed).toEqual(["read_file"]);
    expect(selection.refused.map((r) => r.tool)).toEqual(["generate", "mystery_tool"]);
  });

  it("never lets the provisional write list leak into the read list", () => {
    for (const tool of CLAUDE_DESIGN_WRITE_TOOLS) {
      expect(CLAUDE_DESIGN_READ_TOOLS).not.toContain(tool);
    }
  });
});
