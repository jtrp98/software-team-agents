import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  declareInstallationConfigOverrideChannelForTest,
  defaultInstallationConfigPath,
  InstallationConfigError,
  installationConfigOverride,
  loadInstallationConfig,
  resetInstallationConfigOverrideChannelForTest,
} from "./installation.js";

/**
 * `STA_INSTALLATION_CONFIG` is an internal test/E2E channel, not a public
 * feature (DR §9, package B). This file deliberately never declares the
 * in-process channel, so its tests observe what a production invocation
 * sees: the override is refused with the canonical config path named until
 * either the explicit declaration or the packaged-E2E harness marker exists.
 */
const ENV_KEY = "STA_INSTALLATION_CONFIG";
const HARNESS_KEY = "STA_TEST_HARNESS";
const originalEnv = process.env[ENV_KEY];
const originalHarness = process.env[HARNESS_KEY];

beforeEach(() => {
  resetInstallationConfigOverrideChannelForTest();
  delete process.env[ENV_KEY];
  delete process.env[HARNESS_KEY];
});

afterEach(() => {
  resetInstallationConfigOverrideChannelForTest();
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  if (originalHarness === undefined) delete process.env[HARNESS_KEY];
  else process.env[HARNESS_KEY] = originalHarness;
});

describe("STA_INSTALLATION_CONFIG — internal test/E2E channel", () => {
  it("refuses the override in a production invocation and names the canonical config path", () => {
    const override = path.join(os.tmpdir(), "sta-override-refused.yaml");
    process.env[ENV_KEY] = override;
    expect(() => installationConfigOverride()).toThrow(InstallationConfigError);
    expect(() => installationConfigOverride()).toThrow(/canonical installation config at /);
    expect(() => installationConfigOverride()).toThrow(override);
    expect(() => defaultInstallationConfigPath()).toThrow(InstallationConfigError);
    expect(() => loadInstallationConfig()).toThrow(InstallationConfigError);
  });

  it("honors the override once the calling test harness declares the channel", () => {
    const override = path.join(os.tmpdir(), "sta-override-declared.yaml");
    process.env[ENV_KEY] = override;
    declareInstallationConfigOverrideChannelForTest();
    expect(installationConfigOverride()).toBe(path.resolve(override));
    expect(defaultInstallationConfigPath()).toBe(path.resolve(override));
  });

  it("honors the override under the packaged-E2E harness marker without an in-process declaration", () => {
    const override = path.join(os.tmpdir(), "sta-override-packaged-e2e.yaml");
    process.env[ENV_KEY] = override;
    process.env[HARNESS_KEY] = "1";
    expect(defaultInstallationConfigPath()).toBe(path.resolve(override));
  });

  it("falls through to the platform default when the env is unset, with or without the contract", () => {
    expect(defaultInstallationConfigPath("win32", "C:/Users/x/AppData/Local", "/home/x")).toBe(
      path.join("C:/Users/x/AppData/Local", "software-team-agents", "installation.yaml"),
    );
    declareInstallationConfigOverrideChannelForTest();
    expect(defaultInstallationConfigPath("linux", undefined, "/home/x")).toBe(
      path.join("/home/x", ".config", "software-team-agents", "installation.yaml"),
    );
  });
});
