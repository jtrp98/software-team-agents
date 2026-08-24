import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultInstallationConfigPath } from "./installation.js";

/**
 * The installation-config default path is what every unconfigured caller
 * resolves state through (`resolveRoots`, the target CLI, status). Its one
 * env override is the isolation channel packaged E2E runs depend on — if it
 * stopped being honoured there, an E2E on a configured machine would silently
 * read that machine's real Knowledge root.
 */
const ENV_KEY = "AGENTCLAUDE_INSTALLATION_CONFIG";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("defaultInstallationConfigPath — the AGENTCLAUDE_INSTALLATION_CONFIG override", () => {
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
