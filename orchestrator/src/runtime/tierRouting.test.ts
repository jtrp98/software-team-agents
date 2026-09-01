import { describe, expect, it } from "vitest";
import type { ModelTierId, ModelTiers } from "./modelTiers.js";
import { campForRuntime, resolveTierBinding } from "./tierRouting.js";

const cell = (model: string, effort: string) => ({ model, effort, notes: "human choice" });
const table = Object.fromEntries((["T1", "T2", "T3", "T4", "T5", "T6"] as ModelTierId[]).map((tier, index) => [tier, {
  reserved: tier === "T1",
  camps: {
    anthropic: cell(`anthropic-${index}`, "high"),
    openai: cell(`openai-${index}`, "high"),
    google: cell(`google-${index}`, "high"),
    zai: cell(index < 2 ? "zai-top" : `zai-${index}`, index < 2 ? "thinking" : "off"),
  },
}])) as ModelTiers;

describe("T-V4-CAST-005 tier-to-camp resolution", () => {
  it.each([
    ["claude-code", "anthropic-3", "high"],
    ["codex", "openai-3", "high"],
    ["antigravity", "google-3", "high"],
    ["opencode", "zai-3", "off"],
  ])("resolves T4 for %s", (runtimeId, model, effort) => {
    expect(resolveTierBinding(table, "T4", runtimeId)).toMatchObject({ model, effort });
  });

  it("collapses a shorter camp upward deterministically through its repeated top rung", () => {
    expect(resolveTierBinding(table, "T1", "opencode")).toEqual(resolveTierBinding(table, "T2", "opencode"));
    expect(campForRuntime("opencode")).toBe("zai");
    expect(campForRuntime("paid-api")).toBeNull();
  });
});
