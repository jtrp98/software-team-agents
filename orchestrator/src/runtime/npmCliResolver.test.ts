import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { formatResolvedCommand, resolveBundledStaCli, resolveNpmCliScript } from "./npmCliResolver.js";

describe("bundled sta resolver (T-V3TOK-042)", () => {
  it("resolves the JS entry directly through Node, bypassing Windows npm shims", () => {
    const root = "C:\\Program Files\\software-team-agents";
    const entry = path.join(root, "orchestrator", "dist", "cli.js");
    const resolved = resolveBundledStaCli(root, { exists: (candidate) => candidate === entry, execPath: "C:\\Program Files\\nodejs\\node.exe" });
    expect(resolved).toEqual({ file: "C:\\Program Files\\nodejs\\node.exe", prefixArgs: [entry] });
    expect(formatResolvedCommand(resolved!)).toBe(`"C:\\Program Files\\nodejs\\node.exe" "${entry}"`);
  });

  it("returns null when an installation has no sta entry", () => {
    expect(resolveBundledStaCli("C:\\missing", { exists: () => false })).toBeNull();
  });
});

describe("resolveNpmCliScript — the shim beside which the package sits decides identity", () => {
  const npmDir = "C:\\Users\\u\\AppData\\Roaming\\npm";
  const execPath = "C:\\Program Files\\nodejs\\node.exe";

  it("resolves @openai/codex through its bin/<command>.js node entry (0.155.1 layout)", () => {
    const binJs = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const resolved = resolveNpmCliScript("codex", {
      dirs: [npmDir],
      exists: (candidate) => candidate === path.join(npmDir, "codex.cmd") || candidate === binJs,
      execPath,
    });
    expect(resolved).toEqual({ file: execPath, prefixArgs: [binJs] });
  });

  it("prefers a native bin/<command>.exe when the package ships one", () => {
    const exe = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.exe");
    const resolved = resolveNpmCliScript("codex", {
      dirs: [npmDir],
      exists: (candidate) => candidate === path.join(npmDir, "codex.cmd") || candidate === exe,
      execPath,
    });
    expect(resolved).toEqual({ file: exe, prefixArgs: [] });
  });

  it("returns null for a package it does not know, and when no shim sits on the scanned PATH", () => {
    const binJs = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    expect(resolveNpmCliScript("somecli", { dirs: [npmDir], exists: () => true })).toBeNull();
    expect(resolveNpmCliScript("codex", { dirs: [npmDir], exists: (candidate) => candidate === binJs })).toBeNull();
  });
});
