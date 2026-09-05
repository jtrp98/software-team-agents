import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  StaConfigInvalidError,
  StaConfigMissingError,
  checkStaConfig,
  defaultStaConfig,
  effectiveExecutionConfig,
  inertConfigKeys,
  inspectStaConfig,
  loadStaConfig,
  staConfigPath,
  writeStaConfig,
} from "./staConfig.js";

const roots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-config-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("defaultStaConfig / writeStaConfig / loadStaConfig", () => {
  it("round-trips the default config", () => {
    const root = tmpRoot();
    writeStaConfig(root, defaultStaConfig());
    expect(fs.existsSync(staConfigPath(root))).toBe(true);
    expect(loadStaConfig(root)).toEqual({ schema_version: 1 });
  });

  it("round-trips overrides", () => {
    const root = tmpRoot();
    writeStaConfig(root, {
      schema_version: 1,
      stack: "nextjs-express",
      model_routing: { "qa-engineer": "opus" },
      execution: { mode: "auto", runner: "claude-code", allow_handoff: true, allow_paid_fallback: false },
      routing: {
        strategy: "subscription-first",
        order: ["claude-code", "codex"],
        by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } },
        allow_below_supported: ["codex"],
      },
      qa: { strategy: "risk-based" },
      verification: { baseline: ["unit", "typecheck", "build"] },
      permission_overrides: { "backend-engineer": { write: ["extra/**"] } },
      token_budget: 42_000,
      context_budget: { roles: { "qa-engineer": 90_000 }, model_context_windows: { opus: 120_000 }, max_context_estimated_tokens: 30_000, mode: "reject" },
    });
    const loaded = loadStaConfig(root);
    expect(loaded.stack).toBe("nextjs-express");
    expect(loaded.model_routing).toEqual({ "qa-engineer": "opus" });
    expect(loaded.execution).toEqual({ mode: "auto", runner: "claude-code", allow_handoff: true, allow_paid_fallback: false });
    expect(loaded.routing).toEqual({
      strategy: "subscription-first",
      order: ["claude-code", "codex"],
      by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } },
      allow_below_supported: ["codex"],
    });
    expect(loaded.qa).toEqual({ strategy: "risk-based" });
    expect(loaded.verification).toEqual({ baseline: ["unit", "typecheck", "build"] });
    expect(loaded.permission_overrides).toEqual({ "backend-engineer": { write: ["extra/**"] } });
    expect(loaded.token_budget).toBe(42_000);
    expect(loaded.context_budget).toEqual({ roles: { "qa-engineer": 90_000 }, model_context_windows: { opus: 120_000 }, max_context_estimated_tokens: 30_000, mode: "reject" });
  });

  it("keeps V3 execution defaults additive and paid fallback off when the block is absent", () => {
    const config = defaultStaConfig();
    expect(config).toEqual({ schema_version: 1 });
    // `mode` and `allow_handoff` are no longer resolved to an effective value
    // because nothing reads them; they are reported as inert.
    expect(effectiveExecutionConfig(config.execution)).toEqual({
      runner: "claude-code",
      allow_paid_fallback: false,
      deterministic_gate_enabled: true,
    });
    expect(inertConfigKeys(config, config.execution)).toEqual([]);
  });

  it("defaults paid fallback off when execution exists without that key", () => {
    expect(effectiveExecutionConfig({ mode: "auto" }).allow_paid_fallback).toBe(false);
  });

  // A config written for the removed routing engine must still load, and
  // every key nothing reads must be reported rather than silently honoured.
  it("still loads a config carrying the removed routing keys and names them inert", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.dirname(staConfigPath(root)), { recursive: true });
    fs.writeFileSync(
      staConfigPath(root),
      [
        "schema_version: 1",
        "model_routing:",
        "  qa-engineer: opus",
        "execution:",
        "  mode: auto",
        "  runner: codex",
        "  allow_handoff: true",
        "  allow_paid_fallback: true",
        "routing:",
        "  strategy: subscription-first",
        "  order: [claude-code, codex]",
        "  by_role:",
        "    backend-engineer: codex:gpt-5",
        "",
      ].join("\n"),
      "utf8",
    );
    const loaded = loadStaConfig(root);
    expect(loaded.execution?.runner).toBe("codex");
    expect(inspectStaConfig(root)).toEqual({ problems: [], warnings: [] });
    expect(inertConfigKeys(loaded, loaded.execution)).toEqual([
      "execution.mode",
      "execution.allow_handoff",
      "execution.allow_paid_fallback",
      "routing.strategy",
      "routing.order",
      "model_routing",
    ]);
  });

  it("throws StaConfigMissingError when there is no config yet", () => {
    const root = tmpRoot();
    expect(() => loadStaConfig(root)).toThrow(StaConfigMissingError);
  });

  it("throws StaConfigInvalidError on a malformed config", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.dirname(staConfigPath(root)), { recursive: true });
    fs.writeFileSync(staConfigPath(root), "schema_version: 2\n", "utf8");
    expect(() => loadStaConfig(root)).toThrow(StaConfigInvalidError);
  });
});

describe("checkStaConfig", () => {
  it("reports missing rather than throwing", () => {
    const root = tmpRoot();
    expect(checkStaConfig(root)).toEqual([staConfigPath(root) + " is missing"]);
  });

  it("reports invalid YAML rather than throwing", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.dirname(staConfigPath(root)), { recursive: true });
    fs.writeFileSync(staConfigPath(root), "stack: [unterminated\n", "utf8");
    expect(checkStaConfig(root).length).toBeGreaterThan(0);
  });

  it("passes for a valid config", () => {
    const root = tmpRoot();
    writeStaConfig(root, defaultStaConfig());
    expect(checkStaConfig(root)).toEqual([]);
  });

  it("a pre-V3 schema warns about every additive V3 block and never errors", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.dirname(staConfigPath(root)), { recursive: true });
    fs.writeFileSync(
      staConfigPath(root),
      "schema_version: 1\nexecution:\n  mode: auto\nrouting:\n  strategy: subscription-first\nqa:\n  strategy: risk-based\nverification:\n  baseline: [unit]\n",
      "utf8",
    );
    const result = inspectStaConfig(root, "pre-v3");
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/execution.*qa.*routing.*verification/);
  });
});
