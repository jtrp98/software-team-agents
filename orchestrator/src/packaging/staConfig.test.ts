import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  StaConfigInvalidError,
  StaConfigMissingError,
  checkStaConfig,
  defaultStaConfig,
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
      permission_overrides: { "backend-engineer": { write: ["extra/**"] } },
      token_budget: 42_000,
      context_budget: { roles: { "qa-engineer": 90_000 }, model_context_windows: { opus: 120_000 } },
    });
    const loaded = loadStaConfig(root);
    expect(loaded.stack).toBe("nextjs-express");
    expect(loaded.model_routing).toEqual({ "qa-engineer": "opus" });
    expect(loaded.permission_overrides).toEqual({ "backend-engineer": { write: ["extra/**"] } });
    expect(loaded.token_budget).toBe(42_000);
    expect(loaded.context_budget).toEqual({ roles: { "qa-engineer": 90_000 }, model_context_windows: { opus: 120_000 } });
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
});
