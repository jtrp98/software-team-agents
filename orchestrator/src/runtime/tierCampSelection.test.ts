import { describe, expect, it, vi } from "vitest";
import { selectTierCamp } from "./tierCampSelection.js";

const choose = (overrides: Partial<Parameters<typeof selectTierCamp>[0]> = {}) => {
  const prompt = vi.fn(() => "opencode");
  const selected = selectTierCamp({
    hasConfiguredRoleRoute: false,
    isTTY: true,
    defaultRuntimeId: "claude-code",
    prompt,
    ...overrides,
  });
  return { selected, prompt };
};

describe("T-V4-CAST-005 tier camp selection", () => {
  it("lets an explicit flag beat a configured camp without prompting", () => {
    const { selected, prompt } = choose({ flagRuntime: "codex", configuredRuntime: "opencode" });
    expect(selected).toEqual({ runtimeId: "codex", source: "flag" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("lets a configured camp beat the prompt", () => {
    const { selected, prompt } = choose({ configuredRuntime: "opencode" });
    expect(selected).toEqual({ runtimeId: "opencode", source: "config" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("defers a configured per-role camp to the existing router without prompting", () => {
    const { selected, prompt } = choose({ hasConfiguredRoleRoute: true });
    expect(selected).toEqual({ source: "configured-role-route" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts only when a terminal is attached and no camp was specified", () => {
    const { selected, prompt } = choose();
    expect(selected).toEqual({ runtimeId: "opencode", source: "prompt" });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("uses the configured default without reading stdin in headless mode", () => {
    const { selected, prompt } = choose({ isTTY: false });
    expect(selected).toEqual({ runtimeId: "claude-code", source: "default" });
    expect(prompt).not.toHaveBeenCalled();
  });
});
