import { describe, expect, it } from "vitest";
import type { ModelTierId, ModelTierPolicy, ModelTiers } from "./modelTiers.js";
import { campForRuntime, formatModelPolicyBasis, resolveEffectiveModelPolicy, resolveTierBinding } from "./tierRouting.js";

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
const policy: ModelTierPolicy = {
  tiers: table,
  roleDefaults: { "business-analyst": "T3", devops: "runtime-default" },
  legacyRoleDefaults: false,
};

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

describe("T-V8-005 effective model policy precedence", () => {
  it("uses role Tier defaults when the task and operator are silent", () => {
    const resolved = resolveEffectiveModelPolicy({ role: "business-analyst", runtimeId: "claude-code", policy });
    expect(resolved).toMatchObject({
      effectiveTier: "T3",
      model: "anthropic-2",
      effort: "high",
      modelExplicit: true,
      modelBasis: "role-default-tier:T3",
      effortBasis: "role-default-tier:T3",
    });
  });

  it("task Tier beats the role default and records both requested values", () => {
    const resolved = resolveEffectiveModelPolicy({ role: "business-analyst", runtimeId: "codex", policy, taskTier: "T4" });
    expect(resolved).toMatchObject({
      effectiveTier: "T4",
      model: "openai-3",
      requested: { taskTier: "T4", roleDefaultTier: "T3" },
    });
    expect(resolved.diagnostics).toContain("task Tier T4 overrides role default T3 for business-analyst");
  });

  it("operator model/effort beat both task and role Tier values without hiding the conflict", () => {
    const resolved = resolveEffectiveModelPolicy({
      role: "business-analyst",
      runtimeId: "claude-code",
      policy,
      taskTier: "T4",
      operatorModel: "operator-model",
      operatorEffort: "operator-effort",
    });
    expect(resolved).toMatchObject({
      effectiveTier: "T4",
      model: "operator-model",
      effort: "operator-effort",
      modelBasis: "operator-model",
      effortBasis: "operator-effort",
      requested: { operatorModel: "operator-model", operatorEffort: "operator-effort", taskTier: "T4", roleDefaultTier: "T3" },
    });
    expect(formatModelPolicyBasis(resolved)).toBe("tier=T4,model=operator-model,effort=operator-effort");
  });

  it("honours an intentional runtime-default role without consulting frontmatter", () => {
    const resolved = resolveEffectiveModelPolicy({
      role: "devops",
      runtimeId: "claude-code",
      policy,
      legacyFrontmatterModel: "must-not-win",
      legacyFrontmatterEffort: "must-not-win",
    });
    expect(resolved.model).toBeUndefined();
    expect(resolved.effort).toBeUndefined();
    expect(resolved).toMatchObject({ modelExplicit: false, modelBasis: "runtime-default", effortBasis: "runtime-default" });
  });

  it("fails closed for invalid/reserved task tiers and a Tier on an unmapped runtime", () => {
    expect(() => resolveEffectiveModelPolicy({ role: "business-analyst", runtimeId: "claude-code", policy, taskTier: "T1" })).toThrow(/reserved/);
    expect(() => resolveEffectiveModelPolicy({ role: "business-analyst", runtimeId: "claude-code", policy, taskTier: "T9" })).toThrow(/invalid/);
    expect(() => resolveEffectiveModelPolicy({ role: "business-analyst", runtimeId: "custom-runtime", policy })).toThrow(/no model-tier camp mapping/);
  });

  it("keeps pre-V8 frontmatter as an explicitly diagnosed compatibility fallback", () => {
    const resolved = resolveEffectiveModelPolicy({
      role: "business-analyst",
      runtimeId: "claude-code",
      policy: { tiers: table, roleDefaults: {}, legacyRoleDefaults: true },
      legacyFrontmatterModel: "sonnet",
      legacyFrontmatterEffort: "medium",
    });
    expect(resolved).toMatchObject({ model: "sonnet", effort: "medium", modelExplicit: false, modelBasis: "legacy-frontmatter", effortBasis: "legacy-frontmatter" });
    expect(resolved.diagnostics.join("\n")).toContain("legacy agent frontmatter compatibility");
  });
});
