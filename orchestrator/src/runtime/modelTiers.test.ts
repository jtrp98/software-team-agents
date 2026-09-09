import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODEL_TIER_CAMPS,
  MODEL_TIER_IDS,
  MODEL_POLICY_ROLES,
  ModelTiersInvalidError,
  RUNTIME_DEFAULT_TIER,
  loadModelTierPolicy,
  loadModelTiers,
  parseModelTierPolicy,
  parseModelTiers,
} from "./modelTiers.js";

const COMPLETE = `tiers:
  T1:
    reserved: true
    camps:
      anthropic: { model: opus, effort: max, notes: reserved }
      openai: { model: sol, effort: xhigh, notes: reserved }
      google: { model: pro, effort: high, notes: reserved }
      zai: { model: glm, effort: thinking, notes: reserved }
  T2:
    camps:
      anthropic: { model: opus, effort: high, notes: planning }
      openai: { model: sol, effort: high, notes: planning }
      google: { model: pro, effort: high, notes: planning }
      zai: { model: glm, effort: thinking, notes: planning }
  T3:
    camps:
      anthropic: { model: opus, effort: medium, notes: analysis }
      openai: { model: sol, effort: medium, notes: analysis }
      google: { model: pro, effort: medium, notes: analysis }
      zai: { model: glm, effort: thinking, notes: analysis }
  T4:
    camps:
      anthropic: { model: sonnet, effort: high, notes: implementation }
      openai: { model: terra, effort: high, notes: implementation }
      google: { model: flash, effort: high, notes: implementation }
      zai: { model: glm, effort: thinking, notes: implementation }
  T5:
    camps:
      anthropic: { model: sonnet, effort: medium, notes: light }
      openai: { model: terra, effort: medium, notes: light }
      google: { model: flash, effort: medium, notes: light }
      zai: { model: glm, effort: off, notes: light }
  T6:
    camps:
      anthropic: { model: haiku, effort: low, notes: mechanical }
      openai: { model: luna, effort: low, notes: mechanical }
      google: { model: flash-lite, effort: low, notes: mechanical }
      zai: { model: turbo, effort: off, notes: mechanical }
`;

const ROLE_DEFAULTS = `role_defaults:
  setup: T6
  business-analyst: T3
  system-analyst: T2
  project-manager: T2
  test-planner: T2
  uxui-designer: T3
  backend-engineer: T5
  frontend-engineer: T5
  qa-engineer: T3
  security: T2
  devops: runtime-default
`;
const CURRENT = ROLE_DEFAULTS + COMPLETE;

describe("T-V4-CAST-003 model tiers", () => {
  it("accepts exactly six tiers, four camps, required cell fields, and reserved T1", () => {
    const tiers = parseModelTiers(COMPLETE);
    expect(Object.keys(tiers)).toEqual(MODEL_TIER_IDS);
    expect(Object.keys(tiers.T1.camps)).toEqual(MODEL_TIER_CAMPS);
    expect(tiers.T1.reserved).toBe(true);
    expect(tiers.T4.camps.anthropic).toEqual({ model: "sonnet", effort: "high", notes: "implementation" });
  });

  it("rejects an incomplete shape without judging any binding's adequacy", () => {
    expect(() => parseModelTiers(COMPLETE.replace("      zai: { model: turbo, effort: off, notes: mechanical }\n", "")))
      .toThrow(ModelTiersInvalidError);
  });

  it("treats an absent optional file as no tiers configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-model-tiers-"));
    expect(loadModelTiers(root)).toBeNull();
  });
});

describe("T-V8-005 role-default model policy", () => {
  it("parses one complete role-default policy while preserving the tier-table compatibility projection", () => {
    const policy = parseModelTierPolicy(CURRENT);
    expect(Object.keys(policy.roleDefaults)).toEqual(MODEL_POLICY_ROLES);
    expect(policy.roleDefaults).toMatchObject({
      "business-analyst": "T3",
      "system-analyst": "T2",
      "project-manager": "T2",
      "qa-engineer": "T3",
      devops: RUNTIME_DEFAULT_TIER,
    });
    expect(policy.legacyRoleDefaults).toBe(false);
    expect(parseModelTiers(CURRENT).T4.camps.anthropic.model).toBe("sonnet");
  });

  it("keeps a pre-V8 tier table readable and labels its missing role defaults as legacy", () => {
    const policy = parseModelTierPolicy(COMPLETE);
    expect(policy.roleDefaults).toEqual({});
    expect(policy.legacyRoleDefaults).toBe(true);
  });

  it("fails closed on incomplete roles, unknown roles, reserved T1, and unknown root keys", () => {
    expect(() => parseModelTierPolicy(CURRENT.replace("  devops: runtime-default\n", ""))).toThrow(/role_defaults is missing devops/);
    expect(() => parseModelTierPolicy(CURRENT.replace("  devops: runtime-default\n", "  devops: T1\n"))).toThrow(/reserved T1/);
    expect(() => parseModelTierPolicy(CURRENT.replace("tiers:\n", "invented: true\ntiers:\n"))).toThrow(/root has unexpected key invented/);
    expect(() => parseModelTierPolicy(CURRENT.replace("  devops: runtime-default\n", "  devops: runtime-default\n  human: T2\n"))).toThrow(/unexpected key human/);
  });

  it("loads the full policy and the old tier-only view from the same file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-model-policy-"));
    fs.writeFileSync(path.join(root, "model-tiers.yaml"), CURRENT, "utf8");
    expect(loadModelTierPolicy(root)?.roleDefaults["business-analyst"]).toBe("T3");
    expect(loadModelTiers(root)?.T3.camps.openai.model).toBe("sol");
  });
});
