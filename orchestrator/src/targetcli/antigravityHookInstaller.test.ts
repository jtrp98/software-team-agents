import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGY_MANAGED_MACHINE_HOOK_KEY,
  installAntigravityHook,
  uninstallAntigravityHook,
} from "./antigravityHookInstaller.js";
import { antigravityCoverage, guardCoverage, guardCoverageIsPositive } from "./guardSettings.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";

describe("antigravityHookInstaller — machine-level PreToolUse hook installation & detection", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let machineConfigDir: string;
  let machineHooksPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-agy-install-test-"));
    workspaceRoot = path.join(tempDir, "workspace");
    machineConfigDir = path.join(tempDir, ".gemini", "config");
    machineHooksPath = path.join(machineConfigDir, "hooks.json");

    fs.mkdirSync(path.join(workspaceRoot, ".agents", "hooks"), { recursive: true });
    fs.mkdirSync(machineConfigDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws when workspace has no .agents/hooks/sta-guard.js", () => {
    expect(() =>
      installAntigravityHook({
        targetRoot: workspaceRoot,
        machineHooksPath,
      }),
    ).toThrow(/no \.agents\/hooks\/sta-guard\.js in/);
  });

  it("installs PreToolUse hook pointing to absolute sta-guard.js path and creates backup", () => {
    // Write a dummy sta-guard.js in the workspace
    const guardScript = path.join(workspaceRoot, ".agents", "hooks", "sta-guard.js");
    fs.writeFileSync(guardScript, "// guard script", "utf8");

    // Write an existing hooks.json
    const initialConfig = {
      "user-hook": {
        PostToolUse: [{ matcher: "view_file", hooks: [{ command: "echo viewed" }] }],
      },
    };
    fs.writeFileSync(machineHooksPath, JSON.stringify(initialConfig, null, 2), "utf8");

    // Check detection before install
    const coverageBefore = antigravityCoverage(workspaceRoot, { machineHooksPath });
    expect(coverageBefore.level).toBe("unguarded");
    expect(guardCoverageIsPositive(coverageBefore)).toBe(false);

    // Run installer
    const installResult = installAntigravityHook({
      targetRoot: workspaceRoot,
      machineHooksPath,
    });

    expect(installResult.ok).toBe(true);
    expect(installResult.backupPath).toBeDefined();
    expect(fs.existsSync(installResult.backupPath!)).toBe(true);

    // Verify backup content matches initial
    const backupContent = JSON.parse(fs.readFileSync(installResult.backupPath!, "utf8"));
    expect(backupContent).toEqual(initialConfig);

    // Verify installed hooks.json content
    const updated = JSON.parse(fs.readFileSync(machineHooksPath, "utf8"));
    expect(updated["user-hook"]).toBeDefined(); // preserved
    expect(updated[AGY_MANAGED_MACHINE_HOOK_KEY]).toBeDefined();

    const managed = updated[AGY_MANAGED_MACHINE_HOOK_KEY];
    expect(managed.PreToolUse).toBeDefined();
    expect(managed.PreToolUse.length).toBe(1);
    const hookCmd = managed.PreToolUse[0].hooks[0].command;
    const normGuard = guardScript.toLowerCase().replace(/\\/g, "/");
    expect(hookCmd.toLowerCase().replace(/\\/g, "/")).toContain(normGuard);

    // Check detection after install
    const coverageAfter = antigravityCoverage(workspaceRoot, { machineHooksPath });
    expect(coverageAfter.level).toBe("partial");
    expect(guardCoverageIsPositive(coverageAfter)).toBe(true);
    expect(coverageAfter.enforced).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(coverageAfter.unenforced).toContain(RuntimeCapability.POST_TOOL_GUARD);

    // guardCoverage dispatcher also passes through
    const dispatched = guardCoverage({
      runtime: "antigravity",
      targetRoot: workspaceRoot,
      machineHooksPath,
    });
    expect(dispatched.level).toBe("partial");
  });

  it("uninstalls and restores from backup", () => {
    const guardScript = path.join(workspaceRoot, ".agents", "hooks", "sta-guard.js");
    fs.writeFileSync(guardScript, "// guard script", "utf8");

    const originalHooks = { original: true };
    fs.writeFileSync(machineHooksPath, JSON.stringify(originalHooks), "utf8");

    installAntigravityHook({
      targetRoot: workspaceRoot,
      machineHooksPath,
    });

    // Uninstall with restore
    const uninstallResult = uninstallAntigravityHook({
      machineHooksPath,
      restore: true,
    });

    expect(uninstallResult.ok).toBe(true);
    expect(uninstallResult.restoredFrom).toBeDefined();
    const restored = JSON.parse(fs.readFileSync(machineHooksPath, "utf8"));
    expect(restored).toEqual(originalHooks);

    // Coverage reverts to unguarded
    const coverage = antigravityCoverage(workspaceRoot, { machineHooksPath });
    expect(coverage.level).toBe("unguarded");
  });

  it("uninstalls by removing key when restore is not requested", () => {
    const guardScript = path.join(workspaceRoot, ".agents", "hooks", "sta-guard.js");
    fs.writeFileSync(guardScript, "// guard script", "utf8");

    fs.writeFileSync(machineHooksPath, JSON.stringify({ otherTool: true }), "utf8");

    installAntigravityHook({
      targetRoot: workspaceRoot,
      machineHooksPath,
    });

    const uninstallResult = uninstallAntigravityHook({
      machineHooksPath,
      restore: false,
    });

    expect(uninstallResult.ok).toBe(true);
    expect(uninstallResult.removedKeys).toContain(AGY_MANAGED_MACHINE_HOOK_KEY);
    const remaining = JSON.parse(fs.readFileSync(machineHooksPath, "utf8"));
    expect(remaining.otherTool).toBe(true);
    expect(remaining[AGY_MANAGED_MACHINE_HOOK_KEY]).toBeUndefined();
  });
});
