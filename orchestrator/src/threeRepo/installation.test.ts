import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declareInstallationConfigOverrideChannelForTest, defaultInstallationConfigPath } from "./installation.js";

declareInstallationConfigOverrideChannelForTest();

/**
 * The installation-config default path is what every unconfigured caller
 * resolves state through (`resolveRoots`, the target CLI, status). Its one
 * env override is the internal test/E2E channel packaged E2E runs depend on
 * (DR §9, package B) — this suite declares the channel explicitly, because a
 * production invocation finding the env set without a harness contract is
 * refused rather than silently reading another installation.
 */
const ENV_KEY = "STA_INSTALLATION_CONFIG";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("defaultInstallationConfigPath — the STA_INSTALLATION_CONFIG override", () => {
  it("resolves the override, absolute, ahead of every platform default", () => {
    process.env[ENV_KEY] = "some/installation.yaml";
    expect(defaultInstallationConfigPath()).toBe(path.resolve("some/installation.yaml"));
  });

  it("falls back to the per-OS location when no override is set", () => {
    delete process.env[ENV_KEY];
    expect(defaultInstallationConfigPath("win32", "C:/Users/x/AppData/Local", "/home/x")).toBe(
      path.join("C:/Users/x/AppData/Local", "software-team-agents", "installation.yaml"),
    );
    expect(defaultInstallationConfigPath("linux", undefined, "/home/x")).toBe(
      path.join("/home/x", ".config", "software-team-agents", "installation.yaml"),
    );
  });
});
