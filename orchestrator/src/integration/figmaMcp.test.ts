import { describe, expect, it } from "vitest";
import {
  FIGMA_MCP_READ_TOOLS,
  figmaMcpConnectVerdict,
  isFigmaReadTool,
  isReadOnlyToolSelection,
  looksLikeWriteTool,
} from "./figmaMcp.js";

describe("the read-only allowlist", () => {
  it("carries identity and the four read surfaces — and nothing else", () => {
    expect(FIGMA_MCP_READ_TOOLS).toEqual(["get_me", "get_metadata", "get_code", "get_screenshot", "get_variable_defs"]);
  });

  it("recognizes its own tools", () => {
    for (const tool of FIGMA_MCP_READ_TOOLS) expect(isFigmaReadTool(tool)).toBe(true);
    expect(isFigmaReadTool("post_comment")).toBe(false);
  });
});

describe("isReadOnlyToolSelection", () => {
  it("accepts a subset of the read tools", () => {
    expect(isReadOnlyToolSelection(["get_me", "get_code"])).toBe(true);
    expect(isReadOnlyToolSelection([])).toBe(true);
  });

  it("refuses any unknown name — an allowlist that silently drops names would widen what runs", () => {
    expect(isReadOnlyToolSelection(["get_me", "join_call"])).toBe(false);
    expect(isReadOnlyToolSelection(["get_met"])).toBe(false);
  });
});

describe("looksLikeWriteTool", () => {
  it("flags mutating names even if someone later adds one to the list", () => {
    expect(looksLikeWriteTool("write_design")).toBe(true);
    expect(looksLikeWriteTool("create_node")).toBe(true);
    expect(looksLikeWriteTool("Post_Comment")).toBe(true);
    expect(looksLikeWriteTool("update_variable")).toBe(true);
    expect(looksLikeWriteTool("get_metadata")).toBe(false);
  });
});

describe("figmaMcpConnectVerdict (the connect-time gate)", () => {
  const good = { declaredEmail: "me@person.dev", getMeEmail: "me@person.dev", toolNames: ["get_me", "get_code"] };

  it("allows a verified identity over read-only tools", () => {
    const verdict = figmaMcpConnectVerdict(good);
    expect(verdict.allowed).toBe(true);
    expect(verdict.readOnlyOk).toBe(true);
  });

  it("fails closed on an unverified identity before even looking at the tools", () => {
    const verdict = figmaMcpConnectVerdict({ ...good, getMeEmail: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/FIGMA_PAT/);
  });

  it("refuses a write-capable selection — Code-to-Canvas never connects", () => {
    const verdict = figmaMcpConnectVerdict({ ...good, toolNames: ["get_me", "create_dev_component"] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.readOnlyOk).toBe(false);
    expect(verdict.reason).toMatch(/read-only|canvas/i);
  });

  it("refuses when nothing is declared at all", () => {
    const verdict = figmaMcpConnectVerdict({ ...good, declaredEmail: undefined });
    expect(verdict.allowed).toBe(false);
  });
});
