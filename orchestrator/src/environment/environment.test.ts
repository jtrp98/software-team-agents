import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  Environment,
  EnvironmentConfigError,
  checkEnvironmentConfig,
  describeEnvironment,
  environmentsPath,
  hasEnvironmentConfig,
  isEnvironment,
  loadEnvironmentConfig,
  resolveDefaultEnvironment,
} from "./environment.js";

function tmpDir(prefix = "orchestrator-env-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("isEnvironment", () => {
  it("accepts exactly the four fixed names", () => {
    expect(isEnvironment("local")).toBe(true);
    expect(isEnvironment("dev")).toBe(true);
    expect(isEnvironment("staging")).toBe(true);
    expect(isEnvironment("production")).toBe(true);
  });

  it("rejects anything else, including a plausible-looking invention", () => {
    expect(isEnvironment("prod")).toBe(false);
    expect(isEnvironment("Production")).toBe(false);
    expect(isEnvironment("")).toBe(false);
  });
});

describe("a project with no environments.yaml — the built-in defaults", () => {
  it("hasEnvironmentConfig is false", () => {
    expect(hasEnvironmentConfig(tmpDir())).toBe(false);
  });

  it("describeEnvironment returns a non-empty built-in description for every one of the four names", () => {
    const root = tmpDir();
    for (const env of Object.values(Environment)) {
      expect(describeEnvironment(env, root).length).toBeGreaterThan(0);
    }
  });

  it("resolveDefaultEnvironment falls back to local", () => {
    expect(resolveDefaultEnvironment(tmpDir())).toBe(Environment.LOCAL);
  });

  it("checkEnvironmentConfig passes with a note, not an error", () => {
    const result = checkEnvironmentConfig(tmpDir());
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain("built-in");
  });
});

describe("a valid environments.yaml", () => {
  it("loads, and describeEnvironment prefers the file's own description over the built-in one", () => {
    const root = tmpDir();
    fs.writeFileSync(
      environmentsPath(root),
      "version: 1\n" +
        "environments:\n" +
        "  - name: production\n    description: our real customer-facing environment, EU region\n    requires_approval: true\n" +
        "default: staging\n",
      "utf8",
    );

    const config = loadEnvironmentConfig(root);
    expect(config.environments).toEqual([
      { name: Environment.PRODUCTION, description: "our real customer-facing environment, EU region", requiresApproval: true },
    ]);
    expect(config.default).toBe(Environment.STAGING);

    expect(describeEnvironment(Environment.PRODUCTION, root)).toBe("our real customer-facing environment, EU region");
    // dev isn't declared in the file — still falls back to the built-in text rather than being empty.
    expect(describeEnvironment(Environment.DEV, root).length).toBeGreaterThan(0);
  });

  it("passes --check-environments with no notes when self-consistent", () => {
    const root = tmpDir();
    fs.writeFileSync(
      environmentsPath(root),
      "version: 1\nenvironments:\n  - name: local\n    description: dev machine\ndefault: local\n",
      "utf8",
    );
    const result = checkEnvironmentConfig(root);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe("a broken environments.yaml", () => {
  it("loadEnvironmentConfig throws on invalid YAML", () => {
    const root = tmpDir();
    fs.writeFileSync(environmentsPath(root), "version: [not\n  valid", "utf8");
    expect(() => loadEnvironmentConfig(root)).toThrow(EnvironmentConfigError);
  });

  it("loadEnvironmentConfig throws when a name isn't one of the four fixed values", () => {
    const root = tmpDir();
    fs.writeFileSync(environmentsPath(root), "version: 1\nenvironments:\n  - name: prod\n    description: x\n", "utf8");
    expect(() => loadEnvironmentConfig(root)).toThrow(EnvironmentConfigError);
  });

  it("checkEnvironmentConfig fails when an environment repeats", () => {
    const root = tmpDir();
    fs.writeFileSync(
      environmentsPath(root),
      "version: 1\nenvironments:\n  - name: dev\n    description: a\n  - name: dev\n    description: b\n",
      "utf8",
    );
    const result = checkEnvironmentConfig(root);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('"dev"') && p.includes("more than once"))).toBe(true);
  });

  it("checkEnvironmentConfig fails when default names an environment the file never declares", () => {
    const root = tmpDir();
    fs.writeFileSync(environmentsPath(root), "version: 1\nenvironments:\n  - name: dev\n    description: a\ndefault: production\n", "utf8");
    const result = checkEnvironmentConfig(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("default");
  });

  it("describeEnvironment/resolveDefaultEnvironment fall back gracefully instead of throwing when the file is broken", () => {
    const root = tmpDir();
    fs.writeFileSync(environmentsPath(root), "not: [valid", "utf8");
    expect(describeEnvironment(Environment.LOCAL, root).length).toBeGreaterThan(0);
    expect(resolveDefaultEnvironment(root)).toBe(Environment.LOCAL);
  });
});
